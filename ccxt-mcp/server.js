/**
 * CCXT MCP Server (Node.js port of Nayshins/mcp-server-ccxt)
 * Read-only cryptocurrency market data over MCP stdio.
 * No API keys — public exchange endpoints only.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import ccxt from "ccxt";

// Some networks (corp/AV TLS interception) break cert validation against certain
// exchanges. Set CCXT_INSECURE=1 to relax TLS verification as a last resort.
if (process.env.CCXT_INSECURE === "1") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  console.error("WARNING: CCXT_INSECURE=1 — TLS certificate verification disabled");
}

const SUPPORTED_EXCHANGES = {
  binance: "binance",
  coinbase: "coinbase",
  kraken: "kraken",
  kucoin: "kucoin",
  hyperliquid: "hyperliquid",
  huobi: "htx", // huobi renamed htx in ccxt v4
  bitfinex: "bitfinex",
  bybit: "bybit",
  okx: "okx",
  mexc: "mexc",
};

const TIMEFRAME_MS = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
  "1w": 604_800_000,
};

const exchangeInstances = new Map();

async function getExchange(id) {
  const key = (id || "binance").toLowerCase();
  if (!(key in SUPPORTED_EXCHANGES)) {
    throw new Error(
      `Unsupported exchange: ${id}. Supported: ${Object.keys(SUPPORTED_EXCHANGES).join(", ")}`
    );
  }
  if (!exchangeInstances.has(key)) {
    const ExchangeClass = ccxt[SUPPORTED_EXCHANGES[key]];
    const inst = new ExchangeClass({ enableRateLimit: true });
    inst.timeout = 20_000;
    exchangeInstances.set(key, inst);
  }
  return exchangeInstances.get(key);
}

const exchangeSchema = () => ({
  type: "string",
  description: `Exchange to use (supported: ${Object.keys(SUPPORTED_EXCHANGES).join(", ")})`,
  enum: Object.keys(SUPPORTED_EXCHANGES),
  default: "binance",
});

const fmtTicker = (t, ex) =>
  [
    `Exchange: ${ex.toUpperCase()}`,
    `Symbol: ${t.symbol}`,
    `Last Price: ${t.last ?? "N/A"}`,
    `24h High: ${t.high ?? "N/A"}`,
    `24h Low: ${t.low ?? "N/A"}`,
    `24h Volume: ${t.baseVolume ?? "N/A"}`,
    `Bid: ${t.bid ?? "N/A"}`,
    `Ask: ${t.ask ?? "N/A"}`,
    `Timestamp: ${t.timestamp ?? Date.now()}`,
    "---",
  ].join("\n");

function fmtOHLCV(rows, limit = 200) {
  const out = [];
  const data = rows.slice(0, limit);
  for (let i = 0; i < data.length; i++) {
    const [ts, o, h, l, c, v] = data[i];
    let change = "";
    if (i > 0) {
      const prev = data[i - 1][4];
      change = `Change: ${(((c - prev) / prev) * 100).toFixed(2)}%`;
    }
    out.push(
      [
        `Time: ${new Date(ts).toISOString().replace("T", " ").slice(0, 19)}`,
        `Open: ${Number(o).toFixed(8)}`,
        `High: ${Number(h).toFixed(8)}`,
        `Low: ${Number(l).toFixed(8)}`,
        `Close: ${Number(c).toFixed(8)}`,
        `Volume: ${Number(v).toFixed(2)}`,
        change,
        "---",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
  return out.join("\n");
}

const server = new Server(
  { name: "crypto-server", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get-price",
      description: "Get current price of a cryptocurrency pair from a specific exchange",
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Trading pair (e.g., BTC/USDT, ETH/USDT)" },
          exchange: exchangeSchema(),
        },
        required: ["symbol"],
      },
    },
    {
      name: "get-market-summary",
      description: "Get detailed market summary for a cryptocurrency pair",
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Trading pair (e.g., BTC/USDT)" },
          exchange: exchangeSchema(),
        },
        required: ["symbol"],
      },
    },
    {
      name: "get-order-book",
      description: "Get public bid/ask order-book levels for realistic paper-fill and liquidity simulation",
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Trading pair (e.g., BTC/USDT)" },
          limit: { type: "number", description: "Number of levels per side (default 10, max 50)" },
          exchange: exchangeSchema(),
        },
        required: ["symbol"],
      },
    },
    {
      name: "list-exchanges",
      description: "List all supported cryptocurrency exchanges",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get-historical-ohlcv",
      description: "Get historical OHLCV (candlestick) data for a trading pair",
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Trading pair (e.g., BTC/USDT)" },
          timeframe: {
            type: "string",
            description: "Candle timeframe",
            enum: ["1m", "5m", "15m", "1h", "4h", "1d", "1w"],
            default: "1h",
          },
          days_back: {
            type: "number",
            description: "Days of history to fetch (default: 7, max: 30)",
            default: 7,
            maximum: 30,
          },
          exchange: exchangeSchema(),
        },
        required: ["symbol"],
      },
    },
    {
      name: "get-price-change",
      description: "Get price change statistics over 1h / 24h / 7d / 30d",
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Trading pair (e.g., BTC/USDT)" },
          exchange: exchangeSchema(),
        },
        required: ["symbol"],
      },
    },
    {
      name: "get-volume-history",
      description: "Get daily trading volume history",
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Trading pair (e.g., BTC/USDT)" },
          days: { type: "number", description: "Days of history (default: 7, max: 30)", default: 7, maximum: 30 },
          exchange: exchangeSchema(),
        },
        required: ["symbol"],
      },
    },
    {
      name: "get-tickers",
      description: "Get 24h tickers for all markets on an exchange (for volume ranking)",
      inputSchema: {
        type: "object",
        properties: {
          exchange: exchangeSchema(),
          quote: { type: "string", description: "Optional quote currency filter (e.g., USDT)" },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    if (name === "list-exchanges") {
      const list = Object.keys(SUPPORTED_EXCHANGES)
        .map((e) => `- ${e.toUpperCase()}`)
        .join("\n");
      return { content: [{ type: "text", text: `Supported exchanges:\n\n${list}` }] };
    }

    const exchangeId = (args.exchange || "binance").toLowerCase();
    const exchange = await getExchange(exchangeId);

    if (name === "get-price") {
      const symbol = args.symbol.toUpperCase();
      const t = await exchange.fetchTicker(symbol);
      const [, quote] = symbol.split("/");
      return {
        content: [
          {
            type: "text",
            text: `Current price of ${symbol} on ${exchangeId.toUpperCase()}: ${t.last} ${quote}`,
          },
        ],
      };
    }

    if (name === "get-market-summary") {
      const symbol = args.symbol.toUpperCase();
      const t = await exchange.fetchTicker(symbol);
      return {
        content: [{ type: "text", text: `Market summary for ${symbol}:\n\n${fmtTicker(t, exchangeId)}` }],
      };
    }

    if (name === "get-order-book") {
      const symbol = args.symbol.toUpperCase();
      const limit = Math.min(Number(args.limit || 10), 50);
      const book = await exchange.fetchOrderBook(symbol, limit);
      const bid = book.bids?.[0]?.[0] ?? null;
      const ask = book.asks?.[0]?.[0] ?? null;
      return {
        content: [{ type: "text", text: JSON.stringify({
          exchange: exchangeId, symbol, timestamp: book.timestamp || Date.now(),
          bid, ask, bids: (book.bids || []).slice(0, limit), asks: (book.asks || []).slice(0, limit),
        }) }],
      };
    }

    if (name === "get-top-volumes") {
      const limit = Math.min(Number(args.limit || 5), 50);
      const tickers = await exchange.fetchTickers();
      const top = Object.values(tickers)
        .filter((t) => t.baseVolume != null)
        .sort((a, b) => (b.baseVolume || 0) - (a.baseVolume || 0))
        .slice(0, limit);
      const body = top.map((t) => fmtTicker(t, exchangeId)).join("\n");
      return {
        content: [
          { type: "text", text: `Top ${limit} pairs by volume on ${exchangeId.toUpperCase()}:\n\n${body}` },
        ],
      };
    }

    if (name === "get-tickers") {
      const quote = args.quote ? String(args.quote).toUpperCase() : null;
      const tickers = await exchange.fetchTickers();
      const slim = Object.values(tickers)
        .filter((t) => t.symbol && (!quote || t.symbol.endsWith("/" + quote)))
        .map((t) => ({ symbol: t.symbol, last: t.last ?? null, quoteVolume: t.quoteVolume ?? null, baseVolume: t.baseVolume ?? null }));
      return { content: [{ type: "text", text: JSON.stringify(slim) }] };
    }

    if (name === "get-historical-ohlcv") {
      const symbol = args.symbol.toUpperCase();
      const timeframe = args.timeframe || "1h";
      const daysBack = Math.min(Number(args.days_back || 7), 30);
      const since = Date.now() - daysBack * 86_400_000;
      let all = [];
      let cursor = since;
      // paginate: most exchanges cap at 500-1000 candles per call
      for (let page = 0; page < 12; page++) {
        const batch = await exchange.fetchOHLCV(symbol, timeframe, cursor, 1000);
        if (!batch.length) break;
        all = all.concat(batch);
        const lastTs = batch[batch.length - 1][0];
        if (lastTs <= cursor) break;
        cursor = lastTs + TIMEFRAME_MS[timeframe];
        if (batch.length < 1000) break;
      }
      const text = `Historical OHLCV for ${symbol} (${timeframe}) on ${exchangeId.toUpperCase()} — ${all.length} candles:\n\n${fmtOHLCV(all, 300)}`;
      return { content: [{ type: "text", text }] };
    }

    if (name === "get-price-change") {
      const symbol = args.symbol.toUpperCase();
      const t = await exchange.fetchTicker(symbol);
      const current = t.last;
      const periods = { "1h": 1 / 24, "24h": 1, "7d": 7, "30d": 30 };
      const lines = [];
      for (const [label, days] of Object.entries(periods)) {
        try {
          // since = exactly `days` ago, then compare first candle open to now
          const since = Date.now() - days * 86_400_000;
          const candles = await exchange.fetchOHLCV(symbol, days < 1 ? "1h" : "1d", since, 5);
          if (candles.length) {
            const startPrice = candles[0][1];
            lines.push(`${label} change: ${(((current - startPrice) / startPrice) * 100).toFixed(2)}%`);
          }
        } catch (e) {
          lines.push(`${label} change: unavailable (${e.message})`);
        }
      }
      return {
        content: [
          { type: "text", text: `Price changes for ${symbol} on ${exchangeId.toUpperCase()}:\n\n${lines.join("\n")}` },
        ],
      };
    }

    if (name === "get-volume-history") {
      const symbol = args.symbol.toUpperCase();
      const days = Math.min(Number(args.days || 7), 30);
      const since = Date.now() - days * 86_400_000;
      const candles = await exchange.fetchOHLCV(symbol, "1d", since);
      const lines = candles.map(
        (c) => `${new Date(c[0]).toISOString().slice(0, 10)}: ${Number(c[5]).toLocaleString("en-US", { maximumFractionDigits: 2 })}`
      );
      return {
        content: [
          { type: "text", text: `Daily trading volume for ${symbol} on ${exchangeId.toUpperCase()}:\n\n${lines.join("\n")}` },
        ],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error accessing cryptocurrency data: ${err.message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("CCXT MCP server (Node) running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
