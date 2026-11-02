import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { DB_PATH, RISK } from "./config.js";
import { baseSlip, slipFrac, fillAt, openFill, closeFill, bookFill, feeUsd, dir, stopDistance, sizePosition, exitLevels, costBreakEven, pnlOnClose } from "./engine.js";

assert.equal(DB_PATH, ":memory:", "regressions must run with node --test and an in-memory database");
const { db, getCash, setCash, openPositions, openPosition, openSymbols, openPositionAnySide, equityNow, openTrade, closePositionQty, accrueFunding, lastClose, minutesSinceClose, kellyScale, updatePositionState, stats, snapshotEquity } = await import("./db.js");
const T = Date.UTC(2026, 9, 28, 12);
const HOUR = 3600000;
const near = (actual, expected, epsilon = 1e-8) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
const row = (id) => db.prepare("SELECT * FROM positions WHERE id=?").get(id);
const state = () => ({
  cash: getCash(),
  positions: db.prepare("SELECT * FROM positions ORDER BY id").all(),
  trades: db.prepare("SELECT * FROM trades ORDER BY id").all(),
});
const order = (overrides = {}) => ({ symbol: "BTC/USDT", side: "long", qty: 4, markPrice: 100, stopPrice: 98.5, tp1Price: 102.25, tp2Price: 104.5, sizeUsd: 400, reason: "test", slip: 0, nowMs: T, ...overrides });
const book = (overrides = {}) => ({ timestamp: T, bids: [[99.9, 10]], asks: [[100.1, 10]], ...overrides });
const close = (pos, qty, mark, reason = "test", slip = 0, depth, nowMs = T) => closePositionQty(pos, qty, mark, reason, slip, depth, nowMs);

beforeEach(() => {
  db.exec(`DROP TRIGGER IF EXISTS fail_trade;
    DROP TRIGGER IF EXISTS fail_position;
    DELETE FROM trades; DELETE FROM positions; DELETE FROM meta;
    DELETE FROM equity_snapshots; DELETE FROM decisions; DELETE FROM analyses;`);
  lastClose.clear();
  setCash(RISK.startingBalance);
});
after(() => db.close());

test("candidate database is in memory, has funding columns and a five-second busy timeout", () => {
  assert.equal(db.prepare("PRAGMA database_list").get().file, "");
  assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 5000);
  const columns = db.prepare("PRAGMA table_info(positions)").all().map((c) => c.name);
  assert.ok(columns.includes("funding_paid"));
  assert.ok(columns.includes("last_funding_at"));
  assert.equal(kellyScale(), 1);
});

for (const side of ["long", "short"]) {
  test(`${side}: full close nets both fees and reconciles cash and equity`, () => {
    const result = openTrade(order({ side, slip: RISK.slippagePct }));
    const pos = row(result.id);
    const expectedEntry = openFill(100, side);
    near(result.entry, expectedEntry);
    near(result.fee, feeUsd(4 * expectedEntry));
    near(pos.realized_pnl, -result.fee);
    near(pos.pnl_usd, -result.fee);
    near(pos.fees_paid, result.fee);
    near(pos.size_usd, 4 * expectedEntry);
    near(getCash(), RISK.startingBalance - pos.size_usd - result.fee);
    near(equityNow().equity, RISK.startingBalance - result.fee);
    assert.equal(pos.last_funding_at, new Date(T).toISOString());
    assert.equal(openPosition(pos.symbol, side).id, pos.id);
    assert.ok(openSymbols().has(`${pos.symbol}:${side}`));
    assert.equal(openPositionAnySide(pos.symbol).length, 1);
    const mark = side === "long" ? 110 : 90;
    const resultClose = close(pos, pos.qty, mark, "take_profit_2", RISK.slippagePct);
    const exit = closeFill(mark, side);
    const net = dir(side) * (exit - expectedEntry) * 4 - result.fee - feeUsd(exit * 4);
    const closed = row(pos.id);
    near(resultClose.exit, exit);
    near(resultClose.pnl, pnlOnClose(pos, 4, exit) - feeUsd(exit * 4));
    near(closed.realized_pnl, net);
    near(closed.pnl_usd, net);
    near(closed.fees_paid, result.fee + feeUsd(exit * 4));
    near(getCash(), RISK.startingBalance + net);
    near(equityNow().equity, getCash());
    assert.equal(closed.status, "closed");
    assert.equal(closed.qty_open, 0);
    assert.equal(openPositions().length, 0);
    near(stats().totalPnl, net);
    near(db.prepare("SELECT SUM(pnl_usd) n FROM trades").get().n, net);
    const before = state();
    assert.throws(() => close(pos, pos.qty, mark), /not open/);
    assert.deepEqual(state(), before);
  });

  test(`${side}: TP1 and TP2 using the same stale snapshot accumulate rather than overwrite`, () => {
    const { id, fee } = openTrade(order({ side }));
    const stale = row(id);
    const tp1 = side === "long" ? 105 : 95;
    const tp2 = side === "long" ? 110 : 90;
    close(stale, 2, tp1, "take_profit_1");
    const firstNet = -fee + 10 - feeUsd(2 * tp1);
    near(row(id).realized_pnl, firstNet);
    near(row(id).pnl_usd, firstNet);
    assert.equal(row(id).qty_open, 2);
    assert.equal(row(id).status, "open");
    assert.equal(minutesSinceClose(stale.symbol, side, T), Infinity);
    updatePositionState(id, { tp1Hit: 1, trailActive: 1, bestPrice: tp1 });
    close({ ...stale, side: "wrong", symbol: "wrong", realized_pnl: 99999 }, stale.qty_open, tp2, "take_profit_2");
    const net = firstNet + 20 - feeUsd(2 * tp2);
    const final = row(id);
    near(final.pnl_usd, net);
    near(final.realized_pnl, net);
    near(final.fees_paid, fee + feeUsd(2 * tp1) + feeUsd(2 * tp2));
    near(getCash(), RISK.startingBalance + net);
    assert.equal(final.qty_open, 0);
    assert.equal(final.qty, 4);
    assert.equal(final.tp1_hit, 1);
    assert.equal(final.trail_active, 1);
    assert.equal(final.exit_reason, "take_profit_2");
    assert.deepEqual(db.prepare("SELECT qty FROM trades ORDER BY id").all().map((r) => r.qty), [4, 2, 2]);
    assert.equal(stats().closedCount, 1);
    near(stats().totalPnl, net);
  });

  test(`${side}: ATR exits use actual book fill, and TP2 is 3R beyond TP1 at high ATR`, () => {
    const result = openTrade(order({ side, atr: 20, book: book(), slip: RISK.slippagePct }));
    const pos = row(result.id);
    const executionPrice = fillAt(side === "long" ? 100.1 : 99.9, side === "long" ? "buy" : "sell", RISK.slippagePct);
    near(result.entry, executionPrice);
    const expected = exitLevels(result.entry, 20, side);
    near(pos.stop_price, expected.stop);
    near(pos.tp1_price, expected.tp1);
    near(pos.tp2_price, expected.tp2);
    near(dir(side) * (pos.tp2_price - pos.entry_price), 3 * Math.abs(pos.entry_price - pos.stop_price));
    assert.ok(dir(side) * (pos.tp2_price - pos.tp1_price) > 0);
    near(Math.abs(pos.stop_price / pos.entry_price - 1), RISK.maxStopPct);
  });

  test(`${side}: cost break-even covers entry fee, carry, exit fee and adverse slippage`, () => {
    for (const carry of [0, 0.7]) {
      const mark = costBreakEven(100, side, feeUsd(100), carry);
      const exit = closeFill(mark, side);
      near(dir(side) * (exit - 100) - feeUsd(100) - carry - feeUsd(exit), 0);
      assert.ok(dir(side) * (mark - 100) > 0);
    }
    near(costBreakEven(100, side), costBreakEven(100, side, feeUsd(100), 0, RISK.slippagePct));
  });

  test(`${side}: sizing budgets both fees and slippage and respects fill cash and caps`, () => {
    const input = { equity: 10000, cash: 10000, entryPrice: 100, atr: 10, side, deployedUsd: 0 };
    const sized = sizePosition(input);
    assert.ok(sized);
    const entry = openFill(100, side);
    const exit = closeFill(sized.stopPrice, side);
    const loss = sized.qty * (dir(side) * (entry - exit) + feeUsd(entry) + feeUsd(exit));
    near(loss, input.equity * RISK.riskPerTradePct);
    near(sized.stopPrice, exitLevels(entry, input.atr, side).stop);
    near(sized.sizeUsd, sized.qty * input.entryPrice);
    const affordable = sizePosition({ ...input, cash: 100, atr: 0 });
    assert.ok(affordable);
    assert.ok(affordable.qty * entry * (1 + RISK.takerFeePct) <= 100 + 1e-9);
    near(affordable.qty * entry * (1 + RISK.takerFeePct), 100);
    const capped = sizePosition({ ...input, atr: 0 });
    near(capped.qty * entry, input.equity * RISK.maxPositionPct);
    const portfolio = sizePosition({ ...input, atr: 0, deployedUsd: 970 });
    assert.ok(portfolio);
    near(portfolio.qty * entry, 30);
    assert.equal(sizePosition({ ...input, deployedUsd: 1000 }), null);
    assert.equal(sizePosition({ ...input, cash: 24 }), null);
  });

  test(`${side}: optional close book uses executable quotes with base impact only`, () => {
    const { id } = openTrade(order({ side }));
    const mark = side === "short" ? 100.1 : 99.9;
    const result = close(row(id), 4, mark, "test", RISK.slippagePct, book());
    near(result.exit, closeFill(mark, side));
    assert.equal(row(id).status, "closed");
  });

  test(`${side}: risk overrides size against the actual-fill ATR stop and stressed costs`, () => {
    const risk = { ...RISK, riskPerTradePct: 0.003, maxPositionPct: 0.8, maxDeployPct: 0.9,
      stopLossPct: 0.02, maxStopPct: 0.07, atrStopMultiple: 3, tp1R: 2, tp2R: 4 };
    const input = { equity: 10000, cash: 10000, entryPrice: 100, atr: 1, side };
    const normal = sizePosition(input, risk);
    const stressed = { ...risk, takerFeePct: risk.takerFeePct * 2, slippagePct: risk.slippagePct * 2 };
    const size = sizePosition(input, stressed);
    const entry = openFill(input.entryPrice, side, stressed.slippagePct);
    const levels = exitLevels(entry, input.atr, side, stressed);
    const exit = closeFill(size.stopPrice, side, stressed.slippagePct);
    near(size.stopPrice, levels.stop);
    near(Math.abs(entry - levels.stop), 3);
    near(dir(side) * (levels.tp1 - entry), 6);
    near(dir(side) * (levels.tp2 - entry), 12);
    near(size.qty * (dir(side) * (entry - exit) + (entry + exit) * stressed.takerFeePct), 30);
    assert.ok(size.qty < normal.qty);
    near(stopDistance(entry, 0, side, risk), risk.stopLossPct);
    near(stopDistance(entry, 100, side, risk), risk.maxStopPct);
  });

  test(`${side}: overridden caps and cash use actual entry notional under double slippage`, () => {
    const risk = { ...RISK, slippagePct: RISK.slippagePct * 2, takerFeePct: RISK.takerFeePct * 2,
      riskPerTradePct: 0.5, maxPositionPct: 0.03, maxDeployPct: 0.04 };
    const input = { equity: 10000, cash: 10000, entryPrice: 100, atr: 0, side };
    const entry = openFill(input.entryPrice, side, risk.slippagePct);
    near(sizePosition(input, risk).qty * entry, 300);
    near(sizePosition({ ...input, deployedUsd: 360 }, risk).qty * entry, 40);
    assert.equal(sizePosition({ ...input, deployedUsd: 400 }, risk), null);
    near(sizePosition({ ...input, cash: 100 }, risk).qty * entry * (1 + risk.takerFeePct), 100);
  });

  test(`${side}: explicit break-even fee rate covers effective stress fees and carry`, () => {
    for (const multiplier of [0, 2]) {
      const slip = RISK.slippagePct * multiplier, feeRate = RISK.takerFeePct * multiplier;
      const entry = openFill(100, side, slip), carry = 0.7;
      const mark = costBreakEven(entry, side, entry * feeRate, carry, slip, feeRate);
      const exit = closeFill(mark, side, slip);
      near(dir(side) * (exit - entry) - (entry + exit) * feeRate - carry, 0);
    }
    for (const feeRate of [-1, 1, NaN, Infinity, "0.01", null]) {
      assert.throws(() => costBreakEven(100, side, 0, 0, 0, feeRate), /break-even/);
      assert.equal(sizePosition({ equity: 10000, cash: 10000, entryPrice: 100, side }, { ...RISK, takerFeePct: feeRate }), null);
    }
  });
}

test("supplied exit levels remain unchanged without ATR", () => {
  const { id } = openTrade(order({ stopPrice: 97, tp1Price: 108, tp2Price: 113 }));
  const pos = row(id);
  assert.deepEqual([pos.stop_price, pos.tp1_price, pos.tp2_price], [97, 108, 113]);
});

test("funding prorates elapsed time, uses fresh checkpoints and is timestamp-idempotent", () => {
  const { id, fee } = openTrade(order({ side: "short" }));
  const stale = row(id);
  const first = 4 * 110 * RISK.fundingPerHourShortPct * 0.25;
  near(accrueFunding(stale, 110, T + HOUR / 4), first);
  const checkpoint = state();
  assert.equal(accrueFunding(stale, 999, T + HOUR / 4), 0);
  assert.equal(accrueFunding(stale, 999, T), 0);
  assert.deepEqual(state(), checkpoint);
  const second = 4 * 90 * RISK.fundingPerHourShortPct * 0.75;
  near(accrueFunding(stale, 90, T + HOUR), second);
  near(row(id).funding_paid, first + second);
  near(row(id).realized_pnl, -fee - first - second);
  near(row(id).pnl_usd, -fee - first - second);
  near(row(id).fees_paid, fee);
  near(getCash(), RISK.startingBalance - 400 - fee - first - second);
  assert.equal(row(id).last_funding_at, new Date(T + HOUR).toISOString());
  near(equityNow().equity, RISK.startingBalance - fee - first - second);
});

test("partial and full short closes settle funding on remaining quantity without double charge", () => {
  const { id, fee } = openTrade(order({ side: "short" }));
  const stale = row(id);
  close(stale, 2, 100, "take_profit_1", 0, undefined, T + HOUR / 2);
  const first = 4 * 100 * RISK.fundingPerHourShortPct * 0.5;
  near(row(id).funding_paid, first);
  assert.equal(accrueFunding(stale, 100, T + HOUR / 2), 0);
  const second = 2 * 100 * RISK.fundingPerHourShortPct * 1.5;
  close(stale, stale.qty, 100, "take_profit_2", 0, undefined, T + 2 * HOUR);
  const net = -fee - feeUsd(400) - first - second;
  near(row(id).funding_paid, first + second);
  near(row(id).pnl_usd, net);
  near(getCash(), RISK.startingBalance + net);
  near(stats().totalPnl, net);
  assert.equal(accrueFunding(stale, 100, T + 3 * HOUR), 0);
  near(row(id).funding_paid, first + second);
});

test("longs incur no short funding and default funding timestamp checkpoints wall clock", () => {
  const { id } = openTrade(order({ nowMs: Date.now() - HOUR }));
  const pos = row(id);
  const cash = getCash();
  const before = Date.now();
  assert.equal(accrueFunding(pos, 100), 0);
  const after = Date.now();
  const checkpoint = Date.parse(row(id).last_funding_at);
  assert.ok(checkpoint >= before && checkpoint <= after);
  near(getCash(), cash);
  near(row(id).funding_paid, 0);
});

test("cooldown is recovered from closed rows even when process cache is empty", () => {
  const first = openTrade(order());
  const pos = row(first.id);
  close(pos, 4, 99, "stop", 0, undefined, T + 60000);
  lastClose.clear();
  assert.equal(minutesSinceClose(pos.symbol, "long", T + 6 * 60000), 5);
  assert.equal(minutesSinceClose(pos.symbol, "short", T + 6 * 60000), Infinity);
  const reopened = openTrade(order({ nowMs: T + 10 * 60000 }));
  assert.notEqual(reopened.id, first.id);
  close(row(reopened.id), 4, 101, "test", 0, undefined, T + 11 * 60000);
  lastClose.set(`${pos.symbol}:long`, 0);
  assert.equal(minutesSinceClose(pos.symbol, "long", T + 12 * 60000), 1);
});

test("book VWAP uses executable levels plus base impact, never an added half-spread", () => {
  assert.equal(baseSlip(), RISK.slippagePct);
  assert.equal(slipFrac({ bid: 90, ask: 110 }), RISK.slippagePct);
  const depth = book({ asks: [[100.1, 1], [100.2, 3]] });
  const result = bookFill(depth, "buy", 4, 100.1, RISK.slippagePct, T);
  near(result.price, ((100.1 + 3 * 100.2) / 4) * (1 + RISK.slippagePct));
  near(result.impactPct, Math.abs(result.price - 100.1) / 100.1);
  assert.equal(result.filledQty, 4);
  assert.equal(result.levels, 2);
  assert.equal(result.partial, false);
  near(bookFill(undefined, "buy", 4, 100, 0, T).price, 100);
  near(bookFill(book({ bids: [["99.9", "10"]], asks: [["100.1", "10"]] }), "sell", 2, 99.9, 0, T).price, 99.9);
});

test("invalid, empty, partial, depleted, stale and high-impact books reject opens atomically", () => {
  const badBooks = [null, {}, book({ timestamp: undefined }), book({ timestamp: NaN }),
    book({ timestamp: T - RISK.maxDataAgeMs - 1 }), book({ timestamp: T + 1 }),
    book({ bids: [] }), book({ asks: [] }), book({ asks: [[100.1, 3]] }),
    book({ asks: [[100.1, 0]] }), book({ bids: [[99.9, -1]] }), book({ asks: [[NaN, 10]] }),
    book({ asks: [[100.1, Infinity]] }), book({ asks: [[100.1]] }), book({ asks: [["", 10]] }),
    book({ bids: [[null, 10]] }), book({ asks: [[100.1, 10], [100, 10]] }),
    book({ bids: [[101, 10]] }), book({ asks: [[105, 10]] })];
  for (const depth of badBooks) {
    const before = state();
    assert.throws(() => openTrade(order({ book: depth })), /book|impact/);
    assert.deepEqual(state(), before);
  }
});

test("invalid and partial close books leave position, cash, funding and trades untouched", () => {
  const { id } = openTrade(order({ side: "short" }));
  const pos = row(id);
  for (const depth of [null, book({ timestamp: T + HOUR, asks: [] }), book({ timestamp: T + HOUR, asks: [[100.1, 1]] }), book()]) {
    const before = state();
    assert.throws(() => close(pos, 4, 100, "test", 0, depth, T + HOUR), /book/);
    assert.deepEqual(state(), before);
  }
});

test("duplicate symbols are rejected on either side", () => {
  openTrade(order());
  const before = state();
  assert.throws(() => openTrade(order()), /duplicate/);
  assert.throws(() => openTrade(order({ side: "short" })), /duplicate/);
  assert.deepEqual(state(), before);
});

test("open-count and same-direction position limits reject without writes", () => {
  openTrade(order({ qty: 1 }));
  openTrade(order({ symbol: "ETH/USDT", qty: 1 }));
  const before = state();
  assert.throws(() => openTrade(order({ symbol: "SOL/USDT", qty: 1 })), /same-direction/);
  assert.throws(() => openTrade(order({ symbol: "SOL/USDT", qty: 1, side: "short" })), /maximum open/);
  assert.deepEqual(state(), before);
});

test("actual fill notional, not supplied size, enforces position and deployment caps", () => {
  let before = state();
  assert.throws(() => openTrade(order({ qty: 6, sizeUsd: 1 })), /position notional/);
  assert.deepEqual(state(), before);
  assert.throws(() => openTrade(order({ qty: 5, slip: RISK.slippagePct, sizeUsd: 1 })), /position notional/);
  assert.deepEqual(state(), before);
  openTrade(order());
  setCash(300);
  before = state();
  assert.throws(() => openTrade(order({ symbol: "ETH/USDT", qty: 0.25, sizeUsd: 1 })), /deployment/);
  assert.deepEqual(state(), before);
});

test("cash guard includes entry fee and leaves cash unchanged on rejection", () => {
  for (const cash of [0, 99, 100]) {
    setCash(cash);
    const before = state();
    assert.throws(() => openTrade(order({ qty: 1 })), /insufficient cash/);
    assert.deepEqual(state(), before);
  }
});

test("invalid sizing and execution numbers are rejected without corrupting accounting", () => {
  const input = { equity: 10000, cash: 10000, entryPrice: 100, atr: 1, side: "long", deployedUsd: 0 };
  for (const key of ["equity", "cash", "entryPrice", "atr", "deployedUsd"]) {
    for (const value of [NaN, Infinity, -1, null, "100"]) assert.equal(sizePosition({ ...input, [key]: value }), null);
  }
  assert.equal(sizePosition({ ...input, equity: 0 }), null);
  assert.equal(sizePosition({ ...input, entryPrice: 0 }), null);
  assert.equal(sizePosition({ ...input, entryPrice: Number.MAX_VALUE }), null);
  assert.equal(sizePosition({ ...input, entryPrice: Number.MAX_VALUE, side: "short" }), null);
  assert.equal(sizePosition({ ...input, side: "invalid" }), null);
  assert.equal(sizePosition(), null);
  for (const override of [{ qty: 0 }, { qty: NaN }, { qty: Infinity }, { qty: -1 }, { markPrice: 0 }, { markPrice: NaN }, { markPrice: "100" }, { side: "invalid" }, { symbol: "" }, { atr: NaN }, { atr: -1 }, { stopPrice: NaN }, { sizeUsd: Infinity }, { slip: -1 }, { slip: 1 }, { slip: NaN }, { nowMs: NaN }]) {
    const before = state();
    assert.throws(() => openTrade(order(override)));
    assert.deepEqual(state(), before);
  }
  const { id } = openTrade(order());
  const pos = row(id);
  for (const qty of [0, -1, NaN, Infinity, "1"]) {
    const before = state();
    assert.throws(() => close(pos, qty, 100), /invalid close/);
    assert.deepEqual(state(), before);
  }
  const before = state();
  assert.throws(() => close(pos, 1, NaN), /invalid close/);
  assert.throws(() => accrueFunding(pos, NaN, T + HOUR), /invalid funding/);
  assert.throws(() => accrueFunding(pos, 100, NaN), /timestamp/);
  assert.throws(() => close(pos, 1, 100, "test", 0, undefined, T - 1), /predates/);
  assert.deepEqual(state(), before);
  assert.throws(() => costBreakEven(0, "long"));
  assert.throws(() => costBreakEven(100, "other"));
  assert.throws(() => costBreakEven(100, "short", 101));
  assert.throws(() => costBreakEven(100, "long", 1, NaN));
  assert.throws(() => costBreakEven(100, "long", 1, 0, 1));
});

test("ATR stops obey configured multiple, minimum and maximum", () => {
  near(stopDistance(100, 0, "long"), RISK.stopLossPct);
  near(stopDistance(100, 1, "short"), 0.02);
  near(stopDistance(100, 100, "long"), RISK.maxStopPct);
  assert.ok(Number.isNaN(stopDistance(NaN, 1, "long")));
  assert.throws(() => exitLevels(100, NaN, "long"));
});

test("open transaction rolls back an inserted position when trade insertion fails", () => {
  const before = state();
  db.exec("CREATE TRIGGER fail_trade BEFORE INSERT ON trades BEGIN SELECT RAISE(ABORT, 'injected trade failure'); END");
  assert.throws(() => openTrade(order()), /injected trade failure/);
  assert.deepEqual(state(), before);
  db.exec("DROP TRIGGER fail_trade");
  assert.ok(openTrade(order()).id);
});

test("close transaction rolls back funding, trades and cash when final position update fails", () => {
  const { id } = openTrade(order({ side: "short" }));
  const pos = row(id);
  const before = state();
  db.exec("CREATE TRIGGER fail_position BEFORE UPDATE OF status ON positions BEGIN SELECT RAISE(ABORT, 'injected close failure'); END");
  assert.throws(() => close(pos, 4, 90, "stop", 0, undefined, T + HOUR), /injected close failure/);
  assert.deepEqual(state(), before);
  assert.equal(lastClose.size, 0);
  assert.equal(minutesSinceClose(pos.symbol, pos.side, T + HOUR), Infinity);
  db.exec("DROP TRIGGER fail_position");
  close(pos, 4, 90, "stop", 0, undefined, T + HOUR);
  assert.equal(row(id).status, "closed");
});

test("funding transaction rolls back cash when checkpoint update fails", () => {
  const { id } = openTrade(order({ side: "short" }));
  const pos = row(id);
  const before = state();
  db.exec("CREATE TRIGGER fail_position BEFORE UPDATE OF funding_paid ON positions BEGIN SELECT RAISE(ABORT, 'injected funding failure'); END");
  assert.throws(() => accrueFunding(pos, 100, T + HOUR), /injected funding failure/);
  assert.deepEqual(state(), before);
  db.exec("DROP TRIGGER fail_position");
  near(accrueFunding(pos, 100, T + HOUR), 0.04);
});

test("statistics use net position outcomes, not profitable fills or gross P&L", () => {
  const first = openTrade(order({ qty: 2 }));
  close(row(first.id), 2, 110);
  const winner = row(first.id).pnl_usd;
  const second = openTrade(order({ side: "short", qty: 2 }));
  close(row(second.id), 2, 110, "stop", 0, undefined, T + HOUR);
  const loser = row(second.id).pnl_usd;
  const third = openTrade(order({ qty: 2 }));
  close(row(third.id), 2, 100.1);
  const feeLoser = row(third.id).pnl_usd;
  assert.ok(feeLoser < 0);
  const total = winner + loser + feeLoser;
  snapshotEquity(10000, 10000, 0);
  snapshotEquity(9900, 9900, 0);
  const result = stats();
  assert.equal(result.closedCount, 3);
  near(result.winRate, 100 / 3);
  near(result.totalPnl, total);
  near(result.expectancy, total / 3);
  near(result.profitFactor, winner / Math.abs(loser + feeLoser));
  near(result.totalFees, result.closed.reduce((sum, p) => sum + p.fees_paid, 0));
  near(getCash(), RISK.startingBalance + total);
  near(result.maxDrawdownPct, 1);
  assert.equal(result.equityPeak, 10000);
  assert.equal(result.totalFills, 6);
  assert.equal(kellyScale(), 1);
});

test("five-argument mark close stays compatible", () => {
  const result = openTrade(order({ nowMs: Date.now() }));
  const pos = row(result.id);
  const closed = closePositionQty(pos, pos.qty, 100, "test", 0);
  near(closed.exit, 100);
  assert.equal(row(pos.id).status, "closed");
});
