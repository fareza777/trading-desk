import { DatabaseSync } from "node:sqlite";
import { DB_PATH, RISK, ensureDirs } from "./config.js";
import { openFill, closeFill, bookFill, feeUsd, dir } from "./engine.js";

// cooldown bookkeeping — when a symbol+side last closed
export const lastClose = new Map();   // key `${symbol}:${side}` → ms epoch
export function minutesSinceClose(symbol, side) {
  const t = lastClose.get(`${symbol}:${side}`);
  return t == null ? Infinity : (Date.now() - t) / 60000;
}

ensureDirs();
export const db = new DatabaseSync(DB_PATH);

db.exec(`
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
export function openTrade({ symbol, side = "long", qty, markPrice, stopPrice, tp1Price, tp2Price, sizeUsd, reason, slip, book }) {
  const orderSide = side === "short" ? "sell" : "buy";
  const bf = book ? bookFill(book, orderSide, qty, markPrice, slip ?? RISK.slippagePct) : null;
  if (bf?.partial) throw new Error(`paper order rejected: order book depth could not fill ${qty} units`);
  if (bf && bf.impactPct > RISK.maxImpactPct) throw new Error(`paper order rejected: estimated impact ${(bf.impactPct * 100).toFixed(3)}% > ${(RISK.maxImpactPct * 100).toFixed(2)}% limit`);
  const entry = bf?.price ?? openFill(markPrice, side, slip);
  const notional = qty * entry;
  const fee = feeUsd(notional);
  const now = new Date().toISOString();
  const info = db.prepare(`INSERT INTO positions(symbol,side,qty,qty_open,entry_price,stop_price,tp1_price,tp2_price,size_usd,status,opened_at,best_price,reason)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(symbol, side, qty, qty, entry, stopPrice, tp1Price ?? null, tp2Price ?? null, sizeUsd, "open", now, entry, reason);
  const id = info.lastInsertRowid;
  db.prepare(`INSERT INTO trades(ts,symbol,action,side,qty,price,value_usd,fee_usd,reason,position_id) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(now, symbol, side === "short" ? "SELL" : "BUY", side, qty, entry, notional, fee, reason, id);
  // cash: for BOTH sides we lock the notional as margin+fee. Short proceeds are NOT credited;
  // they sit inside the locked notional until the position closes.
  setCash(getCash() - notional - fee);
  db.prepare("UPDATE positions SET fees_paid=fees_paid+? WHERE id=?").run(fee, id);
  return { id, entry, fee };
}

/**
 * Close `qty` at mark. LONG: return proceeds(=notional)+pnl implicitly. SHORT: return locked
 * notional adjusted by (entry-exit) per unit → notional + dir*(entry-exit)*qty.
 */
export function closePositionQty(pos, qty, markPrice, reason, slip) {
  qty = Math.min(qty, pos.qty_open);
  const exit = closeFill(markPrice, pos.side, slip);
  const notional = qty * pos.entry_price;                    // locked margin portion
  const fee = feeUsd(qty * exit);
  const pnl = dir(pos.side) * (exit - pos.entry_price) * qty;
  const now = new Date().toISOString();
  const action = reason === "stop" ? "STOP" : reason === "trail" ? "TRAIL" : reason.startsWith("take_profit") ? "TAKE_PROFIT" : pos.side === "short" ? "COVER" : "SELL";
  db.prepare(`INSERT INTO trades(ts,symbol,action,side,qty,price,value_usd,fee_usd,pnl_usd,reason,position_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(now, pos.symbol, action, pos.side, qty, exit, qty * exit, fee, pnl, reason, pos.id);
  // credit back: locked notional + realized pnl − fee
  setCash(getCash() + notional + pnl - fee);
  const newQty = pos.qty_open - qty;
  const newRealized = pos.realized_pnl + pnl - fee;
  db.prepare(`UPDATE positions SET qty_open=?, realized_pnl=?, fees_paid=fees_paid+? WHERE id=?`)
    .run(Math.max(newQty, 0), newRealized, fee, pos.id);
  if (newQty <= 1e-9) {
    db.prepare(`UPDATE positions SET status='closed',closed_at=?,exit_price=?,exit_reason=?,pnl_usd=? WHERE id=?`)
      .run(now, exit, reason, newRealized, pos.id);
    lastClose.set(`${pos.symbol}:${pos.side}`, Date.now());   // start cooldown
  }
  return { pnl: pnl - fee, exit };
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
