import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { HERE, RISK, SYMBOLS } from "./config.js";
import { ema, sma, atr, rsi, adx } from "./indicators.js";
import { closedCandles, aggregate4h } from "./market.js";
import { replay, metrics } from "./backtest.js";
import { legacySignal } from "./legacy.js";

const HOUR = 3_600_000;
const FOUR = 4 * HOUR;
export const STUDY = Object.freeze({
  version: "three-hypotheses-2026-10-28-v1",
  warmupHours: 3200,
  developmentEnd: Date.UTC(2025, 0, 1),
  validationEnd: Date.UTC(2025, 8, 1),
  reservedEnd: Date.UTC(2026, 2, 1),
  previouslyExaminedFrom: 1774155600000,
  hypotheses: ["trend", "breakout", "reversion"],
  periods: { fast: 20, slow: 50, regime: 200, breakout: 55, breakoutExit: 20, bollinger: 20, rsi: 14, adx: 14 },
  reversionAdxCeiling: 20,
  reversionRsiCeiling: 45,
  reversionRewardCostMultiple: 2,
  developmentMinTrades: 40,
  validationMinTrades: 20,
  selectionMinProfitFactor: 1.1,
  reservedMinTrades: 30,
  totalMinTrades: 100,
  reservedMinProfitFactor: 1.2,
  maxDrawdownPct: 5,
  selection: "Highest validation net P&L among hypotheses passing development and validation gates; no fallback winner from reserved data.",
});
export const STUDY_RISK = Object.freeze({ ...RISK, stopLossPct: 0.03, maxStopPct: 0.08,
  atrStopMultiple: 4, trailDistancePct: 0.05, timeStopCandles: 336 });
const SOURCE_FILES = ["study.js", "config.js", "engine.js", "exits.js", "strategy.js", "indicators.js", "market.js", "backtest.js", "legacy.js"];
const INPUT = path.join(HERE, "history-3y-20261028.json");
const REGISTRATION = path.join(HERE, "study-registration.json");
const DEVELOPMENT = path.join(HERE, "study-development.json");
const RESULTS = path.join(HERE, "study-results.json");
const sha = value => createHash("sha256").update(value).digest("hex");
const iso = time => new Date(time).toISOString();
const hold = reason => ({ decision: "HOLD", score: 0, reason });

function bands(values, period) {
  const mean = sma(values, period);
  return mean.map((m, i) => {
    if (m === null) return null;
    const variance = values.slice(i - period + 1, i + 1).reduce((sum, value) => sum + (value - m) ** 2, 0) / period;
    return { mean: m, lower: m - 2 * Math.sqrt(variance) };
  });
}

export function prepareStudy(dataset) {
  if (dataset.exchange !== "okx" || dataset.timeframe !== "1h" ||
      !Number.isSafeInteger(dataset.from) || !Number.isSafeInteger(dataset.to) ||
      dataset.from % HOUR || dataset.to % HOUR || dataset.to <= dataset.from)
    throw new Error("invalid study dataset bounds or market");
  const rows = {}, index = {}, features = {};
  const start = Math.ceil((dataset.from + STUDY.warmupHours * HOUR) / FOUR) * FOUR;
  if (start >= dataset.to) throw new Error("insufficient study warmup");
  for (const symbol of SYMBOLS) {
    if (!Array.isArray(dataset.symbols[symbol])) throw new Error(`missing study symbol ${symbol}`);
    const input = dataset.symbols[symbol].filter(c => c[0] >= dataset.from && c[0] + HOUR <= dataset.to);
    const one = closedCandles(input, HOUR, dataset.to);
    if (one.length !== input.length || one.length !== (dataset.to - dataset.from) / HOUR ||
        one.some((c, i) => c[0] !== dataset.from + i * HOUR)) throw new Error(`${symbol}: missing or duplicate study candles`);
    const four = aggregate4h(one);
    const c1 = one.map(c => c[4]), c4 = four.map(c => c[4]);
    const e20 = ema(c4, STUDY.periods.fast), e50 = ema(c4, STUDY.periods.slow), e200 = ema(c4, STUDY.periods.regime);
    const e20h = ema(c1, 20), e50h = ema(c1, 50), e200h = ema(c1, 200);
    const a1 = atr(one, 14), r1 = rsi(c1, 14), r4 = rsi(c4, STUDY.periods.rsi), d4 = adx(four, STUDY.periods.adx);
    const bb = bands(c4, STUDY.periods.bollinger);
    const e12 = ema(c4, 12), e26 = ema(c4, 26);
    const macd = c4.map((_, i) => e26[i] === null ? null : e12[i] - e26[i]);
    const macdSignal = [...Array(25).fill(null), ...ema(macd.slice(25), 9)].slice(0, four.length);
    const hist = macd.map((v, i) => v === null || macdSignal[i] === null ? null : v - macdSignal[i]);
    rows[symbol] = one;
    index[symbol] = new Map(one.map((c, i) => [c[0], i]));
    features[symbol] = new Map();
    let j = -1;
    for (let time = start; time < dataset.to; time += HOUR) {
      const i = index[symbol].get(time) - 1;
      while (j + 1 < four.length && four[j + 1][0] + FOUR <= time) j++;
      const previous = four[j - 1];
      const previousHigh55 = Math.max(...four.slice(j - STUDY.periods.breakout, j).map(c => c[2]));
      const previousLow20 = Math.min(...four.slice(j - STUDY.periods.breakoutExit, j).map(c => c[3]));
      const volume24 = one.slice(i - 23, i + 1).reduce((sum, c) => sum + c[4] * c[5], 0);
      const meanVolume = one.slice(i - 20, i).reduce((sum, c) => sum + c[5], 0) / 20;
      const returns = c1.slice(i - 24, i + 1).slice(1).map((v, k) => Math.log(v / c1[i - 24 + k]));
      const meanReturn = returns.reduce((sum, v) => sum + v, 0) / returns.length;
      const analysis = {
        ready: true, symbol, candleTs: one[i][0], fourCandleTs: four[j][0], decisionTime: time,
        closed4h: four[j][0] + FOUR === time, price: c1[i], close4h: c4[j], previousClose4h: previous[4],
        ema20_4h: e20[j], ema50_4h: e50[j], ema200_4h: e200[j], previousEma20_4h: e20[j - 1], previousEma50_4h: e50[j - 1],
        previousHigh55, previousLow20, bbMean: bb[j].mean, bbLower: bb[j].lower, previousBbLower: bb[j - 1].lower,
        rsi4h: r4[j], adx4h: d4[j], atr1h: a1[i],
        trend1h: e20h[i] > e50h[i] ? "up" : "down", trend4h: e20[j] > e50[j] ? "up" : "down",
        aboveEma200: c1[i] > e200h[i], ema20_1h: e20h[i], ema50_1h: e50h[i], ema200_1h: e200h[i],
        rsi1h: r1[i], macd4hHist: hist[j], macd4hHistPrev: hist[j - 1],
        momentum1h_12h: 100 * (c1[i] / c1[i - 12] - 1), momentum4h_28h: 100 * (c4[j] / c4[j - 7] - 1),
        volatilityPct: 100 * Math.sqrt(returns.reduce((sum, v) => sum + (v - meanReturn) ** 2, 0) / (returns.length - 1)),
        volumeSpike: { ratio: meanVolume > 0 ? one[i][5] / meanVolume : 1 },
      };
      features[symbol].set(time, { candidate: analysis, quoteVolume: volume24 });
    }
  }
  return { symbols: [...SYMBOLS], rows, index, features, start, end: dataset.to };
}

export function studySignal(id, a, hasPosition = false) {
  if (!STUDY.hypotheses.includes(id)) throw new Error("unknown study hypothesis");
  if (!a?.ready || !a.closed4h) return hold("wait for a fully closed 4h candle");
  if (hasPosition) {
    const exit = id === "trend" ? a.close4h < a.ema50_4h :
      id === "breakout" ? a.close4h < a.previousLow20 : a.close4h >= a.bbMean;
    return exit ? { decision: "SELL", score: 0, reason: `${id} closed-candle exit` } : hold("keep position; protective exits remain active");
  }
  const rawStop = Math.max(STUDY_RISK.stopLossPct, STUDY_RISK.atrStopMultiple * a.atr1h / a.price);
  if (!(a.atr1h > 0) || rawStop > STUDY_RISK.maxStopPct) return hold("stop outside volatility budget");
  let enter = false, score = 0;
  if (id === "trend") {
    enter = a.close4h > a.ema200_4h && a.ema20_4h > a.ema50_4h && a.previousEma20_4h <= a.previousEma50_4h;
    score = (a.ema20_4h / a.ema50_4h - 1) * 100;
  } else if (id === "breakout") {
    enter = a.close4h > a.ema200_4h && a.close4h > a.previousHigh55;
    score = (a.close4h / a.previousHigh55 - 1) * 100;
  } else {
    const roundTripCost = 2 * (STUDY_RISK.takerFeePct + STUDY_RISK.slippagePct);
    const reward = a.bbMean / a.close4h - 1;
    enter = a.adx4h < STUDY.reversionAdxCeiling && a.rsi4h <= STUDY.reversionRsiCeiling &&
      a.previousClose4h < a.previousBbLower && a.close4h > a.bbLower &&
      reward >= STUDY.reversionRewardCostMultiple * roundTripCost;
    score = reward * 100;
  }
  return enter ? { decision: "BUY", score, reason: `${id} fixed hypothesis` } : hold(`${id} entry absent`);
}

const strategyFor = id => id === "legacy-corrected" ? legacySignal : (a, hasPosition) => studySignal(id, a, hasPosition);
export function runWindow(prepared, id, from, to, frictionMultiplier = 1) {
  return replay(prepared, { strategy: strategyFor(id), risk: STUDY_RISK, from, to, frictionMultiplier, details: true });
}
const compact = result => {
  const { curve, trades, ...summary } = result;
  return summary;
};

export function passiveBenchmark(prepared, from, to, frictionMultiplier = 1) {
  const fee = STUDY_RISK.takerFeePct * frictionMultiplier, slip = STUDY_RISK.slippagePct * frictionMultiplier;
  const initial = STUDY_RISK.startingBalance, notional = initial * STUDY_RISK.maxDeployPct / prepared.symbols.length;
  let cash = initial, fees = 0;
  const positions = prepared.symbols.map(symbol => {
    const entry = prepared.rows[symbol][prepared.index[symbol].get(from)][1] * (1 + slip);
    const qty = notional / entry, entryFee = notional * fee;
    fees += entryFee; cash -= notional + entryFee;
    return { symbol, entry, qty, entryFee };
  });
  const curve = [];
  for (let time = from; time < to; time += HOUR) {
    const equity = cash + positions.reduce((sum, p) => {
      const mark = prepared.rows[p.symbol][prepared.index[p.symbol].get(time)][4];
      return sum + p.qty * mark * (1 - slip) * (1 - fee);
    }, 0);
    curve.push({ ts: time + HOUR, equity });
  }
  const trades = positions.map(p => {
    const exit = prepared.rows[p.symbol][prepared.index[p.symbol].get(to - HOUR)][4] * (1 - slip);
    const exitFee = p.qty * exit * fee;
    fees += exitFee;
    return { symbol: p.symbol, pnl_usd: p.qty * (exit - p.entry) - p.entryFee - exitFee };
  });
  return { ...metrics(trades, curve, initial, fees, 0), from: iso(from), to: iso(to),
    description: "90% cash + initial 2% each in five spot assets, no rebalancing; allocation-matched, NOT risk-matched" };
}

export function profitFactorPass(result, minimum) {
  return result.profitFactor === null
    ? result.closed > 0 && result.wins > 0 && result.avgLoss === 0 && result.netPnl > 0
    : result.profitFactor > minimum;
}

export function chooseDevelopment(results) {
  const eligible = STUDY.hypotheses.filter(id => {
    const r = results[id];
    return r.development.closed >= STUDY.developmentMinTrades && r.validation.closed >= STUDY.validationMinTrades &&
      r.development.netPnl > 0 && r.validation.netPnl > 0 && r.validationDoubleCosts.netPnl > 0 &&
      profitFactorPass(r.development, STUDY.selectionMinProfitFactor) && profitFactorPass(r.validation, STUDY.selectionMinProfitFactor) &&
      r.development.maxDrawdownPct < STUDY.maxDrawdownPct && r.validation.maxDrawdownPct < STUDY.maxDrawdownPct;
  });
  eligible.sort((a, b) => results[b].validation.netPnl - results[a].validation.netPnl || a.localeCompare(b));
  return eligible[0] ?? null;
}

export function developmentRun(prepared) {
  if (prepared.start >= STUDY.developmentEnd || prepared.end < STUDY.validationEnd) throw new Error("study development dates unavailable");
  const results = {};
  for (const id of [...STUDY.hypotheses, "legacy-corrected"]) {
    results[id] = {
      development: compact(runWindow(prepared, id, prepared.start, STUDY.developmentEnd)),
      validation: compact(runWindow(prepared, id, STUDY.developmentEnd, STUDY.validationEnd)),
      validationDoubleCosts: compact(runWindow(prepared, id, STUDY.developmentEnd, STUDY.validationEnd, 2)),
    };
  }
  return { results, selected: chooseDevelopment(results), selectionRule: STUDY.selection };
}

export function evaluationRun(prepared, development) {
  if (prepared.end <= STUDY.reservedEnd) throw new Error("study reserved dates unavailable");
  if (development.selected !== chooseDevelopment(development.results)) throw new Error("development selection changed");
  const results = {};
  const foldHours = (STUDY.reservedEnd - STUDY.validationEnd) / HOUR;
  for (const id of [...STUDY.hypotheses, "legacy-corrected"]) {
    results[id] = {
      reserved: runWindow(prepared, id, STUDY.validationEnd, STUDY.reservedEnd),
      reservedDoubleCosts: compact(runWindow(prepared, id, STUDY.validationEnd, STUDY.reservedEnd, 2)),
      reservedFolds: Array.from({ length: 3 }, (_, i) => compact(runWindow(prepared, id,
        STUDY.validationEnd + Math.floor(foldHours * i / 3) * HOUR,
        STUDY.validationEnd + Math.floor(foldHours * (i + 1) / 3) * HOUR))),
      recentDiagnostic: compact(runWindow(prepared, id, STUDY.reservedEnd, prepared.end)),
      recentDoubleCosts: compact(runWindow(prepared, id, STUDY.reservedEnd, prepared.end, 2)),
    };
  }
  const selected = development.selected;
  let gates = { developmentSelectedCandidate: selected !== null };
  if (selected) {
    const r = results[selected], d = development.results[selected];
    gates = { ...gates, reservedAtLeast30Trades: r.reserved.closed >= STUDY.reservedMinTrades,
      totalAtLeast100Trades: d.development.closed + d.validation.closed + r.reserved.closed >= STUDY.totalMinTrades,
      reservedPositiveExpectancy: r.reserved.expectancy > 0,
      reservedProfitFactorAbove1_2: profitFactorPass(r.reserved, STUDY.reservedMinProfitFactor),
      reservedDrawdownBelow5Pct: r.reserved.maxDrawdownPct < STUDY.maxDrawdownPct,
      reservedDoubleCostsPositive: r.reservedDoubleCosts.netPnl > 0,
      twoOfThreeReservedFoldsPositive: r.reservedFolds.filter(f => f.netPnl > 0).length >= 2,
      recentDiagnosticPositive: r.recentDiagnostic.netPnl > 0,
      recentDoubleCostsPositive: r.recentDoubleCosts.netPnl > 0 };
  }
  const verdict = Object.values(gates).every(Boolean) ? "HISTORICAL_SCREEN_PASS_FORWARD_PAPER_REQUIRED" : "NO_CANDIDATE_FOR_PROMOTION";
  return { selectedBeforeReservedTest: selected, results, gates, verdict,
    benchmarks: { cashReturnPct: 0, reservedPassive: passiveBenchmark(prepared, STUDY.validationEnd, STUDY.reservedEnd),
      recentPassive: passiveBenchmark(prepared, STUDY.reservedEnd, prepared.end) } };
}

function provenance() {
  return { datasetSha256: sha(fs.readFileSync(INPUT)),
    sourceSha256: Object.fromEntries(SOURCE_FILES.map(name => [name, sha(fs.readFileSync(path.join(HERE, name)))])),
    legacySourceSha256: Object.fromEntries(["../config.js", "../engine.js", "../indicators.js"].map(name => [name, sha(fs.readFileSync(path.join(HERE, name)))])) };
}
const exclusiveJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
function assertRegistered() {
  const registration = JSON.parse(fs.readFileSync(REGISTRATION, "utf8"));
  if (JSON.stringify(registration.provenance) !== JSON.stringify(provenance())) throw new Error("registered source or dataset changed; do not silently rerun/tune this experiment");
  return registration;
}
const assumptions = [
  "Three fixed hypotheses; no grid search and no thresholds tuned after replay. Selection uses development/validation only, before reserved testing. Rejected hypotheses remain reported.",
  "Reserved historical window is 2025-09-01 through 2026-03-01, ending before the dataset previously inspected in this session. This is retrospective research, not prospective or guaranteed unseen market knowledge.",
  "Data from 2026-03 onward is a previously-informed recent diagnostic, never called pristine holdout. No forward-paper results yet.",
  "Signals use closed UTC 4h candles; risk exits checked hourly. Stop is max(3%, 4 x closed 1h ATR), capped at 8%; oversized raw stops reject entries. Shared 0.25% risk, 5% position/10% deployment limits, TP1 1.5R half/TP2 3R, 5% trail, 14-day weak-position time stop.",
  "Both sides charged 0.26% fees and 0.08% adverse slippage; double-cost scenario doubles both. These are conservative assumptions, not the verified account fee tier. Spot long-only, no leverage, no short carry.",
  "Same-hour existing stop takes priority over targets; same-hour trailing reversals are pessimistic. Hourly OHLC cannot resolve ticks; no historical books, spreads, or intrahour drawdown observations.",
  "Five current assets have selection/survivorship bias; USD volume approximated by closed-bar close times base volume. Portfolio cash earns zero.",
  "Legacy-corrected baseline uses the old score with corrected, full-warmup indicators and exactly the study risk/exits; it is NOT the original live 200-symbol/15-minute system.",
  "Each window/fold starts from $10000 and liquidates at the end; folds cannot be summed as one continuous portfolio. Passive comparator has the same initial 10% allocation, not the same risk or time-varying exposure.",
  "Promotion is never automatic. Passing historical gates only qualifies a hypothesis for isolated forward-paper validation."
];

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !["--register", "--develop", "--evaluate"].includes(args[0]))
    throw new Error("Usage: node study.js --register | --develop | --evaluate");
  if (args[0] === "--register") {
    exclusiveJson(REGISTRATION, { registeredAt: iso(Date.now()), specification: STUDY, risk: STUDY_RISK, provenance: provenance(), assumptions });
    console.log(JSON.stringify({ registered: REGISTRATION, version: STUDY.version }));
    return;
  }
  const registration = assertRegistered();
  const dataset = JSON.parse(fs.readFileSync(INPUT, "utf8"));
  if (args[0] === "--develop") {
    if (fs.existsSync(DEVELOPMENT)) throw new Error("development results already exist");
    const prepared = prepareStudy({ ...dataset, to: STUDY.validationEnd });
    const result = { generatedAt: iso(Date.now()), registrationSha256: sha(fs.readFileSync(REGISTRATION)), ...developmentRun(prepared) };
    exclusiveJson(DEVELOPMENT, result);
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (fs.existsSync(RESULTS)) throw new Error("reserved test results already exist");
    const development = JSON.parse(fs.readFileSync(DEVELOPMENT, "utf8"));
    if (development.registrationSha256 !== sha(fs.readFileSync(REGISTRATION))) throw new Error("development registration mismatch");
    const result = { generatedAt: iso(Date.now()), registration, developmentSha256: sha(fs.readFileSync(DEVELOPMENT)),
      ...evaluationRun(prepareStudy(dataset), development) };
    exclusiveJson(RESULTS, result);
    console.log(JSON.stringify({ selected: result.selectedBeforeReservedTest, gates: result.gates, verdict: result.verdict,
      results: Object.fromEntries(Object.entries(result.results).map(([id, r]) => [id, { reserved: compact(r.reserved),
        reservedDoubleCosts: r.reservedDoubleCosts, recentDiagnostic: r.recentDiagnostic, recentDoubleCosts: r.recentDoubleCosts }])), benchmarks: result.benchmarks }, null, 2));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
