import path from "node:path";
import { fileURLToPath } from "node:url";
import { STUDY_RISK } from "../../candidate/study.js";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const VERSION = "adaptive-active-v2";
export const PREVIOUS_VERSION = "adaptive-shadow-v1";
export const PREVIOUS_HASH = "5a69edae4ddfdc915d43b2a1ace398442353adeb1a187e933a0c05223256aa5f";
export const RISK = Object.freeze({ ...STUDY_RISK });
export const EXPLORATION = Object.freeze({
  baseline: "hourly-recovery",
  riskPerTradePct: RISK.riskPerTradePct,
  maxPositionPct: RISK.maxPositionPct,
  maxDeployPct: RISK.maxDeployPct,
  maxOpenPositions: RISK.maxOpenPositions,
  selectionDays: 90,
  minClosedPerScenario: 8,
  switchAdvantageUsd: 10,
});
export const CANDIDATES = Object.freeze([
  { id: "trend-capped", family: "trend", targetR: 3, trailPct: 0.05, maxHoldHours: 336 },
  { id: "trend-runner", family: "trend", targetR: null, trailPct: 0.08, maxHoldHours: 720 },
  { id: "breakout-capped", family: "breakout", targetR: 3, trailPct: 0.05, maxHoldHours: 336 },
  { id: "breakout-runner", family: "breakout", targetR: null, trailPct: 0.08, maxHoldHours: 720 },
  { id: "reversion-fast", family: "reversion", targetR: 1, trailPct: null, maxHoldHours: 48 },
  { id: "reversion-standard", family: "reversion", targetR: 1.5, trailPct: null, maxHoldHours: 96 },
  { id: "hourly-recovery", family: "hourly-recovery", targetR: 2, trailPct: null, maxHoldHours: 72,
    rsiEntryMax: 25, rsiExitMin: 55, momentumFloorPct: -8, regimeFloorPct: 0.9 },
].map(Object.freeze));
export const LEARNING = Object.freeze({
  reviewDays: 7,
  lookbackDays: 180,
  minDays: 90,
  minTrades: 30,
  minRecentTrades: 5,
  recentDays: 45,
  minProfitFactor: 1.2,
  minimumAdvantageUsd: 10,
  minPositiveBlocks: 2,
  blocks: 3,
  standardErrorMultiple: 3,
  challengerConfirmations: 2,
  minChampionDays: 28,
  maxPromotionDrawdownPct: 5,
  driftClosedTrades: 10,
  driftMinimumLosses: 7,
});
export function candidateById(id) {
  const candidate = CANDIDATES.find(c => c.id === id);
  if (!candidate) throw new Error(`unknown adaptive candidate: ${id}`);
  return candidate;
}
