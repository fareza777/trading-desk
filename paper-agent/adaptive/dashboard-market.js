import { createExchange, closedCandles } from "../candidate/market.js";
import { SYMBOLS } from "../candidate/config.js";
import { ema, rsi, pctChange, volatility, volumeSpike } from "../candidate/indicators.js";

const HOUR = 3_600_000;
const STEPS = new Map([["15m", HOUR / 4], ["1h", HOUR], ["4h", 4 * HOUR], ["1w", 168 * HOUR]]);
const ALLOWED_SYMBOLS = new Set(SYMBOLS);
const MONDAY = Date.UTC(1970, 0, 5);
const CANDLE_TTL = 30_000;
const REFRESH_TTL = 30_000;
const QUOTE_TTL = 60_000;
const LIMIT = 300;
const finite = value => Number.isFinite(value) ? value : null;
const fresh = (timestamp, now, ttl) => now >= timestamp && now - timestamp < ttl;
const quoteFresh = (timestamp, now) => Number.isFinite(timestamp) && now - timestamp >= -5_000 && now - timestamp <= QUOTE_TTL;
const message = error => error instanceof Error ? error.message : String(error);
const copyRows = rows => rows.map(row => row.slice());

function validateRequest(symbol, tf) {
  if (!ALLOWED_SYMBOLS.has(symbol) || !STEPS.has(tf)) {
    throw Object.assign(new RangeError("invalid market symbol or timeframe"), {
      code: "ERR_MARKET_VALIDATION", status: 400, statusCode: 400,
    });
  }
}

function validatedRows(rows, tf, asOf) {
  if (!Array.isArray(rows)) throw new Error("invalid OHLCV response");
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row) || row.length < 6 || !Number.isSafeInteger(row[0]) || row[0] < 0 ||
        (i > 0 && row[0] <= rows[i - 1][0])) throw new Error("invalid OHLCV candle order or timestamp");
  }
  // Shift Monday-based weeks to epoch alignment for the shared validator.
  const offset = tf === "1w" ? MONDAY : 0;
  const shifted = rows.map(row => [row[0] - offset, ...row.slice(1, 6)]);
  return closedCandles(shifted, STEPS.get(tf), asOf - offset)
    .slice(-LIMIT).map(row => [row[0] + offset, ...row.slice(1)]);
}

function emptyEntry() {
  return { price: null, priceTs: null, trend1h: null, trend4h: null, rsi1h: null,
    momentum1h: null, momentum4h: null, volatility: null, volSpike: null,
    vol24: null, high24: null, low24: null, candles1h: [], error: null };
}

// A gap must not turn a bar-count change into a purported 12h/28h change.
function continuousTail(rows, step) {
  let start = rows.length - 1;
  while (start > 0 && rows[start][0] === rows[start - 1][0] + step) start--;
  return rows.slice(Math.max(0, start));
}

function trend(values) {
  if (values.length < 50) return null;
  const fast = finite(ema(values, 20).at(-1)), slow = finite(ema(values, 50).at(-1));
  if (fast === null || slow === null || fast === slow) return null;
  return fast > slow ? "up" : "down";
}

function displayContext(rows, tf) {
  const tail = continuousTail(rows, STEPS.get(tf));
  const closes = tail.map(row => row[4]);
  if (tf === "4h") return { trend4h: trend(closes),
    momentum4h: closes.length > 7 ? finite(pctChange(closes, 7)) : null };
  const spike = tail.length > 21 ? volumeSpike(tail.map(row => row[5]), 20) : null;
  return { trend1h: trend(closes),
    rsi1h: closes.length > 14 ? finite(rsi(closes, 14).at(-1)) : null,
    momentum1h: closes.length > 12 ? finite(pctChange(closes, 12)) : null,
    volatility: closes.length > 24 ? finite(volatility(closes, 24)) : null,
    volSpike: spike && spike.avg > 0 ? finite(spike.ratio) : null };
}

function quoteContext(ticker, symbol, receivedAt, now) {
  const values = { price: null, priceTs: null, vol24: null, high24: null, low24: null };
  const errors = [];
  if (!ticker || typeof ticker !== "object" || Array.isArray(ticker) ||
      (ticker.symbol != null && ticker.symbol !== symbol)) {
    return { values, errors: ["invalid ticker response or symbol"] };
  }
  const timestamp = ticker.timestamp ?? receivedAt;
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    return { values, errors: ["invalid quote timestamp"] };
  }
  values.priceTs = timestamp;
  if (!quoteFresh(timestamp, now)) return { values, errors: ["stale or future quote"] };
  for (const [field, source, minimum] of [
    ["price", "last", Number.MIN_VALUE], ["vol24", "quoteVolume", 0],
    ["high24", "high", Number.MIN_VALUE], ["low24", "low", Number.MIN_VALUE],
  ]) {
    if (Number.isFinite(ticker[source]) && ticker[source] >= minimum) values[field] = ticker[source];
    else errors.push(`missing or invalid ticker ${source}`);
  }
  if (values.high24 !== null && values.low24 !== null && values.high24 < values.low24) {
    values.high24 = values.low24 = null;
    errors.push("invalid ticker high/low range");
  }
  return { values, errors };
}

/** Public display context only: no strategy warmup, decisions, orders or timers. */
export class DashboardMarket {
  #exchange;
  #clock;
  #data = Object.fromEntries(SYMBOLS.map(symbol => [symbol, emptyEntry()]));
  #cache = new Map();
  #candleFlights = new Map();
  #refreshFlight = null;
  #refreshedAt = null;
  #closed = false;
  #closeFlight = null;

  constructor({ exchange = createExchange(), clock = Date.now } = {}) {
    this.#exchange = exchange;
    this.#clock = clock;
  }

  get data() {
    const now = this.#clock();
    return Object.fromEntries(SYMBOLS.map(symbol => {
      const stored = this.#data[symbol];
      const entry = { ...stored, candles1h: copyRows(stored.candles1h) };
      // Expired quotes must not look current between refreshes.
      if (entry.priceTs !== null && !quoteFresh(entry.priceTs, now)) {
        entry.price = entry.vol24 = entry.high24 = entry.low24 = null;
        entry.error = [entry.error, "stale or future quote"].filter(Boolean).join("; ");
      }
      return [symbol, entry];
    }));
  }

  get error() {
    const errors = Object.entries(this.data).filter(([, entry]) => entry.error);
    return errors.length ? errors.map(([symbol, entry]) => `${symbol}: ${entry.error}`).join("; ") : null;
  }

  get ready() { return !this.#closed && this.#refreshedAt !== null && this.error === null; }

  async #rawCandles(symbol, tf) {
    validateRequest(symbol, tf);
    if (this.#closed) throw new Error("dashboard market is closed");
    const key = `${symbol}:${tf}`;
    if (this.#candleFlights.has(key)) return this.#candleFlights.get(key);
    const requestedAt = this.#clock();
    const cached = this.#cache.get(key);
    if (cached && fresh(cached.receivedAt, requestedAt, CANDLE_TTL)) return cached.rows;
    const request = (async () => {
      const raw = await this.#exchange.fetchOHLCV(symbol, tf, undefined, LIMIT);
      // A response crossing a boundary may still contain a partial bar.
      const rows = validatedRows(raw, tf, requestedAt);
      this.#cache.set(key, { rows, receivedAt: this.#clock() });
      return rows;
    })();
    this.#candleFlights.set(key, request);
    try { return await request; }
    catch (error) { this.#cache.delete(key); throw error; }
    finally { this.#candleFlights.delete(key); }
  }

  async candles(symbol, tf) {
    const rows = await this.#rawCandles(symbol, tf);
    return rows.map(([t, o, h, l, c, v]) => ({ t: t / 1000, o, h, l, c, v }));
  }

  async #refreshSymbol(symbol) {
    const [quote, hourly, fourHourly] = await Promise.allSettled([
      (async () => {
        const ticker = await this.#exchange.fetchTicker(symbol);
        return { ticker, receivedAt: this.#clock() };
      })(),
      this.#rawCandles(symbol, "1h"), this.#rawCandles(symbol, "4h"),
    ]);
    const entry = { ...this.#data[symbol] }, errors = [];
    if (quote.status === "fulfilled") {
      const result = quoteContext(quote.value.ticker, symbol, quote.value.receivedAt, this.#clock());
      Object.assign(entry, result.values);
      errors.push(...result.errors.map(error => `ticker: ${error}`));
    } else errors.push(`ticker: ${message(quote.reason)}`);
    for (const [result, tf] of [[hourly, "1h"], [fourHourly, "4h"]]) {
      if (result.status === "rejected") { errors.push(`${tf}: ${message(result.reason)}`); continue; }
      Object.assign(entry, displayContext(result.value, tf));
      // Preserve raw hourly timestamps for exact checkpoint valuation.
      if (tf === "1h") entry.candles1h = copyRows(result.value);
      if (continuousTail(result.value, STEPS.get(tf)).length < 50) {
        errors.push(`${tf}: insufficient continuous candles for full display context`);
      }
    }
    entry.error = errors.length ? errors.join("; ") : null;
    this.#data[symbol] = entry;
  }

  async refresh() {
    if (this.#closed) throw new Error("dashboard market is closed");
    if (this.#refreshFlight) return this.#refreshFlight;
    const requestedAt = this.#clock();
    if (this.#refreshedAt !== null && fresh(this.#refreshedAt, requestedAt, REFRESH_TTL) && this.error === null) return this.data;
    const request = (async () => {
      await Promise.all(SYMBOLS.map(symbol => this.#refreshSymbol(symbol)));
      // Request-time expiry leaves room to refresh before quotes become stale.
      this.#refreshedAt = this.error === null ? requestedAt : null;
      return this.data;
    })();
    this.#refreshFlight = request;
    try { return await request; }
    finally { this.#refreshFlight = null; }
  }

  async close() {
    if (this.#closeFlight) return this.#closeFlight;
    this.#closed = true;
    this.#closeFlight = (async () => {
      await Promise.allSettled([this.#refreshFlight, ...this.#candleFlights.values()]);
      this.#cache.clear();
      await this.#exchange.close?.();
    })();
    return this.#closeFlight;
  }
}
