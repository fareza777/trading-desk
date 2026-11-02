import { RISK } from "./config.js";
import { costBreakEven } from "./engine.js";

export function exitPlan(pos, mark, now, risk = RISK, legacy = false) {
  const d = pos.side === "short" ? -1 : 1;
  if (d * (mark - pos.stop_price) <= 0) return [{ fraction: 1, reason: "stop" }];
  const actions = [];
  let stop = pos.stop_price;
  const best = pos.best_price == null ? mark : d === 1 ? Math.max(pos.best_price, mark) : Math.min(pos.best_price, mark);
  if (!pos.tp1_hit && d * (mark - pos.tp1_price) >= 0) {
    actions.push({ fraction: risk.tp1ClosePct, reason: "take_profit_1" });
    const be = legacy ? pos.entry_price * (1 + d * 0.005)
      : costBreakEven(pos.entry_price, pos.side, pos.entry_price * risk.takerFeePct, 0, risk.slippagePct, risk.takerFeePct);
    stop = d === 1 ? Math.max(stop, be) : Math.min(stop, be);
    actions.push({ state: { tp1Hit: 1, trailActive: risk.trailAfterTp1 ? 1 : 0, stop } });
  }
  if (d * (mark - pos.tp2_price) >= 0) return [...actions, { fraction: 1, reason: "take_profit_2" }];
  if (pos.trail_active || actions.some(a => a.state?.trailActive)) {
    const trailing = best * (1 - d * risk.trailDistancePct);
    stop = d === 1 ? Math.max(stop, trailing) : Math.min(stop, trailing);
    if (d * (mark - stop) <= 0) return [...actions, { fraction: 1, reason: "trail" }];
  }
  if (now - Date.parse(pos.opened_at) > risk.timeStopCandles * 3_600_000 && d * (mark / pos.entry_price - 1) < 0.01)
    return [...actions, { fraction: 1, reason: "time_stop" }];
  return [...actions, { state: { stop, bestPrice: best } }];
}
