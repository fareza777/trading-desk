import { CANDIDATES, DAY, HOUR, LEARNING, RISK } from "./config.js";

const sum = values => values.reduce((total, value) => total + value, 0);
const mean = values => values.length ? sum(values) / values.length : 0;
const closeTime = trade => Date.parse(trade.closed_at);

export function newLearning() {
  return { champion: null, championSince: null, pending: null, confirmations: 0, lastReview: null, reviewCount: 0, riskHalted: false };
}

export function scorePortfolio(portfolio, now) {
  const curve = portfolio.curve.filter(point => point.ts <= now);
  const firstTime = curve.length ? curve[0].ts - HOUR : now;
  const from = Math.max(firstTime, now - LEARNING.lookbackDays * DAY);
  const equityAt = time => {
    let equity = RISK.startingBalance;
    for (const point of curve) { if (point.ts > time) break; equity = point.equity; }
    return equity;
  };
  const openingEquity = equityAt(from), endingEquity = equityAt(now);
  const trades = portfolio.closed.filter(p => closeTime(p) > from && closeTime(p) <= now);
  const wins = trades.filter(p => p.pnl_usd > 0), losses = trades.filter(p => p.pnl_usd < 0);
  const profit = sum(wins.map(p => p.pnl_usd)), loss = -sum(losses.map(p => p.pnl_usd));
  let peak = openingEquity, maxDrawdownPct = 0;
  for (const point of curve.filter(p => p.ts > from)) {
    peak = Math.max(peak, point.equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, 100 * (1 - point.equity / peak));
  }
  const weeklyPnl = [];
  for (let to = from + 7 * DAY; to <= now; to += 7 * DAY) weeklyPnl.push(equityAt(to) - equityAt(to - 7 * DAY));
  const weeklyMean = mean(weeklyPnl);
  const weeklySd = weeklyPnl.length > 1 ? Math.sqrt(sum(weeklyPnl.map(v => (v - weeklyMean) ** 2)) / (weeklyPnl.length - 1)) : 0;
  const lowerWeeklyEstimate = weeklyPnl.length >= 12
    ? weeklyMean - LEARNING.standardErrorMultiple * weeklySd / Math.sqrt(weeklyPnl.length) : null;
  const blockPnl = Array.from({ length: LEARNING.blocks }, (_, i) => {
    const a = from + Math.floor((now - from) * i / LEARNING.blocks / HOUR) * HOUR;
    const b = from + Math.floor((now - from) * (i + 1) / LEARNING.blocks / HOUR) * HOUR;
    return equityAt(b) - equityAt(a);
  });
  const recent = trades.filter(p => closeTime(p) > now - LEARNING.recentDays * DAY);
  const byRegime = {};
  for (const p of trades) {
    const group = byRegime[p.entry_regime] ??= { trades: 0, netPnl: 0 };
    group.trades++; group.netPnl += p.pnl_usd;
  }
  return { from, to: now, observedDays: curve.length ? (Math.min(now, curve.at(-1).ts) - from) / DAY : 0,
    closed: trades.length, wins: wins.length, winRatePct: trades.length ? wins.length / trades.length * 100 : 0,
    profitFactor: loss > 0 ? profit / loss : null, noLossPositive: loss === 0 && profit > 0,
    netPnl: endingEquity - openingEquity, realizedPnl: profit - loss,
    expectancy: trades.length ? (profit - loss) / trades.length : 0,
    avgWin: wins.length ? profit / wins.length : 0, avgLoss: losses.length ? loss / losses.length : 0,
    recentNetPnl: endingEquity - equityAt(Math.max(from, now - LEARNING.recentDays * DAY)),
    recentClosed: recent.length, maxDrawdownPct, lowerWeeklyEstimate, weeklyPnl, blockPnl, byRegime,
    fees: sum(trades.map(p => p.entry_fee + p.exit_fee)),
    stopCount: trades.filter(p => p.exit_reason === "stop").length };
}

export function screenCandidate(normal, stressed) {
  const gates = {
    enoughObservation: normal.observedDays >= LEARNING.minDays && stressed.observedDays >= LEARNING.minDays,
    enoughTrades: normal.closed >= LEARNING.minTrades && stressed.closed >= LEARNING.minTrades,
    enoughRecentTrades: normal.recentClosed >= LEARNING.minRecentTrades && stressed.recentClosed >= LEARNING.minRecentTrades,
    positiveNet: normal.netPnl > 0 && normal.expectancy > 0,
    adequateProfitFactor: normal.noLossPositive || normal.profitFactor >= LEARNING.minProfitFactor,
    stressPositive: stressed.netPnl > 0 && stressed.expectancy > 0,
    recentPositive: normal.recentNetPnl > 0 && stressed.recentNetPnl > 0,
    drawdownWithinLimit: normal.maxDrawdownPct < LEARNING.maxPromotionDrawdownPct && stressed.maxDrawdownPct < LEARNING.maxPromotionDrawdownPct,
    consistentBlocks: normal.blockPnl.filter(v => v > 0).length >= LEARNING.minPositiveBlocks,
    conservativeWeeklyScore: normal.lowerWeeklyEstimate !== null && normal.lowerWeeklyEstimate > 0 &&
      stressed.lowerWeeklyEstimate !== null && stressed.lowerWeeklyEstimate > 0,
  };
  let diagnosis = "eligible for paper comparison";
  if (!gates.enoughObservation || !gates.enoughTrades || !gates.enoughRecentTrades) diagnosis = "insufficient forward evidence; keep collecting shadow outcomes";
  else if (!gates.stressPositive) diagnosis = "edge does not survive doubled costs";
  else if (normal.avgWin < normal.avgLoss && normal.expectancy <= 0) diagnosis = "wins too small relative to losses; compare bounded exit variants";
  else if (!gates.positiveNet) diagnosis = "negative net expectancy; do not scale this signal";
  else if (!gates.drawdownWithinLimit) diagnosis = "drawdown exceeds the fixed promotion budget";
  else if (!gates.conservativeWeeklyScore || !gates.consistentBlocks || !gates.recentPositive) diagnosis = "unstable performance across time blocks";
  return { eligible: Object.values(gates).every(Boolean), gates, diagnosis, robustNetPnl: Math.min(normal.netPnl, stressed.netPnl) };
}

export function updateLearning(previous, shadows, active, now) {
  if (!Number.isSafeInteger(now) || now % HOUR) throw new Error("learning time must be an aligned closed-hour boundary");
  if (previous.lastReview !== null && now < previous.lastReview) throw new Error("learning cannot travel backwards");
  const learning = structuredClone(previous);
  const activeCurve = active.curve.filter(p => p.ts <= now);
  const equity = activeCurve.at(-1)?.equity ?? RISK.startingBalance;
  const closePeak = activeCurve.reduce((max, point) => Math.max(max, point.equity), RISK.startingBalance);
  const peak = active.lastTime != null && active.lastTime + HOUR <= now ? Math.max(closePeak, active.peak) : closePeak;
  if (learning.riskHalted || active.riskHalted || equity <= peak * (1 - RISK.circuitBreakPct)) {
    const old = learning.champion;
    learning.champion = null; learning.pending = null; learning.confirmations = 0; learning.riskHalted = true;
    return { learning, event: old === null ? null : { type: "DEMOTE", ts: now, previous: old, next: null, reason: "active peak drawdown brake; no automatic reset" } };
  }
  if (learning.champion !== null) {
    const recent = active.closed.filter(p => p.candidateId === learning.champion && closeTime(p) <= now &&
      closeTime(p) >= learning.championSince).slice(-LEARNING.driftClosedTrades);
    if (recent.length === LEARNING.driftClosedTrades && recent.filter(p => p.pnl_usd < 0).length >= LEARNING.driftMinimumLosses && sum(recent.map(p => p.pnl_usd)) < 0) {
      const old = learning.champion;
      learning.champion = null; learning.pending = null; learning.confirmations = 0; learning.lastReview = now;
      return { learning, event: { type: "DEMOTE", ts: now, previous: old, next: null, reason: "recent active trade deterioration; existing position exits remain pinned" } };
    }
  }
  if (learning.lastReview !== null && now - learning.lastReview < LEARNING.reviewDays * DAY) return { learning, event: null };
  learning.lastReview = now; learning.reviewCount++;
  const scores = Object.fromEntries(CANDIDATES.map(candidate => {
    const pair = shadows[candidate.id];
    const normal = scorePortfolio(pair.normal, now), stressed = scorePortfolio(pair.stressed, now);
    return [candidate.id, { normal, stressed, ...screenCandidate(normal, stressed) }];
  }));
  const before = learning.champion;
  let reason = "no eligible challenger; retain cash or qualified champion";
  if (learning.champion !== null && !scores[learning.champion].eligible) {
    learning.champion = null; learning.pending = null; learning.confirmations = 0;
    reason = "champion no longer passes forward gates; stop its new entries";
  }
  const eligible = CANDIDATES.filter(c => scores[c.id].eligible)
    .sort((a, b) => scores[b.id].robustNetPnl - scores[a.id].robustNetPnl || a.id.localeCompare(b.id));
  const best = eligible[0]?.id ?? null;
  const incumbentScore = learning.champion === null ? 0 : scores[learning.champion].robustNetPnl;
  const canChallenge = best !== null && best !== learning.champion &&
    scores[best].robustNetPnl > incumbentScore + LEARNING.minimumAdvantageUsd;
  if (canChallenge) {
    if (learning.pending === best) learning.confirmations++;
    else { learning.pending = best; learning.confirmations = 1; }
    reason = "challenger collecting consecutive review confirmations";
    const residenceComplete = learning.champion === null || now - learning.championSince >= LEARNING.minChampionDays * DAY;
    if (learning.confirmations >= LEARNING.challengerConfirmations && residenceComplete) {
      learning.champion = best; learning.championSince = now; learning.pending = null; learning.confirmations = 0;
      reason = "bounded challenger passed net, cost, sample and stability gates; paper-only promotion effective next hour";
    }
  } else { learning.pending = null; learning.confirmations = 0; }
  const type = learning.champion !== before ? (learning.champion === null ? "DEMOTE" : "PROMOTE") : "REVIEW";
  return { learning, event: { type, ts: now, review: learning.reviewCount, previous: before, next: learning.champion,
    pending: learning.pending, confirmations: learning.confirmations, reason, scores } };
}
