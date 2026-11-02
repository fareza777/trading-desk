const $ = id => document.getElementById(id);
const money = value => Number.isFinite(value) ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value) : "—";
const number = value => Number.isFinite(value) ? String(value) : "—";
const percent = value => Number.isFinite(value) ? `${(value * 100).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%` : "—";
const date = value => Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString("en-GB", { timeZoneName: "short" }) : "—";
const tone = value => value > 0 ? "pos" : value < 0 ? "neg" : "";
const gateLabels = {
  enoughObservation: "Observation", enoughTrades: "Trade sample", enoughRecentTrades: "Recent sample",
  positiveNet: "Net edge", adequateProfitFactor: "Profit factor", stressPositive: "2× costs",
  recentPositive: "Recent edge", drawdownWithinLimit: "Drawdown", consistentBlocks: "Time blocks",
  conservativeWeeklyScore: "Weekly stability"
};
let snapshot = null;
let busy = false;
let lastError = null;
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}
function value(id, text, className) {
  $(id).textContent = text;
  if (className !== undefined) $(id).className = className;
}
function freshness() {
  const age = snapshot ? Date.now() - Date.parse(snapshot.generatedAt) : Infinity;
  const behind = snapshot?.nextHour ? Date.now() - Date.parse(snapshot.nextHour) : 0;
  const stale = age > 7 * 60_000 || age < -5 * 60_000 || behind > 2 * 3_600_000;
  const label = lastError ? (snapshot ? "Snapshot unavailable · retained data" : "Snapshot unavailable")
    : !snapshot ? "Checking snapshot" : stale ? "Stale snapshot" : "Snapshot current";
  value("adaptiveHealth", label, `adaptive-badge ${!lastError && snapshot && !stale ? "adaptive-good" : "adaptive-warn"}`);
  $("adaptiveError").classList.toggle("hidden", !lastError && (!snapshot || !stale));
  value("adaptiveError", lastError ? `${lastError}${snapshot ? " Last valid data is retained below; it is not a live status." : " No account values are available."}`
    : stale ? "The observer snapshot is delayed. Do not treat the values below as current or assume the engine is running." : "");
  if (snapshot) value("adaptiveTiming", `Snapshot: ${date(snapshot.generatedAt)} · Sampling since: ${date(snapshot.startedAt)} · Next candle to process: ${date(snapshot.nextHour)} · Audit revision: ${number(snapshot.audit?.revision)}`);
}
function candidateCard(candidate, data) {
  const pair = data.shadows[candidate.id];
  const score = data.latestReview?.scores?.[candidate.id];
  const card = node("article", "adaptive-card");
  const title = node("div", "adaptive-card-title");
  title.append(node("h2", "", candidate.id), node("span", `adaptive-badge ${score?.eligible ? "adaptive-good" : ""}`, score ? (score.eligible ? "Qualified" : "Collecting / blocked") : "Awaiting review"));
  card.append(title, node("p", "adaptive-muted", `${candidate.family} · ${candidate.targetR === null ? "No fixed target" : `${number(candidate.targetR)}R target`} · ${number(candidate.maxHoldHours)}h max hold`));
  const returns = node("div", "adaptive-returns");
  for (const [label, account] of [["Normal costs", pair.normal], ["2× fees + slippage", pair.doubleCosts]]) {
    const cell = node("div", "");
    cell.append(node("span", "adaptive-muted", label), node("strong", tone(account.netPnlIncludingOpenLiquidationCosts), money(account.netPnlIncludingOpenLiquidationCosts)),
      node("span", "adaptive-muted", `${number(account.closed)} closed · ${account.closed ? `${account.winRatePct.toFixed(1)}% wins` : "— wins"} · PF ${account.profitFactor === null ? "—" : account.profitFactor.toFixed(2)}`));
    returns.append(cell);
  }
  card.append(returns);
  const days = score?.normal?.observedDays;
  const trades = score ? Math.min(score.normal.closed, score.stressed.closed) : null;
  card.append(node("p", "adaptive-sample", score ? `At last review: ${days.toFixed(1)} / ${number(data.learningPolicy.minDays)} days · ${trades} / ${number(data.learningPolicy.minTrades)} closes per scenario`
    : `Required: ${number(data.learningPolicy.minDays)} days + ${number(data.learningPolicy.minTrades)} closes per scenario`));
  if (score) {
    const gates = node("div", "adaptive-gates");
    for (const [key, label] of Object.entries(gateLabels)) {
      if (typeof score.gates?.[key] !== "boolean") continue;
      gates.append(node("span", `adaptive-gate ${score.gates[key] ? "passed" : ""}`, `${score.gates[key] ? "Pass" : "Wait"} · ${label}`));
    }
    card.append(gates);
  }
  card.append(node("p", "adaptive-diagnosis", score?.diagnosis ?? "Collecting prospective outcomes. No historical winner is imported."));
  return card;
}
function validate(data) {
  if (data?.mode !== "FORWARD_SHADOW" || data.realOrdersEnabled !== false || !Number.isFinite(Date.parse(data.generatedAt)) ||
      !Number.isFinite(Date.parse(data.startedAt)) || !Number.isFinite(Date.parse(data.nextHour)) ||
      !data.active || !data.risk || !data.learningPolicy || !Array.isArray(data.candidates) || data.candidates.length !== 6 || !data.shadows)
    throw new Error("Unsupported or incomplete adaptive snapshot.");
  const accounts = [data.active];
  for (const candidate of data.candidates) {
    if (typeof candidate.id !== "string" || !data.shadows[candidate.id]?.normal || !data.shadows[candidate.id]?.doubleCosts)
      throw new Error("Incomplete candidate snapshot.");
    accounts.push(data.shadows[candidate.id].normal, data.shadows[candidate.id].doubleCosts);
    const score = data.latestReview?.scores?.[candidate.id];
    if (score && (!Number.isFinite(score.normal?.observedDays) || !Number.isFinite(score.normal?.closed) || !Number.isFinite(score.stressed?.closed)))
      throw new Error("Incomplete review snapshot.");
  }
  for (const account of accounts) {
    if (![account.cash, account.equity, account.netPnlIncludingOpenLiquidationCosts, account.closed, account.winRatePct, account.openPositions].every(Number.isFinite) ||
        (account.profitFactor !== null && !Number.isFinite(account.profitFactor))) throw new Error("Invalid account values in snapshot.");
  }
  return data;
}
function render(data) {
  const active = data.active, policy = data.learningPolicy, risk = data.risk;
  value("adaptiveEquity", money(active.equity));
  value("adaptiveCash", `Cash ${money(active.cash)}`);
  value("adaptivePnl", money(active.netPnlIncludingOpenLiquidationCosts), `kpi-val ${tone(active.netPnlIncludingOpenLiquidationCosts)}`);
  value("adaptiveChampion", data.champion);
  value("adaptivePending", data.riskHalted ? "New entries halted by risk brake" : data.pending ? `Challenger: ${data.pending}` : data.champion === "CASH" ? "No qualified strategy selected" : "Automatic paper selection");
  value("adaptiveTrades", `${active.closed} / ${active.closed ? `${active.winRatePct.toFixed(1)}%` : "—"}`);
  value("adaptiveOpen", `${active.openPositions} open · no real orders`);
  $("adaptiveCandidates").replaceChildren(...data.candidates.map(candidate => candidateCard(candidate, data)));
  value("adaptiveReviewCount", `${number(data.reviews)} reviews`);
  $("adaptivePolicy").replaceChildren(...[
    "Observe completed 1h / 4h candles and simulate all six variants automatically.",
    `Review every ${number(policy.reviewDays)} days over a ${number(policy.lookbackDays)}-day window; minimum ${number(policy.minDays)} days, ${number(policy.minTrades)} closes and ${number(policy.minRecentTrades)} recent closes in both cost scenarios.`,
    `Require positive net results at normal and doubled costs, PF ≥ ${number(policy.minProfitFactor)}, and time-block stability. The weekly score is a heuristic, not statistical proof.`,
    `Promote after ${number(policy.challengerConfirmations)} consecutive qualifying reviews; keep incumbents at least ${number(policy.minChampionDays)} days before a challenger switch, but demote sooner if evidence fails.`,
    "Weakening results stop new entries automatically. Existing positions retain their original exit rules."
  ].map(text => node("li", "", text)));
  value("adaptiveReview", data.latestReview ? `${date(data.latestReview.ts)} · ${data.latestReview.reason}` : "The first review follows the first completed sampled hour. No manual strategy selection is needed.");
  value("adaptiveRiskState", data.riskHalted ? "HALTED" : "Guardrails set", `adaptive-badge ${data.riskHalted ? "adaptive-warn" : "adaptive-good"}`);
  const limits = [
    ["Risk per trade", percent(risk.riskPerTradePct)], ["Per position / total deployed", `${percent(risk.maxPositionPct)} / ${percent(risk.maxDeployPct)}`],
    ["Maximum open positions", number(risk.maxOpenPositions)], ["Daily loss / peak drawdown", `${percent(risk.dailyHaltPct)} / ${percent(risk.circuitBreakPct)}`],
    ["Loss pause", `${number(risk.maxConsecutiveLosses)} losses within ${number(risk.lossPauseHours)}h`],
    ["Fee / slippage per side", `${percent(risk.takerFeePct)} / ${percent(risk.slippagePct)}`]
  ];
  $("adaptiveRisk").replaceChildren(...limits.flatMap(([label, text]) => [node("dt", "", label), node("dd", "", text)]));
}
async function refresh() {
  if (busy) return;
  busy = true;
  $("adaptiveRefresh").disabled = true;
  try {
    const response = await fetch("/adaptive-status.json", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Snapshot request failed (HTTP ${response.status}).`);
    const next = validate(await response.json());
    render(next);
    snapshot = next;
    lastError = null;
  } catch (error) { lastError = error instanceof Error ? error.message : "Unable to read adaptive snapshot."; }
  finally {
    busy = false;
    $("adaptiveRefresh").disabled = false;
    freshness();
  }
}
$("adaptiveRefresh").addEventListener("click", refresh);
refresh();
setInterval(refresh, 15_000);
setInterval(freshness, 10_000);
