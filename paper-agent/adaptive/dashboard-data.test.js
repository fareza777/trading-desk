import test from "node:test";
import assert from "node:assert/strict";
import { buildDashboard } from "./dashboard-data.js";
import { newState, advanceState } from "./v2/runner.js";
import { CANDIDATES, HOUR, RISK, VERSION } from "./v2/config.js";
import { SYMBOLS } from "../candidate/config.js";

const T = Date.UTC(2026, 9, 29);
const MINUTE = 60_000;
const iso = ts => new Date(ts).toISOString();
const closeEnough = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const sum = values => values.reduce((a, b) => a + b, 0);
const fresh = (state, now, revision = 19) => ({ mode: "FORWARD_SHADOW", version: state.version,
  audit: { revision }, generatedAt: iso(now), nextHour: iso(state.nextTime) });

function position(overrides = {}) {
  const p = { symbol: SYMBOLS[0], candidateId: "trend-runner", side: "long", qty: 4, entry_price: 100,
    stop_price: 95, target_price: null, best_price: 105, opened_at: iso(T + 4 * HOUR), entry_regime: "up", ...overrides };
  return { ...p, entry_fee: p.entry_fee ?? p.qty * p.entry_price * RISK.takerFeePct };
}
function closedPosition(overrides = {}) {
  const p = position({ opened_at: iso(T), ...overrides });
  const exit_price = overrides.exit_price ?? 110;
  const exit_fee = p.qty * exit_price * RISK.takerFeePct;
  return { ...p, exit_price, exit_fee, closed_at: overrides.closed_at ?? iso(T + 2 * HOUR),
    exit_reason: overrides.exit_reason ?? "target", pnl_usd: p.qty * (exit_price - p.entry_price) - p.entry_fee - exit_fee };
}
function fixture() {
  const state = structuredClone(newState(T, "frozen-source"));
  const p = position();
  state.learning.champion = "reversion-fast"; // Open positions keep their entry candidate, not this one.
  state.nextTime = T + 5 * HOUR;
  state.active.positions = { [p.symbol]: p };
  state.active.closed = [closedPosition({ symbol: SYMBOLS[1], candidateId: "trend-capped", target_price: 110 }),
    closedPosition({ symbol: SYMBOLS[2], opened_at: iso(T + HOUR), closed_at: iso(T + 3 * HOUR),
      exit_price: 90, exit_reason: "stop" })];
  const realized = sum(state.active.closed.map(p => p.pnl_usd));
  state.active.cash = RISK.startingBalance + realized - p.qty * p.entry_price - p.entry_fee;
  const liquidation = p.qty * 105 * (1 - RISK.slippagePct) * (1 - RISK.takerFeePct);
  const equities = [RISK.startingBalance, RISK.startingBalance + state.active.closed[0].pnl_usd,
    RISK.startingBalance + realized, RISK.startingBalance + realized, state.active.cash + liquidation];
  state.active.curve = equities.map((equity, i) => ({ ts: T + (i + 1) * HOUR, equity }));
  state.active.peak = Math.max(RISK.startingBalance, ...equities);
  state.active.lastTime = state.nextTime - HOUR;
  const market = { [p.symbol]: { price: 999, priceTs: state.nextTime + MINUTE, trend1h: "up", trend4h: "down",
    rsi1h: 0, momentum1h: 1, momentum4h: -2, volatility: 3, volSpike: 4, vol24: 20_000_000, high24: 1000, low24: 90,
    candles1h: [[state.nextTime, 999, 1000, 998, 999, 123],
      [state.nextTime - HOUR, 102, 106, 101, 105, 200_000],
      [state.nextTime - 2 * HOUR, 90, 91, 89, 90, 100]] } };
  const now = state.nextTime + 2 * MINUTE;
  return { state, events: [], options: { market, now, revision: 19, snapshot: fresh(state, now) } };
}
const build = ({ state, events, options }) => buildDashboard(state, events, options);

function freezeDeep(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

function prepared() {
  const rows = {}, index = {}, features = {};
  for (const symbol of SYMBOLS) {
    rows[symbol] = [[T, 100, 101, 99, 100, 200_000]];
    index[symbol] = new Map([[T, 0]]);
    features[symbol] = new Map([[T, { quoteVolume: 20_000_000, candidate: {
      ready: true, symbol, candleTs: T - HOUR, decisionTime: T, fourCandleTs: T - 4 * HOUR, closed4h: true,
      price: 100, close4h: 100, atr1h: 1, ema200_4h: 90, ema20_4h: 97, ema50_4h: 96,
      previousEma20_4h: 95, previousEma50_4h: 96, previousHigh55: 99, previousLow20: 90,
      previousClose4h: 96, previousBbLower: 97, bbLower: 99, bbMean: 104, adx4h: 18, rsi4h: 40, trend4h: "up",
    } }]]);
  }
  return { start: T, end: T + HOUR, rows, index, features, symbols: SYMBOLS };
}

test("newState produces legacy-compatible zero-trade defaults without invented observations", () => {
  const state = newState(T, "frozen-source");
  const out = buildDashboard(state, [], { now: T });
  assert.deepEqual(Object.keys(out), ["status", "assets", "positions", "closed", "trades", "decisions", "curve", "logs"]);
  const s = out.status;
  assert.equal(s.schema, 2);
  assert.equal(s.source, VERSION);
  assert.equal(s.automatic, true);
  assert.equal(s.accountId, "adaptive-active");
  assert.equal(s.champion, "CASH");
  assert.equal(s.activeStrategy, "hourly-recovery");
  assert.equal(s.exploration.candidateId, "hourly-recovery");
  assert.equal(s.riskHalted, false);
  assert.equal(s.equity, RISK.startingBalance);
  assert.equal(s.cash, RISK.startingBalance);
  assert.equal(s.deployedUsd, 0);
  assert.equal(s.pnlTotal, 0);
  assert.equal(s.pnlPct, 0);
  assert.equal(s.openCount, 0);
  assert.equal(s.loopIntervalMin, 5);
  assert.equal(s.exchange, "okx");
  assert.equal(s.risk, RISK);
  assert.equal(s.lastCycle, null);
  assert.equal(s.valuationTime, null);
  assert.equal(s.nextObservationAt, null);
  assert.equal(s.observerFresh, false);
  assert.equal(s.agent.running, false);
  assert.equal(s.agent.pid, null);
  assert.equal(s.lastReview, null);
  assert.equal(s.reviewCount, 0);
  assert.deepEqual(s.stats, { closedCount: 0, winRate: 0, totalPnl: 0, totalFees: 0,
    totalFills: 0, closed: [], unrealizedNet: 0, equityPeak: RISK.startingBalance, maxDrawdownPct: 0 });
  assert.deepEqual(out.curve, [{ ts: iso(T), equity: RISK.startingBalance }]);
  for (const key of ["positions", "closed", "trades"]) assert.deepEqual(out[key], []);
  assert.deepEqual(out.assets.map(a => a.symbol), SYMBOLS);
  assert.ok(out.assets.every(a => a.price === null && a.position === null));
  assert.equal(out.decisions.length, SYMBOLS.length);
  assert.ok(out.decisions.every(d => d.decision === "HOLD" && /exploration candidate hourly-recovery/i.test(d.reason)));
  assert.match(s.message, /closed-hour simulation/);
  assert.match(s.message, /Old ledger retained unchanged/);
  assert.match(out.logs.join("\n"), /Old ledger retained/);
  assert.ok(!out.logs.some(log => /Observer error:|database.*locked/i.test(log)));
  assert.deepEqual(buildDashboard(state).curve, out.curve);
});

test("only active state contributes account balances, positions, fills and stats", () => {
  const f = fixture(), expected = build(f);
  for (const candidate of CANDIDATES) for (const scenario of ["normal", "stressed"]) {
    f.state.shadows[candidate.id][scenario] = { cash: 99_000_000, peak: 100_000_000,
      positions: { [SYMBOLS[4]]: position({ symbol: SYMBOLS[4] }) },
      closed: [closedPosition({ symbol: SYMBOLS[4], qty: 10_000 })],
      curve: [{ ts: f.state.nextTime, equity: 500_000_000 }] };
  }
  f.options.snapshot.active = { cash: -123, equity: 1e12 };
  f.events.push({ revision: 19, ts: f.state.nextTime, kind: "CLOSED_HOUR", data: {
    activeOutcomes: f.state.active.closed, shadowOutcomes: [closedPosition({ symbol: SYMBOLS[4], qty: 10_000 })] } });
  assert.deepEqual(build(f), expected);
});

test("closed and open fee-net accounting reconciles cash, liquidation, P&L and every fill fee", () => {
  const f = fixture(), { status: s, positions, closed, trades, assets } = build(f);
  const p = positions[0], original = f.state.active.positions[p.symbol];
  const realized = sum(f.state.active.closed.map(p => p.pnl_usd));
  assert.equal(s.equity, f.state.active.curve.at(-1).equity);
  assert.equal(s.cash, f.state.active.cash);
  assert.equal(s.stats.totalPnl, realized);
  assert.equal(s.stats.closedCount, 2);
  assert.equal(s.stats.winRate, 50);
  assert.equal(s.stats.totalFills, 5);
  assert.deepEqual(s.stats.closed, closed);
  closeEnough(p.liquidationValue, original.qty * 105 * (1 - RISK.slippagePct) * (1 - RISK.takerFeePct));
  closeEnough(p.unrealizedNet, p.liquidationValue - p.size_usd - original.entry_fee);
  assert.equal(p.unrealized, p.unrealizedNet);
  closeEnough(s.unrealizedNet, p.unrealizedNet);
  assert.equal(s.stats.unrealizedNet, s.unrealizedNet);
  closeEnough(s.cash + p.liquidationValue, s.equity);
  closeEnough(s.deployedUsd, p.liquidationValue);
  closeEnough(s.pnlTotal, s.stats.totalPnl + s.unrealizedNet);
  closeEnough(s.pnlPct, s.pnlTotal / RISK.startingBalance * 100);
  closeEnough(s.stats.totalFees, sum(trades.map(t => t.fee_usd)));
  assert.equal(p.qty_open, original.qty);
  assert.equal(p.qty, original.qty);
  assert.equal(p.size_usd, original.qty * original.entry_price);
  assert.equal(assets[0].position.sizeUsd, p.liquidationValue);
  assert.equal(assets[0].position.entryNotionalUsd, p.size_usd);
  assert.ok(closed.every(p => p.qty_open === 0 && p.status === "closed"));
});

test("actual adaptive runner output reconciles without pooling shadow simulations", () => {
  const initial = newState(T, "frozen-source");
  initial.learning.champion = "trend-capped";
  const data = prepared();
  const { state, event } = advanceState(initial, data);
  const now = state.nextTime + MINUTE;
  const out = buildDashboard(state, [{ ...event, revision: 1 }], { now, revision: 1,
    snapshot: fresh(state, now, 1), market: Object.fromEntries(SYMBOLS.map(symbol =>
      [symbol, { price: 1_000_000, candles1h: data.rows[symbol] }])) });
  assert.equal(out.status.champion, "CASH");
  assert.equal(out.positions.length, 2);
  assert.ok(out.positions.every(p => p.candidateId === "trend-capped"));
  assert.equal(out.trades.length, 2);
  closeEnough(out.status.equity, out.status.cash + sum(out.positions.map(p => p.liquidationValue)));
  closeEnough(out.status.unrealizedNet, sum(out.positions.map(p => p.unrealizedNet)));
  assert.equal(out.status.lastReview.type, "DEMOTE");
});

test("marks use the exact accounting candle close, not its open, the latest candle or a live quote", () => {
  const f = fixture(), out = build(f), p = out.positions[0], asset = out.assets[0];
  assert.equal(p.markPrice, 105);
  assert.equal(p.markTime, iso(f.state.nextTime - HOUR));
  assert.equal(out.status.valuationTime, iso(f.state.nextTime));
  assert.equal(out.status.lastCycle, iso(f.state.nextTime));
  assert.equal(asset.price, 999);
  assert.equal(asset.priceTs, iso(f.options.market[p.symbol].priceTs));
  assert.equal(asset.lastTs, asset.priceTs);
  for (const key of ["trend1h", "trend4h", "rsi1h", "momentum1h", "momentum4h", "volatility", "volSpike", "vol24", "high24", "low24"])
    assert.equal(asset[key], f.options.market[p.symbol][key]);
  const before = out.status;
  f.options.market[p.symbol].price = 0.01;
  f.options.market["DOGE/USDT"] = { price: 100 };
  assert.deepEqual(build(f).status, before);
  assert.equal(build(f).assets.length, SYMBOLS.length);
});

test("missing or invalid exact-hour marks stay null without entry or live fallback", () => {
  for (const candles of [undefined, [], [[T + 5 * HOUR, 102, 106, 101, 105, 1]],
    [[T + 3 * HOUR, 102, 106, 101, 105, 1]], [[T + 4 * HOUR, 102, 106, 101, NaN, 1]],
    [[T + 4 * HOUR, 102, 106, 101, 999, 1]]]) {
    const f = fixture(), original = build(f).status;
    f.options.market[SYMBOLS[0]].candles1h = candles;
    const out = build(f), p = out.positions[0];
    for (const key of ["markPrice", "markTime", "unrealized", "unrealizedNet", "liquidationValue"]) assert.equal(p[key], null, key);
    assert.equal(out.assets[0].position.sizeUsd, null);
    assert.deepEqual(out.status, original);
    assert.match(out.logs.join("\n"), /accounting mark unavailable/);
  }
  const f = fixture();
  delete f.options.market[SYMBOLS[0]];
  assert.equal(build(f).positions[0].markPrice, null);
});

test("targetless positions have no partial TP and trailing depends on pinned variant and threshold", () => {
  const f = fixture(), p = f.state.active.positions[SYMBOLS[0]];
  const threshold = p.best_price * (1 - CANDIDATES.find(c => c.id === p.candidateId).trailPct);
  p.stop_price = threshold - 1e-8;
  assert.equal(build(f).positions[0].trail_active, false);
  p.stop_price = threshold - Number.EPSILON * threshold;
  const mapped = build(f).positions[0];
  assert.equal(mapped.trail_active, true);
  assert.equal(mapped.tp1_price, null);
  assert.equal(mapped.tp2_price, null);
  assert.equal(mapped.target_price, null);
  p.candidateId = "reversion-fast";
  p.stop_price = p.best_price;
  assert.equal(build(f).positions[0].trail_active, false);
  p.target_price = 120;
  assert.equal(build(f).positions[0].tp2_price, 120);
  assert.equal(build(f).positions[0].tp1_price, null);
});

test("active fill IDs survive closing, are unique and deterministic, and sort newest first", () => {
  const f = fixture(), before = build(f), original = f.state.active.positions[SYMBOLS[0]];
  const entry = before.trades.find(t => t.symbol === original.symbol);
  assert.equal(typeof entry.id, "string");
  assert.equal(entry.action, "BUY");
  assert.equal(entry.pnl_usd, null);
  assert.equal(entry.fee_usd, original.entry_fee);
  assert.equal(entry.value_usd, original.qty * original.entry_price);
  f.state.active.closed.push(closedPosition({ ...original, closed_at: iso(f.state.nextTime), exit_reason: "time_exit" }));
  delete f.state.active.positions[original.symbol];
  const after = build(f);
  assert.equal(after.trades.find(t => t.symbol === original.symbol && t.action === "BUY").id, entry.id);
  assert.equal(after.closed.find(p => p.symbol === original.symbol).id, before.positions[0].id);
  assert.equal(new Set(after.trades.map(t => t.id)).size, after.trades.length);
  assert.equal(after.trades[0].action, "SELL");
  assert.equal(after.trades[0].pnl_usd, f.state.active.closed.at(-1).pnl_usd);
  assert.ok(after.trades.every((t, i, rows) => i === 0 || Date.parse(rows[i - 1].ts) >= Date.parse(t.ts)));
  f.state.active.closed.reverse();
  assert.deepEqual(build(f).trades, after.trades);
  f.events.push({ revision: 20, ts: f.state.nextTime, kind: "CLOSED_HOUR", data: { activeOutcomes: f.state.active.closed } });
  assert.deepEqual(build(f).trades, after.trades);
});

test("fill action mapping and pinned reasons are safe, and same-time exits precede entries", () => {
  const state = structuredClone(newState(T, "frozen-source"));
  state.active.closed = ["stop", "target", "time_exit", "signal_exit", "<img src=x onerror=alert(1)>"].map((reason, i) =>
    closedPosition({ symbol: SYMBOLS[i], candidateId: i === 4 ? "<script>bad</script>" : "trend-runner",
      opened_at: iso(T), closed_at: iso(T), exit_reason: reason }));
  const out = buildDashboard(state, [], { now: T });
  assert.deepEqual(out.trades.slice(0, 5).map(t => t.action).sort(), ["SELL", "SELL", "SELL", "STOP", "TAKE_PROFIT"]);
  assert.ok(out.trades.slice(5).every(t => t.action === "BUY" && t.pnl_usd === null));
  assert.ok(out.trades.every(t => !/[<>]/.test(t.reason) && !/onerror/.test(t.reason)));
  assert.ok(out.trades.filter(t => t.symbol !== SYMBOLS[4]).every(t => /pinned candidate trend-runner/.test(t.reason)));
  assert.equal(new Set(out.trades.map(t => t.id)).size, 10);
});

test("observer freshness has inclusive age bounds and is not process PID liveness", () => {
  for (const [age, expected] of [[-5 * MINUTE - 1, false], [-5 * MINUTE, true], [0, true],
    [7 * MINUTE, true], [7 * MINUTE + 1, false]]) {
    const f = fixture();
    f.options.snapshot.generatedAt = iso(f.options.now - age);
    f.options.snapshot.pid = 12345;
    f.options.snapshot.agent = { running: true, pid: 12345 };
    const { status } = build(f);
    assert.equal(status.observerFresh, expected, `age ${age}`);
    assert.equal(status.agent.running, expected);
    assert.equal(status.agent.pid, null);
    assert.equal(status.nextObservationAt, iso(f.options.now - age + 5 * MINUTE));
  }
});

test("wrong revision/version/mode and data more than two hours behind fail freshness", () => {
  const changes = [f => { f.options.snapshot.audit.revision--; }, f => { f.options.snapshot.audit.revision = "19"; },
    f => { f.options.snapshot.version = "other"; }, f => { f.options.snapshot.mode = "HISTORICAL_RESEARCH"; },
    f => { f.state.mode = "HISTORICAL_RESEARCH"; }, f => { f.options.snapshot.generatedAt = "invalid"; },
    f => { delete f.options.snapshot.audit; }, f => { f.options.snapshot = null; }];
  for (const change of changes) {
    const f = fixture(); change(f);
    assert.equal(build(f).status.agent.running, false);
    assert.equal(build(f).status.observerFresh, false);
  }
  for (const [lag, expected] of [[2 * HOUR, true], [2 * HOUR + 1, false]]) {
    const f = fixture();
    f.options.now = f.state.nextTime + lag;
    f.options.snapshot.generatedAt = iso(f.options.now);
    assert.equal(build(f).status.observerFresh, expected);
  }
});

test("fresh initialized CASH can be observed without fabricating a completed cycle", () => {
  const state = newState(T + HOUR, "frozen-source");
  state.initializedAt = T + 59 * MINUTE;
  const snapshot = fresh(state, state.initializedAt, 1);
  const { status } = buildDashboard(state, [], { snapshot, revision: 1, now: state.initializedAt });
  assert.equal(status.agent.running, true);
  assert.equal(status.agent.pid, null);
  assert.equal(status.lastCycle, null);
  assert.equal(status.valuationTime, null);
  assert.equal(status.nextObservationAt, iso(state.initializedAt + 5 * MINUTE));
});

test("staleness logs actual supplied observer errors only, never invented outcomes", () => {
  const f = fixture();
  f.options.snapshot.generatedAt = iso(f.options.now - 8 * MINUTE);
  assert.ok(!build(f).logs.some(line => /Observer error:|SQLITE_BUSY|locked/i.test(line)));
  f.options.snapshot.error = { message: "SQLITE_BUSY: supplied observer failure" };
  f.events.push({ revision: 19, ts: f.state.nextTime, kind: "OBSERVER_ERROR", data: { error: "supplied data gap" } });
  const out = build(f);
  assert.ok(out.logs.includes("Observer error: SQLITE_BUSY: supplied observer failure"));
  assert.ok(out.logs.includes("Observer error: supplied data gap"));
  assert.deepEqual(out.trades, build(fixture()).trades);
  f.options.snapshot.generatedAt = iso(f.options.now);
  assert.ok(!build(f).logs.some(line => line.startsWith("Observer error:")));
});

test("risk-halted and CASH status never manufacture entries or remove pinned positions", () => {
  for (const halt of ["none", "learning", "active", "day"]) {
    const f = fixture();
    f.state.learning.champion = null;
    f.state.learning.exploration = null;
    if (halt === "learning") f.state.learning.riskHalted = true;
    if (halt === "active") f.state.active.riskHalted = true;
    if (halt === "day") f.state.active.dayHalted = true;
    const out = build(f), holds = out.decisions.filter(d => d.kind === "STATUS");
    assert.equal(out.status.champion, "CASH");
    assert.equal(out.status.riskHalted, ["learning", "active"].includes(halt));
    assert.equal(out.status.agent.running, true);
    assert.equal(out.status.cash, f.state.active.cash);
    assert.equal(out.status.risk, RISK);
    assert.equal(out.positions.length, 1);
    assert.deepEqual(holds.map(d => d.symbol).sort(), [...SYMBOLS].sort());
    assert.ok(holds.every(d => d.decision === "HOLD"));
    assert.match(holds.find(d => d.symbol === SYMBOLS[0]).reason, /pinned trend-runner/);
    assert.equal(out.decisions.filter(d => d.kind === "FILL").length, out.trades.length);
    if (["learning", "active"].includes(halt)) assert.ok(holds.every(d => /Risk halted/.test(d.reason)));
    else if (halt === "day") assert.ok(holds.every(d => /Daily risk halt/.test(d.reason)));
    else assert.ok(holds.every(d => /CASH selected/.test(d.reason)));
  }
});

test("decisions use actual fills and revision-ordered reviews, not market signals or shadow outcomes", () => {
  const f = fixture();
  const latest = { type: "PROMOTE", ts: f.state.nextTime, previous: null, next: "reversion-fast", reason: "recorded gates passed",
    scores: { "reversion-fast": { eligible: true } } };
  f.state.learning.reviewCount = 8;
  f.events = [{ revision: 19, ts: f.state.nextTime, kind: "CLOSED_HOUR", data: { review: latest } },
    { revision: 9, ts: T + HOUR, kind: "CLOSED_HOUR", data: { review: { type: "REVIEW", ts: T + HOUR, previous: null, next: null } } }];
  const out = build(f);
  assert.equal(out.status.reviewCount, 8);
  assert.deepEqual(out.status.lastReview, latest);
  const reviews = out.decisions.filter(d => d.kind === "REVIEW");
  assert.deepEqual(reviews.map(d => d.reviewType), ["PROMOTE", "REVIEW"]);
  assert.ok(reviews.every(d => d.decision === "HOLD" && d.price === null));
  for (const d of out.decisions.filter(d => ["BUY", "SELL"].includes(d.decision))) {
    const fill = out.trades.find(t => t.id === d.fillId);
    assert.ok(fill);
    assert.equal(d.ts, fill.ts);
    assert.equal(d.price, fill.price);
    assert.equal(d.action, fill.action);
  }
  assert.ok(out.decisions.filter(d => d.kind === "STATUS").every(d => /Selected strategy reversion-fast/.test(d.reason)));
  assert.ok(out.decisions.every((d, i, rows) => i === 0 || Date.parse(rows[i - 1].ts) >= Date.parse(d.ts)));
});

test("curve has an ISO baseline and unique ordered times; drawdown excludes intrahour broker peaks", () => {
  const state = structuredClone(newState(T, "frozen-source"));
  state.active.curve = [{ ts: T, equity: 10_000 }, { ts: T + HOUR, equity: 11_000 },
    { ts: T + HOUR, equity: 11_000 }, { ts: T + 2 * HOUR, equity: 9900 }];
  state.active.peak = 50_000;
  state.active.cash = 9900;
  state.nextTime = T + 2 * HOUR;
  const { curve, status } = buildDashboard(state, [], { now: state.nextTime });
  assert.deepEqual(curve, [{ ts: iso(T), equity: 10_000 }, { ts: iso(T + HOUR), equity: 11_000 },
    { ts: iso(T + 2 * HOUR), equity: 9900 }]);
  assert.equal(status.stats.equityPeak, 11_000);
  closeEnough(status.stats.maxDrawdownPct, 10);
  assert.equal(status.equity, 9900);
  assert.equal(status.lastCycle, iso(T + 2 * HOUR));
  assert.match(status.drawdownBasis, /closed-hour equity curve only/);
  assert.match(status.drawdownBasis, /excludes intrahour/);
});

test("breakeven trades count in win-rate denominator and zero equity is not replaced with starting balance", () => {
  const f = fixture();
  const p = closedPosition({ symbol: SYMBOLS[4] });
  p.exit_price = (p.qty * p.entry_price + p.entry_fee) / (p.qty * (1 - RISK.takerFeePct));
  p.exit_fee = p.qty * p.exit_price * RISK.takerFeePct;
  p.pnl_usd = 0;
  f.state.active.closed.push(p);
  closeEnough(build(f).status.stats.winRate, 100 / 3);
  const state = structuredClone(newState(T, "frozen-source"));
  state.active.curve = [{ ts: T + HOUR, equity: 0 }];
  state.active.cash = 0;
  const { status } = buildDashboard(state, [], { now: T + HOUR });
  assert.equal(status.equity, 0);
  assert.equal(status.pnlPct, -100);
  assert.equal(status.stats.maxDrawdownPct, 100);
});

test("frozen inputs remain unchanged and returned records do not alias mutable input records", () => {
  const f = fixture();
  f.events = [{ revision: 19, ts: f.state.nextTime, kind: "CLOSED_HOUR", data: { review: {
    type: "REVIEW", ts: f.state.nextTime, next: null, previous: null, scores: { sample: { eligible: false } },
  } } }];
  const before = structuredClone(f);
  freezeDeep(f);
  const out = build(f);
  assert.deepEqual(f, before);
  out.positions[0].stop_price = 1;
  out.closed[0].pnl_usd = 1e9;
  out.trades[0].price = 1e9;
  out.curve[0].equity = 1;
  out.assets[0].position.qty = 1e9;
  out.status.lastReview.scores.sample.eligible = true;
  assert.deepEqual(f, before);
  assert.deepEqual(build(f), build(before));
});
