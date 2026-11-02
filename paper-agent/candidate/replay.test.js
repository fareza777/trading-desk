import test from "node:test";
import assert from "node:assert/strict";
import { replay } from "./backtest.js";
import { exitPlan } from "./exits.js";
import { RISK } from "./config.js";
import { closeFill, costBreakEven, dir, exitLevels, sizePosition } from "./engine.js";
import { entryPause, symbolCooling } from "./strategy.js";

const HOUR = 3_600_000;
const near = (actual, expected, epsilon = 1e-8) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
const buy = () => ({ decision: "BUY", score: 1, reason: "fixed test signal" });
const a = { ready: true, price:100, trend1h:"up", trend4h:"up", aboveEma200:true,
  ema50Slope:1, adx4h:25, rsi1h:55, rsiSlope:2, pullbackTouched:true,
  ema20_1h:99, ema50_1h:96, previousHigh:99.5, atr1h:1.6, momentum1h_12h:2 };
function fixture(bars, analysis = a, symbols = ["BTC/USDT"]) {
  return { symbols, rows: Object.fromEntries(symbols.map(symbol => [symbol, bars])),
    index: Object.fromEntries(symbols.map(symbol => [symbol, new Map(bars.map((c, i) => [c[0], i]))])),
    features: Object.fromEntries(symbols.map(symbol => [symbol, new Map(bars.map(c => [c[0], {
      candidate: { ...analysis, symbol }, legacy: { ...analysis, symbol }, quoteVolume: 20_000_000,
    }]))])), start: bars[0][0], end: bars.at(-1)[0] + HOUR };
}
test("stop-first policy is conservative when one candle hits both sides", () => {
  const result = replay(fixture([[0,100,115,90,105,1000]]));
  assert.equal(result.closed,1);
  assert.equal(result.wins,0);
  assert.ok(result.netPnl < -15);
  assert.ok(result.fees > 0);
});
test("an opening gap through both targets counts TP1 and TP2 with reconciled cash", () => {
  const result = replay(fixture([[0,100,101,99,100,1000],[HOUR,110,115,109,110,1000]]), { details: true });
  assert.equal(result.closed,1);
  assert.equal(result.wins,1);
  assert.equal(result.trades[0].tp1_hit,1);
  assert.equal(result.trades[0].exit_reason,"take_profit_2");
  assert.ok(result.netPnl > 45 && result.netPnl < 48);
});
test("unavailable signals stay in cash, not a fabricated win", () => {
  const result = replay(fixture([[0,100,115,90,105,1000]],{...a,ready:false}));
  assert.equal(result.closed,0);
  assert.equal(result.netPnl,0);
  assert.equal(result.profitFactor,null);
});
test("flat roundtrip loses costs and increasing costs never improves it", () => {
  const prepared = fixture([[0,100,101,99,100,1000]]);
  const normal = replay(prepared), stressed = replay(prepared,{frictionMultiplier:2});
  assert.equal(normal.closed,1);
  assert.ok(normal.netPnl<0);
  assert.ok(stressed.netPnl < normal.netPnl);
});
test("TP1 followed by a same-hour reversal cannot ride a later gap higher", () => {
  const result = replay(fixture([[0,100,106,99,101,1000],[HOUR,110,111,109,110,1000]]));
  assert.equal(result.closed,1);
  assert.ok(result.netPnl < 25);
});
test("short carry includes intrabar stops and final liquidation exactly once", () => {
  const short = { ...a, trend1h:"down",trend4h:"down",aboveEma200:false,rsi1h:50,
    macd4hHist:-1,macd4hHistPrev:0,momentum4h_28h:-3,volatilityPct:1,volumeSpike:{ratio:1},atr1h:1 };
  const stopped = replay(fixture([[0,100,106,99,100,1000]],short),{legacy:true});
  assert.equal(stopped.closed,1);
  assert.ok(stopped.funding > 0);
  const flat = replay(fixture([[0,100,101,99,100,1000]],short),{legacy:true});
  assert.ok(Math.abs(flat.funding - 0.1) < 1e-9);
});
test("time stop and signal-independent stop handling remain active", () => {
  const pos = { side:"long", entry_price:100, stop_price:97, tp1_price:104.5, tp2_price:109,
    best_price:100, qty_open:1, tp1_hit:0, trail_active:0, opened_at:new Date(0).toISOString() };
  assert.equal(exitPlan(pos,96,HOUR)[0].reason,"stop");
  assert.equal(exitPlan(pos,100,(RISK.timeStopCandles+1)*HOUR)[0].reason,"time_stop");
});
test("trailing stop never loosens and TP2 follows TP1 actions", () => {
  const pos = { side:"long", entry_price:100, stop_price:101, tp1_price:104.5, tp2_price:109,
    best_price:106, qty_open:1, tp1_hit:1, trail_active:1, opened_at:new Date(0).toISOString() };
  const plan = exitPlan(pos,105,HOUR);
  assert.ok(plan.at(-1).state.stop >= pos.stop_price);
  const fresh = {...pos,stop_price:97,tp1_hit:0,trail_active:0};
  const hit = exitPlan(fresh,110,HOUR);
  assert.deepEqual(hit.filter(x=>x.reason).map(x=>x.reason),["take_profit_1","take_profit_2"]);
});

for (const side of ["long", "short"]) {
  test(`${side}: same-hour TP1 stop reversal wins over a possible later TP2 touch`, () => {
    const prepared = fixture([[0,100,115,85,100,1000]]);
    prepared.rows["BTC/USDT"][0][side === "long" ? 3 : 2] = side === "long" ? 99 : 101;
    const strategy = () => ({ decision: side === "long" ? "BUY" : "SHORT", score: 1 });
    const result = replay(prepared, { strategy, risk: { allowShort: true, fundingPerHourShortPct: 0 }, details: true });
    const p = result.trades[0];
    assert.equal(p.tp1_hit, 1);
    assert.equal(p.exit_reason, "stop");
    const qty = p.size_usd / p.entry_price;
    const exit = closeFill(p.tp1_price, side), stopExit = closeFill(p.stop_price, side);
    const tpNet = dir(side) * (exit - p.entry_price) - exit * RISK.takerFeePct;
    const stopNet = dir(side) * (stopExit - p.entry_price) - stopExit * RISK.takerFeePct;
    near(result.netPnl, qty * (RISK.tp1ClosePct * tpNet + (1 - RISK.tp1ClosePct) * stopNet - p.entry_price * RISK.takerFeePct));
  });

  test(`${side}: custom strategy gets candidate analysis and benchmark for entry and exit`, () => {
    const prepared = fixture([[0,100,100.5,99.5,100,1000],[HOUR,100,100.5,99.5,100,1000]], { ...a, ready: false });
    for (const data of prepared.features["BTC/USDT"].values()) data.legacy = { legacyOnly: true };
    const calls = [];
    const strategy = (analysis, hasPosition, benchmark) => {
      assert.equal(analysis.ready, false);
      assert.equal(analysis.symbol, "BTC/USDT");
      assert.equal(analysis.legacyOnly, undefined);
      assert.equal(benchmark.ready, false);
      calls.push({ analysis, hasPosition, benchmark });
      return { decision: hasPosition ? (side === "long" ? "SELL" : "COVER") : (side === "long" ? "BUY" : "SHORT"), score: 1 };
    };
    const result = replay(prepared, { strategy, risk: { allowShort: true }, details: true });
    assert.equal(result.closed, 1);
    assert.equal(result.trades[0].side, side);
    assert.equal(result.trades[0].exit_reason, "signal_exit");
    assert.equal(Date.parse(result.trades[0].closed_at), HOUR);
    assert.equal(calls[0].hasPosition, false);
    const exit = calls.find(call => call.hasPosition);
    assert.equal(exit.analysis.side, side);
    assert.strictEqual(exit.benchmark, prepared.features["BTC/USDT"].get(HOUR).candidate);
    assert.strictEqual(calls[0].benchmark, prepared.features["BTC/USDT"].get(0).candidate);
    assert.equal(prepared.features["BTC/USDT"].get(HOUR).candidate.side, undefined);
    assert.equal(replay(prepared).closed, 0);
  });

  test(`${side}: replay sizes the actual stop using effective stress costs exactly once`, () => {
    const prepared = fixture([[0,100,110,90,100,1000]]);
    const risk = { ...RISK, allowShort: true, fundingPerHourShortPct: 0, riskPerTradePct: 0.001,
      maxPositionPct: 0.8, maxDeployPct: 0.9 };
    const strategy = () => ({ decision: side === "long" ? "BUY" : "SHORT", score: 1 });
    const run = frictionMultiplier => replay(prepared, { strategy, risk, frictionMultiplier, details: true });
    const normal = run(1), stressed = run(2);
    const effective = { ...risk, slippagePct: risk.slippagePct * 2, takerFeePct: risk.takerFeePct * 2 };
    const expected = sizePosition({ equity: risk.startingBalance, cash: risk.startingBalance, entryPrice: 100, atr: a.atr1h, side }, effective);
    const p = stressed.trades[0];
    assert.equal(stressed.closed, 1);
    assert.equal(p.exit_reason, "stop");
    near(p.stop_price, expected.stopPrice);
    near(p.size_usd / p.entry_price, expected.qty);
    near(p.entry_price, 100 * (1 + dir(side) * effective.slippagePct));
    assert.ok(p.size_usd / p.entry_price < normal.trades[0].size_usd / normal.trades[0].entry_price);
    near(stressed.netPnl, -risk.startingBalance * risk.riskPerTradePct);
    near(normal.netPnl, stressed.netPnl);
    near(stressed.fees, expected.qty * (p.entry_price + closeFill(p.stop_price, side, effective.slippagePct)) * effective.takerFeePct);
    assert.equal(risk.slippagePct, RISK.slippagePct);
    assert.equal(risk.takerFeePct, RISK.takerFeePct);
  });

  test(`${side}: TP1 break-even uses effective costs and respects trailAfterTp1`, () => {
    const risk = { ...RISK, takerFeePct: RISK.takerFeePct * 2, slippagePct: RISK.slippagePct * 2, trailAfterTp1: false };
    const levels = exitLevels(100, 1.5, side, risk);
    const pos = { side, entry_price: 100, stop_price: levels.stop, tp1_price: levels.tp1, tp2_price: levels.tp2,
      best_price: 100, tp1_hit: 0, trail_active: 0, opened_at: new Date(0).toISOString() };
    const plan = exitPlan(pos, levels.tp1, HOUR, risk);
    const state = plan.find(action => action.state?.tp1Hit).state;
    assert.equal(state.trailActive, 0);
    const be = costBreakEven(100, side, 100 * risk.takerFeePct, 0, risk.slippagePct, risk.takerFeePct);
    near(state.stop, be);
    near(plan.at(-1).state.stop, be);
    const exit = closeFill(be, side, risk.slippagePct);
    near(dir(side) * (exit - 100) - (100 + exit) * risk.takerFeePct, 0);
    const trailing = exitPlan(pos, levels.tp1, HOUR, { ...risk, trailAfterTp1: true });
    assert.equal(trailing.find(action => action.state?.tp1Hit).state.trailActive, 1);
  });
}

test("replay overrides cap actual notional under double slippage and set ATR exit levels", () => {
  const prepared = fixture([[0,100,100.1,99.9,100,1000]], a, ["BTC/USDT", "ETH/USDT", "SOL/USDT"]);
  const risk = { startingBalance: 20000, maxPositionPct: 0.025, maxDeployPct: 0.04,
    maxOpenPositions: 3, maxSameDirection: 3, riskPerTradePct: 0.1,
    stopLossPct: 0.02, maxStopPct: 0.04, atrStopMultiple: 1, tp1R: 2, tp2R: 4 };
  const original = { ...risk };
  const result = replay(prepared, { strategy: buy, risk, frictionMultiplier: 2, details: true });
  const effective = { ...RISK, ...risk, slippagePct: RISK.slippagePct * 2, takerFeePct: RISK.takerFeePct * 2 };
  assert.equal(result.closed, 2);
  const [first, second] = result.trades;
  near(first.size_usd, risk.startingBalance * risk.maxPositionPct);
  const qty = first.size_usd / first.entry_price;
  const exit = closeFill(100, "long", effective.slippagePct);
  const equity = risk.startingBalance + qty * (exit - first.entry_price) - qty * (exit + first.entry_price) * effective.takerFeePct;
  near(second.size_usd, equity * risk.maxDeployPct - first.size_usd);
  for (const p of result.trades) {
    assert.ok(p.size_usd <= risk.startingBalance * risk.maxPositionPct + 1e-8);
    near(p.entry_price, 100 * (1 + effective.slippagePct));
    const levels = exitLevels(p.entry_price, a.atr1h, p.side, effective);
    near(p.stop_price, levels.stop);
    near(p.tp1_price, levels.tp1);
    near(p.tp2_price, levels.tp2);
  }
  assert.deepEqual(risk, original);
  assert.deepEqual(result, replay(prepared, { strategy: buy, risk, frictionMultiplier: 2, details: true }));
});

test("details add copied trades, curve and per-symbol totals without changing metrics", () => {
  const prepared = fixture([[0,100,101,99,100,1000]], a, ["BTC/USDT", "ETH/USDT"]);
  const strategy = analysis => ({ decision: analysis.symbol === "BTC/USDT" ? "BUY" : "HOLD", score: 1 });
  const plain = replay(prepared, { strategy });
  const detailed = replay(prepared, { strategy, details: true });
  const { trades, curve, perSymbol, ...metrics } = detailed;
  assert.deepEqual(metrics, plain);
  assert.equal(trades.length, plain.closed);
  assert.deepEqual(perSymbol["ETH/USDT"], { netPnl: 0, trades: 0 });
  near(perSymbol["BTC/USDT"].netPnl, plain.netPnl);
  assert.equal(perSymbol["BTC/USDT"].trades, 1);
  near(curve.at(-1).equity, RISK.startingBalance + plain.netPnl);
  trades[0].pnl_usd = 999;
  curve[0].equity = 0;
  assert.deepEqual(replay(prepared, { strategy }), plain);
});

test("entry pauses and both cooldown types use the supplied risk", () => {
  const risk = { ...RISK, circuitBreakPct: 0.2, dailyHaltPct: 0.1,
    maxConsecutiveLosses: 2, lossPauseHours: 3, stopCooldownMin: 30, symbolCooldownMin: 15 };
  assert.equal(entryPause([], 9400, 10000, 9000, HOUR, risk), null);
  assert.equal(entryPause([], 9400, 10000, 9000, HOUR), "peak drawdown circuit breaker");
  assert.equal(entryPause([], 9500, 9500, 10000, HOUR, risk), null);
  assert.equal(entryPause([], 9500, 9500, 10000, HOUR), "daily loss halt");
  const losses = [0, HOUR].map(time => ({ pnl_usd: -1, closed_at: new Date(time).toISOString() }));
  assert.equal(entryPause(losses, 10000, 10000, 10000, 2 * HOUR), null);
  assert.equal(entryPause(losses, 10000, 10000, 10000, 2 * HOUR, risk), "consecutive losses pause");
  assert.equal(entryPause(losses, 10000, 10000, 10000, 4 * HOUR, risk), null);
  for (const [reason, minutes] of [["stop", 30], ["signal_exit", 15]]) {
    const last = { closed_at: new Date(0).toISOString(), exit_reason: reason };
    assert.equal(symbolCooling(last, minutes * 60000 - 1, risk), true);
    assert.equal(symbolCooling(last, minutes * 60000, risk), false);
    assert.equal(symbolCooling(last, minutes * 60000), true);
  }
  assert.equal(symbolCooling(null, 0, risk), false);
});

test("replay applies stop cooldown and consecutive-loss pause overrides", () => {
  const prepared = fixture(Array.from({ length: 7 }, (_, i) => [i * HOUR,100,100.1,95,100,1000]));
  const risk = { circuitBreakPct: 0.5, dailyHaltPct: 0.5, maxConsecutiveLosses: 10 };
  assert.equal(replay(prepared, { strategy: buy, risk }).closed, 1);
  assert.equal(replay(prepared, { strategy: buy, risk: { ...risk, stopCooldownMin: 60 } }).closed, 4);
  assert.equal(replay(prepared, { strategy: buy, risk: { ...risk, stopCooldownMin: 0 } }).closed, 7);
  assert.equal(replay(prepared, { strategy: buy, risk: { ...risk, stopCooldownMin: 0, maxConsecutiveLosses: 2, lossPauseHours: 2 } }).closed, 3);
  assert.equal(replay(prepared, { strategy: buy, risk: { ...risk, stopCooldownMin: 0, maxConsecutiveLosses: 2, lossPauseHours: 0 } }).closed, 7);
});

test("replay applies ordinary symbol cooldown overrides after custom signal exits", () => {
  const prepared = fixture(Array.from({ length: 4 }, (_, i) => [i * HOUR,100,100.1,99.9,100,1000]));
  const strategy = (analysis, hasPosition) => ({ decision: hasPosition ? "SELL" : "BUY", score: 1 });
  assert.equal(replay(prepared, { strategy, frictionMultiplier: 0 }).closed, 1);
  assert.equal(replay(prepared, { strategy, frictionMultiplier: 0, risk: { symbolCooldownMin: 0 } }).closed, 4);
});

test("legacySignals uses candidate sizing and exit risk, not legacy helper defaults", () => {
  const prepared = fixture([[0,100,110,90,100,1000]], { ...a, volatilityPct: 1, volumeSpike: { ratio: 1 } });
  const risk = { riskPerTradePct: 0.001, atrStopMultiple: 1, stopLossPct: 0.02 };
  const result = replay(prepared, { legacySignals: true, risk, frictionMultiplier: 2, details: true });
  assert.equal(result.closed, 1);
  near(result.netPnl, -10);
  near(result.trades[0].stop_price, result.trades[0].entry_price * 0.98);
});

test("replay TP1 runner breaks even with stressed costs and no trailing activation", () => {
  const prepared = fixture([[0,100,105,99,104,1000],[HOUR,104,104,100,101,1000]]);
  const result = replay(prepared, { strategy: buy, frictionMultiplier: 2, risk: { trailAfterTp1: false }, details: true });
  assert.equal(result.closed, 1);
  const p = result.trades[0], feeRate = RISK.takerFeePct * 2, slip = RISK.slippagePct * 2;
  assert.equal(p.tp1_hit, 1);
  assert.equal(p.trail_active, 0);
  assert.equal(p.exit_reason, "stop");
  near(p.stop_price, costBreakEven(p.entry_price, p.side, p.entry_price * feeRate, 0, slip, feeRate));
  const tp1Exit = closeFill(p.tp1_price, p.side, slip);
  const qty = p.size_usd / p.entry_price;
  near(result.netPnl, qty * RISK.tp1ClosePct * (tp1Exit - p.entry_price - (tp1Exit + p.entry_price) * feeRate));
});

test("replay rejects ambiguous strategies, invalid friction and invalid effective costs", () => {
  const prepared = fixture([[0,100,101,99,100,1000]]);
  for (const mode of [{ legacy: true }, { legacySignals: true }, { legacy: true, legacySignals: true }]) {
    assert.throws(() => replay(prepared, { ...mode, strategy: buy }), /custom strategy.*legacy/);
  }
  for (const strategy of [false, "unknown", {}, 1]) assert.throws(() => replay(prepared, { strategy }), /strategy must be/);
  for (const frictionMultiplier of [-1, NaN, Infinity, -Infinity, "2", null]) {
    assert.throws(() => replay(prepared, { frictionMultiplier }), /friction/);
  }
  for (const key of ["takerFeePct", "slippagePct"]) {
    for (const value of [-0.1, NaN, Infinity, 0.5]) {
      assert.throws(() => replay(prepared, { risk: { [key]: value }, frictionMultiplier: 2 }), /effective fee or slippage/);
    }
  }
  for (const risk of [false, "unknown", []]) assert.throws(() => replay(prepared, { risk }), /risk override/);
  near(replay(prepared, { strategy: buy, frictionMultiplier: 0 }).fees, 0);
});

test("replay rejects unknown, nonfinite, unaligned, empty and out-of-bounds windows", () => {
  const prepared = fixture([[0,100,101,99,100,1000],[HOUR,100,101,99,100,1000]], { ...a, ready: false });
  for (const key of ["from", "to"]) {
    for (const value of ["unknown", null, NaN, Infinity, -Infinity, 1, HOUR + 1]) {
      assert.throws(() => replay(prepared, { [key]: value }), /replay window/);
    }
  }
  for (const options of [{ from: -HOUR }, { to: 3 * HOUR }, { from: HOUR, to: HOUR }, { from: HOUR, to: 0 }, { to: 0 }]) {
    assert.throws(() => replay(prepared, options), /replay window/);
  }
  const result = replay(prepared, { from: HOUR, to: 2 * HOUR, details: true });
  assert.equal(result.curve.length, 1);
  assert.equal(result.curve[0].ts, 2 * HOUR);
  assert.equal(result.from, new Date(HOUR).toISOString());
  assert.equal(result.to, new Date(2 * HOUR).toISOString());
  prepared.features["BTC/USDT"].delete(HOUR);
  assert.throws(() => replay(prepared), /missing prepared replay data/);
});

test("replay rejects missing indexed bars or benchmark data before invoking a custom signal", () => {
  for (const damage of [
    p => p.index["BTC/USDT"].delete(0),
    p => { p.rows["BTC/USDT"] = []; },
    p => { p.symbols = []; },
  ]) {
    const prepared = fixture([[0,100,101,99,100,1000]]);
    damage(prepared);
    let called = false;
    assert.throws(() => replay(prepared, { strategy: () => { called = true; return buy(); } }), /replay/);
    assert.equal(called, false);
  }
  const prepared = fixture([[0,100,101,99,100,1000]]);
  delete prepared.features["BTC/USDT"].get(0).candidate;
  assert.throws(() => replay(prepared, { legacySignals: true }), /missing benchmark candidate/);
});
