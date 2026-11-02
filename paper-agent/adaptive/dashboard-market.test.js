import test from "node:test";
import assert from "node:assert/strict";
import { DashboardMarket } from "./dashboard-market.js";
import { SYMBOLS } from "../candidate/config.js";
import { ema, rsi, pctChange, volatility, volumeSpike } from "../candidate/indicators.js";

const HOUR = 3_600_000;
const WEEK = 168 * HOUR;
const MONDAY = Date.UTC(1970, 0, 5);
const NOW = Date.UTC(2026, 9, 29, 12, 30);
const STEPS = { "15m": HOUR / 4, "1h": HOUR, "4h": 4 * HOUR, "1w": WEEK };
const FIELDS = ["price", "priceTs", "trend1h", "trend4h", "rsi1h", "momentum1h", "momentum4h",
  "volatility", "volSpike", "vol24", "high24", "low24", "candles1h", "error"].sort();

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function bar(t, c = 100, v = 1000) { return [t, c - 0.1, c + 1, c - 1, c, v]; }

function recentRows(symbol, tf, now, count = 300, includeOpen = true) {
  const step = STEPS[tf], offset = tf === "1w" ? MONDAY : 0;
  const start = Math.floor((now - offset) / step) * step + offset;
  const base = (SYMBOLS.indexOf(symbol) + 1) * 1000 + step / HOUR;
  return Array.from({ length: count }, (_, i) => bar(
    start - (count - i - (includeOpen ? 1 : 0)) * step,
    base + i / 5 + Math.sin(i / 5), 1000 + 3 * i,
  ));
}

function fixture(start = NOW) {
  const f = { now: start, candleCalls: [], tickerCalls: [], closes: 0 };
  f.rows = (symbol, tf) => recentRows(symbol, tf, f.now);
  f.quote = symbol => ({ symbol, last: 9000 + SYMBOLS.indexOf(symbol), timestamp: f.now,
    quoteVolume: 23_456_789 + SYMBOLS.indexOf(symbol), baseVolume: 123,
    high: 10_000 + SYMBOLS.indexOf(symbol), low: 8000 + SYMBOLS.indexOf(symbol) });
  // Only these fake public-data methods exist; no real exchange is constructed.
  f.exchange = {
    async fetchOHLCV(symbol, tf, since, limit) {
      assert.ok(SYMBOLS.includes(symbol));
      assert.ok(Object.hasOwn(STEPS, tf));
      assert.equal(since, undefined);
      assert.equal(limit, 300);
      f.candleCalls.push([symbol, tf, since, limit]);
      return f.rows(symbol, tf);
    },
    async fetchTicker(symbol) {
      assert.ok(SYMBOLS.includes(symbol));
      f.tickerCalls.push(symbol);
      return f.quote(symbol);
    },
    async close() { f.closes++; },
  };
  f.market = new DashboardMarket({ exchange: f.exchange, clock: () => f.now });
  return f;
}

function assertNullQuote(entry) {
  for (const field of ["price", "vol24", "high24", "low24"]) assert.equal(entry[field], null, field);
}

test("construction is passive and exposes synchronous null context for exactly five assets", async () => {
  const f = fixture();
  assert.equal(SYMBOLS.length, 5);
  assert.deepEqual(Object.keys(f.market.data), SYMBOLS);
  assert.equal(f.market.ready, false);
  assert.equal(f.market.error, null);
  for (const entry of Object.values(f.market.data)) {
    assert.deepEqual(Object.keys(entry).sort(), FIELDS);
    assert.deepEqual(entry.candles1h, []);
    for (const field of FIELDS.filter(field => field !== "candles1h")) assert.equal(entry[field], null);
  }
  assert.equal(f.candleCalls.length + f.tickerCalls.length, 0);
  await f.market.close();
});

test("candles have a 30-second per-symbol/timeframe cache and detached seconds-based objects", async () => {
  const f = fixture(), symbol = SYMBOLS[0];
  const first = await f.market.candles(symbol, "1h");
  assert.equal(first.length, 299);
  assert.deepEqual(Object.keys(first[0]), ["t", "o", "h", "l", "c", "v"]);
  const raw = f.rows(symbol, "1h");
  assert.equal(first[0].t, raw[0][0] / 1000);
  first[0].c = -1;
  f.now += 29_999;
  assert.equal((await f.market.candles(symbol, "1h"))[0].c, raw[0][4]);
  assert.equal(f.candleCalls.length, 1);
  const other = await f.market.candles(SYMBOLS[1], "1h");
  await f.market.candles(symbol, "4h");
  assert.notEqual(other[0].c, raw[0][4]);
  assert.equal(f.candleCalls.length, 3);
  f.now++;
  await f.market.candles(symbol, "1h");
  assert.equal(f.candleCalls.length, 4);
  await f.market.close();
});

test("identical candle requests singleflight, without merging other symbols or timeframes", async () => {
  const f = fixture(), gate = deferred(), source = f.rows;
  f.rows = async (symbol, tf) => { await gate.promise; return source(symbol, tf); };
  const requests = [f.market.candles(SYMBOLS[0], "1h"), f.market.candles(SYMBOLS[0], "1h"),
    f.market.candles(SYMBOLS[1], "1h"), f.market.candles(SYMBOLS[0], "4h")];
  assert.equal(f.candleCalls.length, 3);
  gate.resolve();
  const [first, duplicate, otherSymbol, otherTf] = await Promise.all(requests);
  assert.deepEqual(first, duplicate);
  assert.notStrictEqual(first, duplicate);
  assert.notEqual(first[0].c, otherSymbol[0].c);
  assert.notEqual(first[0].t, otherTf[0].t);
  await f.market.close();
});

test("invalid symbols/timeframes fail at the boundary before any exchange call", async () => {
  const f = fixture();
  const invalid = [
    ["DOGE/USDT", "1h"], ["btc/usdt", "1h"], ["BTC/USDT:USDT", "1h"],
    [" BTC/USDT", "1h"], ["__proto__", "1h"], [null, "1h"],
    [{ toString: () => SYMBOLS[0] }, "1h"],
    ...["1d", "1H", "1W", "constructor", "toString", "", null, undefined, 3600].map(tf => [SYMBOLS[0], tf]),
  ];
  for (const [symbol, tf] of invalid) {
    await assert.rejects(f.market.candles(symbol, tf), error => {
      assert.ok(error instanceof RangeError);
      assert.equal(error.code, "ERR_MARKET_VALIDATION");
      assert.equal(error.status, 400);
      assert.equal(error.statusCode, 400);
      return true;
    });
  }
  assert.equal(f.candleCalls.length + f.tickerCalls.length, 0);
  await f.market.close();
});

test("malformed, non-finite, misaligned and unordered OHLCV is rejected, including open rows", async t => {
  const start = Math.floor(NOW / HOUR) * HOUR;
  const invalid = {
    "non-array response": null,
    "non-array row": [null],
    "short row": [[start - HOUR, 100]],
    "non-finite close": [bar(start - HOUR, NaN)],
    "infinite volume": [bar(start - HOUR, 100, Infinity)],
    "negative volume": [bar(start - HOUR, 100, -1)],
    "string price": [[start - HOUR, "100", 101, 99, 100, 1]],
    "zero price": [[start - HOUR, 0, 101, 99, 100, 1]],
    "high below open": [[start - HOUR, 100, 99, 98, 99, 1]],
    "low above close": [[start - HOUR, 100, 101, 100, 99, 1]],
    "off-grid timestamp": [bar(start - HOUR + 1)],
    "fractional timestamp": [bar(start - HOUR + 0.5)],
    "negative timestamp": [bar(-HOUR)],
    "duplicate timestamp": [bar(start - HOUR), bar(start - HOUR)],
    "reversed timestamp": [bar(start - HOUR), bar(start - 2 * HOUR)],
    "malformed open candle": [bar(start - HOUR), bar(start, 100, -1)],
  };
  for (const [name, rows] of Object.entries(invalid)) await t.test(name, async () => {
    const f = fixture();
    f.rows = () => rows;
    await assert.rejects(f.market.candles(SYMBOLS[0], "1h"), /invalid OHLCV/);
    f.rows = () => [bar(start - HOUR)];
    assert.equal((await f.market.candles(SYMBOLS[0], "1h")).length, 1);
    assert.equal(f.candleCalls.length, 2);
    await f.market.close();
  });
});

test("15m, 1h, 4h and Monday-UTC weekly candles exclude open/future bars until their close", async t => {
  for (const [tf, step] of Object.entries(STEPS)) await t.test(tf, async () => {
    const offset = tf === "1w" ? MONDAY : 0;
    const start = Math.floor((NOW - offset) / step) * step + offset;
    const f = fixture(start + step - 60_000);
    const raw = [bar(start - step), bar(start), bar(start + step)];
    f.rows = () => raw;
    assert.deepEqual((await f.market.candles(SYMBOLS[0], tf)).map(c => c.t), [(start - step) / 1000]);
    f.now = start + step;
    assert.deepEqual((await f.market.candles(SYMBOLS[0], tf)).map(c => c.t), [(start - step) / 1000, start / 1000]);
    assert.deepEqual(raw, [bar(start - step), bar(start), bar(start + step)]);
    if (tf === "1w") assert.equal(new Date(start).getUTCDay(), 1);
    await f.market.close();
  });
});

test("weekly validation rejects epoch-Thursday and Sunday alignment; midweek stays open", async () => {
  const f = fixture();
  const monday = Math.floor((f.now - MONDAY) / WEEK) * WEEK + MONDAY;
  f.rows = () => [bar(monday - WEEK), bar(monday)];
  assert.deepEqual((await f.market.candles(SYMBOLS[0], "1w")).map(c => c.t), [(monday - WEEK) / 1000]);
  for (const timestamp of [Math.floor(NOW / WEEK) * WEEK, monday - 24 * HOUR]) {
    f.now += 30_000;
    f.rows = () => [bar(timestamp)];
    await assert.rejects(f.market.candles(SYMBOLS[0], "1w"), /invalid OHLCV/);
  }
  await f.market.close();
});

test("a slow response crossing Monday cannot relabel a captured partial week as closed", async () => {
  const monday = Date.UTC(2026, 10, 2);
  const f = fixture(monday - 1), gate = deferred();
  f.rows = () => gate.promise;
  const pending = f.market.candles(SYMBOLS[0], "1w");
  f.now = monday + 1000;
  gate.resolve([bar(monday - 2 * WEEK), bar(monday - WEEK)]);
  assert.deepEqual((await pending).map(c => c.t), [(monday - 2 * WEEK) / 1000]);
  await f.market.close();
});

test("expired candle requests propagate failures, release singleflight and never serve stale-as-fresh", async () => {
  const f = fixture(), source = f.rows;
  await f.market.candles(SYMBOLS[0], "1h");
  f.now += 30_000;
  const gate = deferred(), failure = new Error("public candles unavailable");
  f.rows = () => gate.promise;
  const a = f.market.candles(SYMBOLS[0], "1h"), b = f.market.candles(SYMBOLS[0], "1h");
  const rejected = Promise.all([assert.rejects(a, error => error === failure), assert.rejects(b, error => error === failure)]);
  gate.reject(failure);
  await rejected;
  assert.equal(f.candleCalls.length, 2);
  f.rows = () => { throw failure; };
  await assert.rejects(f.market.candles(SYMBOLS[0], "1h"), error => error === failure);
  assert.equal(f.candleCalls.length, 3);
  f.rows = source;
  await f.market.candles(SYMBOLS[0], "1h");
  assert.equal(f.candleCalls.length, 4);
  await f.market.close();
});

test("refresh returns five isolated, bounded display contexts and reuses raw candle cache", async () => {
  const f = fixture();
  await f.market.candles(SYMBOLS[0], "1h");
  const data = await f.market.refresh();
  assert.deepEqual(Object.keys(data), SYMBOLS);
  assert.deepEqual(f.tickerCalls, SYMBOLS);
  assert.equal(f.candleCalls.length, 10);
  assert.equal(new Set(f.candleCalls.map(([s, tf]) => `${s}:${tf}`)).size, 10);
  assert.equal(f.market.ready, true);
  assert.equal(f.market.error, null);
  for (const symbol of SYMBOLS) {
    const entry = data[symbol], quote = f.quote(symbol);
    const rows1 = f.rows(symbol, "1h").slice(0, -1), rows4 = f.rows(symbol, "4h").slice(0, -1);
    const c1 = rows1.map(c => c[4]), c4 = rows4.map(c => c[4]);
    assert.deepEqual(Object.keys(entry).sort(), FIELDS);
    assert.equal(entry.price, quote.last);
    assert.equal(entry.priceTs, quote.timestamp);
    assert.equal(entry.vol24, quote.quoteVolume);
    assert.notEqual(entry.vol24, quote.baseVolume * quote.last);
    assert.equal(entry.high24, quote.high);
    assert.equal(entry.low24, quote.low);
    assert.equal(entry.trend1h, ema(c1, 20).at(-1) > ema(c1, 50).at(-1) ? "up" : "down");
    assert.equal(entry.trend4h, ema(c4, 20).at(-1) > ema(c4, 50).at(-1) ? "up" : "down");
    assert.equal(entry.rsi1h, rsi(c1, 14).at(-1));
    assert.ok(entry.rsi1h >= 0 && entry.rsi1h <= 100);
    assert.equal(entry.momentum1h, pctChange(c1, 12));
    assert.equal(entry.momentum4h, pctChange(c4, 7));
    assert.equal(entry.volatility, volatility(c1, 24));
    assert.equal(entry.volSpike, volumeSpike(rows1.map(c => c[5]), 20).ratio);
    assert.equal(entry.error, null);
    assert.deepEqual(entry.candles1h, rows1);
    assert.ok(entry.candles1h.length <= 300);
    const nextTime = Math.floor(f.now / HOUR) * HOUR;
    const mark = entry.candles1h.find(c => c[0] === nextTime - HOUR)[4];
    assert.equal(mark, rows1.at(-1)[4]);
    assert.notEqual(mark, entry.price); // Historical accounting must not use the display ticker.
    for (const forbidden of ["signal", "decision", "score", "regime", "aboveEma200", "atr1h", "positions"]) {
      assert.equal(Object.hasOwn(entry, forbidden), false);
    }
  }
  data[SYMBOLS[0]].price = -1;
  data[SYMBOLS[0]].candles1h[0][4] = -1;
  assert.ok(f.market.data[SYMBOLS[0]].price > 0);
  assert.ok((await f.market.candles(SYMBOLS[0], "1h"))[0].c > 0);
  assert.ok(f.market.data[SYMBOLS[0]].candles1h[0][4] > 0);
  await f.market.close();
});

test("refresh singleflights with other refreshes and concurrent chart requests", async () => {
  const f = fixture(), gate = deferred(), source = f.rows, quote = f.quote;
  f.rows = async (symbol, tf) => { await gate.promise; return source(symbol, tf); };
  f.quote = async symbol => { await gate.promise; return quote(symbol); };
  const chart = f.market.candles(SYMBOLS[0], "1h");
  const a = f.market.refresh(), b = f.market.refresh();
  assert.equal(f.candleCalls.length, 10);
  assert.equal(f.tickerCalls.length, 5);
  gate.resolve();
  const [first, second, candles] = await Promise.all([a, b, chart]);
  assert.deepEqual(first, second);
  assert.equal(first[SYMBOLS[0]].candles1h.length, candles.length);
  await f.market.close();
});

test("refresh caches successful context for 30 seconds, before quotes expire", async () => {
  const f = fixture();
  await f.market.refresh();
  f.now += 29_999;
  await f.market.candles(SYMBOLS[0], "1h");
  await f.market.refresh();
  assert.equal(f.tickerCalls.length, 5);
  assert.equal(f.candleCalls.length, 10);
  f.now++;
  await f.market.refresh();
  assert.equal(f.tickerCalls.length, 10);
  assert.equal(f.candleCalls.length, 20);
  await f.market.close();
});

test("15-second scheduling renews quotes despite response latency", async () => {
  const f = fixture(), gate = deferred(), quote = f.quote;
  f.quote = async symbol => { const value = quote(symbol); await gate.promise; return value; };
  const pending = f.market.refresh();
  f.now += 5000;
  gate.resolve();
  await pending;
  f.quote = quote;
  f.now = NOW + 15_000;
  await f.market.refresh();
  assert.equal(f.tickerCalls.length, 5);
  f.now = NOW + 30_000;
  await f.market.refresh();
  assert.equal(f.tickerCalls.length, 10);
  for (const entry of Object.values(f.market.data)) {
    assert.equal(entry.priceTs, f.now);
    assert.equal(entry.error, null);
  }
  await f.market.close();
});

test("missing, stale, future and mismatched tickers produce nulls, never synthetic quotes", async () => {
  const f = fixture(), quote = f.quote;
  f.quote = symbol => {
    const value = quote(symbol);
    if (symbol === SYMBOLS[0]) delete value.timestamp;
    if (symbol === SYMBOLS[1]) { delete value.last; delete value.quoteVolume; delete value.high; delete value.low; }
    if (symbol === SYMBOLS[2]) value.timestamp -= 60_001;
    if (symbol === SYMBOLS[3]) value.timestamp += 5001;
    if (symbol === SYMBOLS[4]) value.quoteVolume = 0;
    return value;
  };
  const data = await f.market.refresh();
  assert.equal(data[SYMBOLS[0]].priceTs, f.now);
  assert.equal(data[SYMBOLS[0]].error, null);
  assertNullQuote(data[SYMBOLS[1]]);
  assert.match(data[SYMBOLS[1]].error, /missing or invalid ticker/);
  for (const symbol of [SYMBOLS[2], SYMBOLS[3]]) {
    assertNullQuote(data[symbol]);
    assert.match(data[symbol].error, /stale or future quote/);
  }
  assert.equal(data[SYMBOLS[2]].priceTs, f.now - 60_001);
  assert.equal(data[SYMBOLS[4]].vol24, 0);
  assert.equal(data[SYMBOLS[4]].error, null);
  f.quote = symbol => ({ ...quote(symbol), symbol: "DOGE/USDT" });
  const mismatched = await f.market.refresh();
  for (const entry of Object.values(mismatched)) {
    assertNullQuote(entry);
    assert.equal(entry.priceTs, null);
    assert.match(entry.error, /invalid ticker response or symbol/);
  }
  await f.market.close();
});

test("invalid ticker values and timestamps are not coerced or replaced with candle prices", async t => {
  const cases = [
    [null, "response"], [{ timestamp: "now" }, "timestamp"], [{ timestamp: NaN }, "timestamp"],
    [{ last: "123" }, "last"], [{ last: 0 }, "last"], [{ last: Infinity }, "last"],
    [{ quoteVolume: -1 }, "quoteVolume"], [{ high: 99, low: 100 }, "high/low"],
  ];
  for (const [patch, expected] of cases) await t.test(String(expected), async () => {
    const f = fixture(), quote = f.quote;
    f.quote = symbol => patch === null ? null : { ...quote(symbol), ...patch };
    const data = await f.market.refresh();
    for (const entry of Object.values(data)) assert.ok(entry.error.includes(expected));
    if (expected === "last") assert.equal(data[SYMBOLS[0]].price, null);
    if (expected === "quoteVolume") assert.equal(data[SYMBOLS[0]].vol24, null);
    if (expected === "high/low") assert.equal(data[SYMBOLS[0]].high24, null);
    await f.market.close();
  });
});

test("receivedAt is captured when a timestamp-less ticker arrives, not when slow candles finish", async () => {
  const f = fixture(), gate = deferred(), arrived = deferred(), source = f.rows;
  f.exchange.fetchTicker = symbol => {
    f.tickerCalls.push(symbol);
    const { timestamp, ...quote } = f.quote(symbol);
    if (f.tickerCalls.length === SYMBOLS.length) queueMicrotask(() => arrived.resolve());
    return quote;
  };
  f.rows = async (symbol, tf) => { await gate.promise; return source(symbol, tf); };
  const pending = f.market.refresh();
  await arrived.promise;
  f.now += 10_000;
  gate.resolve();
  const data = await pending;
  for (const entry of Object.values(data)) assert.equal(entry.priceTs, NOW);
  await f.market.close();
});

test("data expires quotes without changing timestamps and refresh bypasses cache when stale", async () => {
  const f = fixture(), quote = f.quote;
  f.quote = symbol => ({ ...quote(symbol), timestamp: f.now - 45_000 });
  const first = await f.market.refresh();
  f.now += 15_001;
  const cached = f.market.data;
  assert.equal(f.tickerCalls.length, 5);
  for (const symbol of SYMBOLS) {
    assertNullQuote(cached[symbol]);
    assert.equal(cached[symbol].priceTs, first[symbol].priceTs);
    assert.deepEqual(cached[symbol].candles1h, first[symbol].candles1h);
    assert.equal(cached[symbol].rsi1h, first[symbol].rsi1h);
    assert.match(cached[symbol].error, /stale/);
  }
  assert.equal(f.market.ready, false);
  assert.match(f.market.error, /stale/);
  f.quote = quote;
  const recovered = await f.market.refresh();
  assert.equal(f.tickerCalls.length, 10);
  assert.equal(f.market.ready, true);
  for (const entry of Object.values(recovered)) assert.equal(entry.priceTs, f.now);
  await f.market.close();
});

test("temporary failures retain prior context and quote timestamp, expose errors and allow retry", async () => {
  const f = fixture(), source = f.rows, quote = f.quote;
  const previous = await f.market.refresh();
  f.now += 60_000;
  f.quote = symbol => { if (symbol === SYMBOLS[0]) throw new Error("quote offline"); return quote(symbol); };
  f.rows = (symbol, tf) => {
    if (symbol === SYMBOLS[0]) throw new Error("candles offline");
    return source(symbol, tf);
  };
  const failed = await f.market.refresh();
  const entry = failed[SYMBOLS[0]];
  assert.equal(entry.priceTs, previous[SYMBOLS[0]].priceTs);
  assert.equal(entry.price, previous[SYMBOLS[0]].price);
  assert.deepEqual(entry.candles1h, previous[SYMBOLS[0]].candles1h);
  assert.equal(entry.trend1h, previous[SYMBOLS[0]].trend1h);
  assert.equal(entry.rsi1h, previous[SYMBOLS[0]].rsi1h);
  assert.match(entry.error, /ticker: quote offline/);
  assert.match(entry.error, /1h: candles offline/);
  assert.match(entry.error, /4h: candles offline/);
  assert.equal(failed[SYMBOLS[1]].priceTs, f.now);
  assert.equal(failed[SYMBOLS[1]].error, null);
  f.now++;
  assertNullQuote(f.market.data[SYMBOLS[0]]);
  assert.equal(f.market.data[SYMBOLS[0]].priceTs, previous[SYMBOLS[0]].priceTs);
  f.quote = quote;
  f.rows = source;
  const recovered = await f.market.refresh();
  assert.equal(f.tickerCalls.length, 15);
  assert.equal(f.candleCalls.length, 22); // Only the two failed candle keys need retrying.
  assert.equal(recovered[SYMBOLS[0]].priceTs, f.now);
  assert.equal(recovered[SYMBOLS[0]].error, null);
  assert.equal(f.market.ready, true);
  await f.market.close();
});

test("first-fetch quote errors leave null prices while independent candles still populate", async () => {
  const f = fixture();
  f.quote = () => { throw new Error("ticker unavailable"); };
  const data = await f.market.refresh();
  for (const entry of Object.values(data)) {
    assertNullQuote(entry);
    assert.equal(entry.priceTs, null);
    assert.equal(entry.candles1h.length, 299);
    assert.notEqual(entry.rsi1h, null);
    assert.match(entry.error, /ticker unavailable/);
  }
  await f.market.close();
});

test("display indicators need their own bounded samples, not frozen strategy warmup", async t => {
  for (const count of [0, 1, 8, 13, 15, 21, 22, 25, 49, 50, 300, 350]) await t.test(`${count} bars`, async () => {
    const f = fixture();
    f.rows = (symbol, tf) => recentRows(symbol, tf, f.now, count, false);
    const data = await f.market.refresh();
    for (const symbol of SYMBOLS) {
      const entry = data[symbol];
      assert.equal(entry.candles1h.length, Math.min(count, 300));
      for (const [field, minimum] of [["trend1h", 50], ["trend4h", 50], ["rsi1h", 15],
        ["momentum1h", 13], ["momentum4h", 8], ["volatility", 25], ["volSpike", 22]]) {
        assert.equal(entry[field] === null, count < minimum, `${field}: ${count}`);
      }
      assert.equal(entry.error === null, count >= 50);
    }
    await f.market.close();
  });
});

test("gaps cannot invent time horizons, flat trends and zero volume cannot invent direction or ratios", async () => {
  const f = fixture();
  f.rows = (symbol, tf) => {
    const rows = recentRows(symbol, tf, f.now, 60, false);
    rows.splice(rows.length - (tf === "1h" ? 13 : 8), 1);
    return rows;
  };
  const gapped = await f.market.refresh();
  for (const entry of Object.values(gapped)) {
    assert.equal(entry.momentum1h, null);
    assert.equal(entry.momentum4h, null);
    assert.equal(entry.trend1h, null);
    assert.equal(entry.trend4h, null);
    assert.equal(entry.candles1h.length, 59);
    assert.match(entry.error, /insufficient continuous/);
  }
  f.now += 30_000;
  f.rows = (symbol, tf) => recentRows(symbol, tf, f.now, 60, false).map(row => bar(row[0], 100, 0));
  const flat = await f.market.refresh();
  for (const entry of Object.values(flat)) {
    assert.equal(entry.trend1h, null);
    assert.equal(entry.trend4h, null);
    assert.equal(entry.volSpike, null);
    assert.equal(entry.rsi1h, 50);
    assert.equal(entry.momentum1h, 0); // Real zero change, not a missing-data fallback.
    assert.equal(entry.volatility, 0);
  }
  await f.market.close();
});

test("close is idempotent, drains pending work and blocks further market requests", async () => {
  const f = fixture(), gate = deferred(), source = f.rows;
  f.rows = async (symbol, tf) => { await gate.promise; return source(symbol, tf); };
  const pending = f.market.refresh();
  const closing = f.market.close(), duplicateClose = f.market.close();
  assert.equal(f.closes, 0);
  await assert.rejects(f.market.refresh(), /closed/);
  await assert.rejects(f.market.candles(SYMBOLS[0], "1h"), /closed/);
  gate.resolve();
  await Promise.all([pending, closing, duplicateClose]);
  await f.market.close();
  assert.equal(f.closes, 1);
  assert.equal(f.tickerCalls.length, 5);
  assert.equal(f.candleCalls.length, 10);
  assert.equal(f.market.ready, false);
});

test("close supports public clients without a close method and propagates close failures", async () => {
  const f = fixture();
  delete f.exchange.close;
  await f.market.close();
  const failing = fixture();
  failing.exchange.close = async () => { throw new Error("close failed"); };
  await assert.rejects(failing.market.close(), /close failed/);
  await assert.rejects(failing.market.close(), /close failed/);
});
