import { CANDIDATES, HOUR, RISK, VERSION } from "./v2/config.js";
import { SYMBOLS } from "../candidate/config.js";

const MINUTE = 60_000;
const ACCOUNT = "adaptive-active";
const DESCRIPTION = "Automatic adaptive paper account: closed-hour simulation, not live order-book fills. " +
  "Live quotes are market context only. Shadow balances are separate. Old ledger retained unchanged and excluded from this account.";
const NAMES = ["Bitcoin", "Ethereum", "Solana", "Chainlink", "Avalanche"];
const candidates = new Map(CANDIDATES.map(candidate => [candidate.id, candidate]));
const sum = values => values.reduce((total, value) => total + value, 0);
const time = value => typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
const iso = value => Number.isFinite(time(value)) ? new Date(time(value)).toISOString() : null;
const numeric = value => Number.isFinite(value) ? value : null;
const candidateName = id => id == null || id === "CASH" ? "CASH" : candidates.has(id) ? id : "unknown candidate";
const positionId = p => [ACCOUNT, p.candidateId, p.symbol, p.opened_at].map(encodeURIComponent).join(":");
const compareId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const newestFirst = (a, b) => time(b.ts) - time(a.ts) || compareId(a, b);

function compatiblePosition(p, closed = false) {
  const trail = candidates.get(p.candidateId)?.trailPct;
  const threshold = trail == null ? null : p.best_price * (1 - trail);
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(threshold ?? 0), Math.abs(p.stop_price)) * 8;
  return { ...p, id: positionId(p), status: closed ? "closed" : "open", qty_open: closed ? 0 : p.qty,
    size_usd: p.qty * p.entry_price, tp1_price: null, tp2_price: p.target_price ?? null,
    trail_active: threshold !== null && p.stop_price + tolerance >= threshold };
}

function markPosition(p, candles, candleOpen) {
  // The broker values the CLOSE of this exact candle, never the live quote or a nearby hour.
  const row = (candles ?? []).find(c => Array.isArray(c) && c[0] === candleOpen);
  const valid = row && row.length >= 6 && row.slice(0, 6).every(Number.isFinite) &&
    row.slice(1, 5).every(n => n > 0) && row[5] >= 0 &&
    row[3] <= Math.min(row[1], row[4]) && row[2] >= Math.max(row[1], row[4]);
  const markPrice = valid ? row[4] : null;
  // Match broker.equityAt: slippage on the exit price, then an exit fee on that notional.
  const exitNotional = markPrice === null ? null : p.qty * (markPrice * (1 - RISK.slippagePct));
  const liquidationValue = exitNotional === null ? null : exitNotional - exitNotional * RISK.takerFeePct;
  const unrealizedNet = liquidationValue === null ? null : liquidationValue - p.qty * p.entry_price - p.entry_fee;
  return { ...compatiblePosition(p), markPrice, markTime: valid ? iso(candleOpen) : null,
    liquidationValue, unrealized: unrealizedNet, unrealizedNet };
}

function fillsFrom(positions, closed) {
  const fills = new Map();
  for (const p of [...closed, ...positions]) {
    const id = positionId(p), pinned = candidateName(p.candidateId);
    fills.set(`${id}:entry`, { id: `${id}:entry`, ts: iso(p.opened_at), symbol: p.symbol,
      action: "BUY", side: p.side, qty: p.qty, price: p.entry_price, value_usd: p.qty * p.entry_price,
      fee_usd: p.entry_fee, pnl_usd: null, reason: `Closed-hour simulated entry; pinned candidate ${pinned}.` });
  }
  for (const p of closed) {
    const id = `${positionId(p)}:exit`;
    const exit = { stop: ["STOP", "protective stop"], target: ["TAKE_PROFIT", "full target exit"],
      time_exit: ["SELL", "maximum holding time"], signal_exit: ["SELL", "closed-candle strategy exit"] };
    const [action, reason] = Object.hasOwn(exit, p.exit_reason) ? exit[p.exit_reason] : ["SELL", "recorded exit"];
    fills.set(id, { id, ts: iso(p.closed_at), symbol: p.symbol, action, side: p.side,
      qty: p.qty, price: p.exit_price, value_usd: p.qty * p.exit_price, fee_usd: p.exit_fee,
      pnl_usd: p.pnl_usd, reason: `Closed-hour simulated ${reason}; pinned candidate ${candidateName(p.candidateId)}.` });
  }
  // At a shared timestamp show exits before entries; IDs break remaining ties deterministically.
  return [...fills.values()].sort((a, b) => time(b.ts) - time(a.ts) ||
    Number(a.action === "BUY") - Number(b.action === "BUY") || compareId(a, b));
}

function curveFrom(state) {
  const points = new Map([[state.startedAt, RISK.startingBalance]]);
  for (const point of state.active.curve) points.set(point.ts, point.equity);
  return [...points].sort(([a], [b]) => a - b).map(([ts, equity]) => ({ ts: iso(ts), equity }));
}

function reviewDecision(event) {
  const review = event.data.review;
  const type = ["REVIEW", "PROMOTE", "DEMOTE"].includes(review.type) ? review.type : "REVIEW";
  return { id: `${ACCOUNT}:review:${event.revision}`, ts: iso(review.ts ?? event.ts),
    symbol: "ACCOUNT", decision: "HOLD", kind: "REVIEW", reviewType: type, price: null,
    reason: `${type}: ${candidateName(review.previous)} -> ${candidateName(review.next)}. ` +
      "Recorded strategy review, not a trade fill." };
}

function errorMessage(value) {
  const message = typeof value === "string" ? value : value?.message;
  return typeof message === "string" && message.trim() ? message : null;
}

export function buildDashboard(state, events = [], { snapshot = null, revision = 0, market = {}, now = Date.now() } = {}) {
  const { active, learning } = state;
  const positions = Object.values(active.positions).map(p =>
    markPosition(p, market[p.symbol]?.candles1h, state.nextTime - HOUR)).sort(compareId);
  const closed = active.closed.map(p => compatiblePosition(p, true)).sort((a, b) =>
    time(b.closed_at) - time(a.closed_at) || compareId(a, b));
  const trades = fillsFrom(positions, closed);
  const curve = curveFrom(state);
  const equity = active.curve.at(-1)?.equity ?? RISK.startingBalance;
  const totalPnl = sum(active.closed.map(p => p.pnl_usd));
  const unrealizedNet = equity - RISK.startingBalance - totalPnl;
  let equityPeak = RISK.startingBalance, maxDrawdownPct = 0;
  for (const point of curve) {
    equityPeak = Math.max(equityPeak, point.equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, (1 - point.equity / equityPeak) * 100);
  }
  const stats = { closedCount: closed.length,
    winRate: closed.length ? closed.filter(p => p.pnl_usd > 0).length / closed.length * 100 : 0,
    totalPnl, totalFees: sum(active.closed.map(p => p.entry_fee + p.exit_fee)) + sum(positions.map(p => p.entry_fee)),
    totalFills: trades.length, closed, unrealizedNet, equityPeak, maxDrawdownPct };

  const generatedAt = time(snapshot?.generatedAt);
  const age = now - generatedAt;
  const observerFresh = state.mode === "FORWARD_SHADOW" && snapshot?.mode === "FORWARD_SHADOW" &&
    snapshot.version === state.version && snapshot.audit?.revision === revision &&
    Number.isFinite(age) && age >= -5 * MINUTE && age <= 7 * MINUTE &&
    Number.isFinite(state.nextTime) && now - state.nextTime <= 2 * HOUR;
  const nextObservationAt = iso(generatedAt + 5 * MINUTE);
  const lastCycle = iso(active.curve.at(-1)?.ts);
  const reviews = events.filter(event => event.data?.review).slice().sort((a, b) => a.revision - b.revision);
  const reviewDecisions = reviews.map(reviewDecision);
  const champion = learning.champion ?? null;
  const exploration = learning.exploration ?? null;
  const activeStrategy = champion ?? exploration?.candidateId ?? "CASH";
  const riskHalted = Boolean(learning.riskHalted || active.riskHalted);
  const status = { schema: 2, source: VERSION, automatic: true, accountId: ACCOUNT,
    mode: state.mode, version: state.version, revision, champion: champion ?? "CASH", activeStrategy,
    exploration: exploration ? { candidateId: exploration.candidateId, since: iso(exploration.since),
      reason: typeof exploration.reason === "string" ? exploration.reason : null } : null,
    riskHalted, dayHalted: Boolean(active.dayHalted),
    startedAt: iso(state.startedAt), agent: { running: observerFresh, startedAt: iso(state.initializedAt), pid: null },
    observerFresh, nextObservationAt, lastCycle, valuationTime: lastCycle, loopIntervalMin: 5, exchange: "okx",
    cash: active.cash, equity, deployedUsd: equity - active.cash, openCount: positions.length,
    pnlTotal: equity - RISK.startingBalance, pnlPct: (equity - RISK.startingBalance) / RISK.startingBalance * 100,
    unrealizedNet, stats, risk: RISK, reviewCount: learning.reviewCount,
    lastReview: reviews.length ? structuredClone(reviews.at(-1).data.review) : null,
    drawdownBasis: "Starting balance plus active closed-hour equity curve only; excludes intrahour broker peaks and shadow accounts.",
    realOrdersEnabled: false, message: DESCRIPTION };

  const bySymbol = new Map(positions.map(p => [p.symbol, p]));
  const assets = SYMBOLS.map((symbol, i) => {
    const context = market[symbol] ?? {}, p = bySymbol.get(symbol);
    return { symbol, name: NAMES[i], price: numeric(context.price), priceTs: iso(context.priceTs), lastTs: iso(context.priceTs),
      trend1h: context.trend1h ?? null, trend4h: context.trend4h ?? null, rsi1h: numeric(context.rsi1h),
      momentum1h: numeric(context.momentum1h), momentum4h: numeric(context.momentum4h),
      volatility: numeric(context.volatility), volSpike: numeric(context.volSpike), vol24: numeric(context.vol24),
      high24: numeric(context.high24), low24: numeric(context.low24), error: errorMessage(context.error),
      // Allocation uses net liquidation value, while size_usd on positions stays entry notional.
      position: p ? { id: p.id, qty: p.qty, side: p.side, entry: p.entry_price, sizeUsd: p.liquidationValue,
        entryNotionalUsd: p.size_usd, markPrice: p.markPrice, markTime: p.markTime, unrealizedNet: p.unrealizedNet } : null };
  });

  const selection = riskHalted ? "Risk halted; new entries disabled." : active.dayHalted ? "Daily risk halt; new entries disabled." :
    champion ? `Selected strategy ${candidateName(champion)} (qualified champion).` :
    exploration ? `Selected exploration candidate ${candidateName(exploration.candidateId)} from prior shadow results; no entry without its closed-candle signal.` :
    "CASH selected; no active entry strategy.";
  const lastSignalEvent = events.filter(event => event.kind === "CLOSED_HOUR" &&
    event.data?.executionUsed === activeStrategy).sort((a, b) => a.revision - b.revision).at(-1);
  const signalReason = symbol => lastSignalEvent?.data?.entrySignals?.find(signal => signal.symbol === symbol)?.reason ?? null;
  const decisions = trades.map(fill => ({ id: `${fill.id}:decision`, ts: fill.ts, symbol: fill.symbol,
    decision: fill.action === "BUY" ? "BUY" : "SELL", kind: "FILL", action: fill.action, fillId: fill.id,
    price: fill.price, reason: fill.reason }));
  decisions.push(...reviewDecisions, ...SYMBOLS.map(symbol => {
    const p = bySymbol.get(symbol), waiting = signalReason(symbol);
    return { id: `${ACCOUNT}:hold:${encodeURIComponent(symbol)}`, ts: lastCycle ?? iso(state.startedAt),
      symbol, decision: "HOLD", kind: "STATUS", price: p?.markPrice ?? null,
      reason: `${selection} ${p ? `Existing position retains pinned ${candidateName(p.candidateId)} exits.` :
        waiting ? `No position: ${waiting}.` : "No active position."} ` +
        "Closed-hour simulation status only; live quotes do not create signals." };
  }));
  decisions.sort((a, b) => time(b.ts) - time(a.ts) ||
    Number(a.kind === "STATUS") - Number(b.kind === "STATUS") || newestFirst(a, b));

  const logs = [DESCRIPTION, `Account ${ACCOUNT}; champion ${candidateName(champion)}; exploration ${candidateName(exploration?.candidateId)}; ${selection}`];
  const recorded = [...trades.map(fill => ({ ...fill, text: `${fill.action} ${fill.symbol}: ${fill.reason}` })),
    ...reviewDecisions.map(d => ({ ...d, text: d.reason }))].sort((a, b) => time(a.ts) - time(b.ts) || compareId(a, b));
  logs.push(...recorded.map(item => `[${item.ts}] ${item.text}`));
  for (const p of positions) if (p.markPrice === null)
    logs.push(`${p.symbol}: accounting mark unavailable for candle open ${iso(state.nextTime - HOUR)}; account equity remains the saved closed-hour value.`);
  if (!observerFresh) {
    logs.push("Observer snapshot missing, stale or mismatched, or closed-hour data over two hours behind; process liveness is not inferred.");
    const errors = [snapshot?.error, snapshot?.observerError, ...events.filter(e => /ERROR|HALTED/.test(e.kind)).map(e => e.data?.error)];
    for (const message of new Set(errors.map(errorMessage).filter(Boolean))) logs.push(`Observer error: ${message}`);
  }
  return { status, assets, positions, closed, trades, decisions, curve, logs };
}
