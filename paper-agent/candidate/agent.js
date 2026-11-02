import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { RISK, SYMBOLS, STRATEGY_VERSION } from "./config.js";
import { createExchange, fetchHistory, fetchQuote, aggregate4h, closedCandles, quoteEligible } from "./market.js";
import { analyze } from "./indicators.js";
import { signal, entryPause, symbolCooling } from "./strategy.js";
import { sizePosition, exitLevels } from "./engine.js";
import { exitPlan } from "./exits.js";

const log = message => console.log(`[${new Date().toISOString()}] ${message}`);
const history = new Map();

export function recoveryHours(cached, asOf) {
  if (!cached.length || cached.some((c, i) => i && c[0] !== cached[i - 1][0] + 3_600_000)) return 1000;
  return Math.min(1000, Math.max(12, Math.ceil((asOf - cached.at(-1)[0]) / 3_600_000) + 1));
}

export function parseMode(args) {
  if (args.some(a => !["--paper", "--check"].includes(a)) || new Set(args).size !== args.length || args.length > 1)
    throw new Error("choose exactly one of --check or --paper; default is read-only --check");
  return args.includes("--paper") ? "paper" : "check";
}

export function ensureDayOpen(L, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  const dayKey = `day_open:${day}`;
  const prior = L.db.prepare("SELECT equity FROM equity_snapshots WHERE ts<? ORDER BY id DESC LIMIT 1").get(day)?.equity;
  L.db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)").run(dayKey, String(prior ?? RISK.startingBalance));
  return Number(L.db.prepare("SELECT value FROM meta WHERE key=?").get(dayKey).value);
}

export function accountControls(L, summaries, now = Date.now()) {
  for (const pos of L.openPositions()) {
    const s = summaries[pos.symbol];
    if (!s || ![s.bid, s.ask, s.receivedAt].every(Number.isFinite) || now - s.receivedAt > RISK.maxDataAgeMs)
      throw new Error("fresh open-position valuation required");
  }
  const account = L.equityNow({}, summaries);
  const day = new Date(now).toISOString().slice(0, 10);
  const dayOpen = ensureDayOpen(L, now);
  const oldPeak = Number(L.db.prepare("SELECT value FROM meta WHERE key='risk_peak'").get()?.value ?? RISK.startingBalance);
  const peak = Math.max(oldPeak, account.equity);
  L.db.prepare("INSERT INTO meta(key,value) VALUES('risk_peak',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(peak));
  if (account.equity <= dayOpen * (1 - RISK.dailyHaltPct))
    L.db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES(?, '1')").run(`day_halt:${day}`);
  const closed = L.db.prepare("SELECT * FROM positions WHERE status='closed' ORDER BY closed_at,id").all();
  const reason = L.db.prepare("SELECT value FROM meta WHERE key=?").get(`day_halt:${day}`) ? "daily loss halt (latched)" : entryPause(closed, account.equity, peak, dayOpen, now);
  return { ...account, peak, dayOpen, closed, reason };
}

export function entryControls(L, summaries, symbol, now = Date.now()) {
  const state = accountControls(L, summaries, now);
  const last = state.closed.filter(p => p.symbol === symbol).at(-1);
  return { ...state, reason: state.reason || (symbolCooling(last, now) ? "symbol cooldown" : null) ||
    (L.openPositions().length >= RISK.maxOpenPositions ? "portfolio position cap" : null) };
}

export async function scan(exchange, asOf = Date.now()) {
  const analyses = {};
  for (const symbol of SYMBOLS) {
    try {
      const cached = history.get(symbol) || [];
      const hours = recoveryHours(cached, asOf);
      const recent = await fetchHistory(exchange, symbol, hours, asOf);
      const rows = closedCandles([...cached, ...recent], 3_600_000, asOf).slice(-1000);
      history.set(symbol, rows);
      analyses[symbol] = { ...analyze(rows, aggregate4h(rows), asOf), symbol };
    } catch (error) { analyses[symbol] = { ready: false, reason: error.message, symbol }; }
  }
  return analyses;
}

export async function runCheck(exchange) {
  const analyses = await scan(exchange);
  const results = [];
  for (const symbol of SYMBOLS) {
    const a = analyses[symbol];
    const decision = signal(a, false, analyses["BTC/USDT"]);
    let marketReason;
    try {
      const { summary, book } = await fetchQuote(exchange, symbol);
      marketReason = quoteEligible(summary, book, RISK);
    } catch (error) { marketReason = error.message; }
    results.push({ symbol, ready: a.ready, closedCandle: a.candleTs, price: a.price, adx4h: a.adx4h, rsi: a.rsi1h,
      decision: marketReason ? "HOLD" : decision.decision, reason: marketReason || decision.reason });
  }
  console.log(JSON.stringify({ version: STRATEGY_VERSION, mode: "READ_ONLY_CHECK", shorts: false, results }, null, 2));
}

async function runPaper(exchange) {
  const L = await import("./db.js");
  let monitoring = false, scanning = false, lastScanHour = null;
  const monitor = async () => {
    if (monitoring) return;
    monitoring = true;
    try {
      ensureDayOpen(L);
      const summaries = {};
      for (const previous of L.openPositions()) {
        try {
          const { summary, book } = await fetchQuote(exchange, previous.symbol);
          summaries[previous.symbol] = summary;
          if (Date.now() - book.timestamp > RISK.maxDataAgeMs || book.timestamp > Date.now() + 5000) throw new Error("stale exit book");
          const mark = previous.side === "short" ? summary.ask : summary.bid;
          if (!(mark > 0 && Number.isFinite(mark))) throw new Error("missing executable exit price");
          const pos = L.openPosition(previous.symbol, previous.side);
          if (!pos) continue;
          L.accrueFunding(pos, mark);
          for (const action of exitPlan(pos, mark, Date.now())) {
            const current = L.openPosition(previous.symbol, previous.side);
            if (!current) break;
            if (action.state) L.updatePositionState(current.id, action.state);
            else {
              const result = L.closePositionQty(current, current.qty_open * action.fraction, mark, action.reason, RISK.slippagePct, book);
              log(`${action.reason} ${pos.symbol} net-fill=${result.pnl.toFixed(2)}`);
            }
          }
        } catch (error) { log(`EXIT CHECK FAILED ${previous.symbol}: ${error.message}`); }
      }
      const account = accountControls(L, summaries);
      L.snapshotEquity(account.cash, account.equity, account.openCount, account.deployedUsd);
    } catch (error) { log(`RISK CHECK FAILED: ${error.message}`); }
    finally { monitoring = false; }
  };
  const cycle = async () => {
    const hour = Math.floor(Date.now() / 3_600_000);
    if (scanning || hour === lastScanHour) return;
    scanning = true;
    try {
      const analyses = await scan(exchange);
      const benchmark = analyses["BTC/USDT"];
      const ranked = SYMBOLS.map(symbol => ({ symbol, a: analyses[symbol], decision: signal(analyses[symbol], false, benchmark) }))
        .sort((a, b) => b.decision.score - a.decision.score || a.symbol.localeCompare(b.symbol));
      for (const { symbol, a, decision } of ranked) {
        try {
          const positions = L.openPositionAnySide(symbol);
          if (positions.length) {
            for (const pos of positions) {
              const exit = signal({ ...a, side: pos.side }, true, benchmark);
              if (!["SELL", "COVER"].includes(exit.decision)) continue;
              const { summary, book } = await fetchQuote(exchange, symbol);
              if (Date.now() - book.timestamp > RISK.maxDataAgeMs) continue;
              const mark = pos.side === "short" ? summary.ask : summary.bid;
              if (!(mark > 0 && Number.isFinite(mark))) continue;
              const current = L.openPosition(symbol, pos.side);
              if (current) L.closePositionQty(current, current.qty_open, mark, "signal_exit", RISK.slippagePct, book);
            }
            continue;
          }
          let reason = decision.reason;
          if (decision.decision === "BUY") {
            const summaries = {};
            for (const pos of L.openPositions()) {
              const { summary, book } = await fetchQuote(exchange, pos.symbol);
              if (Date.now() - book.timestamp > RISK.maxDataAgeMs || !Number.isFinite(summary.bid) || !Number.isFinite(summary.ask)) throw new Error("open-position valuation unavailable");
              summaries[pos.symbol] = summary;
            }
            const { summary, book } = await fetchQuote(exchange, symbol);
            const account = entryControls(L, summaries, symbol);
            reason = account.reason || quoteEligible(summary, book, RISK);
            if (!reason && Math.abs(summary.last - a.price) > 0.5 * a.atr1h) reason = "price moved beyond closed signal";
            if (!reason) {
              const sz = sizePosition({ equity: account.equity, cash: account.cash, entryPrice: summary.ask, atr: a.atr1h, side: "long", deployedUsd: account.deployedUsd });
              if (!sz) reason = "risk/size limit";
              else {
                const levels = exitLevels(summary.ask, a.atr1h, "long");
                L.openTrade({ symbol, side: "long", qty: sz.qty, markPrice: summary.ask, atr: a.atr1h,
                  stopPrice: levels.stop, tp1Price: levels.tp1, tp2Price: levels.tp2, sizeUsd: sz.sizeUsd,
                  reason: `${STRATEGY_VERSION}: ${decision.reason}`, slip: RISK.slippagePct, book });
                reason = "OPENED";
              }
            }
          }
          L.recordDecision(symbol, reason === "OPENED" ? "BUY" : "HOLD", reason, a.price, a);
          log(`${symbol} ${reason}`);
        } catch (error) { log(`SKIP ${symbol}: ${error.message}`); }
      }
      const summaries = {}, marks = {};
      for (const p of L.openPositions()) {
        const { summary, book } = await fetchQuote(exchange, p.symbol);
        if (Date.now() - book.timestamp > RISK.maxDataAgeMs) throw new Error("snapshot quote stale");
        summaries[p.symbol] = summary; marks[p.symbol] = summary.last;
      }
      const account = L.equityNow(marks, summaries);
      L.snapshotEquity(account.cash, account.equity, account.openCount, account.deployedUsd);
      lastScanHour = hour;
    } catch (error) { log(`CYCLE FAILED: ${error.message}`); }
    finally { scanning = false; }
  };
  log(`${STRATEGY_VERSION}: isolated paper ledger; no real orders; monitor interval ${RISK.positionPollMs}ms plus API latency`);
  await monitor();
  const timer = setInterval(() => { void monitor(); void cycle(); }, RISK.positionPollMs);
  await cycle();
  const finish = () => { clearInterval(timer); exchange.close().finally(() => process.exit(0)); };
  process.once("SIGINT", finish); process.once("SIGTERM", finish);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const paper = parseMode(process.argv.slice(2)) === "paper";
  const exchange = createExchange();
  (paper ? runPaper(exchange) : runCheck(exchange)).catch(error => { console.error(error); process.exitCode = 1; })
    .finally(() => { if (!paper) return exchange.close(); });
}
