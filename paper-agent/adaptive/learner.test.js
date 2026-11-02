import test from "node:test";
import assert from "node:assert/strict";
import { CANDIDATES, DAY, HOUR, LEARNING, RISK } from "./config.js";
import { newLearning, scorePortfolio, screenCandidate, updateLearning } from "./learner.js";

const empty = () => ({ curve: [], closed: [] });
function profitable(daily = 2, days = 160) {
  return { curve: Array.from({ length: days * 24 }, (_, i) => ({ ts: (i + 1) * HOUR, equity: 10000 + daily * (i + 1) / 24 })),
    closed: Array.from({ length: Math.floor(days / 2) }, (_, i) => ({ candidateId: "trend-capped", closed_at: new Date((i + 1) * 2 * DAY).toISOString(),
      pnl_usd: daily * 2, entry_fee: 1, exit_fee: 1, entry_regime: "up", exit_reason: "target" })) };
}
const shadows = () => Object.fromEntries(CANDIDATES.map(c => [c.id, { normal: empty(), stressed: empty() }]));
function qualifying(id = "trend-capped") {
  const all = shadows();
  all[id] = { normal: profitable(), stressed: profitable(1) };
  return all;
}
const score = (p, days = 100) => scorePortfolio(p, days * DAY);

test("empty and insufficient observations cannot qualify", () => {
  assert.equal(screenCandidate(score(empty()), score(empty())).eligible, false);
  const short = score(profitable(), 80);
  assert.equal(screenCandidate(short, short).gates.enoughObservation, false);
  const few = profitable(); few.closed = few.closed.slice(0, 2);
  assert.equal(screenCandidate(score(few), score(few)).gates.enoughTrades, false);
});

test("positive no-loss samples handle null profit factor and retain regime diagnostics", () => {
  const normal = score(profitable()), stress = score(profitable(1));
  assert.equal(normal.profitFactor, null);
  assert.equal(normal.noLossPositive, true);
  assert.equal(normal.closed, 50);
  assert.equal(normal.netPnl, 200);
  assert.equal(normal.realizedPnl, 200);
  assert.equal(normal.byRegime.up.netPnl, 200);
  assert.equal(normal.fees, 100);
  assert.ok(normal.lowerWeeklyEstimate > 0);
  assert.equal(screenCandidate(normal, stress).eligible, true);
});

test("cost-fragile returns, absent stressed recent trades and high-win losing systems fail", () => {
  const normal = score(profitable());
  const bad = score(profitable(-1));
  assert.equal(screenCandidate(normal, bad).gates.stressPositive, false);
  const stale = profitable(1); stale.closed = stale.closed.filter(p => Date.parse(p.closed_at) < 55 * DAY);
  assert.equal(screenCandidate(normal, score(stale)).gates.enoughRecentTrades, false);
  const p = profitable(-1);
  p.closed = p.closed.map((t, i) => ({ ...t, pnl_usd: i % 10 === 9 ? -30 : 2 }));
  const s = score(p);
  assert.equal(s.winRatePct, 90);
  assert.ok(s.expectancy < 0);
  assert.equal(screenCandidate(s, s).eligible, false);
});

test("unrealized losses, drawdown and unstable weeks veto realized winners", () => {
  const p = profitable();
  p.curve.at(100 * 24 - 1).equity = 9400;
  const s = score(p);
  assert.ok(s.realizedPnl > 0);
  assert.ok(s.netPnl < 0);
  assert.equal(screenCandidate(s, s).gates.drawdownWithinLimit, false);
  assert.equal(screenCandidate(s, s).eligible, false);
});

test("future curves and trades cannot alter past scores or selection", () => {
  const full = profitable();
  const past = { curve: full.curve.filter(p => p.ts <= 100 * DAY), closed: full.closed.filter(p => Date.parse(p.closed_at) <= 100 * DAY) };
  assert.deepEqual(score(full), score(past));
  const all = qualifying(); const snapshot = structuredClone(all);
  const a = updateLearning(newLearning(), all, empty(), 100 * DAY);
  all["trend-capped"].normal.curve.push({ ts: 200 * DAY, equity: 1e10 });
  all["trend-capped"].normal.closed.push({ closed_at: new Date(200 * DAY).toISOString(), pnl_usd: 1e10 });
  const b = updateLearning(newLearning(), all, empty(), 100 * DAY);
  assert.deepEqual(a, b);
  assert.deepEqual(snapshot["trend-capped"].normal, full);
});

test("two distinct weekly confirmations promote only after adequate evidence", () => {
  const all = qualifying(); const initial = newLearning();
  const first = updateLearning(initial, all, empty(), 100 * DAY);
  assert.equal(first.learning.champion, null);
  assert.equal(first.learning.pending, "trend-capped");
  assert.equal(first.learning.confirmations, 1);
  assert.deepEqual(initial, newLearning());
  const early = updateLearning(first.learning, all, empty(), 101 * DAY);
  assert.deepEqual(early.learning, first.learning);
  assert.equal(early.event, null);
  const second = updateLearning(early.learning, all, empty(), 107 * DAY);
  assert.equal(second.learning.champion, "trend-capped");
  assert.equal(second.learning.championSince, 107 * DAY);
  assert.equal(second.event.type, "PROMOTE");
  assert.equal(second.learning.confirmations, 0);
});

test("selection ranks worst-cost return rather than normal headline profit", () => {
  const all = qualifying();
  all["trend-capped"] = { normal: profitable(5), stressed: profitable(0.5) };
  all["breakout-runner"] = { normal: profitable(3), stressed: profitable(1) };
  assert.equal(updateLearning(newLearning(), all, empty(), 100 * DAY).learning.pending, "breakout-runner");
});

test("unqualified weeks reset confirmations and weak champions demote immediately", () => {
  const first = updateLearning(newLearning(), qualifying(), empty(), 100 * DAY).learning;
  const next = updateLearning(first, shadows(), empty(), 107 * DAY);
  assert.equal(next.learning.pending, null);
  assert.equal(next.learning.confirmations, 0);
  const incumbent = { ...first, champion: "trend-capped", championSince: 100 * DAY };
  const failed = updateLearning(incumbent, shadows(), empty(), 107 * DAY);
  assert.equal(failed.learning.champion, null);
  assert.equal(failed.event.type, "DEMOTE");
});

test("qualified incumbent is not churned before minimum residence", () => {
  const all = qualifying();
  all["breakout-runner"] = { normal: profitable(3), stressed: profitable(2) };
  let learning = { ...newLearning(), champion: "trend-capped", championSince: 100 * DAY, lastReview: 100 * DAY };
  for (const day of [107, 114, 121]) {
    learning = updateLearning(learning, all, empty(), day * DAY).learning;
    assert.equal(learning.champion, "trend-capped");
  }
  learning = updateLearning(learning, all, empty(), 128 * DAY).learning;
  assert.equal(learning.champion, "breakout-runner");
});

test("active deterioration demotes without touching portfolio or counting future losses", () => {
  const active = { ...empty(), positions: { BTC: { candidateId: "trend-capped" } } };
  active.closed = Array.from({ length: 10 }, (_, i) => ({ candidateId: "trend-capped", pnl_usd: i < 7 ? -2 : 1,
    closed_at: new Date((100 + i) * DAY).toISOString() }));
  const learning = { ...newLearning(), champion: "trend-capped", championSince: 99 * DAY, lastReview: 108 * DAY };
  const before = structuredClone(active);
  assert.equal(updateLearning(learning, qualifying(), active, 108 * DAY).learning.champion, "trend-capped");
  const result = updateLearning(learning, qualifying(), active, 109 * DAY);
  assert.equal(result.learning.champion, null);
  assert.equal(result.event.type, "DEMOTE");
  assert.match(result.event.reason, /deterioration/);
  assert.deepEqual(active, before);
});

test("active drawdown latches permanently even if remaining positions recover", () => {
  const active = { curve: [{ ts: HOUR, equity: 10000 }, { ts: 100 * DAY, equity: 9500 }], closed: [] };
  const incumbent = { ...newLearning(), champion: "trend-capped", championSince: 90 * DAY };
  const stopped = updateLearning(incumbent, qualifying(), active, 100 * DAY);
  assert.equal(stopped.learning.champion, null);
  assert.equal(stopped.learning.riskHalted, true);
  active.curve.push({ ts: 114 * DAY, equity: 10200 });
  const recovered = updateLearning(stopped.learning, qualifying(), active, 114 * DAY);
  assert.equal(recovered.learning.champion, null);
  assert.equal(recovered.learning.riskHalted, true);
});

test("as-of broker opening peak triggers the latch even when closing peaks never rose", () => {
  const active = { curve: [{ ts: 100 * DAY, equity: 9993.22 }], closed: [], peak: 10986.28, lastTime: 100 * DAY - HOUR };
  const incumbent = { ...newLearning(), champion: "trend-capped", championSince: 99 * DAY };
  const result = updateLearning(incumbent, qualifying(), active, 100 * DAY);
  assert.equal(result.learning.riskHalted, true);
  assert.equal(result.learning.champion, null);
  active.curve.push({ ts: 114 * DAY, equity: 10900 }); active.lastTime = 114 * DAY - HOUR;
  assert.equal(updateLearning(result.learning, qualifying(), active, 114 * DAY).learning.champion, null);
});

test("rolling scores exclude expired trade outcomes and retain the correct equity baseline", () => {
  const p = profitable(2, 400);
  const s = score(p, 400);
  assert.equal(s.from, 220 * DAY);
  assert.equal(s.observedDays, 180);
  assert.equal(s.netPnl, 360);
  assert.equal(s.closed, 90);
  assert.equal(s.realizedPnl, 360);
  assert.equal(s.recentNetPnl, 90);
  assert.equal(s.weeklyPnl.length, 25);
  assert.deepEqual(s.blockPnl, [120, 120, 120]);
});

test("time travel is rejected and fixed policy cannot be mutated", () => {
  for (const now of [NaN, Infinity, 1]) assert.throws(() => updateLearning(newLearning(), shadows(), empty(), now), /time/);
  assert.throws(() => updateLearning({ ...newLearning(), lastReview: DAY }, shadows(), empty(), 0), /backwards/);
  assert.throws(() => { RISK.maxDeployPct = 1; }, TypeError);
  assert.throws(() => { LEARNING.minTrades = 1; }, TypeError);
  assert.throws(() => { CANDIDATES[0].targetR = 99; }, TypeError);
});
