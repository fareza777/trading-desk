import test from "node:test";
import assert from "node:assert/strict";
import { RISK, DB_PATH } from "./config.js";
import { closedCandles, aggregate4h, fetchHistory, quoteEligible } from "./market.js";
import { analyze, ema, adx, rsi } from "./indicators.js";
import { signal, entryPause, symbolCooling } from "./strategy.js";

const HOUR = 3_600_000;
const rows = Array.from({ length: 1200 }, (_, i) => {
  const price = 100 * Math.exp(i * 0.0002) * (1 + 0.025 * Math.sin(i / 8));
  return [i * HOUR, price, price * 1.006, price * 0.994, price, 100_000];
});
const qualified = { ready: true, price: 100, trend1h: "up", trend4h: "up", aboveEma200: true,
  ema50Slope: 1, adx4h: 25, rsi1h: 55, rsiSlope: 2, pullbackTouched: true,
  ema20_1h: 99, ema50_1h: 96, previousHigh: 99.5, atr1h: 1.6, momentum1h_12h: 2 };

test("tests can never select the live ledger", () => assert.equal(DB_PATH, ":memory:"));
test("open/future candles excluded and duplicates sorted", () => {
  assert.deepEqual(closedCandles([rows[2], rows[0], rows[0], rows[1]], HOUR, 2 * HOUR), rows.slice(0, 2));
});
test("malformed candle rejected", () => {
  assert.throws(() => closedCandles([[0, 100, 99, 100, 100, 10]], HOUR, HOUR), /invalid/);
});
test("4h availability excludes partial aggregation", () => {
  assert.equal(aggregate4h(rows.slice(0, 3)).length, 0);
  assert.equal(aggregate4h(rows.slice(0, 4)).length, 1);
  assert.equal(closedCandles(aggregate4h(rows.slice(0, 8)), 4 * HOUR, 7 * HOUR).length, 1);
  assert.equal(aggregate4h([rows[0], rows[1], rows[3], rows[4]]).length, 0);
});
test("EMA200 warmup is not shortened", () => {
  assert.equal(analyze(rows.slice(0, 168), aggregate4h(rows.slice(0, 168)), 168 * HOUR).ready, false);
  assert.equal(ema(rows.slice(0, 199).map(c => c[4]), 200).at(-1), null);
});
test("only available data can affect signals", () => {
  const past = rows.slice(0, 1100);
  const before = analyze(past, aggregate4h(past), 1100 * HOUR);
  const future = rows.slice(1100).map(c => [c[0], c[1] * 10, c[2] * 10, c[3] * 10, c[4] * 10, c[5]]);
  const after = analyze([...past, ...future], aggregate4h([...past, ...future]), 1100 * HOUR);
  assert.equal(before.ready, true);
  assert.deepEqual(after, before);
});
test("gapped and stale windows cannot trade", () => {
  assert.equal(analyze(rows.filter((_, i) => i !== 800), aggregate4h(rows), 1200 * HOUR).ready, false);
  assert.equal(analyze(rows, aggregate4h(rows), 1202 * HOUR).ready, false);
});
test("EMA200 startup stability across 800 and 1200 bars", () => {
  const values = rows.map(c => c[4]);
  const long = ema(values, 200).at(-1), short = ema(values.slice(-800), 200).at(-1);
  assert.ok(Math.abs(short - long) / long < 0.0001);
});
test("ADX and RSI reference edge cases", () => {
  const trending = rows.map((_, i) => [i * HOUR, 100 + i, 101 + i, 99 + i, 100 + i, 10]);
  assert.ok(Math.abs(adx(trending).at(-1) - 100) < 1e-9);
  assert.equal(rsi(Array(100).fill(100)).at(-1), 50);
  assert.equal(rsi(Array.from({ length: 100 }, (_, i) => i + 1)).at(-1), 100);
});
test("qualified pullback gets BUY; all critical filters fail closed", () => {
  assert.equal(signal(qualified, false, qualified).decision, "BUY");
  for (const mutation of [ {ready:false}, {trend1h:"down"}, {trend4h:"down"}, {aboveEma200:false},
    {ema50Slope:0}, {adx4h:10}, {rsi1h:null}, {rsi1h:80}, {rsiSlope:-1}, {pullbackTouched:false},
    {previousHigh:101}, {ema20_1h:95}, {atr1h:0.01}, {atr1h:10} ])
    assert.equal(signal({ ...qualified, ...mutation }, false, qualified).decision, "HOLD", JSON.stringify(mutation));
  assert.equal(signal(qualified).decision, "HOLD");
  assert.equal(signal(qualified, false, { ...qualified, trend4h:"down" }).decision, "HOLD");
});
test("long only and exits do not depend on entry gates", () => {
  assert.equal(RISK.allowShort, false);
  assert.equal(signal({ ...qualified, side:"long", trend4h:"down", price:90 }, true).decision, "SELL");
  assert.equal(signal({ ...qualified, side:"short", rsi1h:80 }, true).decision, "COVER");
});
test("loss brakes and cooldowns have explicit expiry", () => {
  const now = Date.UTC(2026, 9, 28);
  const losses = [1,2,3].map(() => ({ pnl_usd:-10, closed_at:new Date(now - HOUR).toISOString() }));
  assert.match(entryPause(losses, 9990, 10000, 10000, now), /consecutive/);
  assert.equal(entryPause(losses, 9990, 10000, 10000, now + 24 * HOUR), null);
  assert.match(entryPause([], 9400, 10000, 10000, now), /drawdown/);
  assert.match(entryPause([], 9800, 10000, 10000, now), /daily/);
  const last = { closed_at:new Date(now).toISOString(), exit_reason:"stop" };
  assert.equal(symbolCooling(last, now + 11 * HOUR), true);
  assert.equal(symbolCooling(last, now + 12 * HOUR), false);
});
test("historical fetching paginates short exchange pages", async () => {
  let calls = 0;
  const exchange = { fetchOHLCV: async (_, tf, since) => { calls++; return rows.filter(c => c[0] >= since).slice(0, 100); } };
  const result = await fetchHistory(exchange, "BTC/USDT", 500, 500 * HOUR);
  assert.equal(result.length, 500);
  assert.equal(calls, 5);
  assert.equal(result.at(-1)[0], 499 * HOUR);
});
test("quote liquidity uses USD quote-volume and refuses stale/missing books", () => {
  const now = Date.now();
  const summary = { last:100, bid:99.99, ask:100.01, quoteVolume:20_000_000, timestamp:now, receivedAt:now };
  const book = { timestamp:now, bids:[[99.99,20]], asks:[[100.01,20]] };
  assert.equal(quoteEligible(summary, book, RISK, now), null);
  assert.match(quoteEligible({ ...summary, quoteVolume:10 }, book, RISK, now), /volume/);
  assert.match(quoteEligible(summary, { ...book, bids:[] }, RISK, now), /empty/);
  assert.match(quoteEligible(summary, { ...book, timestamp:now - 120000 }, RISK, now), /stale/);
});
