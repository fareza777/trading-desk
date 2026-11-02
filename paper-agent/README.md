# Crypto Research + Paper-Trading Agent

A single-repo agent that reads **live market data only through MCP** (DexPaprika + a local CCXT server), computes trend/momentum/volatility, and executes **paper trades** into a local SQLite ledger. No exchange keys, no wallets, no real orders.

## Architecture

```
watchlist.json  ──►  paper-agent/agent.js  ──►  ccxt-mcp/server.js   (prices, OHLCV)
                          │                  ──►  dexpaprika-mcp     (DEX liquidity, token data)
                          ▼
                     ledger.db (SQLite)  ──►  paper-agent/report.js ──► reports/report-YYYY-MM-DD.md
```

- `ccxt-mcp/` — Node.js port of the CCXT MCP server (read-only). Prices, candles, volume from Kraken/Binance/etc. Defaults to **kraken** because Binance/Coinbase TLS is being intercepted on this network; change per-call or set `CCXT_INSECURE=1` as a last resort.
- `paper-agent/` — the agent loop, indicators, risk manager, SQLite ledger, and daily report.

## Install

Already done. To reinstall the CCXT server deps:

```bash
cd ccxt-mcp && npm install
cd ../paper-agent && npm install
```

## Run

```bash
cd paper-agent
node agent.js        # or double-click run.bat
```

The agent runs a full cycle every `loopIntervalMinutes` (default 15), appends decisions to `ledger.db`, and writes `reports/report-<date>.md` once per cycle.

## Risk rules (hard, in `config.js`)

| Rule | Value |
|---|---|
| Starting balance | $10,000 (paper) |
| Max position size | 5% of equity |
| Max open positions | 3 |
| Stop-loss | 3% below entry |
| Take-profit | 6% above entry |
| Leverage | none |
| Min DEX liquidity | $500,000 (token skipped below this) |

## How decisions are made

For each asset in `watchlist.json`:
1. Fetch `get-historical-ohlcv` 1h (7d) and 4h (14d) candles + `get-market-summary` + DexPaprika `getTokenDetails` (liquidity) via the MCP tools.
2. `indicators.js` computes EMA20/50 (1h & 4h), RSI(14), momentum, volatility, and a volume-spike ratio.
3. A score-based `decide()` returns BUY / SELL / HOLD with a written reason. SELL is also triggered on a position when the trend flips.
4. `tryOpen()` enforces the risk limits and writes to `positions` + `trades`. Stops/targets are checked every cycle in `manageOpenPositions()`.

## Editing the watchlist

`watchlist.json` at repo root:

- `symbol` — a CCXT pair on the `exchange` (e.g. `BTC/USDT` on kraken).
- `dexNetwork` / `dexTokenAddress` — optional; used only for the on-chain liquidity check. Wrapped-asset addresses (WBTC, WETH, WSOL…) are the right proxy for the underlying.
- `exchange` — default ccxt exchange. `kraken` works on this network.

## Disclaimer

All trades are **paper** trades. Results are logged for research and are **not predictive** of future performance. No real orders are placed and no funds move.
