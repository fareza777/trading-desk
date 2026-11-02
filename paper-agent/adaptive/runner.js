import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { HERE, VERSION, HOUR, DAY, RISK, CANDIDATES, LEARNING } from "./config.js";
import { newPortfolio, advancePortfolio } from "./broker.js";
import { newLearning, updateLearning } from "./learner.js";
import { AdaptiveStore } from "./store.js";
import { SYMBOLS } from "../candidate/config.js";
import { prepareStudy } from "../candidate/study.js";
import { createExchange, fetchHistory } from "../candidate/market.js";

const DB_FILE = path.join(HERE, "adaptive-state.db");
const REGISTRATION = path.join(HERE, "registration.json");
const REPLAY_REPORT = path.join(HERE, "replay-results.json");
const SOURCE_FILES = ["config.js", "learner.js", "broker.js", "store.js", "runner.js", "../candidate/study.js",
  "../candidate/config.js", "../candidate/indicators.js", "../candidate/market.js", "../candidate/engine.js",
  "../candidate/backtest.js", "../candidate/exits.js", "../candidate/strategy.js", "../candidate/legacy.js",
  "../config.js", "../engine.js", "../package.json", "../../ccxt-mcp/package-lock.json"];
const hash = value => createHash("sha256").update(value).digest("hex");
const jsonHash = value => hash(JSON.stringify(value));
export function fingerprint() {
  return jsonHash(Object.fromEntries(SOURCE_FILES.map(file => [file, hash(fs.readFileSync(path.join(HERE, file)))])));
}
export function parseMode(args) {
  if (args.length > 1 || args.some(arg => !["--status", "--once", "--watch", "--register", "--replay"].includes(arg)))
    throw new Error("choose one: --status (default), --once, --watch, --register or --replay; no real-order mode exists");
  return args[0] ?? "--status";
}
export function newState(nextTime, codeHash, mode = "FORWARD_SHADOW") {
  return { version: VERSION, codeHash, mode, initializedAt: nextTime, startedAt: nextTime, nextTime, learning: newLearning(),
    active: newPortfolio(), shadows: Object.fromEntries(CANDIDATES.map(c => [c.id, { normal: newPortfolio(), stressed: newPortfolio() }])) };
}
function observations(prepared, time) {
  const bars = {}, analyses = {};
  for (const symbol of SYMBOLS) {
    const data = prepared.features[symbol]?.get(time);
    const bar = prepared.rows[symbol]?.[prepared.index[symbol]?.get(time)];
    if (!data || !bar) throw new Error(`${symbol}: unavailable closed-hour observation`);
    bars[symbol] = bar;
    analyses[symbol] = { ...data.candidate, quoteVolume: data.quoteVolume };
  }
  return { bars, analyses };
}
export function advanceState(previous, prepared) {
  const time = previous.nextTime;
  if (time < prepared.start || time + HOUR > prepared.end) throw new Error("next hour unavailable; never skip an unobserved interval");
  const { bars, analyses } = observations(prepared, time);
  const shadows = {};
  const outcomes = [];
  for (const c of CANDIDATES) {
    const old = previous.shadows[c.id];
    const normal = advancePortfolio(old.normal, bars, analyses, c.id, time, { shadow: true });
    const stressed = advancePortfolio(old.stressed, bars, analyses, c.id, time, { shadow: true, frictionMultiplier: 2 });
    shadows[c.id] = { normal, stressed };
    for (const [scenario, portfolio] of Object.entries(shadows[c.id]))
      outcomes.push(...portfolio.closed.slice(old[scenario].closed.length).map(trade => ({ portfolio: c.id, scenario, trade })));
  }
  const active = advancePortfolio(previous.active, bars, analyses, previous.learning.champion, time);
  const activeOutcomes = active.closed.slice(previous.active.closed.length);
  const { learning, event: review } = updateLearning(previous.learning, shadows, active, time + HOUR);
  const state = { ...previous, nextTime: time + HOUR, shadows, active, learning };
  return { state, event: { ts: time + HOUR, kind: "CLOSED_HOUR", data: { inputHash: jsonHash({ bars, analyses }),
    candleOpen: time, championUsed: previous.learning.champion, nextChampion: learning.champion, review,
    activeOutcomes, shadowOutcomes: outcomes, equity: active.curve.at(-1).equity } } };
}
function accountSummary(portfolio) {
  const equity = portfolio.curve.at(-1)?.equity ?? RISK.startingBalance;
  const winners = portfolio.closed.filter(p => p.pnl_usd > 0), losers = portfolio.closed.filter(p => p.pnl_usd < 0);
  const gains = winners.reduce((n, p) => n + p.pnl_usd, 0), losses = -losers.reduce((n, p) => n + p.pnl_usd, 0);
  return { cash: portfolio.cash, equity, netPnlIncludingOpenLiquidationCosts: equity - RISK.startingBalance,
    realizedPnl: gains - losses, openPositions: Object.keys(portfolio.positions).length,
    closed: portfolio.closed.length, winRatePct: portfolio.closed.length ? winners.length / portfolio.closed.length * 100 : 0,
    profitFactor: losses > 0 ? gains / losses : null, peak: portfolio.peak };
}
export function summarize(state) {
  return { version: state.version, mode: state.mode, startedAt: new Date(state.startedAt).toISOString(),
    nextHour: new Date(state.nextTime).toISOString(), champion: state.learning.champion ?? "CASH",
    pending: state.learning.pending, riskHalted: state.learning.riskHalted, reviews: state.learning.reviewCount, active: accountSummary(state.active),
    shadows: Object.fromEntries(CANDIDATES.map(c => [c.id, { normal: accountSummary(state.shadows[c.id].normal),
      doubleCosts: accountSummary(state.shadows[c.id].stressed) }])),
    realOrdersEnabled: false, productionTradingModified: false,
    evidence: state.mode === "FORWARD_SHADOW" ? "prospective closed-bar simulation, NOT actual order-book fills" : "exploratory historical replay of an already inspected dataset, NOT a new holdout" };
}
export function storeStatus(store) {
  const saved = store.load();
  return { ...(saved ? summarize(saved.state) : { mode: "NOT_INITIALIZED", realOrdersEnabled: false }), audit: store.verify() };
}
export function dashboardSnapshot(store) {
  const latestReview = store.events().findLast(event => event.data?.review)?.data.review ?? null;
  return { ...storeStatus(store), generatedAt: new Date().toISOString(), latestReview,
    risk: RISK, learningPolicy: LEARNING, candidates: CANDIDATES };
}
function publishDashboard(store) {
  const target = path.join(HERE, "../public/adaptive-status.json");
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(dashboardSnapshot(store)) + "\n", { flag: "wx" });
  try { fs.renameSync(temporary, target); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
export function runReplay(prepared, codeHash) {
  let state = newState(prepared.start, codeHash, "HISTORICAL_RESEARCH");
  const reviews = [], transitions = [];
  while (state.nextTime < prepared.end) {
    const result = advanceState(state, prepared);
    state = result.state;
    if (result.event.data.review) {
      reviews.push(result.event.data.review);
      if (result.event.data.review.type !== "REVIEW") transitions.push(result.event.data.review);
    }
  }
  return { ...summarize(state), sourceHash: codeHash, reviews, transitions, activeTrades: state.active.closed,
    activePositions: state.active.positions, activeCurve: state.active.curve,
    shadowEvidence: Object.fromEntries(CANDIDATES.map(c => [c.id, Object.fromEntries(["normal", "stressed"].map(scenario =>
      [scenario, { trades: state.shadows[c.id][scenario].closed, positions: state.shadows[c.id][scenario].positions }]))])),
    finalMarks: Object.fromEntries(SYMBOLS.map(s => [s, prepared.rows[s][prepared.index[s].get(prepared.end - HOUR)][4]])),
    forwardPromotionAuthorized: false };
}

export async function observeOnce(exchange, store, codeHash, wallNow = Date.now()) {
  const serverTime = await exchange.fetchTime();
  if (!Number.isSafeInteger(serverTime) || Math.abs(serverTime - wallNow) > 5 * 60_000)
    throw new Error("market/server clock differs by over five minutes; no learning or orders");
  const end = Math.floor(serverTime / HOUR) * HOUR;
  const saved = store.load();
  if (saved && (saved.state.codeHash !== codeHash || saved.state.version !== VERSION || saved.state.mode !== "FORWARD_SHADOW"))
    throw new Error("checkpoint is not this frozen forward version; do not overwrite or inherit historical winners");
  if (saved && (serverTime < saved.state.initializedAt || saved.state.nextTime > end + HOUR || end - saved.state.nextTime > 30 * DAY))
    throw new Error("clock moved backwards or outage exceeds 30 days; explicit recovery required");
  if (saved && saved.state.nextTime >= end) return { ...summarize(saved.state), processedHours: 0, revision: saved.revision };
  const start = saved?.state.startedAt ?? end + HOUR;
  const from = start - 3216 * HOUR;
  const dataset = { exchange: "okx", timeframe: "1h", from, to: end, symbols: {} };
  for (const symbol of SYMBOLS) dataset.symbols[symbol] = await fetchHistory(exchange, symbol, (end - from) / HOUR, end);
  const prepared = prepareStudy(dataset);
  let revision = saved?.revision ?? 0;
  let state = saved?.state ?? { ...newState(start, codeHash), initializedAt: serverTime };
  let processedHours = 0;
  if (!saved) {
    revision = store.commit(0, state, { ts: serverTime, kind: "INITIALIZED", data: { codeHash, bootstrapDataHash: jsonHash(dataset),
      message: "past candles seed indicators only; first sampled interval starts after initialization" } });
  } else {
    while (state.nextTime < end) {
      const result = advanceState(state, prepared);
      result.event.data.observedAt = serverTime;
      result.event.data.catchUp = end - state.nextTime > HOUR;
      revision = store.commit(revision, result.state, result.event);
      state = result.state; processedHours++;
    }
  }
  return { ...summarize(state), processedHours, revision };
}

function register() {
  const sources = [
    { url: "https://www.freqtrade.io/en/stable/freqai-running/", use: "rolling retraining, model expiry, caution about naive continual-learning overfitting", accessed: "documentation" },
    { url: "https://www.freqtrade.io/en/stable/freqai-reinforcement-learning/", use: "RL reward/environment simplifications are not a production strategy", accessed: "documentation" },
    { url: "https://qlib.readthedocs.io/en/v0.8.3/component/online.html", use: "separate online strategy management, routine updates, and simulation", accessed: "documentation" },
    { url: "https://github.com/microsoft/qlib", use: "repository identified through search; source not inspected because gh is unavailable", accessed: "indexed search only" },
    { url: "https://github.com/robcaulk/freqai", use: "repository identified through search; source not inspected because gh is unavailable", accessed: "indexed search only" },
    { url: "https://portfoliooptimizationbook.com/book/8.3-dangers-backtesting.html", use: "selection bias and repeated strategy testing; preserve rejected alternatives", accessed: "publication" },
    { url: "https://www.nber.org/papers/w24877", use: "historical crypto momentum motivation; does not validate these 4h rules or future profit", accessed: "indexed abstract" },
    { url: "https://www.reddit.com/r/algotrading/comments/1gussns/walk_forward_analysis_overfitting_question_dump/", use: "search surfaced overfitting discussion; direct access was CAPTCHA, no comments treated as evidence", accessed: "blocked" },
  ];
  const datasetHash = hash(fs.readFileSync(path.join(HERE, "../candidate/history-3y-20261028.json")));
  const manifest = { registeredAt: new Date().toISOString(), version: VERSION, sourceHash: fingerprint(), datasetHash,
    nodeVersion: process.version, risk: RISK, candidates: CANDIDATES, learning: LEARNING, sources,
    limitations: [
      "X and Threads searches did not yield usable technical evidence; no claim that their content or all GitHub source was reviewed.",
      "Adaptive means selecting fixed, versioned entry/exit variants from observed net results; it does not rewrite source, invent unbounded strategies, use an LLM reward, or raise risk.",
      "Underlying signal families failed previous screens; they remain hypotheses, not a proven profitable foundation.",
      "Weekly mean minus three standard errors is a conservative heuristic, NOT a calibrated significance level or correction for dependent returns and repeated testing. Multiple alternatives/reviews still create selection bias.",
      "The six shadow portfolios each have independent virtual capital. Their P&Ls must never be added to report active account returns.",
      "Shadow candidates skip portfolio drawdown/daily/consecutive-loss entry brakes to keep sampling hypotheses, but keep cash, position, per-trade risk, liquidity and cooldown limits. Only the selected active paper portfolio has the hard persistent portfolio brakes.",
      "Signals use previous closed data; modeled entry at next hourly open. Completed OHLC bars determine pessimistic stop-first fills. Trailing levels apply next bar. No partial exits. Slippage 0.08% and fee 0.26% per side; actual account fee tier and historical depth remain unverified.",
      "Selection only sees past outcomes; promoted strategy takes new entries next hour. Existing positions retain their entry version and protective exits. Historical winners never seed forward champion.",
      "Historical data was already inspected during earlier failed experiments; replay is exploratory, not a pristine holdout. Forward shadow needs at least 90 days, 30 closed trades, costs/stability gates and two weekly confirmations.",
      "Forward mode is prospective closed-bar simulation, not executable quote/order-book paper fills or real trading. Late polls replay missed hours and are marked catch-up; clock/data gaps fail closed.",
      "Forward indicator initialization uses a fixed start anchor, so hourly and catch-up polling produce identical features on identical candles. Initial sampling starts at the next hour, never before initialization.",
      "No production trading sources, ledger, existing watchdog or credentials are touched. The dashboard receives a separate atomic read-only summary file. --watch lives only as long as its process; no 24/7 durability is implied."
    ] };
  fs.writeFileSync(REGISTRATION, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  return { registered: REGISTRATION, sourceHash: manifest.sourceHash };
}
function registeredHash() {
  const manifest = JSON.parse(fs.readFileSync(REGISTRATION, "utf8"));
  if (manifest.sourceHash !== fingerprint()) throw new Error("source changed after registration; do not silently mutate the experiment");
  return manifest.sourceHash;
}
async function main() {
  const mode = parseMode(process.argv.slice(2));
  if (mode === "--register") { console.log(JSON.stringify(register(), null, 2)); return; }
  if (mode === "--status") {
    if (!fs.existsSync(DB_FILE)) { console.log(JSON.stringify({ mode: "NOT_STARTED", realOrdersEnabled: false })); return; }
    const store = new AdaptiveStore(DB_FILE, { readOnly: true });
    try { console.log(JSON.stringify(storeStatus(store), null, 2)); }
    finally { store.close(); }
    return;
  }
  const codeHash = registeredHash();
  if (mode === "--replay") {
    if (fs.existsSync(REPLAY_REPORT)) throw new Error("historical report already exists; do not overwrite rejected results");
    const input = fs.readFileSync(path.join(HERE, "../candidate/history-3y-20261028.json"));
    const datasetHash = hash(input);
    if (datasetHash !== JSON.parse(fs.readFileSync(REGISTRATION, "utf8")).datasetHash) throw new Error("historical data changed after registration");
    const report = { generatedAt: new Date().toISOString(), datasetHash, ...runReplay(prepareStudy(JSON.parse(input)), codeHash) };
    fs.writeFileSync(REPLAY_REPORT, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    const { reviews, activeTrades, activePositions, activeCurve, shadowEvidence, transitions, ...summary } = report;
    console.log(JSON.stringify({ ...summary, transitions: transitions.map(({ scores, ...event }) => event), saved: REPLAY_REPORT }, null, 2));
    return;
  }
  const exchange = createExchange();
  const store = new AdaptiveStore(DB_FILE);
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    do {
      try {
        const status = await observeOnce(exchange, store, codeHash);
        publishDashboard(store);
        console.log(JSON.stringify(status));
      } catch (error) { console.error(JSON.stringify({ mode: "HALTED_DATA_OR_STATE", error: error.message })); if (mode !== "--watch") throw error; }
      if (mode !== "--watch" || stopped) break;
      await delay(60_000);
    } while (!stopped);
  } finally { store.close(); await exchange.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
