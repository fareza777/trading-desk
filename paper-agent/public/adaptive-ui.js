const $ = id => document.getElementById(id);
const money = value => Number.isFinite(value) ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value) : "—";
const number = value => Number.isFinite(value) ? String(value) : "—";
const percent = value => Number.isFinite(value) ? `${(value * 100).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%` : "—";
const stamp = value => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? parsed.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })
    : "—";
};
const tone = value => value > 0 ? "pos" : value < 0 ? "neg" : "";
const DAY = 86_400_000;
const gateLabels = {
  enoughObservation: "Observation", enoughTrades: "Trade sample", enoughRecentTrades: "Recent sample",
  positiveNet: "Net edge", adequateProfitFactor: "Profit factor", stressPositive: "2× costs",
  recentPositive: "Recent edge", drawdownWithinLimit: "Drawdown", consistentBlocks: "Time blocks",
  conservativeWeeklyScore: "Weekly stability"
};
const summaryGates = ["enoughTrades", "positiveNet", "stressPositive", "drawdownWithinLimit"];
let snapshot = null;
let busy = false;
let lastError = null;
const activeStrategyOf = data => data.activeStrategy ?? data.execution?.candidateId ?? data.exploration?.candidateId ?? "CASH";

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}
function value(id, text, className) {
  const element = $(id);
  if (!element) return;
  element.textContent = text;
  if (className !== undefined) element.className = className;
}
function setBar(element, fraction) {
  if (!element) return;
  element.style.width = `${Math.max(0, Math.min(100, fraction * 100))}%`;
}
function metaItem(label, text) {
  const item = node("span", "adaptive-meta-item");
  item.append(node("span", "", label), node("b", "", text));
  return item;
}
function metric(label, text, className = "", title = "") {
  const cell = node("span", "candidate-metric");
  const valueNode = node("b", className, text);
  if (title) cell.title = title;
  cell.append(node("small", "", label), valueNode);
  return cell;
}
function freshness() {
  const age = snapshot ? Date.now() - Date.parse(snapshot.generatedAt) : Infinity;
  const behind = snapshot?.nextHour ? Date.now() - Date.parse(snapshot.nextHour) : 0;
  const stale = age > 7 * 60_000 || age < -5 * 60_000 || behind > 2 * 3_600_000;
  const live = Boolean(snapshot) && !lastError && !stale;
  value("adaptiveHealth", lastError ? (snapshot ? "Offline · cached" : "Offline")
    : !snapshot ? "Connecting" : stale ? "Delayed" : "Live",
    `adaptive-badge ${live ? "adaptive-good" : "adaptive-warn"}`);
  const orb = $("adaptiveOrb");
  if (orb) orb.className = `adaptive-orb${live ? " on" : ""}`;
  const message = lastError
    ? `${lastError}${snapshot ? " Showing the last valid snapshot; values may be out of date." : " No snapshot is available."}`
    : stale ? "Snapshot delayed. Values are not live; the observer retries automatically." : "";
  const alert = $("adaptiveError");
  if (alert) {
    alert.textContent = message;
    alert.classList.toggle("hidden", !message);
  }
  const timing = $("adaptiveTiming");
  if (timing) {
    if (!snapshot) timing.replaceChildren(metaItem("Updated", "Waiting"), metaItem("Next candle", "—"), metaItem("Audit", "—"));
    else timing.replaceChildren(
      metaItem("Updated", stamp(snapshot.generatedAt)),
      metaItem("Next candle", stamp(Date.parse(snapshot.nextHour) + 3_600_000)),
      metaItem("Audit", `rev ${number(snapshot.audit?.revision)}`)
    );
  }
}
function candidateRow(candidate, data, index, activeStrategy) {
  const pair = data.shadows[candidate.id];
  const score = data.latestReview?.scores?.[candidate.id];
  const champion = data.champion && data.champion !== "CASH" ? data.champion : null;
  const details = node("details", `candidate${candidate.id === activeStrategy ? " is-active" : ""}`);
  details.open = candidate.id === activeStrategy;
  const summary = node("summary", "candidate-summary");
  const title = node("span", "candidate-title");
  title.append(node("b", "", candidate.id));
  if (champion === candidate.id) title.append(node("span", "candidate-chip champion", "Champion"));
  if (candidate.id === activeStrategy) title.append(node("span", "candidate-chip active", "Active"));
  if (score?.eligible && champion !== candidate.id && candidate.id !== activeStrategy)
    title.append(node("span", "candidate-chip qualified", "Qualified"));
  if (!title.querySelector(".candidate-chip")) title.append(node("span", "candidate-chip", "Learning"));
  const name = node("span", "candidate-name");
  name.append(title, node("small", "",
    `${candidate.family ?? "variant"} · ${candidate.targetR === null ? "No fixed target" : `${number(candidate.targetR)}R target`} · ${number(candidate.maxHoldHours)}h max hold`));
  const normal = pair.normal, stressed = pair.doubleCosts;
  const metrics = node("span", "candidate-metrics");
  metrics.append(
    metric("Normal", money(normal.netPnlIncludingOpenLiquidationCosts), tone(normal.netPnlIncludingOpenLiquidationCosts)),
    metric("2× costs", money(stressed.netPnlIncludingOpenLiquidationCosts), tone(stressed.netPnlIncludingOpenLiquidationCosts)),
    metric("Closes", `${number(normal.closed)} / ${number(stressed.closed)}`, "", "Normal costs / 2× costs"),
    metric("Win", normal.closed ? `${normal.winRatePct.toFixed(0)}%` : "—"),
    metric("PF", normal.profitFactor === null ? "—" : normal.profitFactor.toFixed(2))
  );
  summary.append(node("span", "candidate-rank", String(index + 1).padStart(2, "0")), name, metrics,
    node("span", "candidate-chevron", "⌄"));
  details.append(summary);
  const body = node("div", "candidate-body");
  if (score) {
    const days = Math.min(score.normal.observedDays, score.stressed.observedDays);
    const closes = Math.min(score.normal.closed, score.stressed.closed);
    body.append(node("span", "candidate-sample",
      `At last review: ${days.toFixed(1)} / ${number(data.learningPolicy.minDays)} days · ${closes} / ${number(data.learningPolicy.minTrades)} closes per scenario`));
    const gates = node("span", "adaptive-gates");
    for (const [key, label] of Object.entries(gateLabels)) {
      if (typeof score.gates?.[key] !== "boolean") continue;
      gates.append(node("span", `adaptive-gate ${score.gates[key] ? "passed" : ""}`, `${score.gates[key] ? "Pass" : "Wait"} · ${label}`));
    }
    body.append(gates, node("p", "adaptive-diagnosis", score.diagnosis ?? "No diagnosis recorded."));
  } else {
    body.append(node("p", "candidate-empty", "First review pending. Prospective outcomes are still being collected."));
  }
  details.append(body);
  return details;
}
function validate(data) {
  if (data?.schema !== 2 || data.mode !== "FORWARD_SHADOW" || data.realOrdersEnabled !== false ||
      !Number.isFinite(Date.parse(data.generatedAt)) || !Number.isFinite(Date.parse(data.startedAt)) ||
      !Number.isFinite(Date.parse(data.nextHour)) || typeof activeStrategyOf(data) !== "string" ||
      !data.active || !data.risk || !data.learningPolicy || !data.exploration ||
      !Array.isArray(data.candidates) || data.candidates.length < 1 ||
      !data.shadows || Object.keys(data.shadows).length !== data.candidates.length)
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
  const activeStrategy = activeStrategyOf(data);
  const champion = data.champion && data.champion !== "CASH" ? data.champion : null;
  const deployed = Math.max(0, active.equity - active.cash);
  value("adaptiveEquity", money(active.equity));
  value("adaptiveCash", `Cash ${money(active.cash)}`);
  value("adaptivePnl", money(active.netPnlIncludingOpenLiquidationCosts),
    `kpi-val ${tone(active.netPnlIncludingOpenLiquidationCosts)}`);
  value("adaptiveDeployed", money(deployed));
  value("adaptiveDeployedSub", `${number(active.openPositions)} / ${number(risk.maxOpenPositions)} open · no real orders`);
  value("adaptiveTrades", `${number(active.closed)} / ${active.closed ? `${active.winRatePct.toFixed(0)}%` : "—"}`);
  value("adaptiveClosedSub", active.closed ? `${number(active.closed)} closed · paper only` : "No closed trades yet");
  value("adaptiveChampion", activeStrategy);
  value("adaptivePending", data.riskHalted ? "Risk halt" : champion ? "Champion" : "Exploration");
  value("adaptiveStrategyNote", data.riskHalted ? "New entries are paused by a fixed risk brake."
    : champion ? "Champion selected automatically from verified paper results."
    : "No champion yet. The exploration candidate can stay in cash.");

  const started = Date.parse(data.startedAt);
  const observedDays = Math.min(Math.max(0, (Date.now() - started) / DAY), policy.lookbackDays);
  const shadow = data.shadows[activeStrategy];
  const closed = shadow ? Math.min(shadow.normal.closed, shadow.doubleCosts.closed) : 0;
  value("adaptiveDays", `${observedDays.toFixed(1)} / ${number(policy.minDays)} days`);
  value("adaptiveTradesProgress", `${number(closed)} / ${number(policy.minTrades)} closes`);
  const daysLabel = $("adaptiveDays");
  if (daysLabel) daysLabel.title = `Collected since ${stamp(data.startedAt)}`;
  setBar($("adaptiveDaysBar"), observedDays / policy.minDays);
  setBar($("adaptiveTradesBar"), closed / policy.minTrades);

  const score = data.latestReview?.scores?.[activeStrategy];
  const gateNodes = [];
  if (score?.gates) {
    const entries = Object.entries(score.gates).filter(([, passed]) => typeof passed === "boolean");
    gateNodes.push(node("span", "adaptive-gate-chip", `${entries.filter(([, passed]) => passed).length}/${entries.length} gates`));
    for (const key of summaryGates) {
      if (typeof score.gates[key] !== "boolean") continue;
      gateNodes.push(node("span", `adaptive-gate-chip ${score.gates[key] ? "pass" : "wait"}`,
        `${score.gates[key] ? "Pass" : "Wait"} · ${gateLabels[key]}`));
    }
  } else gateNodes.push(node("span", "adaptive-gate-chip", "First review pending"));
  $("adaptiveGateSummary").replaceChildren(...gateNodes);
  value("adaptiveReviewCount", `${number(data.reviews)} ${data.reviews === 1 ? "review" : "reviews"}`);
  const review = data.latestReview;
  value("adaptiveReview", review
    ? `Last review ${stamp(review.ts)} · ${String(review.reason ?? "review complete").replace(/\.$/, "")}`
    : "No review yet. The first review follows the first completed sampled hour.");
  if (review && $("adaptiveReview")) $("adaptiveReview").title = review.reason ?? "";

  value("adaptiveRiskState", data.riskHalted ? "Halted" : "Guardrails set",
    `adaptive-badge ${data.riskHalted ? "adaptive-warn" : "adaptive-good"}`);
  const limits = [
    ["Risk / trade", percent(risk.riskPerTradePct)], ["Per position", percent(risk.maxPositionPct)],
    ["Deployed cap", percent(risk.maxDeployPct)], ["Open cap", number(risk.maxOpenPositions)],
    ["Daily halt", percent(risk.dailyHaltPct)], ["Peak drawdown", percent(risk.circuitBreakPct)],
    ["Loss pause", `${number(risk.maxConsecutiveLosses)} / ${number(risk.lossPauseHours)}h`],
    ["Cost / side", `${percent(risk.takerFeePct)} + ${percent(risk.slippagePct)}`]
  ];
  $("adaptiveRisk").replaceChildren(...limits.map(([label, text]) => {
    const item = node("div", "adaptive-risk-item");
    item.append(node("span", "", label), node("b", "", text));
    return item;
  }));

  const candidates = [...data.candidates].sort((a, b) =>
    data.shadows[b.id].normal.netPnlIncludingOpenLiquidationCosts - data.shadows[a.id].normal.netPnlIncludingOpenLiquidationCosts);
  $("adaptiveCandidates").replaceChildren(...candidates.map((candidate, index) =>
    candidateRow(candidate, data, index, activeStrategy)));

  $("adaptivePolicy").replaceChildren(...[
    `Observe completed 1h and 4h candles, then simulate all ${number(data.candidates.length)} variants at normal and 2× costs.`,
    champion ? `The qualified champion ${champion} takes new entries when its signal is clear.`
      : `Until a champion qualifies, one exploration candidate is followed (${activeStrategy}). No signal means cash.`,
    `Review every ${number(policy.reviewDays)} days over a ${number(policy.lookbackDays)}-day window; require at least ${number(policy.minDays)} days and ${number(policy.minTrades)} closes per scenario.`,
    `Require positive net at both costs, PF ≥ ${number(policy.minProfitFactor)}, drawdown inside the limit and time-block stability.`,
    `Promote after ${number(policy.challengerConfirmations)} qualifying reviews; keep a champion at least ${number(policy.minChampionDays)} days, but demote sooner if evidence weakens.`,
    "Open positions keep the variant and exit rules that entered them."
  ].map(text => node("li", "", text)));
}
async function refresh() {
  if (busy) return;
  busy = true;
  try {
    const response = await fetch("/adaptive-status.json", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Snapshot request failed (HTTP ${response.status}).`);
    const next = validate(await response.json());
    snapshot = next;
    lastError = null;
    render(next);
  } catch (error) {
    lastError = error instanceof Error ? error.message : "Unable to read adaptive snapshot.";
  } finally {
    busy = false;
    freshness();
  }
}
document.addEventListener("td:refresh", refresh);
refresh();
setInterval(refresh, 15_000);
setInterval(freshness, 10_000);
