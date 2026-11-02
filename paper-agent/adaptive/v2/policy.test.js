import test from "node:test";
import assert from "node:assert/strict";
import { candidateSignal, selectExecution } from "./policy.js";
import { CANDIDATES, DAY, EXPLORATION } from "./config.js";

const T = Date.UTC(2026, 0, 15, 12);
const recovery = CANDIDATES.find(candidate => candidate.id === "hourly-recovery");
const base = { ready: true, price: 100, rsi1h: 20, momentum1h_12h: -2, ema200_4h: 90, atr1h: 1 };
const trade = (closedAt, pnl) => ({ closed_at: new Date(closedAt).toISOString(), pnl_usd: pnl });
const pair = (pnl, count = 8) => ({
  normal: { closed: Array.from({ length: count }, (_, i) => trade(T - (i + 1) * DAY, pnl / count)) },
  stressed: { closed: Array.from({ length: count }, (_, i) => trade(T - (i + 1) * DAY, pnl / count)) },
});
const learning = (overrides = {}) => ({ champion: null, riskHalted: false,
  exploration: { candidateId: EXPLORATION.baseline, since: T - DAY }, ...overrides });

test("hourly recovery requires a bounded oversold dislocation and exits on the RSI bounce", () => {
  assert.equal(candidateSignal(recovery, base).decision, "BUY");
  assert.match(candidateSignal(recovery, base).reason, /oversold/);
  assert.equal(candidateSignal(recovery, { ...base, rsi1h: 40 }).decision, "HOLD");
  assert.equal(candidateSignal(recovery, { ...base, momentum1h_12h: 1 }).decision, "HOLD");
  assert.equal(candidateSignal(recovery, { ...base, momentum1h_12h: -12 }).decision, "HOLD");
  assert.equal(candidateSignal(recovery, { ...base, price: 70 }).decision, "HOLD");
  assert.equal(candidateSignal(recovery, { ...base, atr1h: 0 }).decision, "HOLD");
  assert.equal(candidateSignal(recovery, { ...base, rsi1h: undefined }).decision, "HOLD");
  assert.equal(candidateSignal(recovery, base, true).decision, "HOLD");
  assert.equal(candidateSignal(recovery, { ...base, rsi1h: 60 }, true).decision, "SELL");
});

test("selection prefers a champion, stops on a risk latch, and otherwise explores", () => {
  assert.equal(selectExecution(learning({ champion: "trend-runner" }), {}, T).kind, "champion");
  assert.equal(selectExecution(learning({ champion: "trend-runner", riskHalted: true }), {}, T).candidateId, null);
  const baseline = selectExecution(learning(), {}, T);
  assert.equal(baseline.candidateId, EXPLORATION.baseline);
  assert.equal(baseline.kind, "exploration");
});

test("selection switches only after both cost scenarios show enough prior outcomes", () => {
  const shadows = { [EXPLORATION.baseline]: pair(0, 0), "breakout-runner": pair(25) };
  const switched = selectExecution(learning(), shadows, T);
  assert.equal(switched.candidateId, "breakout-runner");
  assert.match(switched.reason, /doubled costs/);
  const thin = { [EXPLORATION.baseline]: pair(0, 0), "breakout-runner": pair(50, 2) };
  assert.equal(selectExecution(learning(), thin, T).candidateId, EXPLORATION.baseline);
  const unprofitable = { [EXPLORATION.baseline]: pair(0, 0), "breakout-runner": pair(-5) };
  assert.equal(selectExecution(learning(), unprofitable, T).candidateId, EXPLORATION.baseline);
  const retained = { "breakout-runner": pair(20), [EXPLORATION.baseline]: pair(25) };
  assert.equal(selectExecution(learning({ exploration: { candidateId: "breakout-runner", since: T } }),
    retained, T).candidateId, "breakout-runner");
  assert.equal(selectExecution(learning(), shadows, T, { allowSwitch: false }).candidateId, EXPLORATION.baseline);
});
