import { DatabaseSync } from "node:sqlite";
import { DB_PATH, RISK } from "./config.js";
import { openFill, closeFill, bookFill, feeUsd, dir, exitLevels } from "./engine.js";

export const lastClose = new Map();
export function minutesSinceClose(symbol, side, nowMs = Date.now()) {
  const row = db.prepare("SELECT MAX(closed_at) closed_at FROM positions WHERE status='closed' AND symbol=? AND side=?").get(symbol, side);
  return row.closed_at == null ? Infinity : (nowMs - Date.parse(row.closed_at)) / 60000;
}

export const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL DEFAULT 'long',        -- 'long' | 'short'
  qty REAL NOT NULL,
  qty_open REAL NOT NULL,
  entry_price REAL NOT NULL,
  stop_price REAL NOT NULL,
  tp1_price REAL, tp2_price REAL,
  size_usd REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  tp1_hit INTEGER NOT NULL DEFAULT 0,
  trail_active INTEGER NOT NULL DEFAULT 0,
  best_price REAL,
  realized_pnl REAL NOT NULL DEFAULT 0,
  fees_paid REAL NOT NULL DEFAULT 0,
  funding_paid REAL NOT NULL DEFAULT 0,
  last_funding_at TEXT,
  exit_price REAL, exit_reason TEXT, pnl_usd REAL, reason TEXT
);
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL, symbol TEXT NOT NULL, action TEXT NOT NULL,
  side TEXT, qty REAL NOT NULL, price REAL NOT NULL,
  value_usd REAL NOT NULL, fee_usd REAL NOT NULL DEFAULT 0,
  pnl_usd REAL, reason TEXT, position_id INTEGER
);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL, symbol TEXT NOT NULL, decision TEXT NOT NULL,
  reason TEXT NOT NULL, price REAL, data_json TEXT
);
CREATE TABLE IF NOT EXISTS equity_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL, cash REAL NOT NULL, equity REAL NOT NULL,
  open_positions INTEGER NOT NULL, deployed_usd REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL, symbol TEXT NOT NULL, data_json TEXT NOT NULL
);
`);

const columns = new Set(db.prepare("PRAGMA table_info(positions)").all().map((c) => c.name));
if (!columns.has("funding_paid")) db.exec("ALTER TABLE positions ADD COLUMN funding_paid REAL NOT NULL DEFAULT 0");
if (!columns.has("last_funding_at")) db.exec("ALTER TABLE positions ADD COLUMN last_funding_at TEXT");

function transaction(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function timestamp(nowMs) {
  if (!Number.isSafeInteger(nowMs)) throw new Error("invalid execution timestamp");
  return new Date(nowMs).toISOString();
}

const positive = (v) => Number.isFinite(v) && v > 0;
const getMeta = db.prepare("SELECT value FROM meta WHERE key=?");
const setMeta = db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");

export function getCash() {
  const r = getMeta.get("cash");
  if (r == null) { setMeta.run("cash", String(RISK.startingBalance)); return RISK.startingBalance; }
  return parseFloat(r.value);
}
export function setCash(v) { setMeta.run("cash", String(v)); }

export const openPositions = () => db.prepare("SELECT * FROM positions WHERE status='open'").all();
export const openSymbols = () => new Set(openPositions().map((p) => p.symbol + ":" + p.side));
export const openPosition = (symbol, side = "long") =>
  db.prepare("SELECT * FROM positions WHERE status='open' AND symbol=? AND side=?").get(symbol, side);
export const openPositionAnySide = (symbol) =>
  db.prepare("SELECT * FROM positions WHERE status='open' AND symbol=?").all(symbol);

export function equityNow(priceMap = {}, summaryMap = {}) {
  const cash = getCash();
  const open = openPositions();
  const markFor = (p) => {
    const s = summaryMap[p.symbol];
    return s ? (p.side === "short" ? (s.ask ?? s.last) : (s.bid ?? s.last)) : (priceMap[p.symbol] ?? p.entry_price);
  };
  const locked = open.reduce((s, p) => s + p.qty_open * p.entry_price, 0);
  const unreal = open.reduce((s, p) => s + dir(p.side) * (markFor(p) - p.entry_price) * p.qty_open, 0);
  const deployed = open.reduce((s, p) => s + p.qty_open * markFor(p), 0);
  return { cash, equity: cash + locked + unreal, deployedUsd: deployed, openCount: open.length };
}

/**
 * Open a position at the real mark price (slippage + fee applied).
 */
export function openTrade({ symbol, side = "long", qty, markPrice, stopPrice, tp1Price, tp2Price, sizeUsd, reason = "", slip = RISK.slippagePct, book, atr, nowMs = Date.now() }) {
  return transaction(() => {
    if (typeof symbol !== "string" || !symbol.trim() || !["long", "short"].includes(side)
      || !positive(qty) || !positive(markPrice) || (sizeUsd !== undefined && !positive(sizeUsd))) throw new Error("invalid open order");
    const now = timestamp(nowMs);
    const open = openPositions();
    if (open.some((p) => p.symbol === symbol)) throw new Error("duplicate open symbol");
    if (open.filter((p) => p.side === side).length >= RISK.maxSameDirection) throw new Error("same-direction position cap reached");
    if (open.length >= RISK.maxOpenPositions) throw new Error("maximum open positions reached");
    const orderSide = side === "short" ? "sell" : "buy";
    const bf = book !== undefined ? bookFill(book, orderSide, qty, markPrice, slip, nowMs) : null;
    if (bf && bf.impactPct > RISK.maxImpactPct) throw new Error("paper order rejected: order book impact exceeds limit");
    const entry = bf?.price ?? openFill(markPrice, side, slip);
    const notional = qty * entry;
    const fee = feeUsd(notional);
    const cash = getCash();
    if (!positive(notional) || !Number.isFinite(cash) || notional + fee > cash) throw new Error("insufficient cash for fill and entry fee");
    const deployed = open.reduce((sum, p) => sum + p.qty_open * p.entry_price, 0);
    const equity = cash + deployed;
    if (notional > equity * RISK.maxPositionPct + 1e-9) throw new Error("position notional cap exceeded");
    if (deployed + notional > equity * RISK.maxDeployPct + 1e-9) throw new Error("portfolio deployment cap exceeded");
    if (atr !== undefined) {
      const levels = exitLevels(entry, atr, side);
      stopPrice = levels.stop; tp1Price = levels.tp1; tp2Price = levels.tp2;
    }
    if (!positive(stopPrice) || (tp1Price != null && !positive(tp1Price)) || (tp2Price != null && !positive(tp2Price))) throw new Error("invalid exit levels");
    const info = db.prepare(`INSERT INTO positions(symbol,side,qty,qty_open,entry_price,stop_price,tp1_price,tp2_price,size_usd,status,opened_at,best_price,reason,realized_pnl,fees_paid,pnl_usd,funding_paid,last_funding_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(symbol, side, qty, qty, entry, stopPrice, tp1Price ?? null, tp2Price ?? null, notional, "open", now, entry, reason, -fee, fee, -fee, 0, now);
    const id = info.lastInsertRowid;
    db.prepare(`INSERT INTO trades(ts,symbol,action,side,qty,price,value_usd,fee_usd,pnl_usd,reason,position_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(now, symbol, side === "short" ? "SELL" : "BUY", side, qty, entry, notional, fee, -fee, reason, id);
    setCash(cash - notional - fee);
    return { id, entry, fee };
  });
}

function fundingForRow(pos, mark, nowMs) {
  if (!positive(mark)) throw new Error("invalid funding mark");
  const now = timestamp(nowMs);
  const checkpoint = Date.parse(pos.last_funding_at ?? pos.opened_at);
  if (!Number.isFinite(checkpoint)) throw new Error("invalid funding checkpoint");
  if (nowMs <= checkpoint) return 0;
  const amount = pos.side === "short" ? pos.qty_open * mark * RISK.fundingPerHourShortPct * ((nowMs - checkpoint) / 3600000) : 0;
  if (!Number.isFinite(amount) || !Number.isFinite(getCash() - amount)) throw new Error("invalid funding amount");
  setCash(getCash() - amount);
  db.prepare(`UPDATE positions SET funding_paid=funding_paid+?, realized_pnl=realized_pnl-?,
    pnl_usd=realized_pnl-?, last_funding_at=? WHERE id=?`).run(amount, amount, amount, now, pos.id);
  return amount;
}

export function accrueFunding(pos, mark, nowMs = Date.now()) {
  return transaction(() => {
    const fresh = db.prepare("SELECT * FROM positions WHERE id=?").get(pos.id);
    if (!fresh) throw new Error("position not found");
    if (fresh.status !== "open") return 0;
    return fundingForRow(fresh, mark, nowMs);
  });
}

export function closePositionQty(pos, qty, markPrice, reason = "", slip = RISK.slippagePct, book, nowMs = Date.now()) {
  const result = transaction(() => {
    const fresh = db.prepare("SELECT * FROM positions WHERE id=?").get(pos.id);
    if (!fresh || fresh.status !== "open" || !positive(fresh.qty_open)) throw new Error("position is not open");
    if (!positive(qty) || !positive(markPrice)) throw new Error("invalid close order");
    const now = timestamp(nowMs);
    if (nowMs < Date.parse(fresh.last_funding_at ?? fresh.opened_at)) throw new Error("close predates funding checkpoint");
    qty = Math.min(qty, fresh.qty_open);
    const orderSide = fresh.side === "short" ? "buy" : "sell";
    const bf = book !== undefined ? bookFill(book, orderSide, qty, markPrice, slip, nowMs) : null;
    if (bf && bf.impactPct > RISK.maxImpactPct) throw new Error("paper order rejected: order book impact exceeds limit");
    const exit = bf?.price ?? closeFill(markPrice, fresh.side, slip);
    const notional = qty * fresh.entry_price;
    const fee = feeUsd(qty * exit);
    const pnl = dir(fresh.side) * (exit - fresh.entry_price) * qty;
    if (![notional, fee, pnl].every(Number.isFinite)) throw new Error("invalid close value");
    const funding = fundingForRow(fresh, markPrice, nowMs);
    const cash = getCash() + notional + pnl - fee;
    const newRealized = fresh.realized_pnl - funding + pnl - fee;
    if (!Number.isFinite(cash) || !Number.isFinite(newRealized)) throw new Error("invalid close accounting");
    const action = reason === "stop" ? "STOP" : reason === "trail" ? "TRAIL" : reason.startsWith("take_profit") ? "TAKE_PROFIT" : fresh.side === "short" ? "COVER" : "SELL";
    db.prepare(`INSERT INTO trades(ts,symbol,action,side,qty,price,value_usd,fee_usd,pnl_usd,reason,position_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(now, fresh.symbol, action, fresh.side, qty, exit, qty * exit, fee, pnl - fee, reason, fresh.id);
    setCash(cash);
    const newQty = fresh.qty_open - qty;
    db.prepare(`UPDATE positions SET qty_open=?, realized_pnl=?, pnl_usd=?, fees_paid=fees_paid+? WHERE id=?`)
      .run(newQty, newRealized, newRealized, fee, fresh.id);
    if (newQty === 0) {
      db.prepare(`UPDATE positions SET status='closed',closed_at=?,exit_price=?,exit_reason=? WHERE id=?`)
        .run(now, exit, reason, fresh.id);
    }
    return { pnl: pnl - fee - funding, exit, closed: newQty === 0, symbol: fresh.symbol, side: fresh.side };
  });
  if (result.closed) lastClose.set(`${result.symbol}:${result.side}`, nowMs);
  return { pnl: result.pnl, exit: result.exit };
}

/** Half-Kelly position multiplier from live win rate. Returns 0..1. */
export function kellyScale() {
  if (!RISK.kellyFactor) return 1;
  const closed = db.prepare("SELECT pnl_usd FROM positions WHERE status='closed'").all();
  if (closed.length < RISK.kellyMinSamples) return 1;
  const wins = closed.filter((p) => p.pnl_usd > 0), losses = closed.filter((p) => p.pnl_usd < 0);
  const p = wins.length / closed.length;
  const avgW = wins.length ? wins.reduce((a, x) => a + x.pnl_usd, 0) / wins.length : 0;
  const avgL = losses.length ? Math.abs(losses.reduce((a, x) => a + x.pnl_usd, 0) / losses.length) : 1;
  const b = avgL > 0 ? avgW / avgL : 1;
  const k = Math.max(0, p - (1 - p) / b);            // full Kelly fraction
  return Math.min(1, 0.4 + k * RISK.kellyFactor);    // never below 40% size, capped at 1×
}

export function updatePositionState(id, { stop, tp1Hit, trailActive, bestPrice }) {
  const p = db.prepare("SELECT * FROM positions WHERE id=?").get(id);
  db.prepare(`UPDATE positions SET stop_price=?, tp1_hit=?, trail_active=?, best_price=? WHERE id=?`)
    .run(stop ?? p.stop_price, tp1Hit ?? p.tp1_hit, trailActive ?? p.trail_active, bestPrice ?? p.best_price, id);
}

export function recordDecision(symbol, decision, reason, price, data) {
  db.prepare(`INSERT INTO decisions(ts,symbol,decision,reason,price,data_json) VALUES(?,?,?,?,?,?)`)
    .run(new Date().toISOString(), symbol, decision, reason, price ?? null, data ? JSON.stringify(data) : null);
}

export function snapshotEquity(cash, equity, openCount, deployedUsd = 0) {
  db.prepare(`INSERT INTO equity_snapshots(ts,cash,equity,open_positions,deployed_usd) VALUES(?,?,?,?,?)`)
    .run(new Date().toISOString(), cash, equity, openCount, deployedUsd);
}

export function recordAnalysis(symbol, data) {
  db.prepare(`INSERT INTO analyses(ts,symbol,data_json) VALUES(?,?,?)`)
    .run(new Date().toISOString(), symbol, JSON.stringify(data));
}

export function latestAnalyses() {
  const rows = db.prepare(`SELECT a.* FROM analyses a JOIN (SELECT symbol, MAX(id) mid FROM analyses GROUP BY symbol) m ON m.mid=a.id`).all();
  const out = {};
  for (const r of rows) out[r.symbol] = { ts: r.ts, ...JSON.parse(r.data_json) };
  return out;
}

export function stats() {
  const closed = db.prepare("SELECT * FROM positions WHERE status='closed'").all();
  const wins = closed.filter((p) => (p.pnl_usd || 0) > 0);
  const losses = closed.filter((p) => (p.pnl_usd || 0) < 0);
  const totalPnl = closed.reduce((a, p) => a + (p.pnl_usd || 0), 0);
  const totalFees = db.prepare("SELECT SUM(fee_usd) f FROM trades").get().f || 0;
  const grossW = wins.reduce((a, p) => a + p.pnl_usd, 0);
  const grossL = Math.abs(losses.reduce((a, p) => a + p.pnl_usd, 0));
  const curve = db.prepare("SELECT ts,equity FROM equity_snapshots ORDER BY ts").all();
  let peak = -Infinity, maxDD = 0;
  for (const { equity } of curve) { peak = Math.max(peak, equity); if (peak > 0) maxDD = Math.max(maxDD, (peak - equity) / peak); }
  // sharpe on equity-curve returns
  const rets = [];
  for (let i = 1; i < curve.length; i++) rets.push(curve[i].equity / curve[i - 1].equity - 1);
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sd = rets.length > 1 ? Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1)) : 0;
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(96) : 0;   // annualize 15m → daily
  const expectancy = closed.length ? totalPnl / closed.length : 0;
  return {
    closedCount: closed.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
    profitFactor: grossL > 0 ? grossW / grossL : (grossW > 0 ? Infinity : 0),
    expectancy, sharpe, totalPnl, totalFees, maxDrawdownPct: maxDD * 100,
    equityPeak: peak === -Infinity ? null : peak,
    totalFills: db.prepare("SELECT COUNT(*) c FROM trades").get().c,
    closed,
  };
}
