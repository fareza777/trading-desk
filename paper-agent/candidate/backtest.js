import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { HERE, RISK, STRATEGY_VERSION, SYMBOLS } from "./config.js";
import { analyze } from "./indicators.js";
import { aggregate4h, closedCandles } from "./market.js";
import { signal, entryPause, symbolCooling } from "./strategy.js";
import { exitPlan } from "./exits.js";
import { sizePosition, exitLevels } from "./engine.js";
import { sizePosition as legacySize, exitLevels as legacyLevels } from "../engine.js";
import { LEGACY_RISK, legacyAnalyze, legacySignal } from "./legacy.js";

const HOUR = 3_600_000;
const direction = p => p.side === "short" ? -1 : 1;

export function prepareFeatures(dataset) {
  const symbols = SYMBOLS.filter(s => dataset.symbols[s]);
  if (symbols.length !== SYMBOLS.length) throw new Error("all five fixed-universe symbols are required");
  const fourHour = {}, rows = {}, index = {}, features = {};
  for (const symbol of symbols) {
    rows[symbol] = closedCandles(dataset.symbols[symbol], HOUR, dataset.to);
    if (rows[symbol].some((c, i) => i && c[0] !== rows[symbol][i - 1][0] + HOUR)) throw new Error(`${symbol}: data gaps prevent aligned replay`);
    fourHour[symbol] = aggregate4h(rows[symbol]);
    index[symbol] = new Map(rows[symbol].map((c, i) => [c[0], i]));
    features[symbol] = new Map();
  }
  const start = Math.max(...symbols.map(s => rows[s][0][0])) + 1000 * HOUR;
  const end = Math.min(...symbols.map(s => rows[s].at(-1)[0])) + HOUR;
  if (end - start < 30 * 24 * HOUR) throw new Error("need at least 30 replay days after indicator warmup");
  for (const symbol of symbols) {
    let j4 = 0;
    for (let time = start; time < end; time += HOUR) {
      const i = index[symbol].get(time);
      while (j4 < fourHour[symbol].length && fourHour[symbol][j4][0] + 4 * HOUR <= time) j4++;
      const one = rows[symbol].slice(Math.max(0, i - 1000), i);
      const four = fourHour[symbol].slice(Math.max(0, j4 - 250), j4);
      const candidate = { ...analyze(one, four, time), symbol };
      const legacy = { ...legacyAnalyze(one.slice(-168), four.slice(-84)), symbol };
      const quoteVolume = one.slice(-24).reduce((sum, c) => sum + c[4] * c[5], 0);
      features[symbol].set(time, { candidate, legacy, quoteVolume });
    }
  }
  return { symbols, rows, index, features, start, end };
}

export function metrics(closed, curve, startBalance, fees, funding) {
  const wins = closed.filter(p => p.pnl_usd > 0), losses = closed.filter(p => p.pnl_usd < 0);
  const grossWin = wins.reduce((s, p) => s + p.pnl_usd, 0);
  const grossLoss = -losses.reduce((s, p) => s + p.pnl_usd, 0);
  let peak = startBalance, maxDrawdown = 0;
  for (const point of curve) { peak = Math.max(peak, point.equity); maxDrawdown = Math.max(maxDrawdown, 1 - point.equity / peak); }
  const net = (curve.at(-1)?.equity ?? startBalance) - startBalance;
  return { closed: closed.length, wins: wins.length, winRatePct: closed.length ? 100 * wins.length / closed.length : 0,
    netPnl: net, returnPct: net / startBalance * 100, profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    expectancy: closed.length ? closed.reduce((s, p) => s + p.pnl_usd, 0) / closed.length : 0,
    avgWin: wins.length ? grossWin / wins.length : 0, avgLoss: losses.length ? grossLoss / losses.length : 0,
    maxDrawdownPct: maxDrawdown * 100, fees, funding };
}

export function replay(prepared, { legacy = false, legacySignals = false, from = prepared.start, to = prepared.end,
  frictionMultiplier = 1, strategy = null, risk: riskOverride = null, details = false } = {}) {
  if (strategy !== null && typeof strategy !== "function") throw new Error("strategy must be a function or null");
  if (strategy !== null && (legacy || legacySignals)) throw new Error("custom strategy cannot be combined with legacy or legacySignals");
  if (![prepared.start, prepared.end, from, to].every(t => Number.isFinite(t) && t % HOUR === 0 && Number.isFinite(new Date(t).getTime()))
    || from < prepared.start || to > prepared.end || from >= to) throw new Error("invalid replay window: must be nonempty, hourly aligned and inside prepared data");
  if (!Number.isFinite(frictionMultiplier) || frictionMultiplier < 0) throw new Error("invalid friction multiplier");
  if (riskOverride !== null && (typeof riskOverride !== "object" || Array.isArray(riskOverride))) throw new Error("risk override must be an object or null");
  const risk = { ...(legacy ? LEGACY_RISK : RISK), ...riskOverride };
  risk.slippagePct *= frictionMultiplier;
  risk.takerFeePct *= frictionMultiplier;
  const slip = risk.slippagePct, feeRate = risk.takerFeePct;
  if (![slip, feeRate].every(n => Number.isFinite(n) && n >= 0 && n < 1)) throw new Error("invalid effective fee or slippage");
  const featureKey = legacy || legacySignals ? "legacy" : "candidate";
  // Preserve the default signal rules; research strategies replace only signal selection.
  const decide = strategy ?? (legacy || legacySignals ? legacySignal : signal);
  if (!prepared.symbols?.length || !prepared.symbols.includes("BTC/USDT")) throw new Error("replay requires symbols and a BTC benchmark");
  for (let time = from; time < to; time += HOUR) {
    for (const symbol of prepared.symbols) {
      const i = prepared.index[symbol]?.get(time);
      if (!Number.isInteger(i) || i < 0 || prepared.rows[symbol]?.[i]?.[0] !== time
        || !prepared.features[symbol]?.get(time)?.[featureKey]) throw new Error(`${symbol}: missing prepared replay data at ${time}`);
    }
    if (!prepared.features["BTC/USDT"].get(time)?.candidate) throw new Error(`missing benchmark candidate at ${time}`);
  }
  let cash = risk.startingBalance, peak = cash, dayOpen = cash, day = null, dayHalted = false, fees = 0, funding = 0;
  const open = new Map(), closed = [], curve = [];
  const fill = (mark, side, entry) => mark * (1 + (side === "long" ? 1 : -1) * (entry ? 1 : -1) * slip);
  const account = (time, field = 1) => cash + [...open.values()].reduce((sum, p) => {
    const c = prepared.rows[p.symbol][prepared.index[p.symbol].get(time)];
    const exit = fill(c[field], p.side, false);
    return sum + p.qty_open * (p.entry_price + direction(p) * (exit - p.entry_price) - exit * feeRate);
  }, 0);
  const close = (p, fraction, mark, reason, time) => {
    if (p.side === "short") {
      const cost = p.qty_open * mark * risk.fundingPerHourShortPct * (time - p.lastFundingAt) / HOUR;
      cash -= cost; p.realized_pnl -= cost; funding += cost; p.lastFundingAt = time;
    }
    const qty = p.qty_open * fraction;
    const exit = fill(mark, p.side, false), fee = qty * exit * feeRate;
    const pnl = direction(p) * (exit - p.entry_price) * qty - fee;
    cash += qty * p.entry_price + pnl; fees += fee; p.realized_pnl += pnl; p.qty_open -= qty;
    if (p.qty_open < 1e-10) {
      p.pnl_usd = p.realized_pnl; p.closed_at = new Date(time).toISOString(); p.exit_reason = reason;
      closed.push({ ...p }); open.delete(p.symbol);
    }
  };
  const executePlan = (p, mark, time) => {
    for (const action of exitPlan(p, mark, time, risk, legacy)) {
      if (!open.has(p.symbol)) break;
      if (action.state) {
        const s = action.state;
        if (s.stop != null) p.stop_price = s.stop;
        if (s.bestPrice != null) p.best_price = s.bestPrice;
        if (s.tp1Hit != null) p.tp1_hit = s.tp1Hit;
        if (s.trailActive != null) p.trail_active = s.trailActive;
      } else close(p, action.fraction, mark, action.reason, time);
    }
  };
  for (let time = from; time < to; time += HOUR) {
    const currentDay = new Date(time).toISOString().slice(0, 10);
    if (day !== currentDay) { dayOpen = curve.at(-1)?.equity ?? risk.startingBalance; day = currentDay; dayHalted = false; }
    const benchmark = prepared.features["BTC/USDT"].get(time).candidate;
    for (const p of [...open.values()]) {
      const c = prepared.rows[p.symbol][prepared.index[p.symbol].get(time)];
      if (p.side === "short") {
        const cost = p.qty_open * c[1] * risk.fundingPerHourShortPct * (time - p.lastFundingAt) / HOUR;
        cash -= cost; p.realized_pnl -= cost; funding += cost; p.lastFundingAt = time;
      }
      executePlan(p, c[1], time);
      if (!open.has(p.symbol)) continue;
      const a = prepared.features[p.symbol].get(time)[featureKey];
      const s = decide({ ...a, side: p.side }, true, benchmark);
      if (s.decision === "SELL" || s.decision === "COVER") close(p, 1, c[1], "signal_exit", time);
    }
    const ranked = prepared.symbols.map(symbol => {
      const data = prepared.features[symbol].get(time);
      const a = data[featureKey];
      return { symbol, a, volume: data.quoteVolume, s: decide(a, false, benchmark) };
    });
    if (!legacy) ranked.sort((a, b) => b.s.score - a.s.score || a.symbol.localeCompare(b.symbol));
    for (const { symbol, a, volume, s } of ranked) {
      if (open.has(symbol) || open.size >= risk.maxOpenPositions || !["BUY", "SHORT"].includes(s.decision)) continue;
      const side = s.decision === "SHORT" ? "short" : "long";
      if (side === "short" && !risk.allowShort) continue;
      if ([...open.values()].filter(p => p.side === side).length >= risk.maxSameDirection) continue;
      const lastClosed = closed.filter(p => p.symbol === symbol && (!legacy || p.side === side)).at(-1);
      if (!legacy ? symbolCooling(lastClosed, time, risk) : lastClosed && time - Date.parse(lastClosed.closed_at) < risk.symbolCooldownMin * 60_000) continue;
      const equity = account(time);
      peak = Math.max(peak, equity);
      if (equity <= dayOpen * (1 - risk.dailyHaltPct)) dayHalted = true;
      if (legacy ? equity < peak * (1 - risk.circuitBreakPct) || equity < dayOpen * (1 - risk.dailyHaltPct) : dayHalted || entryPause(closed, equity, peak, dayOpen, time, risk)) continue;
      const c = prepared.rows[symbol][prepared.index[symbol].get(time)];
      if (!legacy && (volume < risk.minVolume24Usd || Math.abs(c[1] - a.price) > 0.5 * a.atr1h)) continue;
      const entry = fill(c[1], side, true);
      const deployedUsd = [...open.values()].reduce((sum, p) => sum + p.qty_open * p.entry_price, 0);
      // Only full legacy mode retains the original helpers' historical sizing/level defaults.
      const size = (legacy ? legacySize : sizePosition)({ equity, cash, entryPrice: c[1], atr: a.atr1h, side, deployedUsd }, risk);
      if (!size) continue;
      let multiplier = 1;
      if (legacy && closed.length >= risk.kellyMinSamples) {
        const w = closed.filter(p => p.pnl_usd > 0), l = closed.filter(p => p.pnl_usd < 0);
        const prob = w.length / closed.length;
        const avgW = w.length ? w.reduce((sum, p) => sum + p.pnl_usd, 0) / w.length : 0;
        const avgL = l.length ? -l.reduce((sum, p) => sum + p.pnl_usd, 0) / l.length : 1;
        const b = avgL > 0 ? avgW / avgL : 1;
        multiplier = Math.min(1, 0.4 + Math.max(0, prob - (1 - prob) / b) * risk.kellyFactor);
      }
      const qty = Math.min(size.qty * multiplier, cash / (entry * (1 + feeRate)));
      if (qty * entry < 25) continue;
      const fee = qty * entry * feeRate;
      const levels = (legacy ? legacyLevels : exitLevels)(legacy ? c[1] : entry, a.atr1h, side, risk);
      cash -= qty * entry + fee; fees += fee;
      open.set(symbol, { symbol, side, qty_open: qty, entry_price: entry, size_usd: qty * entry,
        stop_price: levels.stop, tp1_price: levels.tp1, tp2_price: levels.tp2,
        best_price: entry, realized_pnl: -fee, opened_at: new Date(time).toISOString(), lastFundingAt: time, tp1_hit: 0, trail_active: 0 });
    }
    for (const p of [...open.values()]) {
      const c = prepared.rows[p.symbol][prepared.index[p.symbol].get(time)];
      const adverse = p.side === "long" ? c[3] : c[2];
      const favorable = p.side === "long" ? c[2] : c[3];
      if (direction(p) * (adverse - p.stop_price) <= 0) {
        const stopFill = direction(p) * (c[1] - p.stop_price) <= 0 ? c[1] : p.stop_price;
        close(p, 1, stopFill, "stop", time + HOUR);
        continue;
      }
      if (!p.tp1_hit && direction(p) * (favorable - p.tp1_price) >= 0) {
        executePlan(p, p.tp1_price, time + HOUR);
        // With unknown tick order, allow a TP1-to-stop reversal before a later TP2 touch.
        if (open.has(p.symbol) && direction(p) * (adverse - p.stop_price) <= 0)
          close(p, 1, p.stop_price, "stop", time + HOUR);
      }
      if (!open.has(p.symbol)) continue;
      if (direction(p) * (favorable - p.tp2_price) >= 0) executePlan(p, p.tp2_price, time + HOUR);
      if (!open.has(p.symbol)) continue;
      if (p.trail_active) {
        p.best_price = p.side === "long" ? Math.max(p.best_price, favorable) : Math.min(p.best_price, favorable);
        const trailing = p.best_price * (1 - direction(p) * risk.trailDistancePct);
        p.stop_price = p.side === "long" ? Math.max(p.stop_price, trailing) : Math.min(p.stop_price, trailing);
        if (direction(p) * (adverse - p.stop_price) <= 0) close(p, 1, p.stop_price, "trail", time + HOUR);
      }
    }
    const equity = account(time, 4); peak = Math.max(peak, equity);
    if (equity <= dayOpen * (1 - risk.dailyHaltPct)) dayHalted = true;
    curve.push({ ts: time + HOUR, equity });
  }
  const finalTime = to - HOUR;
  for (const p of [...open.values()]) {
    const c = prepared.rows[p.symbol][prepared.index[p.symbol].get(finalTime)];
    close(p, 1, c[4], "end_of_window", to);
  }
  curve[curve.length - 1].equity = cash;
  const result = metrics(closed, curve, risk.startingBalance, fees, funding);
  if (Math.abs(closed.reduce((sum, p) => sum + p.pnl_usd, 0) - (cash - risk.startingBalance)) > 1e-6) throw new Error("cash/P&L reconciliation failed");
  if (details) {
    result.trades = closed.map(p => ({ ...p }));
    result.curve = curve.map(point => ({ ...point }));
    result.perSymbol = Object.fromEntries(prepared.symbols.map(symbol => [symbol, { netPnl: 0, trades: 0 }]));
    for (const p of closed) {
      result.perSymbol[p.symbol].netPnl += p.pnl_usd;
      result.perSymbol[p.symbol].trades++;
    }
  }
  return { ...result, from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

export function runComparison(dataset) {
  const prepared = prepareFeatures(dataset);
  const hours = (prepared.end - prepared.start) / HOUR;
  const folds = [];
  for (let i = 0; i < 4; i++) {
    const from = prepared.start + Math.floor(hours * i / 4) * HOUR;
    const to = prepared.start + Math.floor(hours * (i + 1) / 4) * HOUR;
    folds.push({ fold: i + 1, role: i === 3 ? "chronological_holdout" : "fixed_parameter_validation",
      legacy: replay(prepared, { legacy: true, from, to }), candidate: replay(prepared, { from, to }),
      legacySignalsCandidateRisk: replay(prepared, { legacySignals: true, from, to }),
      candidateDoubleCosts: replay(prepared, { from, to, frictionMultiplier: 2 }) });
  }
  const whole = { legacy: replay(prepared, { legacy: true }), candidate: replay(prepared),
    legacySignalsCandidateRisk: replay(prepared, { legacySignals: true }), candidateDoubleCosts: replay(prepared, { frictionMultiplier: 2 }) };
  const holdout = folds.at(-1).candidate;
  const gates = { holdoutAtLeast30Trades: holdout.closed >= 30, totalAtLeast100Trades: whole.candidate.closed >= 100,
    holdoutPositiveExpectancy: holdout.expectancy > 0, holdoutProfitFactorAbove1_2: holdout.profitFactor > 1.2,
    holdoutDrawdownBelow5Pct: holdout.maxDrawdownPct < 5, holdoutDoubleCostsPositive: folds.at(-1).candidateDoubleCosts.netPnl > 0,
    threeOfFourPositiveFolds: folds.filter(f => f.candidate.netPnl > 0).length >= 3 };
  const sha256 = value => createHash("sha256").update(value).digest("hex");
  const provenance = { datasetSha256: sha256(JSON.stringify(dataset)),
    sourceSha256: Object.fromEntries(["config.js","strategy.js","indicators.js","engine.js","exits.js","backtest.js","legacy.js","market.js"].map(name => [name, sha256(fs.readFileSync(path.join(HERE, name)))])) };
  return { strategyVersion: STRATEGY_VERSION, generatedAt: new Date().toISOString(), provenance, dataset: { exchange: dataset.exchange, from: dataset.from, to: dataset.to, symbols: prepared.symbols },
    assumptions: ["Parameters fixed before first replay; no optimization. These are chronological validation folds, not trained walk-forward models. Recent live losses informed the design, so the last fold is not a pristine unseen holdout. Correctness fixes followed the initial replay; no strategy thresholds were tuned.",
      "Legacy signals with candidate risk use the same long-only, exposure, cost, cooldown and exit policy as candidate for a less confounded comparison. Cash earns zero; reduced drawdown alone is not evidence of better signals.",
      "Signals only use fully closed 1h/4h candles; entry at next 1h open with adverse fills. Existing stop wins if stop and target touch in one hour. Remaining TP1 runners pessimistically stop on same-bar trail reversals; exact tick ordering is unknown.",
      "All trades include both entry/exit fees (0.26% per side), slippage (0.08% per side), and hourly short carry. Double-cost scenario doubles fees and slippage.",
      "Legacy signal rules and short history windows retained; replay corrects accounting and uses hourly protective stops, so it is NOT exact reproduction of the live 200-symbol/15-minute system.",
      "Fixed current five-asset universe has selection/survivorship bias; no historical order-book/spread/depth data. Quote volume estimated from trailing closed bars.",
      "Portfolio starts at $10000 per fold; positions liquidated at window end. No forward paper results yet."],
    risk: RISK, whole, folds, gates, verdict: Object.values(gates).every(Boolean) ? "HISTORICAL_GATES_PASS_FORWARD_PAPER_REQUIRED" : "NOT_READY_FOR_PROMOTION" };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const input = process.argv[2] ? path.resolve(process.argv[2]) : path.join(HERE, "history.json");
  const dataset = JSON.parse(fs.readFileSync(input, "utf8"));
  const result = runComparison(dataset);
  fs.writeFileSync(path.join(HERE, "backtest-results.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
