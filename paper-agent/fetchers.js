/** Shared market-data fetch helpers (ccxt + dexpaprika MCP tool calls). */

export const RATIONALE =
  "Paper-trading agent: gathering read-only market data to compute trend, momentum and risk signals.";

export async function fetchCandles(ccxt, symbol, timeframe, daysBack, exchange) {
  const txt = await ccxt.callTool("get-historical-ohlcv", {
    symbol, timeframe, days_back: daysBack, exchange,
  });
  const candles = [];
  let cur = null;
  for (const line of txt.split("\n")) {
    if (line.startsWith("Time:")) { if (cur && cur.o != null) candles.push([cur.ts, cur.o, cur.h, cur.l, cur.c, cur.v]); cur = { ts: new Date(line.slice(5).trim().replace(" ", "T") + "Z").getTime() }; }
    else if (cur && line.startsWith("Open:")) cur.o = parseFloat(line.slice(5));
    else if (cur && line.startsWith("High:")) cur.h = parseFloat(line.slice(5));
    else if (cur && line.startsWith("Low:")) cur.l = parseFloat(line.slice(4));
    else if (cur && line.startsWith("Close:")) cur.c = parseFloat(line.slice(6));
    else if (cur && line.startsWith("Volume:")) cur.v = parseFloat(line.slice(7));
  }
  if (cur && cur.o != null) candles.push([cur.ts, cur.o, cur.h, cur.l, cur.c, cur.v]);
  return candles;
}

export async function fetchSummary(ccxt, symbol, exchange) {
  const txt = await ccxt.callTool("get-market-summary", { symbol, exchange });
  const get = (k) => {
    const m = txt.match(new RegExp(`${k}:\\s*([\\d.eE+-]+)`));
    return m ? parseFloat(m[1]) : null;
  };
  return { last: get("Last Price"), vol24: get("24h Volume"), high: get("24h High"), low: get("24h Low"), bid: get("Bid"), ask: get("Ask"), timestamp: get("Timestamp") };
}

export async function fetchOrderBook(ccxt, symbol, exchange, limit = 10) {
  try {
    const txt = await ccxt.callTool("get-order-book", { symbol, exchange, limit });
    return JSON.parse(txt);
  } catch (e) {
    return { symbol, timestamp: Date.now(), bids: [], asks: [], error: e.message };
  }
}

export function executableMark(summary, side) {
  // Long exits at bid; short exits at ask. Last is only a fallback.
  return side === "short" ? (summary.ask ?? summary.last) : (summary.bid ?? summary.last);
}

export function dataFresh(summary, maxAgeMs = 120_000) {
  return summary?.timestamp == null || Date.now() - summary.timestamp <= maxAgeMs;
}

export async function fetchLiquidity(dexpaprika, asset) {
  if (!asset.dexNetwork || !asset.dexTokenAddress) return { liquidityUsd: null, note: "no dex lookup" };
  try {
    const txt = await dexpaprika.callTool("getTokenDetails", {
      network: asset.dexNetwork,
      token_address: asset.dexTokenAddress,
      rationale: RATIONALE,
    });
    const data = JSON.parse(txt);
    const t = data.summary || data.token || data;
    const liq = t.liquidity_usd ?? t.total_liquidity_usd ?? null;
    const vol24 = (t["24h"] && t["24h"].volume_usd) ?? t.volume_usd_24h ?? null;
    return { liquidityUsd: liq, fdv: t.fdv ?? null, vol24, dexPrice: t.price_usd ?? null };
  } catch (e) {
    return { liquidityUsd: null, note: `dex lookup failed: ${e.message.slice(0, 120)}` };
  }
}
