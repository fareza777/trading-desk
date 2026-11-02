import test from "node:test";
import assert from "node:assert/strict";
import { newPortfolio, advancePortfolio } from "./broker.js";
import { CANDIDATES, RISK, HOUR, DAY } from "./config.js";
import { SYMBOLS } from "../../candidate/config.js";
import { studySignal } from "../../candidate/study.js";
import { candidateSignal } from "./policy.js";
import { sizePosition, openFill, closeFill, stopDistance } from "../../candidate/engine.js";

const T = Date.UTC(2026, 0, 1);
const [BTC, ETH, SOL, LINK, AVAX] = SYMBOLS;
const iso = t => new Date(t).toISOString();
const near = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${actual} != ${expected}`);
function analysis(time, symbol, overrides = {}) {
  const fourCandleTs = Math.floor(time / (4 * HOUR)) * 4 * HOUR - 4 * HOUR;
  return { ready: true, symbol, candleTs: time - HOUR, decisionTime: time, fourCandleTs,
    closed4h: fourCandleTs + 4 * HOUR === time, price: 100, close4h: 100, atr1h: 1,
    ema200_4h: 90, ema20_4h: 97, ema50_4h: 96, previousEma20_4h: 95, previousEma50_4h: 96,
    previousHigh55: 99, previousLow20: 90, previousClose4h: 96, previousBbLower: 97,
    bbLower: 99, bbMean: 104, adx4h: 18, rsi4h: 40, trend4h: "up",
    rsi1h: 20, momentum1h_12h: -2, quoteVolume: RISK.minVolume24Usd, ...overrides };
}
function frame(time, eligible = [], barOverrides = {}, analysisOverrides = {}) {
  return {
    bars: Object.fromEntries(SYMBOLS.map(symbol => [symbol, [time, ...(barOverrides[symbol] ?? [100, 101, 99, 100, 1])]])),
    analyses: Object.fromEntries(SYMBOLS.map(symbol => [symbol,
      analysis(time, symbol, { ready: eligible.includes(symbol), ...analysisOverrides[symbol] })])),
  };
}
function step(p, time, { id = null, eligible = [], bars = {}, analyses = {}, options = {} } = {}) {
  const f = frame(time, eligible, bars, analyses);
  return advancePortfolio(p, f.bars, f.analyses, id, time, options);
}
function enter(id = "trend-capped", eligible = [BTC], options = {}, analyses = {}, time = T) {
  return step(newPortfolio(), time, { id, eligible, options, analyses });
}
function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
function entryEvidence(p) {
  return [...Object.values(p.positions), ...p.closed].map(position => ({ symbol: position.symbol,
    candidateId: position.candidateId, qty: position.qty, entry_price: position.entry_price,
    entry_fee: position.entry_fee, opened_at: position.opened_at })).sort((a, b) => a.symbol.localeCompare(b.symbol));
}
function historyTrade(symbol, ended, pnl) {
  const entry = 100, qty = 1, entryFee = 0.26, exitFee = 0.26;
  return { symbol, candidateId: "trend-runner", side: "long", qty, entry_price: entry,
    entry_fee: entryFee, stop_price: 96, target_price: null, best_price: entry,
    opened_at: iso(ended - HOUR), entry_regime: "up", exit_price: entry + pnl + entryFee + exitFee,
    exit_fee: exitFee, pnl_usd: pnl, closed_at: iso(ended), exit_reason: "signal_exit" };
}
function stoppedPortfolio() {
  return step(enter("trend-capped", [BTC, ETH]), T + HOUR,
    { bars: { [BTC]: [100, 101, 90, 100, 1], [ETH]: [100, 101, 90, 100, 1] } });
}

test("newPortfolio has exactly the serializable contract and independent arrays", () => {
  assert.deepEqual(newPortfolio(1234), { cash: 1234, positions: {}, closed: [], curve: [], peak: 1234,
    day: null, dayOpen: 1234, dayHalted: false, riskHalted: false, lastTime: null });
  assert.equal(newPortfolio().cash, RISK.startingBalance);
  assert.notEqual(newPortfolio().closed, newPortfolio().closed);
  assert.notEqual(newPortfolio().curve, newPortfolio().curve);
  assert.ok(Object.isFrozen(newPortfolio().closed));
  assert.ok(Object.isFrozen(newPortfolio().curve));
  for (const invalid of [0, -1, NaN, Infinity, "10000", null]) assert.throws(() => newPortfolio(invalid));
});

test("long debit, executable MTM, full-close fees and cash reconcile without input mutation", () => {
  const input = deepFreeze(newPortfolio());
  const f = deepFreeze(frame(T, [BTC]));
  const p = advancePortfolio(input, f.bars, f.analyses, "trend-capped", T);
  assert.deepEqual(input, newPortfolio());
  assert.notEqual(p, input);
  const position = p.positions[BTC];
  assert.deepEqual(Object.keys(position).sort(), ["symbol", "candidateId", "side", "qty", "entry_price", "entry_fee",
    "stop_price", "target_price", "best_price", "opened_at", "entry_regime"].sort());
  assert.equal(position.side, "long");
  assert.equal(position.entry_regime, "up");
  near(position.entry_price, openFill(100, "long"));
  near(position.entry_fee, position.qty * position.entry_price * RISK.takerFeePct);
  near(p.cash, RISK.startingBalance - position.qty * position.entry_price - position.entry_fee);
  near(position.stop_price, position.entry_price * (1 - stopDistance(position.entry_price, 1, "long", RISK)));
  near(position.target_price, position.entry_price + 3 * (position.entry_price - position.stop_price));
  near(p.curve[0].equity, p.cash + position.qty * closeFill(100, "long") * (1 - RISK.takerFeePct));
  assert.equal(p.curve[0].ts, T + HOUR);
  assert.equal(p.lastTime, T);
  const beforeClose = structuredClone(p);
  const done = step(deepFreeze(p), T + HOUR, { bars: { [BTC]: [100, 101, 90, 100, 1] } });
  assert.deepEqual(p, beforeClose);
  assert.notEqual(done.curve, p.curve);
  assert.equal(done.curve[0], p.curve[0]);
  assert.ok(Object.isFrozen(done.curve[0]));
  assert.throws(() => { done.curve[0].equity = 0; }, TypeError);
  assert.equal(done.closed.length, 1);
  assert.equal(Object.keys(done.positions).length, 0);
  const trade = done.closed[0];
  near(trade.exit_price, closeFill(position.stop_price, "long"));
  near(trade.exit_fee, trade.qty * trade.exit_price * RISK.takerFeePct);
  near(trade.pnl_usd, trade.qty * (trade.exit_price - trade.entry_price) - trade.entry_fee - trade.exit_fee);
  near(done.cash, p.cash + trade.qty * trade.exit_price - trade.exit_fee);
  near(done.cash, RISK.startingBalance + trade.pnl_usd);
  near(done.curve.at(-1).equity, done.cash);
  assert.equal(trade.closed_at, iso(T + 2 * HOUR));
});

test("generated histories share frozen records in new arrays while mutable state stays independent", () => {
  const initial = newPortfolio();
  const owned = step(initial, T, { id: "trend-capped", eligible: [BTC] });
  const held = step(owned, T + HOUR);
  const closed = step(held, T + 2 * HOUR, { bars: { [BTC]: [100, 101, 90, 100, 1] } });
  const later = step(closed, T + 3 * HOUR);
  const states = [initial, owned, held, closed, later];
  const before = states.map(p => structuredClone(p));
  for (const [index, p] of states.entries()) {
    for (const key of ["closed", "curve"]) {
      assert.ok(Object.isFrozen(p[key]));
      assert.throws(() => p[key].push({}), TypeError);
      assert.throws(() => { p[key][0] = {}; }, TypeError);
      assert.throws(() => { p[key].length = 0; }, TypeError);
      for (const record of p[key]) {
        assert.ok(Object.isFrozen(record));
        assert.throws(() => { record.extra = 1; }, TypeError);
        assert.throws(() => { delete record[Object.keys(record)[0]]; }, TypeError);
      }
      if (index > 0) {
        assert.notEqual(p[key], states[index - 1][key]);
        states[index - 1][key].forEach((record, i) => assert.equal(p[key][i], record));
      }
    }
  }
  assert.throws(() => { later.closed[0].qty = 0; }, TypeError);
  assert.throws(() => { later.curve.at(-1).equity = 0; }, TypeError);
  assert.deepEqual(states, before);
  assert.notEqual(held.positions, owned.positions);
  assert.notEqual(held.positions[BTC], owned.positions[BTC]);
  held.positions[BTC].qty = 1;
  held.cash = 1;
  assert.deepEqual(owned, before[1]);
  assert.deepEqual(closed, before[3]);
});

test("mutable histories and partial freezes are revalidated after a successful call", () => {
  const source = stoppedPortfolio();
  for (const shape of ["mutable", "frozen arrays", "frozen records"]) {
    const input = structuredClone(source);
    for (const key of ["closed", "curve"]) {
      if (shape === "frozen arrays") Object.freeze(input[key]);
      if (shape === "frozen records") input[key].forEach(Object.freeze);
    }
    const output = step(input, T + 2 * HOUR);
    const before = structuredClone(output);
    assert.deepEqual(output, step(source, T + 2 * HOUR));
    for (const key of ["closed", "curve"]) {
      assert.equal(Object.isFrozen(input[key]), shape === "frozen arrays");
      assert.equal(Object.isFrozen(input[key][0]), shape === "frozen records");
      assert.notEqual(output[key][0], input[key][0]);
    }
    if (shape === "frozen records") input.curve[0] = Object.freeze({ ...input.curve[0], equity: -1 });
    else input.curve[0].equity = -1;
    assert.throws(() => step(input, T + 2 * HOUR), /equity curve/);
    if (shape === "frozen records") input.curve[0] = source.curve[0];
    else input.curve[0].equity = source.curve[0].equity;
    if (shape === "frozen records") input.closed[0] = Object.freeze({ ...input.closed[0], qty: 0 });
    else input.closed[0].qty = 0;
    assert.throws(() => step(input, T + 2 * HOUR), /position qty/);
    assert.deepEqual(output, before);
  }
});

test("edited deserialized and unknown frozen histories reject atomically", () => {
  const source = stoppedPortfolio();
  const corruptions = [p => { p.curve[0].ts = p.curve[1].ts; },
    p => { p.curve[0].equity = -1; }, p => { p.curve[0].equity = p.peak + 1; },
    p => { p.closed[0].qty = 0; }, p => { p.closed[0].exit_fee = -1; },
    p => { p.closed[0].candidateId = "missing"; }, p => { p.closed[0].closed_at = iso(T + 3 * HOUR); },
    p => { p.closed[1].closed_at = iso(T + HOUR); },
    p => { p.curve[0].extra = { value: 1 }; }, p => { p.closed[0].extra = { value: 1 }; }];
  for (const deserialize of [structuredClone, p => JSON.parse(JSON.stringify(p))]) {
    const restored = deserialize(source);
    assert.deepEqual(step(restored, T + 2 * HOUR), step(source, T + 2 * HOUR));
    assert.deepEqual(restored, source);
    for (const freeze of [p => p, deepFreeze]) {
      for (const corrupt of corruptions) {
        const input = deserialize(source);
        corrupt(input);
        freeze(input);
        const before = structuredClone(input);
        assert.throws(() => step(input, T + 2 * HOUR));
        assert.deepEqual(input, before);
      }
    }
  }
});

test("cached curve metadata still checks the historical maximum and account time", () => {
  let p = step(newPortfolio(1000), T);
  p.cash = 1500;
  p = step(p, T + HOUR);
  p.cash = 1100;
  p = step(p, T + 2 * HOUR);
  assert.equal(p.curve.at(-1).equity, 1100);
  const before = structuredClone(p);
  for (const peak of [1200, 1499]) {
    assert.throws(() => step({ ...p, peak }, T + 3 * HOUR), /equity curve/);
  }
  for (const lastTime of [T + HOUR, T + 3 * HOUR]) {
    assert.throws(() => step({ ...p, lastTime }, lastTime + HOUR), /equity curve|lastTime/);
  }
  assert.equal(step(p, T + 3 * HOUR).peak, 1500);
  assert.deepEqual(p, before);
});

test("cached closed histories still reject future trades when reused with an earlier account time", () => {
  const p = stoppedPortfolio();
  const rewound = { ...p, curve: newPortfolio().curve, lastTime: null, day: null };
  const before = structuredClone(rewound);
  assert.throws(() => step(rewound, T), /closed position/);
  assert.deepEqual(rewound, before);
});

test("frozen accessor histories are snapshotted, not cached as immutable input", () => {
  const source = stoppedPortfolio();
  let equity = source.curve[0].equity, qty = source.closed[0].qty;
  const input = { ...source,
    curve: Object.freeze(source.curve.map((point, i) => i ? point : Object.freeze({ ...point, get equity() { return equity; } }))),
    closed: Object.freeze(source.closed.map((trade, i) => i ? trade : Object.freeze({ ...trade, get qty() { return qty; } }))) };
  const output = step(input, T + 2 * HOUR);
  const before = structuredClone(output);
  assert.equal(Object.getOwnPropertyDescriptor(output.curve[0], "equity").get, undefined);
  assert.equal(Object.getOwnPropertyDescriptor(output.closed[0], "qty").get, undefined);
  equity = Infinity;
  assert.throws(() => step(input, T + 2 * HOUR), /equity curve/);
  equity = source.curve[0].equity;
  qty = 0;
  assert.throws(() => step(input, T + 2 * HOUR), /position qty/);
  assert.deepEqual(output, before);
});

test("cached histories avoid reparsing old trades; deserialization restores full validation", t => {
  const input = newPortfolio();
  input.closed = Array.from({ length: 128 }, (_, i) => historyTrade(BTC, T - (128 - i) * HOUR, 1));
  const cached = step(input, T);
  const parse = t.mock.method(Date, "parse");
  step(cached, T + HOUR);
  const cachedCalls = parse.mock.callCount();
  parse.mock.resetCalls();
  const restored = step(structuredClone(cached), T + HOUR);
  assert.equal(parse.mock.callCount(), cachedCalls + 2 * input.closed.length);
  parse.mock.resetCalls();
  step(restored, T + 2 * HOUR);
  assert.equal(parse.mock.callCount(), cachedCalls);
});

test("old stop wins a bar touching both stop and target, including a favorable opening gap", () => {
  for (const open of [100, 120]) {
    const p = enter();
    const done = step(p, T + HOUR, { bars: { [BTC]: [open, 125, 90, 110, 1] } });
    assert.equal(done.closed[0].exit_reason, "stop");
    near(done.closed[0].exit_price, closeFill(p.positions[BTC].stop_price, "long"));
    assert.equal(done.closed[0].qty, p.positions[BTC].qty);
  }
});

test("new entry also uses initial stop before target on an ambiguous entry hour", () => {
  const p = step(newPortfolio(), T, { id: "trend-capped", eligible: [BTC], bars: { [BTC]: [100, 130, 80, 105, 1] } });
  assert.equal(p.closed.length, 1);
  assert.equal(p.closed[0].exit_reason, "stop");
  assert.equal(p.closed[0].opened_at, iso(T));
  assert.equal(p.closed[0].closed_at, iso(T + HOUR));
  assert.equal(Object.keys(p.positions).length, 0);
});

test("target is a full close with no favorable gap improvement", () => {
  const p = enter();
  const done = step(p, T + HOUR, { bars: { [BTC]: [120, 125, 119, 122, 1] } });
  const trade = done.closed[0];
  assert.equal(trade.exit_reason, "target");
  near(trade.exit_price, closeFill(p.positions[BTC].target_price, "long"));
  assert.equal(trade.qty, p.positions[BTC].qty);
  assert.equal(done.positions[BTC], undefined);
});

test("there is explicitly NO partial TP at the study engine's 1.5R level", () => {
  const p = enter();
  const position = p.positions[BTC];
  const tp1 = position.entry_price + 1.5 * (position.entry_price - position.stop_price);
  const next = step(p, T + HOUR, { bars: { [BTC]: [100, tp1 + 0.01, 99, tp1, 1] } });
  assert.equal(next.closed.length, 0);
  assert.equal(next.positions[BTC].qty, position.qty);
  assert.equal(next.positions[BTC].entry_fee, position.entry_fee);
  assert.equal(next.cash, p.cash);
  assert.equal(next.positions[BTC].tp1_hit, undefined);
});

test("gap stop fills at the adverse open and can exceed the sized risk budget", () => {
  const p = enter("trend-capped", [BTC], {}, { [BTC]: { atr1h: 2 } });
  const next = step(p, T + HOUR, { bars: { [BTC]: [50, 55, 45, 52, 1] } });
  assert.equal(next.closed[0].exit_reason, "stop");
  assert.equal(next.closed[0].closed_at, iso(T + HOUR));
  near(next.closed[0].exit_price, closeFill(50, "long"));
  assert.ok(-next.closed[0].pnl_usd > RISK.startingBalance * RISK.riskPerTradePct);
});

test("trailing high updates only the NEXT bar's stop and never loosens", () => {
  const p = step(newPortfolio(), T, { id: "trend-runner", eligible: [BTC], bars: { [BTC]: [100, 120, 97, 105, 1] } });
  assert.equal(p.closed.length, 0); // low and close are BELOW the newly raised stop.
  near(p.positions[BTC].stop_price, 120 * 0.92);
  const done = step(p, T + HOUR, { bars: { [BTC]: [105, 121, 104, 120, 1] } });
  assert.equal(done.closed[0].exit_reason, "stop");
  near(done.closed[0].exit_price, closeFill(105, "long"));
  const survives = step(p, T + HOUR, { bars: { [BTC]: [115, 116, 114, 115, 1] } });
  near(survives.positions[BTC].stop_price, p.positions[BTC].stop_price);
  near(survives.positions[BTC].best_price, 120);
});

test("null-target runner holds past capped target and retains all quantity", () => {
  const p = enter("trend-runner");
  const next = step(p, T + HOUR, { bars: { [BTC]: [100, 150, 99, 145, 1] } });
  assert.equal(next.closed.length, 0);
  assert.equal(next.positions[BTC].target_price, null);
  assert.equal(next.positions[BTC].qty, p.positions[BTC].qty);
  near(next.positions[BTC].stop_price, 150 * 0.92);
});

for (const c of CANDIDATES) {
  test(`${c.id}: same qualified family entry and pinned maximum holding time`, () => {
    assert.equal(candidateSignal(c, analysis(T, BTC)).decision, "BUY");
    const p = enter(c.id);
    const initial = p.positions[BTC];
    assert.ok(initial);
    assert.equal(initial.candidateId, c.id);
    if (c.targetR === null) assert.equal(initial.target_price, null);
    else near(initial.target_price, initial.entry_price + c.targetR * (initial.entry_price - initial.stop_price));
    initial.opened_at = iso(T + HOUR - (c.maxHoldHours - 1) * HOUR);
    const before = step(p, T + HOUR);
    assert.ok(before.positions[BTC]);
    const done = step(before, T + 2 * HOUR, { bars: { [BTC]: [100, 130, 1, 100, 1] } });
    assert.equal(done.closed[0].exit_reason, "time_exit");
    assert.equal(done.closed[0].closed_at, iso(T + 2 * HOUR));
    near(done.closed[0].exit_price, closeFill(100, "long"));
  });
}

for (const [family, overrides] of [["trend", { close4h: 94 }], ["breakout", { close4h: 89 }], ["reversion", { close4h: 105 }]]) {
  test(`${family}: prior closed signal exits at open before entries or current range`, () => {
    const id = CANDIDATES.find(c => c.family === family).id;
    let p = enter(id);
    for (let i = 1; i < 4; i++) p = step(p, T + i * HOUR);
    const done = step(p, T + 4 * HOUR, { id: "trend-runner", eligible: [BTC, SOL],
      analyses: { [BTC]: { ...overrides, atr1h: 999, quoteVolume: 0 } },
      bars: { [BTC]: [101, 130, 1, 100, 1] } });
    assert.equal(done.closed[0].exit_reason, "signal_exit");
    assert.equal(done.closed[0].closed_at, iso(T + 4 * HOUR));
    near(done.closed[0].exit_price, closeFill(101, "long"));
    assert.ok(done.positions[SOL]);
    assert.equal(done.positions[BTC], undefined); // Opening exit starts symbol cooldown.
  });
}

test("signal exit is unavailable between closed 4h decisions; protection still executes", () => {
  const p = enter();
  const next = step(p, T + HOUR, { eligible: [BTC], analyses: { [BTC]: { close4h: 94 } } });
  assert.ok(next.positions[BTC]);
  const stopped = step(p, T + HOUR, { eligible: [BTC], analyses: { [BTC]: { close4h: 94 } },
    bars: { [BTC]: [90, 100, 80, 95, 1] } });
  assert.equal(stopped.closed[0].exit_reason, "stop");
});

test("champion changes and cash/null mode preserve original targets, trails and exits", () => {
  const runner = enter("trend-runner");
  const switched = step(runner, T + HOUR, { id: "trend-capped", bars: { [BTC]: [100, 130, 99, 125, 1] } });
  assert.equal(switched.positions[BTC].candidateId, "trend-runner");
  assert.equal(switched.positions[BTC].target_price, null);
  near(switched.positions[BTC].stop_price, 130 * 0.92);
  const cash = step(switched, T + 2 * HOUR, { bars: { [BTC]: [118, 125, 117, 120, 1] } });
  assert.equal(cash.closed[0].candidateId, "trend-runner");
  assert.equal(Object.keys(cash.positions).length, 0);
  const capped = enter();
  const done = step(capped, T + HOUR, { id: "trend-runner", bars: { [BTC]: [100, 120, 99, 115, 1] } });
  assert.equal(done.closed[0].candidateId, "trend-capped");
  assert.equal(done.closed[0].exit_reason, "target");
  assert.equal(Object.keys(step(newPortfolio(), T, { eligible: SYMBOLS }).positions).length, 0);
});

test("ranking is descending score then symbol, never more than two longs", () => {
  const tied = enter("trend-capped", SYMBOLS);
  assert.deepEqual(Object.keys(tied.positions).sort(), [AVAX, BTC]);
  const ranked = enter("trend-capped", SYMBOLS, {}, { [SOL]: { ema20_4h: 110 }, [ETH]: { ema20_4h: 105 } });
  assert.deepEqual(Object.keys(ranked.positions), [SOL, ETH]);
  assert.ok(Object.values(ranked.positions).every(p => p.side === "long"));
  for (const p of Object.values(ranked.positions))
    assert.ok(p.qty * p.entry_price + p.entry_fee <= RISK.startingBalance * RISK.maxPositionPct + 1e-8);
  const allocated = Object.values(ranked.positions).reduce((sum, p) => sum + p.qty * p.entry_price + p.entry_fee, 0);
  assert.ok(allocated <= RISK.startingBalance * RISK.maxDeployPct + 1e-8);
  assert.ok(ranked.cash >= 0);
  assert.ok(Object.values(step(newPortfolio(100), T, { id: "trend-capped", eligible: SYMBOLS }).positions).length === 0);
});

test("USD volume is prior supplied quoteVolume, not current bar volume; gap cutoff is half ATR", () => {
  const bad = enter("trend-capped", [BTC], {}, { [BTC]: { quoteVolume: RISK.minVolume24Usd - 1 } });
  assert.equal(Object.keys(bad.positions).length, 0);
  const tinyVolume = step(newPortfolio(), T, { id: "trend-capped", eligible: [BTC], bars: { [BTC]: [100, 101, 99, 100, 0] } });
  assert.ok(tinyVolume.positions[BTC]);
  for (const open of [99.499, 100.501]) {
    const p = step(newPortfolio(), T, { id: "trend-capped", eligible: [BTC], bars: { [BTC]: [open, 102, 98, 100, 1e12] } });
    assert.equal(Object.keys(p.positions).length, 0);
  }
  for (const open of [99.5, 100.5]) {
    const p = step(newPortfolio(), T, { id: "trend-capped", eligible: [BTC], bars: { [BTC]: [open, 102, 98, 100, 0] } });
    assert.ok(p.positions[BTC]);
  }
});

test("current high/low/close/volume cannot influence entry choice, sizing or free same-hour slots", () => {
  const normal = enter("trend-capped", SYMBOLS);
  const altered = step(newPortfolio(), T, { id: "trend-capped", eligible: SYMBOLS,
    bars: Object.fromEntries(SYMBOLS.map(s => [s, [100, 1000, 1, 500, 1e15]])) });
  assert.deepEqual(entryEvidence(altered), entryEvidence(normal));
  assert.equal(altered.closed.length, 2); // Does not backfill freed slots using future stop proceeds.
  let owned = enter("trend-runner", [BTC, ETH], {}, {}, T - 4 * HOUR);
  for (let t = T - 3 * HOUR; t < T; t += HOUR) owned = step(owned, t);
  const lateStop = step(owned, T, { id: "trend-capped", eligible: [SOL], bars: { [BTC]: [100, 101, 80, 95, 1] } });
  assert.equal(lateStop.positions[SOL], undefined);
  const openingStop = step(owned, T, { id: "trend-capped", eligible: [SOL], bars: { [BTC]: [95, 101, 80, 95, 1] } });
  assert.ok(openingStop.positions[SOL]);
});

test("sizing uses fresh executable opening equity and current marked deployment", () => {
  let p = enter("trend-runner", [BTC]);
  for (let i = 1; i < 4; i++) p = step(p, T + i * HOUR);
  const open = 130;
  const old = p.positions[BTC];
  const equity = p.cash + old.qty * closeFill(open, "long") * (1 - RISK.takerFeePct);
  const deployed = old.qty * open;
  const q = step(p, T + 4 * HOUR, { id: "trend-runner", eligible: [SOL], bars: { [BTC]: [open, 131, 129, 130, 1] } });
  const added = q.positions[SOL];
  const debit = added.qty * added.entry_price + added.entry_fee;
  near(debit, equity * RISK.maxDeployPct - deployed);
  assert.ok(debit < equity * RISK.maxPositionPct);
  const cashPoor = structuredClone(p);
  cashPoor.cash = 10;
  const noBorrow = step(cashPoor, T + 4 * HOUR, { id: "trend-runner", eligible: [SOL], options: { shadow: true } });
  assert.equal(noBorrow.positions[SOL], undefined);
  assert.ok(noBorrow.cash >= 0);
});

test("stressed effective fees/slippage shrink risk-sized orders and reconcile stop losses", () => {
  // The non-trailing variant preserves the initial stop for the budget comparison.
  const base = enter("reversion-standard", [BTC], {}, { [BTC]: { atr1h: 2 } });
  const stressed = enter("reversion-standard", [BTC], { frictionMultiplier: 2 }, { [BTC]: { atr1h: 2 } });
  assert.ok(stressed.positions[BTC].qty < base.positions[BTC].qty);
  for (const multiplier of [0, 1, 2, 10]) {
    const options = { frictionMultiplier: multiplier };
    const p = enter("reversion-standard", [BTC], options, { [BTC]: { atr1h: 2 } });
    const risk = { ...RISK, slippagePct: RISK.slippagePct * multiplier, takerFeePct: RISK.takerFeePct * multiplier };
    const expected = sizePosition({ equity: RISK.startingBalance, cash: RISK.startingBalance, entryPrice: 100,
      atr: 2, side: "long", deployedUsd: 0 }, risk);
    near(p.positions[BTC].qty, expected.qty);
    near(p.positions[BTC].stop_price, expected.stopPrice);
    const pos = p.positions[BTC];
    near(p.curve[0].equity, p.cash + pos.qty * closeFill(100, "long", risk.slippagePct) * (1 - risk.takerFeePct));
    const done = step(p, T + HOUR, { options, bars: { [BTC]: [100, 101, 80, 100, 1] } });
    near(done.closed[0].pnl_usd, -RISK.startingBalance * RISK.riskPerTradePct);
    near(done.cash, RISK.startingBalance + done.closed[0].pnl_usd);
  }
});

test("all five OHLCV bars are checked before any fills, including non-eligible symbols", () => {
  const p = enter();
  const changes = [f => delete f.bars[AVAX], f => { f.bars[AVAX][0] += HOUR; },
    f => { f.bars[AVAX][1] = NaN; }, f => { f.bars[AVAX][2] = 99; }, f => { f.bars[AVAX][3] = 102; },
    f => { f.bars[AVAX][4] = 0; }, f => { f.bars[AVAX][5] = -1; }, f => { f.bars[AVAX][5] = Infinity; },
    f => { f.bars[AVAX][5] = "100"; }, f => f.bars[AVAX].pop(), f => f.bars[AVAX].push(1)];
  for (const change of changes) {
    const f = frame(T + HOUR, [], { [BTC]: [50, 60, 40, 50, 1] });
    change(f);
    const before = structuredClone(p);
    assert.throws(() => advancePortfolio(p, f.bars, f.analyses, null, T + HOUR));
    assert.deepEqual(p, before);
  }
});

test("future, unaligned, mismatched and nonfinite features reject atomically", () => {
  const changes = [f => delete f.analyses[AVAX],
    f => { f.analyses[AVAX].candleTs = T; }, f => { f.analyses[AVAX].candleTs = T - 1; },
    f => { f.analyses[AVAX].decisionTime += HOUR; }, f => { f.analyses[AVAX].fourCandleTs = T; },
    f => { f.analyses[AVAX].fourCandleTs -= 1; }, f => { f.analyses[AVAX].closed4h = false; },
    f => { f.analyses[AVAX].symbol = BTC; }, f => { f.analyses[AVAX].quoteVolume = Infinity; },
    f => { f.analyses[AVAX].quoteVolume = null; }, f => { f.analyses[AVAX].atr1h = NaN; },
    f => { f.analyses[AVAX].price = "100"; }, f => { f.analyses[AVAX].ema50_4h = 0; },
    f => { f.analyses[AVAX].volumeSpike = { ratio: Infinity }; }, f => { f.analyses[AVAX].extra = { value: NaN }; }];
  for (const change of changes) {
    const p = newPortfolio(), f = frame(T, SYMBOLS);
    change(f);
    assert.throws(() => advancePortfolio(p, f.bars, f.analyses, "trend-capped", T));
    assert.deepEqual(p, newPortfolio());
  }
});

test("first hour can be any aligned time, thereafter duplicate, reverse and missing hours reject", () => {
  for (const first of [0, -HOUR, T, T + 7 * HOUR]) {
    const p = step(newPortfolio(), first);
    assert.equal(step(p, first + HOUR).lastTime, first + HOUR);
    for (const wrong of [first, first - HOUR, first + 2 * HOUR, first + HOUR + 1]) {
      const before = structuredClone(p);
      assert.throws(() => step(p, wrong));
      assert.deepEqual(p, before);
    }
  }
  for (const wrong of [NaN, Infinity, T + 1, "0", 8.64e15]) assert.throws(() => step(newPortfolio(), wrong));
});

test("invalid costs, candidate and corrupt portfolio refuse without modifying state", () => {
  const p = enter();
  for (const frictionMultiplier of [NaN, Infinity, -1, "2", 500, Number.MAX_VALUE]) {
    const before = structuredClone(p);
    assert.throws(() => step(p, T + HOUR, { options: { frictionMultiplier } }));
    assert.deepEqual(p, before);
  }
  assert.throws(() => step(p, T + HOUR, { id: "missing" }));
  assert.throws(() => step(p, T + HOUR, { options: { shadow: "yes" } }));
  for (const corrupt of [q => { q.cash = NaN; }, q => { q.positions[BTC].qty = Infinity; },
    q => { q.positions[BTC].side = "short"; }, q => { q.positions[BTC].candidateId = "missing"; },
    q => { q.positions[BTC].opened_at = iso(T + 2 * HOUR); }, q => { q.curve[0].ts += HOUR; },
    q => { q.curve[0].equity = Infinity; }]) {
    const bad = structuredClone(p);
    corrupt(bad);
    const before = structuredClone(bad);
    assert.throws(() => step(bad, T + HOUR));
    assert.deepEqual(bad, before);
  }
});

test("daily halt latches after losses despite recovery; shadow samples but still honors stop cooldown", () => {
  let p = enter("trend-runner", [BTC, ETH]);
  p = step(p, T + HOUR, { bars: { [BTC]: [60, 61, 59, 60, 1] } });
  assert.equal(p.dayHalted, true);
  assert.equal(p.closed[0].exit_reason, "stop");
  p = step(p, T + 2 * HOUR, { bars: { [ETH]: [150, 151, 149, 150, 1] } });
  assert.ok(p.curve.at(-1).equity > p.dayOpen);
  assert.equal(p.dayHalted, true);
  p = step(p, T + 3 * HOUR, { bars: { [ETH]: [150, 151, 149, 150, 1] } });
  const args = { id: "trend-capped", eligible: [BTC, SOL], bars: { [ETH]: [150, 151, 149, 150, 1] },
    analyses: { [BTC]: { ema20_4h: 110 } } };
  const active = step(p, T + 4 * HOUR, args);
  assert.equal(active.positions[SOL], undefined);
  const shadow = step(p, T + 4 * HOUR, { ...args, options: { shadow: true } });
  assert.ok(shadow.positions[SOL]);
  assert.equal(shadow.positions[BTC], undefined);
  assert.equal(shadow.dayHalted, true);
  assert.equal(Object.keys(shadow.positions).length, 2);
});

test("UTC day reset uses prior end-hour equity, clears only daily latch and preserves peak", () => {
  let p = enter("trend-runner", [BTC], {}, {}, T + 20 * HOUR);
  for (let i = 21; i < 23; i++) p = step(p, T + i * HOUR);
  p = step(p, T + 23 * HOUR, { bars: { [BTC]: [100, 110, 99, 108, 1] } });
  p.dayHalted = true;
  const priorEquity = p.curve.at(-1).equity, priorPeak = p.peak;
  const next = step(p, T + DAY);
  near(next.dayOpen, priorEquity);
  assert.equal(next.day, "2026-01-02");
  assert.equal(next.dayHalted, false);
  assert.equal(next.peak, priorPeak);
  assert.ok(next.closed.length); // Protective exit is still processed on the new day.
});

test("5% lifetime peak breaker persists across days, shadow ignores it without resetting peak", () => {
  let p = newPortfolio(9400);
  p.peak = 10000;
  p = step(p, T, { id: "trend-capped", eligible: SYMBOLS });
  assert.equal(Object.keys(p.positions).length, 0);
  for (let i = 1; i < 24; i++) p = step(p, T + i * HOUR);
  const active = step(p, T + DAY, { id: "trend-capped", eligible: SYMBOLS });
  assert.equal(Object.keys(active.positions).length, 0);
  assert.equal(active.dayHalted, false);
  assert.equal(active.peak, 10000);
  const shadow = step(p, T + DAY, { id: "trend-capped", eligible: SYMBOLS, options: { shadow: true } });
  assert.equal(Object.keys(shadow.positions).length, 2);
  assert.equal(shadow.peak, 10000);
  assert.ok(shadow.cash >= 0);
});

test("three losses in 24h pause active entries, not exits or shadow, and expire without trimming", () => {
  const time = T + 8 * HOUR;
  let p = step(newPortfolio(), time - HOUR);
  p.closed = [historyTrade(BTC, time - 3 * HOUR, -1), historyTrade(BTC, time - 2 * HOUR, -1),
    historyTrade(BTC, time - HOUR, 1), historyTrade(BTC, time - HOUR, -1)];
  const args = { id: "trend-capped", eligible: [SOL] };
  const active = step(p, time, args);
  assert.equal(active.positions[SOL], undefined);
  assert.ok(step(p, time, { ...args, options: { shadow: true } }).positions[SOL]);
  p = active;
  for (let i = 1; i < 24; i++) p = step(p, time + i * HOUR);
  const resumed = step(p, time + DAY, args);
  assert.ok(resumed.positions[SOL]);
  assert.equal(resumed.closed.length, 4);
  assert.equal(resumed.curve.length, 26);
  assert.deepEqual(resumed.closed, active.closed);
  assert.deepEqual(resumed.curve.slice(0, active.curve.length), active.curve);
});

test("third loss at the open blocks entries, but a future intrabar loss cannot", () => {
  let p = enter("trend-runner", [BTC], {}, {}, T - 4 * HOUR);
  for (let t = T - 3 * HOUR; t < T; t += HOUR) p = step(p, t);
  p.closed = [historyTrade(ETH, T - 2 * HOUR, -1), historyTrade(ETH, T - HOUR, -1)];
  const args = { id: "trend-capped", eligible: [SOL] };
  const opening = step(p, T, { ...args, bars: { [BTC]: [95, 101, 90, 95, 1] } });
  assert.equal(opening.closed.length, 3);
  assert.equal(opening.positions[SOL], undefined);
  const later = step(p, T, { ...args, bars: { [BTC]: [100, 101, 90, 95, 1] } });
  assert.equal(later.closed.length, 3);
  assert.ok(later.positions[SOL]);
});

test("normal and stop symbol cooldowns apply in both modes, including their exact expiry", () => {
  for (const shadow of [false, true]) {
    for (const [reason, hours] of [["signal_exit", 4], ["stop", 12]]) {
      const p = newPortfolio();
      p.closed = [{ ...historyTrade(BTC, T - (hours - 1) * HOUR, 1), exit_reason: reason }];
      const args = { id: "trend-capped", eligible: [BTC], options: { shadow } };
      assert.equal(step(p, T, args).positions[BTC], undefined);
      p.closed[0] = { ...historyTrade(BTC, T - hours * HOUR, 1), exit_reason: reason };
      assert.ok(step(p, T, args).positions[BTC]);
    }
  }
});
