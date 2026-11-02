import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");
export const WATCHLIST_PATH = path.join(ROOT, "watchlist.json");
export const DB_PATH = path.join(__dirname, "ledger.db");
export const REPORT_DIR = path.join(__dirname, "reports");
export const LOG_DIR = path.join(__dirname, "logs");

export const RISK = {
  startingBalance: 10_000,

  // position sizing
  maxOpenPositions: 4,
  riskPerTradePct: 0.01,        // risk 1% of equity per trade → size = risk / stopDistance
  maxPositionPct: 0.10,         // …but never more than 10% of equity notional
  maxDeployPct: 0.60,           // never have >60% of equity in open positions

  // exits — R = risk unit (distance to stop)
  stopLossPct: 0.03,            // hard stop 3% below entry
  tp1R: 1.5,                    // take-profit-1 at +1.5R → close 50%
  tp1ClosePct: 0.5,
  tp2Pct: 0.08,                 // take-profit-2 (final) at +8%
  trailAfterTp1: true,          // after TP1 hits, move stop to breakeven+0.5% and trail
  trailDistancePct: 0.02,       // trailing stop distance once armed
  timeStopCandles: 96,          // close if 96h old and P&L < +1%

  // frictions — real costs
  takerFeePct: 0.0026,          // Kraken taker fee 0.26%
  slippagePct: 0.0008,          // 0.08% slippage on fills

  // eligibility filters
  minLiquidityUsd: 500_000,     // skip token if DEX liquidity below this
  minVolume24Usd: 1_000_000,
  maxSpreadPct: 0.004,          // skip if bid/ask spread > 0.4%
  maxDataAgeMs: 120_000,        // reject stale ticker/order-book data
  maxImpactPct: 0.003,          // reject simulated fill impact >0.3%
  orderBookLevels: 10,
  rsiEntryMax: 72,              // don't buy into overbought
  allowShort: true,             // enable SHORT signals

  circuitBreakPct: 0.10,        // pause new entries if equity drops 10% below peak

  // new controls
  dailyHaltPct: 0.05,           // STOP all trading if today's loss > 5% of day-open equity
  symbolCooldownMin: 45,        // min minutes before re-entering the same symbol+side
  maxSameDirection: 3,          // max positions on the same side (corr/cluster guard)
  kellyFactor: 0.5,             // scale risk by half-Kelly from live win rate (0=off)
  kellyMinSamples: 10,
  fundingPerHourShortPct: 0.0001, // 0.01%/h carry cost on shorts
  dynamicSlippage: true,        // slippage scales with live bid/ask spread
};

export function loadWatchlist() {
  const wl = JSON.parse(fs.readFileSync(WATCHLIST_PATH, "utf8"));
  // auto-discover top-N symbols by volume from the exchange (merged with manual entries)
  const auto = wl.autoDiscover?.enabled ? loadAutoSymbols(wl) : [];
  const manualSyms = new Set(wl.assets.map((a) => a.symbol));
  const extra = auto.filter((s) => !manualSyms.has(s)).map((s) => ({ symbol: s, name: s.split("/")[0], auto: true }));
  return { ...wl, assets: [...wl.assets, ...extra] };
}

function loadAutoSymbols(wl) {
  try {
    const f = path.join(__dirname, "auto-symbols.json");
    if (!fs.existsSync(f)) return [];
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    return (j.symbols || []).slice(0, wl.autoDiscover?.topN ?? 200);
  } catch { return []; }
}

export function ensureDirs() {
  for (const d of [REPORT_DIR, LOG_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}
