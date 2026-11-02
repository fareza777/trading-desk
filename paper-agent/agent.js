/**
 * Crypto paper-trading agent — REAL execution model.
 * Long & short, risk-based sizing, ATR stops, partial TP1→BE+trail, TP2,
 * time-stop, fees + dynamic slippage, daily halt, cooldown, kelly, funding.
 * Data: ccxt + dexpaprika MCP (read-only). No real orders ever.
 */
import { loadWatchlist, RISK, ensureDirs, LOG_DIR } from "./config.js";
import { connectAll } from "./mcp.js";
import { analyze } from "./indicators.js";
import { fetchCandles, fetchSummary, fetchLiquidity, fetchOrderBook, executableMark, dataFresh } from "./fetchers.js";
import { sizePosition, exitLevels, dir, slipFrac } from "./engine.js";
import { kellyScale, minutesSinceClose } from "./db.js";
import * as L from "./db.js";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

ensureDirs();
const log = (...a) => {
  const line = `[${new Date().toISOString()}] ${a.join(" ")}`;
  console.log(line);
  fs.appendFileSync(path.join(LOG_DIR, "agent.log"), line + "\n");
};

// ---------- signal ----------
function signal(a, hasPos) {
  const r = [];
  let score = 0;
  const tUp = a.trend1h === "up" && a.trend4h === "up";
  const tDn = a.trend1h === "down" && a.trend4h === "down";
  if (tUp) { score += 3; r.push("1h+4h uptrend"); }
  else if (a.trend4h === "up") { score += 1; r.push("4h up"); }
  else if (tDn) { score -= 3; r.push("1h+4h downtrend"); }
  else if (a.trend4h === "down") { score -= 1; r.push("4h down"); }
  if (a.aboveEma200 === true) { score += 1; r.push(">EMA200"); }
  if (a.aboveEma200 === false && a.trend4h === "down") { score -= 1; r.push("<EMA200"); }
  if (a.macd4hHist > 0 && a.macd4hHist > a.macd4hHistPrev) { score += 1; r.push("MACD↑"); }
  if (a.macd4hHist < 0 && a.macd4hHist < a.macd4hHistPrev) { score -= 1; r.push("MACD↓"); }
  if (a.rsi1h != null) {
    if (a.rsi1h < 30 && a.trend4h === "up") { score += 1; r.push("RSI pullback"); }
    if (a.rsi1h > RISK.rsiEntryMax) { score -= 1; r.push(`RSI ${a.rsi1h.toFixed(0)} hot`); }
    if (a.rsi1h > 70 && tDn) { score -= 1; r.push("overbought in dn"); }
  }
  if (a.volumeSpike.ratio > 2 && a.momentum1h_12h > 0) { score += 1; r.push(`vol×${a.volumeSpike.ratio.toFixed(1)}`); }
  if (a.volatilityPct > 3) { score -= 1; r.push(`vol ${a.volatilityPct.toFixed(1)}% hi`); }
  if (a.momentum4h_28h > 2) { score += 1; r.push(`mom4h +${a.momentum4h_28h.toFixed(1)}%`); }
  if (a.momentum4h_28h < -2) { score -= 1; r.push(`mom4h ${a.momentum4h_28h.toFixed(1)}%`); }

  let decision = "HOLD";
  if (hasPos) {
    if (score <= -2 && a.side === "long") decision = "SELL";
    else if (score >= 2 && a.side === "short") decision = "COVER";
    if (decision !== "HOLD") r.unshift("exit signal");
  } else {
    if (score >= 4 && a.volatilityPct <= 3 && a.rsi1h < RISK.rsiEntryMax) decision = "BUY";
    else if (RISK.allowShort && score <= -4 && a.volatilityPct <= 3.5 && a.rsi1h > 30) decision = "SHORT";
  }
  return { decision, score, reason: r.join("; ") || "no edge" };
}

// ---------- exits ----------
function managePositions(priceMap, analyses, summaryMap) {
  const acts = [];
  for (const pos of L.openPositions()) {
    const summary = summaryMap[pos.symbol] || {};
    const mark = executableMark(summary, pos.side) ?? priceMap[pos.symbol];
    if (mark == null) continue;
    const d = dir(pos.side);
    const slip = slipFrac(summaryMap[pos.symbol]);
    const hoursOpen = (Date.now() - new Date(pos.opened_at)) / 3_600_000;

    if (pos.side === "short" && RISK.fundingPerHourShortPct > 0)
      L.setCash(L.getCash() - pos.qty_open * mark * RISK.fundingPerHourShortPct * 0.25);

    const best = pos.best_price == null ? mark : (d === 1 ? Math.max(pos.best_price, mark) : Math.min(pos.best_price, mark));
    if (best !== pos.best_price) L.updatePositionState(pos.id, { bestPrice: best });

    if ((d === 1 ? mark <= pos.stop_price : mark >= pos.stop_price)) {
      const { pnl, exit } = L.closePositionQty(pos, pos.qty_open, mark, "stop", slip);
      acts.push(`STOP ${pos.side} ${pos.symbol} @${exit.toFixed(4)} ${pnl.toFixed(2)}`); continue;
    }
    if (!pos.tp1_hit && pos.tp1_price != null && (d === 1 ? mark >= pos.tp1_price : mark <= pos.tp1_price)) {
      const closeQty = pos.qty_open * RISK.tp1ClosePct;
      const { pnl, exit } = L.closePositionQty(pos, closeQty, mark, "take_profit_1", slip);
      const be = pos.entry_price * (1 + d * 0.005);
      L.updatePositionState(pos.id, { tp1Hit: 1, stop: be, trailActive: 1 });
      acts.push(`TP1 ${pos.symbol} @${exit.toFixed(4)} +${pnl.toFixed(2)} → BE+trail`);
      pos.tp1_hit = 1; pos.trail_active = 1; pos.stop_price = be; pos.qty_open -= closeQty;
      if (pos.qty_open <= 1e-9) continue;
    }
    if (pos.tp2_price != null && (d === 1 ? mark >= pos.tp2_price : mark <= pos.tp2_price)) {
      const { pnl, exit } = L.closePositionQty(pos, pos.qty_open, mark, "take_profit_2", slip);
      acts.push(`TP2 ${pos.symbol} @${exit.toFixed(4)} +${pnl.toFixed(2)}`); continue;
    }
    if (pos.trail_active) {
      const ts = d === 1 ? best * (1 - RISK.trailDistancePct) : best * (1 + RISK.trailDistancePct);
      const tighter = d === 1 ? Math.max(pos.stop_price, ts) : Math.min(pos.stop_price, ts);
      if (tighter !== pos.stop_price) L.updatePositionState(pos.id, { stop: tighter });
      if ((d === 1 ? mark <= tighter : mark >= tighter)) {
        const { pnl, exit } = L.closePositionQty(pos, pos.qty_open, mark, "trail", slip);
        acts.push(`TRAIL ${pos.symbol} @${exit.toFixed(4)} +${pnl.toFixed(2)}`); continue;
      }
    }
    if (hoursOpen > RISK.timeStopCandles) {
      const unreal = d * (mark - pos.entry_price) * pos.qty_open;
      if (unreal / pos.size_usd < 0.01) {
        const { pnl, exit } = L.closePositionQty(pos, pos.qty_open, mark, "time_stop", slip);
        acts.push(`TIME-STOP ${pos.symbol} @${exit.toFixed(4)} ${pnl.toFixed(2)}`); continue;
      }
    }
  }
  return acts;
}

// ---------- entries ----------
function tryEnter(asset, a, side, equity, deployedUsd) {
  const cash = L.getCash();
  if (L.openPositions().length >= RISK.maxOpenPositions) return { ok: false, reason: `max ${RISK.maxOpenPositions} positions` };
  if (L.openPositions().filter((p) => p.side === side).length >= RISK.maxSameDirection)
    return { ok: false, reason: `max ${RISK.maxSameDirection} ${side}s (corr guard)` };
  const cdMin = minutesSinceClose(asset.symbol, side);
  if (cdMin < RISK.symbolCooldownMin) return { ok: false, reason: `cooldown ${RISK.symbolCooldownMin}m` };
  const liq = a.liquidity?.liquidityUsd ?? null;
  if (liq != null && liq < RISK.minLiquidityUsd) return { ok: false, reason: `liq ${(liq / 1e6).toFixed(1)}M<${RISK.minLiquidityUsd / 1e6}M` };
  const vol24 = a.liquidity?.vol24 ?? null;
  if (vol24 != null && vol24 < RISK.minVolume24Usd) return { ok: false, reason: `vol24<${RISK.minVolume24Usd / 1e6}M` };
  if (a.summary?.bid && a.summary?.ask && (a.summary.ask - a.summary.bid) / a.summary.bid > RISK.maxSpreadPct)
    return { ok: false, reason: "spread too wide" };
  const peak = Math.max(equity, L.db.prepare("SELECT MAX(equity) p FROM equity_snapshots").get().p || 0);
  if (peak > 0 && equity < peak * (1 - RISK.circuitBreakPct)) return { ok: false, reason: "circuit breaker" };

  const slip = slipFrac(a.summary);
  let sz = sizePosition({ equity, cash, entryPrice: a.price, atr: a.atr1h, side, deployedUsd });
  if (!sz) return { ok: false, reason: "size < min ticket" };
  const k = kellyScale();
  sz = { ...sz, sizeUsd: sz.sizeUsd * k, qty: (sz.sizeUsd * k) / a.price };
  if (sz.sizeUsd < 25) return { ok: false, reason: `size<min (kelly ${k.toFixed(2)})` };

  const lv = exitLevels(a.price, a.atr1h, side);
  const reason = `${side.toUpperCase()} ${asset.symbol}: ${a.trend1h}/${a.trend4h} ${a.regime}, RSI ${a.rsi1h?.toFixed(0)}, ATR ${a.atrPct?.toFixed(2)}%`;
  const { entry, fee } = L.openTrade({
    symbol: asset.symbol, side, qty: sz.qty, markPrice: a.price,
    stopPrice: lv.stop, tp1Price: lv.tp1, tp2Price: lv.tp2, sizeUsd: sz.sizeUsd, reason, slip, book: a.book,
  });
  return { ok: true, reason: `${reason} | entry ${entry.toFixed(4)} slip ${(slip * 100).toFixed(2)}% SL ${lv.stop.toFixed(4)} TP1 ${lv.tp1.toFixed(4)} fee $${fee.toFixed(2)}` };
}

// ---------- auto symbol discovery (top N by 24h quote volume) ----------
const SKIP_BASES = new Set(["USDT","USDC","BUSD","FDUSD","TUSD","EUR","GBP","TRY","BRL","ARS","DAI","USD","UST","USDP","BFUSD","USD1","PEPE2"]);
async function refreshAutoSymbols(wl) {
  const ex = wl.exchange || "binance";
  const quote = wl.autoDiscover?.quote || "USDT";
  const topN = wl.autoDiscover?.topN ?? 200;
  const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "auto-symbols.json");
  let symbols = [];
  // fetch all tickers via ccxt MCP and rank by 24h quote volume
  const clients = await connectAll();
  const txt = await clients.ccxt.callTool("get-tickers", { exchange: ex, quote });
  let arr = [];
  try { const j = JSON.parse(txt); arr = Array.isArray(j) ? j : Object.values(j); } catch {}
  symbols = arr
    .filter((t) => (t.symbol || "").endsWith(`/${quote}`))
    .map((t) => ({ s: t.symbol, b: (t.symbol || "").split("/")[0], qv: t.quoteVolume ?? ((t.baseVolume || 0) * (t.last || 0)) }))
    .filter((t) => /^[A-Z0-9]+$/.test(t.b) && !SKIP_BASES.has(t.b))
    .sort((a, b) => b.qv - a.qv).slice(0, topN).map((t) => t.s);
  if (!symbols.length) throw new Error("no symbols discovered");
  fs.writeFileSync(out, JSON.stringify({ ts: new Date().toISOString(), exchange: ex, symbols }, null, 1));
  log(`auto-discover: wrote ${symbols.length} symbols → auto-symbols.json`);
  return symbols;
}

// ---------- cycle ----------
let batchCursor = 0;
export async function runCycle(clients, wl, batchOnly = null) {
  const ex = wl.exchange || "kraken";
  const batchSize = wl.scanBatchSize || wl.assets.length;
  const batch = batchOnly ?? wl.assets.slice(batchCursor, batchCursor + batchSize);
  if (!batchOnly) batchCursor = (batchCursor + batchSize) % Math.max(wl.assets.length, 1);
  log(`— cycle @ ${new Date().toISOString()} (${ex}) batch ${batch.length}/${wl.assets.length} —`);
  const priceMap = {}, analyses = {}, summaryMap = {};
  for (const asset of wl.assets) {
    try {
      const [c1h, c4h, summary, book] = await Promise.all([
        fetchCandles(clients.ccxt, asset.symbol, "1h", 7, ex),
        fetchCandles(clients.ccxt, asset.symbol, "4h", 14, ex),
        fetchSummary(clients.ccxt, asset.symbol, ex),
        fetchOrderBook(clients.ccxt, asset.symbol, ex, RISK.orderBookLevels),
      ]);
      const liq = asset.dexTokenAddress ? await fetchLiquidity(clients.dexpaprika, asset) : { liquidityUsd: null, vol24: null };
      if (!dataFresh(summary, RISK.maxDataAgeMs)) { L.recordDecision(asset.symbol, "SKIP", "stale ticker data", summary.last, null); continue; }
      if (c1h.length < 60 || c4h.length < 60) { L.recordDecision(asset.symbol, "SKIP", "insufficient candles", null, null); continue; }
      const a = analyze(c1h, c4h);
      a.summary = summary; a.liquidity = liq; a.book = book;
      analyses[asset.symbol] = a; summaryMap[asset.symbol] = summary;
      priceMap[asset.symbol] = summary.last ?? a.price;
      L.recordAnalysis(asset.symbol, {
        price: a.price, trend1h: a.trend1h, trend4h: a.trend4h, regime: a.regime, rsi1h: a.rsi1h,
        atrPct: a.atrPct, momentum1h_12h: a.momentum1h_12h, momentum4h_28h: a.momentum4h_28h,
        volatilityPct: a.volatilityPct, volumeSpike: a.volumeSpike, liquidityUsd: liq.liquidityUsd ?? null,
        vol24: summary.vol24 ?? null, high24: summary.high ?? null, low24: summary.low ?? null,
        bid: summary.bid, ask: summary.ask,
      });
      log(`${asset.symbol}: ${a.trend1h}/${a.trend4h} ${a.regime} RSI=${a.rsi1h?.toFixed(0)} ATR=${a.atrPct?.toFixed(2)}%`);
    } catch (e) {
      log(`${asset.symbol}: fetch err ${e.message.slice(0, 120)}`);
      L.recordDecision(asset.symbol, "SKIP", `err ${e.message.slice(0, 150)}`, null, null);
    }
  }

  for (const m of managePositions(priceMap, analyses, summaryMap)) log(m);

  const dayStart = new Date().toISOString().slice(0, 10);
  const dayOpen = L.db.prepare("SELECT equity FROM equity_snapshots WHERE ts>=? ORDER BY ts LIMIT 1").get(dayStart + "T00:00:00")?.equity;
  const { equity, deployedUsd } = L.equityNow(priceMap, summaryMap);
  const dailyHalted = dayOpen && equity < dayOpen * (1 - RISK.dailyHaltPct);
  if (dailyHalted) log(`DAILY HALT equity ${equity.toFixed(0)}`);

  for (const asset of batch) {
    const a = analyses[asset.symbol];
    if (!a) continue;
    const openList = L.openPositionAnySide(asset.symbol);
    const has = openList.length > 0;
    a.side = has ? openList[0].side : null;
    const { decision, reason } = signal(a, has);
    const slip = slipFrac(summaryMap[asset.symbol]);
    if (decision === "BUY" && !has && !dailyHalted) {
      const r = tryEnter(asset, a, "long", equity, deployedUsd);
      L.recordDecision(asset.symbol, r.ok ? "BUY" : "HOLD", r.ok ? r.reason : `${reason} | ${r.reason}`, a.price, a);
      if (r.ok) log(r.reason);
    } else if (decision === "SHORT" && !has && !dailyHalted) {
      const r = tryEnter(asset, a, "short", equity, deployedUsd);
      L.recordDecision(asset.symbol, r.ok ? "SHORT" : "HOLD", r.ok ? r.reason : `${reason} | ${r.reason}`, a.price, a);
      if (r.ok) log(r.reason);
    } else if ((decision === "SELL" || decision === "COVER") && has) {
      for (const pos of openList) {
        if ((decision === "SELL" && pos.side === "long") || (decision === "COVER" && pos.side === "short")) {
          const { pnl, exit } = L.closePositionQty(pos, pos.qty_open, a.price, "signal_exit", slip);
          L.recordDecision(asset.symbol, pos.side === "long" ? "SELL" : "COVER", `${reason} | P&L ${pnl.toFixed(2)}`, a.price, a);
          log(`${pos.side === "long" ? "SELL" : "COVER"} ${pos.symbol} @${exit.toFixed(4)} P&L ${pnl.toFixed(2)}`);
        }
      }
    } else {
      L.recordDecision(asset.symbol, has ? `HOLD(${openList[0].side})` : "HOLD", reason, a.price, a);
    }
  }
  const snap = L.equityNow(priceMap, summaryMap);
  L.snapshotEquity(snap.cash, snap.equity, snap.openCount, snap.deployedUsd);
  log(`equity=${snap.equity.toFixed(2)} cash=${snap.cash.toFixed(2)} open=${snap.openCount}${dailyHalted ? " HALTED" : ""}`);
}

async function main() {
  let wl = loadWatchlist();
  // refresh auto-discovered symbol list on startup if enabled
  if (wl.autoDiscover?.enabled) {
    try {
      log(`auto-discover: top ${wl.autoDiscover.topN} symbols on ${wl.exchange}…`);
      await refreshAutoSymbols(wl);
      wl = loadWatchlist();   // reload so merged auto symbols are included
    } catch (e) { log("auto-discover failed:", e.message.slice(0, 120)); }
  }
  const intervalMs = (wl.loopIntervalMinutes || 15) * 60_000;
  const onceOnly = process.argv.includes("--once");
  log("connecting MCP…");
  const clients = await connectAll();
  log(onceOnly ? `single cycle (batch of ${wl.scanBatchSize || wl.assets.length} / ${wl.assets.length} assets)` : `loop every ${intervalMs / 60000} min, batch ${wl.scanBatchSize || wl.assets.length}/${wl.assets.length} assets`);
  const tick = async () => {
    try { await runCycle(clients, wl); } catch (e) { log("cycle err:", e.message); }
    execFile(process.execPath, [fileURLToPath(new URL("./report.js", import.meta.url))], () => {});
    if (!onceOnly) setTimeout(tick, intervalMs); else process.exit(0);
  };
  await tick();
}
if (process.argv[1] && process.argv[1].endsWith("agent.js")) main().catch((e) => { log("fatal:", e.message); process.exit(1); });
