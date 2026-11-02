import test from "node:test";
import assert from "node:assert/strict";
import { AdaptiveStore } from "./store.js";
import { parseMode, newState, advanceState, summarize, observeOnce, storeStatus, fingerprint, runReplay, dashboardSnapshot } from "./runner.js";
import { SYMBOLS } from "../candidate/config.js";
import { HOUR, DAY, CANDIDATES } from "./config.js";

const T = Date.UTC(2026, 0, 1);
function market(end) {
  return { end, requests: 0,
    async fetchTime() { return this.end + 10_000; },
    async fetchOHLCV(symbol, timeframe, since, limit) {
      assert.ok(SYMBOLS.includes(symbol)); assert.equal(timeframe, "1h");
      this.requests++;
      return Array.from({ length: Math.min(limit, (this.end - since) / HOUR) }, (_, i) =>
        [since + i * HOUR, 100, 101, 99, 100, 200000]);
    } };
}
function prepared(time) {
  const rows = {}, index = {}, features = {};
  for (const symbol of SYMBOLS) {
    rows[symbol] = [[time, 100, 101, 99, 100, 200000]];
    index[symbol] = new Map([[time, 0]]);
    const a = { ready: true, symbol, candleTs: time - HOUR, decisionTime: time,
      fourCandleTs: time - 4 * HOUR, closed4h: true, price: 100, close4h: 100, atr1h: 1,
      ema200_4h: 90, ema20_4h: 97, ema50_4h: 96, previousEma20_4h: 95, previousEma50_4h: 96,
      previousHigh55: 99, previousLow20: 90, previousClose4h: 96, previousBbLower: 97,
      bbLower: 99, bbMean: 104, adx4h: 18, rsi4h: 40, trend4h: "up" };
    features[symbol] = new Map([[time, { candidate: a, quoteVolume: 20_000_000 }]]);
  }
  return { start: time, end: time + HOUR, rows, index, features, symbols: SYMBOLS };
}

test("CLI defaults read-only and rejects every real-order or ambiguous mode", () => {
  assert.equal(parseMode([]), "--status");
  for (const mode of ["--once", "--watch", "--replay", "--register", "--status"]) assert.equal(parseMode([mode]), mode);
  for (const args of [["--live"], ["--paper"], ["--once", "--once"], ["--watch", "--status"], ["--risk", "1"]])
    assert.throws(() => parseMode(args), /no real-order mode/);
  assert.match(fingerprint(), /^[a-f0-9]{64}$/);
});

test("state starts in cash with independent shadow balances; empty DB status works", () => {
  const store = new AdaptiveStore(":memory:");
  try { assert.deepEqual(storeStatus(store), { mode: "NOT_INITIALIZED", realOrdersEnabled: false, audit: { events: 0, lastHash: "", revision: 0 } }); }
  finally { store.close(); }
  const state = newState(T, "frozen");
  assert.equal(state.learning.champion, null);
  state.shadows[CANDIDATES[0].id].normal.cash = 42;
  assert.equal(state.active.cash, 10000);
  assert.equal(state.shadows[CANDIDATES[0].id].stressed.cash, 10000);
  assert.equal(summarize(state).active.equity, 10000);
});

test("entry uses the prior champion, demotion affects only later entries and pins exits", () => {
  const state = newState(T, "frozen");
  state.learning.champion = "trend-capped"; state.learning.championSince = T - DAY;
  const before = structuredClone(state);
  const out = advanceState(state, prepared(T));
  assert.equal(out.event.data.championUsed, "trend-capped");
  assert.equal(out.event.data.nextChampion, null);
  assert.equal(out.event.data.review.type, "DEMOTE");
  assert.equal(Object.keys(out.state.active.positions).length, 2);
  assert.ok(Object.values(out.state.active.positions).every(p => p.candidateId === "trend-capped"));
  assert.equal(out.state.nextTime, T + HOUR);
  assert.deepEqual(state, before);
  assert.throws(() => advanceState(out.state, prepared(T)), /next hour unavailable/);
});

test("a non-closing broker peak halts the active portfolio and learner together", () => {
  const state = newState(T, "frozen");
  state.learning = { ...state.learning, champion: "trend-capped", championSince: T, lastReview: T };
  const opened = advanceState(state, prepared(T)).state;
  const next = prepared(T + HOUR);
  for (const symbol of SYMBOLS) {
    next.rows[symbol][0] = [T + HOUR, 200, 201, 100, 100, 200000];
    const a = next.features[symbol].get(T + HOUR).candidate;
    a.closed4h = false; a.fourCandleTs = T - 4 * HOUR;
  }
  const halted = advanceState(opened, next).state;
  assert.ok(halted.active.peak > 10900);
  assert.ok(halted.active.curve.at(-1).equity < halted.active.peak * 0.95);
  assert.equal(halted.active.riskHalted, true);
  assert.equal(halted.learning.riskHalted, true);
  assert.equal(halted.learning.champion, null);
});

test("historical replay keeps every shadow separate and cannot authorize forward promotion", () => {
  const report = runReplay(prepared(T), "frozen");
  assert.equal(report.mode, "HISTORICAL_RESEARCH");
  assert.equal(report.forwardPromotionAuthorized, false);
  assert.equal(report.active.closed, 0);
  assert.equal(report.active.equity, 10000);
  assert.equal(report.activeCurve.length, 1);
  assert.equal(Object.keys(report.shadowEvidence).length, 6);
  assert.equal(Object.keys(report.shadowEvidence["trend-capped"].normal.positions).length, 2);
  assert.equal(report.finalMarks[SYMBOLS[0]], 100);
  assert.ok(report.shadows["trend-capped"].normal.equity < 10000);
  assert.ok(report.shadows["trend-capped"].doubleCosts.equity < report.shadows["trend-capped"].normal.equity);
  for (const c of CANDIDATES) for (const [scenario, multiplier] of [["normal", 1], ["stressed", 2]]) {
    const evidence = report.shadowEvidence[c.id][scenario];
    const account = report.shadows[c.id][scenario === "stressed" ? "doubleCosts" : "normal"];
    const positions = Object.values(evidence.positions);
    const expectedCash = 10000 + evidence.trades.reduce((sum, p) => sum + p.pnl_usd, 0) - positions.reduce((sum, p) => sum + p.qty * p.entry_price + p.entry_fee, 0);
    const expectedEquity = expectedCash + positions.reduce((sum, p) => sum + p.qty * report.finalMarks[p.symbol] * (1 - 0.0008 * multiplier) * (1 - 0.0026 * multiplier), 0);
    assert.ok(Math.abs(account.cash - expectedCash) < 1e-8);
    assert.ok(Math.abs(account.equity - expectedEquity) < 1e-8);
  }
});

test("bootstrap seeds indicators only, duplicate observation is read-only, next hour commits once", async () => {
  const store = new AdaptiveStore(":memory:"), exchange = market(T);
  exchange.fetchTime = async () => exchange.end + 59 * 60_000;
  try {
    const first = await observeOnce(exchange, store, "frozen", T + 59 * 60_000);
    assert.equal(first.processedHours, 0); assert.equal(first.revision, 1);
    assert.equal(first.champion, "CASH"); assert.equal(first.active.closed, 0);
    assert.ok(Object.values(first.shadows).every(p => p.normal.closed === 0));
    assert.equal(store.load().state.nextTime, T + HOUR);
    assert.ok(store.load().state.startedAt > store.load().state.initializedAt);
    assert.equal(store.events()[0].kind, "INITIALIZED");
    const requests = exchange.requests;
    const duplicate = await observeOnce(exchange, store, "frozen", T + 59 * 60_000);
    assert.equal(duplicate.revision, 1); assert.equal(exchange.requests, requests);
    exchange.end += HOUR;
    const pending = await observeOnce(exchange, store, "frozen", exchange.end + 59 * 60_000);
    assert.equal(pending.processedHours, 0); assert.equal(exchange.requests, requests);
    exchange.end += HOUR;
    const next = await observeOnce(exchange, store, "frozen", exchange.end + 59 * 60_000);
    assert.equal(next.processedHours, 1); assert.equal(next.revision, 2);
    assert.equal(next.champion, "CASH"); assert.equal(next.active.closed, 0);
    assert.equal(store.load().state.active.curve.length, 1);
    assert.equal(store.events()[1].data.catchUp, false);
    assert.equal(store.verify().events, 2);
    assert.equal(storeStatus(store).audit.revision, 2);
  } finally { store.close(); }
});

test("missed hours are replayed sequentially and marked catch-up, never silently skipped", async () => {
  const store = new AdaptiveStore(":memory:"), exchange = market(T + 3 * HOUR);
  try {
    store.commit(0, newState(T, "frozen"), { ts: T, kind: "INITIALIZED", data: {} });
    const result = await observeOnce(exchange, store, "frozen", exchange.end + 10_000);
    assert.equal(result.processedHours, 3); assert.equal(result.revision, 4);
    assert.deepEqual(store.events().slice(1).map(e => e.ts), [T + HOUR, T + 2 * HOUR, T + 3 * HOUR]);
    assert.deepEqual(store.events().slice(1).map(e => e.data.catchUp), [true, true, false]);
  } finally { store.close(); }
});

test("hourly polling and a 25-hour catch-up generate identical indicators and outcomes", async () => {
  const hourly = new AdaptiveStore(":memory:"), batched = new AdaptiveStore(":memory:");
  function varying(end) {
    const exchange = market(end);
    exchange.fetchOHLCV = async (symbol, tf, since, limit) => Array.from({ length: Math.min(limit, (exchange.end - since) / HOUR) }, (_, i) => {
      const ts = since + i * HOUR, hour = (ts - T) / HOUR;
      const price = h => 150 + h * 0.008 + 1.7 * Math.sin(h / 19);
      const open = price(hour - 1), close = price(hour);
      return [ts, open, Math.max(open, close) + 0.4, Math.min(open, close) - 0.4, close, 200000];
    });
    return exchange;
  }
  try {
    for (const store of [hourly, batched]) store.commit(0, newState(T, "frozen"), { ts: T, kind: "INITIALIZED", data: {} });
    const exchange = varying(T);
    for (let i = 1; i <= 25; i++) {
      exchange.end = T + i * HOUR;
      await observeOnce(exchange, hourly, "frozen", exchange.end + 10_000);
    }
    await observeOnce(varying(T + 25 * HOUR), batched, "frozen", T + 25 * HOUR + 10_000);
    assert.deepEqual(hourly.load(), batched.load());
    assert.deepEqual(hourly.events().slice(1).map(e => e.data.inputHash), batched.events().slice(1).map(e => e.data.inputHash));
  } finally { hourly.close(); batched.close(); }
});

test("clock skew, missing data and historical checkpoints fail without advancing the ledger", async () => {
  const store = new AdaptiveStore(":memory:"), exchange = market(T + HOUR);
  try {
    store.commit(0, newState(T, "frozen"), { ts: T, kind: "INITIALIZED", data: {} });
    const before = store.load();
    await assert.rejects(observeOnce(exchange, store, "frozen", T), /clock/);
    assert.deepEqual(store.load(), before);
    await assert.rejects(observeOnce(exchange, store, "different", exchange.end + 10_000), /frozen forward/);
    exchange.end = T + 31 * DAY;
    await assert.rejects(observeOnce(exchange, store, "frozen", exchange.end + 10_000), /outage/);
    exchange.end = T - HOUR;
    await assert.rejects(observeOnce(exchange, store, "frozen", exchange.end + 10_000), /backwards/);
    exchange.end = T + HOUR; exchange.fetchOHLCV = async () => [];
    await assert.rejects(observeOnce(exchange, store, "frozen", exchange.end + 10_000), /missing/);
    assert.deepEqual(store.load(), before);
  } finally { store.close(); }
  const historical = new AdaptiveStore(":memory:");
  try {
    historical.commit(0, newState(T, "frozen", "HISTORICAL_RESEARCH"), { ts: T, kind: "INITIALIZED", data: {} });
    await assert.rejects(observeOnce(market(T), historical, "frozen", T + 10_000), /historical winners/);
    assert.equal(historical.verify().revision, 1);
  } finally { historical.close(); }
});

test("dashboard snapshot separates adaptive accounts and exposes only existing evidence", () => {
  const store = new AdaptiveStore(":memory:");
  try {
    const initial = dashboardSnapshot(store);
    assert.equal(initial.mode, "NOT_INITIALIZED");
    assert.equal(initial.latestReview, null);
    store.commit(0, newState(T, "frozen"), { ts: T, kind: "INITIALIZED", data: {} });
    const next = advanceState(store.load().state, prepared(T));
    store.commit(1, next.state, next.event);
    const snapshot = dashboardSnapshot(store);
    assert.equal(snapshot.active.equity, 10000);
    assert.equal(snapshot.champion, "CASH");
    assert.equal(Object.keys(snapshot.shadows).length, 6);
    assert.equal(snapshot.latestReview.ts, T + HOUR);
    assert.equal(snapshot.learningPolicy.minTrades, 30);
    assert.equal(snapshot.realOrdersEnabled, false);
    assert.equal(snapshot.positions, undefined);
  } finally { store.close(); }
});

test("a concurrent writer cannot be overwritten by a stale observation", async () => {
  const store = new AdaptiveStore(":memory:"), exchange = market(T);
  const original = exchange.fetchOHLCV.bind(exchange);
  let raced = false;
  exchange.fetchOHLCV = async (...args) => {
    if (!raced) {
      raced = true;
      store.commit(0, newState(T, "frozen"), { ts: T, kind: "OTHER_WRITER", data: {} });
    }
    return original(...args);
  };
  try {
    await assert.rejects(observeOnce(exchange, store, "frozen", T + 10_000), /revision conflict/);
    assert.equal(store.verify().revision, 1);
    assert.equal(store.events()[0].kind, "OTHER_WRITER");
  } finally { store.close(); }
});
