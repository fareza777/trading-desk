import test from "node:test";
import assert from "node:assert/strict";
import { STUDY, STUDY_RISK, prepareStudy, studySignal, chooseDevelopment, profitFactorPass, passiveBenchmark, runWindow } from "./study.js";
import { SYMBOLS } from "./config.js";
import { ema, atr, adx, rsi } from "./indicators.js";
import { aggregate4h } from "./market.js";

const HOUR = 3_600_000;
const rows = Array.from({ length: 3456 }, (_, i) => {
  const price = 100 * Math.exp(i * 0.00004) * (1 + 0.03 * Math.sin(i / 27));
  return [i * HOUR, price, price * 1.007, price * 0.993, price, 100_000];
});
const dataset = { exchange: "okx", timeframe: "1h", from: 0, to: rows.length * HOUR,
  symbols: Object.fromEntries(SYMBOLS.map(s => [s, rows])) };
const qualified = { ready: true, closed4h: true, price: 100, close4h: 100, atr1h: 1,
  ema200_4h: 90, ema20_4h: 97, ema50_4h: 96, previousEma20_4h: 95, previousEma50_4h: 96,
  previousHigh55: 99, previousLow20: 90, previousClose4h: 96, previousBbLower: 97,
  bbLower: 99, bbMean: 104, adx4h: 18, rsi4h: 40 };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

for (const id of STUDY.hypotheses) {
  test(`${id}: closed-candle golden path and no intrabar entry`, () => {
    assert.equal(studySignal(id, qualified).decision, "BUY");
    assert.equal(studySignal(id, { ...qualified, closed4h: false }).decision, "HOLD");
    assert.equal(studySignal(id, { ...qualified, ready: false }).decision, "HOLD");
    assert.equal(studySignal(id, { ...qualified, atr1h: 5 }).decision, "HOLD");
    assert.equal(studySignal(id, { ...qualified, atr1h: 0 }).decision, "HOLD");
  });
}
test("trend requires a new crossover, not repeatedly buying an old trend", () => {
  assert.equal(studySignal("trend", { ...qualified, previousEma20_4h: 97 }).decision, "HOLD");
  assert.equal(studySignal("trend", { ...qualified, ema200_4h: 101 }).decision, "HOLD");
});
test("breakout must clear the preceding channel, not touch it", () => {
  assert.equal(studySignal("breakout", { ...qualified, previousHigh55: 100 }).decision, "HOLD");
  assert.equal(studySignal("breakout", { ...qualified, ema200_4h: 101 }).decision, "HOLD");
});
test("reversion waits for recovery, range conditions, and a move larger than fees", () => {
  for (const override of [{ previousClose4h: 98 }, { bbLower: 101 }, { adx4h: 25 }, { rsi4h: 50 }, { bbMean: 101 }])
    assert.equal(studySignal("reversion", { ...qualified, ...override }).decision, "HOLD");
});
test("signal exits remain independent of entry and volatility filters", () => {
  assert.equal(studySignal("trend", { ...qualified, close4h: 94, atr1h: 999 }, true).decision, "SELL");
  assert.equal(studySignal("breakout", { ...qualified, close4h: 89, atr1h: 999 }, true).decision, "SELL");
  assert.equal(studySignal("reversion", { ...qualified, close4h: 105, atr1h: 999 }, true).decision, "SELL");
  assert.throws(() => studySignal("unknown", qualified), /unknown/);
});
test("prepared features match independently calculated closed indicators and prior channel", () => {
  const prepared = prepareStudy(dataset), t = prepared.start;
  const a = prepared.features[SYMBOLS[0]].get(t).candidate;
  const past = rows.filter(c => c[0] + HOUR <= t), four = aggregate4h(past), values = four.map(c => c[4]);
  assert.ok(a.closed4h);
  assert.equal(a.fourCandleTs + 4 * HOUR, t);
  near(a.ema200_4h, ema(values, 200).at(-1));
  near(a.atr1h, atr(past, 14).at(-1));
  near(a.adx4h, adx(four, 14).at(-1));
  near(a.rsi4h, rsi(values, 14).at(-1));
  near(a.previousHigh55, Math.max(...four.slice(-56, -1).map(c => c[2])));
  near(a.previousLow20, Math.min(...four.slice(-21, -1).map(c => c[3])));
  near(prepared.features[SYMBOLS[0]].get(t).quoteVolume, past.slice(-24).reduce((s, c) => s + c[4] * c[5], 0));
  assert.equal(prepared.features[SYMBOLS[0]].get(t + HOUR).candidate.closed4h, false);
});
test("changing every future OHLCV row cannot affect earlier features or decisions", () => {
  const before = prepareStudy(dataset), cutoff = before.start + 28 * HOUR;
  const mutated = { ...dataset, symbols: Object.fromEntries(SYMBOLS.map(s => [s, rows.map(c =>
    c[0] >= cutoff ? [c[0], c[1] * 10, c[2] * 10, c[3] * 10, c[4] * 10, c[5] * 7] : c)])) };
  const after = prepareStudy(mutated);
  for (const symbol of SYMBOLS) {
    for (let t = before.start; t <= cutoff; t += HOUR) {
      const a = before.features[symbol].get(t), b = after.features[symbol].get(t);
      assert.deepEqual(a, b);
      for (const id of STUDY.hypotheses) assert.deepEqual(studySignal(id, a.candidate), studySignal(id, b.candidate));
    }
  }
});
test("dataset gaps, duplicates, missing assets and insufficient warmup reject", () => {
  const first = SYMBOLS[0];
  assert.throws(() => prepareStudy({ ...dataset, symbols: { ...dataset.symbols, [first]: rows.filter((_, i) => i !== 100) } }), /missing/);
  assert.throws(() => prepareStudy({ ...dataset, symbols: { ...dataset.symbols, [first]: [...rows, rows[100]] } }), /duplicate/);
  assert.throws(() => prepareStudy({ ...dataset, symbols: {} }), /missing/);
  assert.throws(() => prepareStudy({ ...dataset, to: 1000 * HOUR }), /warmup/);
  assert.throws(() => prepareStudy({ ...dataset, to: dataset.to + 1 }), /bounds/);
});
test("flat passive comparator loses exactly two fees and two adverse fills", () => {
  const flatRows = [[0, 100, 100, 100, 100, 1], [HOUR, 100, 100, 100, 100, 1]];
  const prepared = { symbols: [...SYMBOLS], rows: Object.fromEntries(SYMBOLS.map(s => [s, flatRows])),
    index: Object.fromEntries(SYMBOLS.map(s => [s, new Map([[0, 0], [HOUR, 1]])])) };
  const result = passiveBenchmark(prepared, 0, 2 * HOUR);
  const allocated = STUDY_RISK.startingBalance * STUDY_RISK.maxDeployPct;
  const expected = allocated * ((1 - STUDY_RISK.slippagePct) / (1 + STUDY_RISK.slippagePct) * (1 - STUDY_RISK.takerFeePct) - 1 - STUDY_RISK.takerFeePct);
  near(result.netPnl, expected);
  assert.equal(result.closed, 5);
  assert.equal(result.wins, 0);
  assert.ok(passiveBenchmark(prepared, 0, 2 * HOUR, 2).netPnl < result.netPnl);
});
const good = () => ({ development: { closed: 60, netPnl: 100, profitFactor: 1.4, maxDrawdownPct: 2 },
  validation: { closed: 40, netPnl: 100, profitFactor: 1.4, maxDrawdownPct: 2 }, validationDoubleCosts: { netPnl: 50 } });
test("selection uses only eligible development/validation, never reserved winners", () => {
  const input = { trend: good(), breakout: good(), reversion: good() };
  input.breakout.validation.netPnl = 200;
  input.reversion.validation.netPnl = 300;
  input.reversion.validationDoubleCosts.netPnl = -1;
  assert.equal(chooseDevelopment(input), "breakout");
  input.trend.reserved = { netPnl: 999999 };
  assert.equal(chooseDevelopment(input), "breakout");
  for (const r of Object.values(input)) r.development.netPnl = -1;
  assert.equal(chooseDevelopment(input), null);
});
test("positive zero-loss samples pass PF screens without letting empty samples pass", () => {
  const positive = { closed: 60, wins: 60, netPnl: 120, avgWin: 2, avgLoss: 0, expectancy: 2,
    profitFactor: null, maxDrawdownPct: 0 };
  assert.equal(profitFactorPass(positive, STUDY.reservedMinProfitFactor), true);
  assert.equal(profitFactorPass({ ...positive, closed: 0, wins: 0, netPnl: 0 }, STUDY.reservedMinProfitFactor), false);
  assert.equal(profitFactorPass({ ...positive, netPnl: -1 }, STUDY.reservedMinProfitFactor), false);
  const input = Object.fromEntries(STUDY.hypotheses.map(id => [id, good()]));
  input.trend = { development: positive, validation: positive, validationDoubleCosts: { netPnl: 60 } };
  assert.equal(chooseDevelopment(input), "trend");
});
test("zero or small samples cannot win the development screen", () => {
  const input = Object.fromEntries(STUDY.hypotheses.map(id => [id, good()]));
  input.trend.development.closed = 0;
  input.breakout.validation.closed = 19;
  input.reversion.validation.profitFactor = 1;
  assert.equal(chooseDevelopment(input), null);
});
test("reserved window precedes previously studied data and risk remains long-only", () => {
  assert.ok(STUDY.developmentEnd < STUDY.validationEnd);
  assert.ok(STUDY.validationEnd < STUDY.reservedEnd);
  assert.ok(STUDY.reservedEnd < STUDY.previouslyExaminedFrom);
  assert.equal(STUDY_RISK.allowShort, false);
  assert.equal(STUDY_RISK.riskPerTradePct, 0.0025);
  assert.equal(STUDY_RISK.maxDeployPct, 0.10);
});
test("all three strategies execute via shared replay and retain trade evidence", () => {
  const prepared = prepareStudy(dataset);
  for (const id of STUDY.hypotheses) {
    const result = runWindow(prepared, id, prepared.start, prepared.end);
    assert.ok(Array.isArray(result.trades));
    assert.ok(Array.isArray(result.curve));
    near(result.trades.reduce((sum, p) => sum + p.pnl_usd, 0), result.netPnl);
    assert.ok(result.trades.every(p => p.side === "long"));
  }
});
