import ccxt from "../../ccxt-mcp/node_modules/ccxt/js/ccxt.js";

export function closedCandles(rows, step, asOf) {
  const unique = new Map();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6 || !row.slice(0, 6).every(Number.isFinite) ||
        row.slice(1, 5).some(x => x <= 0) || row[5] < 0 ||
        row[2] < Math.max(row[1], row[3], row[4]) || row[3] > Math.min(row[1], row[2], row[4]) || row[0] % step !== 0)
      throw new Error("invalid OHLCV candle");
    if (row[0] + step <= asOf) unique.set(row[0], row.slice(0, 6));
  }
  return [...unique.values()].sort((a, b) => a[0] - b[0]);
}

export function aggregate4h(rows) {
  const groups = new Map();
  for (const c of rows) {
    const key = Math.floor(c[0] / 14_400_000) * 14_400_000;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const out = [];
  for (const [ts, group] of groups) {
    group.sort((a, b) => a[0] - b[0]);
    if (group.length !== 4 || group.some((c, i) => c[0] !== ts + i * 3_600_000)) continue;
    out.push([ts, group[0][1], Math.max(...group.map(c => c[2])), Math.min(...group.map(c => c[3])), group[3][4], group.reduce((s, c) => s + c[5], 0)]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

export function createExchange() {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new Error("TLS verification must remain enabled");
  const exchange = new ccxt.okx({ enableRateLimit: true, timeout: 20_000,
    options: { defaultType: "spot", fetchMarkets: { types: ["spot"] } } });
  exchange.has.fetchCurrencies = false;
  const sign = exchange.sign.bind(exchange);
  const endpoints = new Set(["public/time", "public/instruments", "market/candles", "market/history-candles", "market/ticker", "market/books"]);
  exchange.sign = (endpoint, api = "public", method = "GET", ...rest) => {
    if (api !== "public" || method !== "GET" || !endpoints.has(endpoint)) throw new Error("only public market-data requests allowed");
    return sign(endpoint, api, method, ...rest);
  };
  return exchange;
}

export async function fetchHistory(exchange, symbol, hours, asOf = Date.now()) {
  const end = Math.floor(asOf / 3_600_000) * 3_600_000;
  let cursor = end - hours * 3_600_000;
  const rows = [];
  while (cursor < end) {
    const batch = await exchange.fetchOHLCV(symbol, "1h", cursor, 300);
    if (!batch.length) break;
    rows.push(...batch);
    const next = batch.at(-1)[0] + 3_600_000;
    if (next <= cursor) break;
    cursor = next;
  }
  return closedCandles(rows, 3_600_000, end).filter(c => c[0] >= end - hours * 3_600_000);
}

export async function fetchQuote(exchange, symbol) {
  const [ticker, book] = await Promise.all([exchange.fetchTicker(symbol), exchange.fetchOrderBook(symbol, 20)]);
  const receivedAt = Date.now();
  return {
    summary: { last: ticker.last, bid: book.bids?.[0]?.[0], ask: book.asks?.[0]?.[0],
      quoteVolume: ticker.quoteVolume ?? ticker.baseVolume * ticker.last,
      timestamp: ticker.timestamp ?? receivedAt, receivedAt },
    book: { ...book, timestamp: book.timestamp ?? receivedAt },
  };
}

export function quoteEligible(summary, book, risk, now = Date.now()) {
  if (![summary?.bid, summary?.ask, summary?.last, summary?.quoteVolume].every(x => Number.isFinite(x) && x > 0)) return "missing valid quote/volume";
  if (summary.ask < summary.bid) return "crossed order book";
  if ((summary.ask - summary.bid) / summary.bid > risk.maxSpreadPct) return "spread too wide";
  if (summary.quoteVolume < risk.minVolume24Usd) return "quote volume below floor";
  if (![summary.timestamp, summary.receivedAt, book?.timestamp].every(t => Number.isFinite(t) && now - t >= -5_000 && now - t <= risk.maxDataAgeMs)) return "stale quote/order book";
  if (!book.bids?.length || !book.asks?.length) return "empty order book";
  return null;
}
