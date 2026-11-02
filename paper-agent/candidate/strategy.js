import { RISK } from "./config.js";

export function bullishRegime(a) {
  return a?.ready === true && a.trend4h === "up" && a.aboveEma200 === true && a.ema50Slope > 0;
}

export function signal(a, hasPosition = false, benchmark = null) {
  const hold = reason => ({ decision: "HOLD", score: 0, reason });
  if (!a?.ready) return hold(a?.reason || "closed-candle warmup incomplete");
  if (hasPosition) {
    if (a.side === "long" && a.trend4h === "down" && a.price < a.ema50_1h)
      return { decision: "SELL", score: -1, reason: "closed 4h trend and 1h support lost" };
    if (a.side === "short" && a.trend4h === "up" && a.price > a.ema50_1h)
      return { decision: "COVER", score: 1, reason: "closed 4h trend and 1h resistance lost" };
    return hold("position trend intact");
  }
  if (!bullishRegime(benchmark)) return hold("BTC regime is not bullish; stay in cash");
  if (!bullishRegime(a) || a.trend1h !== "up") return hold("asset trend not aligned");
  if (!Number.isFinite(a.adx4h) || a.adx4h < RISK.minAdx) return hold("weak 4h trend");
  if (!Number.isFinite(a.rsi1h) || a.rsi1h < RISK.rsiEntryMin || a.rsi1h > RISK.rsiEntryMax || a.rsiSlope <= 0) return hold("RSI confirmation absent or extended");
  if (!a.pullbackTouched || a.price <= a.ema20_1h || a.price <= a.previousHigh) return hold("wait for closed-candle pullback recovery");
  if (!(a.atr1h > 0) || (a.price - a.ema20_1h) / a.atr1h > RISK.maxEntryExtensionAtr) return hold("do not chase extended price");
  const stop = Math.max(RISK.stopLossPct, RISK.atrStopMultiple * a.atr1h / a.price);
  const costs = 2 * (RISK.takerFeePct + RISK.slippagePct);
  if (stop > RISK.maxStopPct || costs / stop > RISK.maxCostToStop) return hold("stop or trading costs too large");
  const reward = stop * (RISK.tp1R * RISK.tp1ClosePct + RISK.tp2R * (1 - RISK.tp1ClosePct));
  if ((reward - costs) / (stop + costs) < RISK.minNetRewardRisk) return hold("net reward/risk below floor");
  return { decision: "BUY", score: a.adx4h + a.momentum1h_12h - benchmark.momentum1h_12h,
    reason: "closed pullback recovery; BTC + asset uptrend; cost-qualified" };
}

export function entryPause(closed, equity, peak, dayOpen, now, risk = RISK) {
  if (equity <= peak * (1 - risk.circuitBreakPct)) return "peak drawdown circuit breaker";
  if (equity <= dayOpen * (1 - risk.dailyHaltPct)) return "daily loss halt";
  const recent = closed.slice(-risk.maxConsecutiveLosses);
  if (recent.length === risk.maxConsecutiveLosses && recent.every(p => p.pnl_usd < 0) &&
      now - Date.parse(recent.at(-1).closed_at) < risk.lossPauseHours * 3_600_000) return "consecutive losses pause";
  return null;
}

export function symbolCooling(lastClosed, now, risk = RISK) {
  if (!lastClosed) return false;
  const minutes = lastClosed.exit_reason === "stop" ? risk.stopCooldownMin : risk.symbolCooldownMin;
  return now - Date.parse(lastClosed.closed_at) < minutes * 60_000;
}
