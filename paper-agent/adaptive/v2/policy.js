import { CANDIDATES, DAY, EXPLORATION, RISK } from "./config.js";
import { studySignal } from "../../candidate/study.js";

const hold = reason => ({ decision: "HOLD", score: 0, reason });

function hourlyRecovery(candidate, a, hasPosition) {
  if (!a?.ready) return hold("wait for closed hourly data");
  if (![a.price, a.rsi1h, a.ema200_4h, a.momentum1h_12h, a.atr1h].every(Number.isFinite))
    return hold("wait for closed hourly indicators");
  if (hasPosition) {
    return a.rsi1h >= candidate.rsiExitMin
      ? { decision: "SELL", score: 0, reason: "hourly recovery bounce reached its exit RSI" }
      : hold("keep position; protective exits remain active");
  }
  if (a.rsi1h > candidate.rsiEntryMax) return hold("hourly RSI is not oversold enough");
  if (a.momentum1h_12h > 0) return hold("no short-term dislocation");
  if (a.momentum1h_12h < candidate.momentumFloorPct) return hold("falling knife, not a recovery setup");
  if (a.price < a.ema200_4h * candidate.regimeFloorPct) return hold("price is far below the 4h regime");
  const rawStop = Math.max(RISK.stopLossPct, RISK.atrStopMultiple * a.atr1h / a.price);
  if (!(a.atr1h > 0) || rawStop > RISK.maxStopPct) return hold("stop outside volatility budget");
  return { decision: "BUY", score: candidate.rsiEntryMax - a.rsi1h,
    reason: `hourly oversold recovery, RSI ${a.rsi1h.toFixed(1)}` };
}

export function candidateSignal(candidate, analysis, hasPosition = false) {
  return candidate.family === "hourly-recovery"
    ? hourlyRecovery(candidate, analysis, hasPosition)
    : studySignal(candidate.family, analysis, hasPosition);
}

function shadowScore(pair, time) {
  const from = time - EXPLORATION.selectionDays * DAY;
  const slice = portfolio => {
    if (!portfolio || !Array.isArray(portfolio.closed)) return { pnl: 0, closed: 0 };
    const trades = portfolio.closed.filter(p => {
      const at = Date.parse(p.closed_at);
      return at > from && at <= time;
    });
    return { pnl: trades.reduce((sum, p) => sum + p.pnl_usd, 0), closed: trades.length };
  };
  const normal = slice(pair?.normal), stressed = slice(pair?.stressed);
  return { normalPnl: normal.pnl, stressedPnl: stressed.pnl, normalClosed: normal.closed,
    stressedClosed: stressed.closed, robustNet: Math.min(normal.pnl, stressed.pnl) };
}

export function selectExecution(learning, shadows, time, { allowSwitch = true } = {}) {
  if (learning.riskHalted)
    return { candidateId: null, kind: "cash", reason: "risk brake is latched; no new entries" };
  if (learning.champion)
    return { candidateId: learning.champion, kind: "champion", reason: "qualified champion; fixed risk" };
  const scores = CANDIDATES.map(candidate => ({ id: candidate.id, ...shadowScore(shadows?.[candidate.id], time) }));
  const stored = learning.exploration?.candidateId;
  const incumbentId = CANDIDATES.some(candidate => candidate.id === stored) ? stored : EXPLORATION.baseline;
  const incumbent = scores.find(score => score.id === incumbentId);
  if (!allowSwitch)
    return { candidateId: incumbentId, kind: "exploration",
      reason: "exploration candidate retained until the next scheduled review" };
  const challengers = scores.filter(score => score.id !== incumbentId &&
    score.normalClosed >= EXPLORATION.minClosedPerScenario &&
    score.stressedClosed >= EXPLORATION.minClosedPerScenario)
    .sort((a, b) => b.robustNet - a.robustNet || a.id.localeCompare(b.id));
  const best = challengers[0];
  if (best && best.robustNet > incumbent.robustNet + EXPLORATION.switchAdvantageUsd)
    return { candidateId: best.id, kind: "exploration",
      reason: `prior ${EXPLORATION.selectionDays}-day shadow results favour ${best.id} by $${(best.robustNet - incumbent.robustNet).toFixed(2)} after doubled costs` };
  return { candidateId: incumbentId, kind: "exploration",
    reason: learning.exploration
      ? "exploration candidate retained until prior shadow results show a clear advantage"
      : "exploration baseline until shadow results accumulate" };
}
