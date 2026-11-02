import { RISK, HOUR, DAY, candidateById } from "./config.js";
import { SYMBOLS } from "../candidate/config.js";
import { studySignal } from "../candidate/study.js";
import { sizePosition, openFill, closeFill, stopDistance } from "../candidate/engine.js";

const positive = n => Number.isFinite(n) && n > 0;
const nonnegative = n => Number.isFinite(n) && n >= 0;
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const iso = time => new Date(time).toISOString();
const aligned = (time, period = HOUR) => Number.isSafeInteger(time) && time % period === 0 &&
  Number.isFinite(new Date(time).getTime());
const ensure = (ok, message) => { if (!ok) throw new Error(message); };
const finite = (value, name) => {
  ensure(Number.isFinite(value), `nonfinite ${name}`);
  return value;
};
const timestamp = value => {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  ensure(aligned(time) && iso(time) === value, "invalid ISO hourly timestamp");
  return time;
};
const numericFeatures = ["price", "close4h", "previousClose4h", "ema20_4h", "ema50_4h",
  "ema200_4h", "previousEma20_4h", "previousEma50_4h", "previousHigh55", "previousLow20",
  "bbMean", "bbLower", "previousBbLower", "rsi4h", "adx4h", "atr1h", "quoteVolume"];
const optionalNumericFeatures = ["ema20_1h", "ema50_1h", "ema200_1h", "rsi1h", "macd4hHist",
  "macd4hHistPrev", "momentum1h_12h", "momentum4h_28h", "volatilityPct"];
const closedHistories = new WeakMap();
const curveHistories = new WeakMap();

function snapshotHistoryRecord(record) {
  ensure(object(record), "invalid history record");
  // Snapshot unknown records; even frozen getters can expose mutable state.
  const copy = { ...record };
  ensure(Reflect.ownKeys(copy).every(key => copy[key] === null ||
    typeof copy[key] !== "object" && typeof copy[key] !== "function"), "invalid flat history record");
  return Object.freeze(copy);
}

function validateAnalysis(a, symbol, time) {
  ensure(object(a) && typeof a.ready === "boolean" && typeof a.closed4h === "boolean",
    `${symbol}: invalid analysis`);
  ensure(a.symbol === undefined || a.symbol === symbol, `${symbol}: mismatched analysis symbol`);
  ensure(aligned(a.candleTs) && a.candleTs < time && a.decisionTime === time,
    `${symbol}: invalid or future feature time`);
  if (a.fourCandleTs !== undefined) {
    ensure(aligned(a.fourCandleTs, 4 * HOUR) && a.fourCandleTs + 4 * HOUR <= time &&
      a.fourCandleTs <= a.candleTs && a.closed4h === (a.fourCandleTs + 4 * HOUR === time),
    `${symbol}: invalid or future 4h feature time`);
  }
  ensure(!a.closed4h || time % (4 * HOUR) === 0, `${symbol}: unaligned closed 4h decision`);
  for (const key of numericFeatures) {
    if (a.ready || a[key] !== undefined) ensure(Number.isFinite(a[key]), `${symbol}: invalid feature ${key}`);
  }
  for (const key of optionalNumericFeatures) {
    if (a[key] !== undefined) ensure(Number.isFinite(a[key]), `${symbol}: invalid feature ${key}`);
  }
  // Even warmup analyses must identify the last closed price, ATR and past USD volume.
  ensure(positive(a.price) && nonnegative(a.atr1h) && nonnegative(a.quoteVolume),
    `${symbol}: invalid price, ATR or quoteVolume`);
  if (a.ready) {
    for (const key of ["close4h", "previousClose4h", "ema20_4h", "ema50_4h", "ema200_4h",
      "previousEma20_4h", "previousEma50_4h", "previousHigh55", "previousLow20", "bbMean"])
      ensure(positive(a[key]), `${symbol}: invalid positive feature ${key}`);
    ensure(a.bbLower <= a.bbMean && a.rsi4h >= 0 && a.rsi4h <= 100 && a.adx4h >= 0 && a.adx4h <= 100,
      `${symbol}: invalid indicator ordering or range`);
  }
  if (a.volumeSpike !== undefined) ensure(object(a.volumeSpike) && nonnegative(a.volumeSpike.ratio),
    `${symbol}: invalid volumeSpike`);
  for (const key of ["regime", "trend4h", "trend1h"])
    if (a[key] !== undefined) ensure(typeof a[key] === "string", `${symbol}: invalid ${key}`);
  // Reject nonfinite numeric metadata too, rather than silently transporting corrupt features.
  function checkNumbers(value) {
    if (typeof value === "number") finite(value, "analysis value");
    else if (value && typeof value === "object") Object.values(value).forEach(checkNumbers);
  }
  checkNumbers(a);
}

function validatePosition(p, symbol, time, closed = false) {
  ensure(object(p) && SYMBOLS.includes(symbol) && p.symbol === symbol && p.side === "long",
    "invalid long position");
  candidateById(p.candidateId);
  for (const key of ["qty", "entry_price", "stop_price", "best_price"])
    ensure(positive(p[key]), `invalid position ${key}`);
  ensure(nonnegative(p.entry_fee) && typeof p.entry_regime === "string" &&
    p.best_price >= p.entry_price && p.stop_price <= p.best_price &&
    (p.target_price === null || positive(p.target_price) && p.target_price > p.entry_price),
  "invalid position costs or levels");
  const opened = timestamp(p.opened_at);
  ensure(opened <= time, "future position");
  finite(p.qty * p.entry_price + p.entry_fee, "position cost");
  if (closed) {
    const ended = timestamp(p.closed_at);
    ensure(ended >= opened && ended <= time && positive(p.exit_price) && nonnegative(p.exit_fee) &&
      Number.isFinite(p.pnl_usd) && typeof p.exit_reason === "string", "invalid closed position");
    finite(p.qty * p.exit_price - p.exit_fee, "closed proceeds");
    return ended;
  }
}

function validatePortfolio(p, time) {
  ensure(object(p) && object(p.positions) && Array.isArray(p.closed) && Array.isArray(p.curve),
    "invalid portfolio state");
  ensure(nonnegative(p.cash) && positive(p.peak) && nonnegative(p.dayOpen) &&
    typeof p.dayHalted === "boolean" && typeof p.riskHalted === "boolean", "invalid portfolio balances or halt");
  ensure(p.lastTime === null || aligned(p.lastTime) && time === p.lastTime + HOUR,
    "time must advance exactly one hour after lastTime");
  ensure(p.day === null || typeof p.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.day) &&
    Number.isFinite(Date.parse(`${p.day}T00:00:00.000Z`)), "invalid portfolio day");
  if (p.lastTime !== null) ensure(p.day === iso(p.lastTime).slice(0, 10), "portfolio day does not match lastTime");
  for (const [symbol, position] of Object.entries(p.positions)) validatePosition(position, symbol, time);
  const cachedClosed = closedHistories.get(p.closed);
  let lastClosed = cachedClosed ?? -Infinity;
  const closed = cachedClosed === undefined ? [] : p.closed.slice();
  if (cachedClosed === undefined) {
    for (const position of p.closed) {
      const record = snapshotHistoryRecord(position);
      const ended = validatePosition(record, record.symbol, time, true);
      ensure(ended >= lastClosed, "unordered closed history");
      lastClosed = ended;
      closed.push(record);
    }
  }
  ensure(lastClosed <= time, "invalid closed position");
  const cachedCurve = curveHistories.get(p.curve);
  let previous = cachedCurve?.lastTime ?? null;
  let maxEquity = cachedCurve?.maxEquity ?? 0;
  const curve = cachedCurve === undefined ? [] : p.curve.slice();
  if (cachedCurve === undefined) {
    for (const point of p.curve) {
      const record = snapshotHistoryRecord(point);
      ensure(aligned(record.ts) && record.ts <= time && nonnegative(record.equity) &&
        (previous === null || record.ts === previous + HOUR), "invalid or unordered equity curve");
      previous = record.ts;
      maxEquity = Math.max(maxEquity, record.equity);
      curve.push(record);
    }
  }
  // Time and peak belong to the mutable account, not the cached history.
  ensure((previous === null || previous <= time) && maxEquity <= p.peak, "invalid or unordered equity curve");
  ensure(p.lastTime === null ? curve.length === 0 : previous === time,
    "curve does not match lastTime");
  return { closed, curve, lastClosed, maxEquity };
}

function freezeHistories(p, lastClosed, maxEquity) {
  // Only fully validated, frozen snapshots receive reusable metadata.
  closedHistories.set(Object.freeze(p.closed), lastClosed);
  curveHistories.set(Object.freeze(p.curve), { lastTime: p.curve.at(-1)?.ts ?? null, maxEquity });
  return p;
}

export function newPortfolio(startingBalance = RISK.startingBalance) {
  ensure(positive(startingBalance), "invalid starting balance");
  return freezeHistories({ cash: startingBalance, positions: {}, closed: [], curve: [], peak: startingBalance,
    day: null, dayOpen: startingBalance, dayHalted: false, riskHalted: false, lastTime: null }, -Infinity, 0);
}

// Entries use prior features; uncertain range fills are stamped at hour end.
export function advancePortfolio(portfolio, bars, analyses, candidateId, time,
  { shadow = false, frictionMultiplier = 1 } = {}) {
  ensure(aligned(time) && aligned(time + HOUR), "invalid aligned hourly time");
  ensure(typeof shadow === "boolean", "invalid shadow mode");
  ensure(nonnegative(frictionMultiplier), "invalid friction multiplier");
  const effectiveRisk = { ...RISK, slippagePct: RISK.slippagePct * frictionMultiplier,
    takerFeePct: RISK.takerFeePct * frictionMultiplier };
  const slip = effectiveRisk.slippagePct, feeRate = effectiveRisk.takerFeePct;
  ensure([slip, feeRate].every(n => nonnegative(n) && n < 1), "invalid effective costs");
  const candidate = candidateId === null ? null : candidateById(candidateId);
  const histories = validatePortfolio(portfolio, time);
  ensure(object(bars) && object(analyses), "missing bars or analyses");
  for (const symbol of SYMBOLS) {
    const bar = bars[symbol];
    ensure(Array.isArray(bar) && bar.length === 6 && bar.every(Number.isFinite), `${symbol}: invalid bar`);
    const [ts, open, high, low, close, volume] = bar;
    ensure(ts === time && [open, high, low, close].every(positive) && nonnegative(volume) &&
      low <= Math.min(open, close) && high >= Math.max(open, close) && low <= high,
    `${symbol}: invalid OHLCV or bar time`);
    validateAnalysis(analyses[symbol], symbol, time);
  }
  // Clone mutable state without revisiting immutable historical records.
  const { closed, curve, ...account } = portfolio;
  const next = { ...structuredClone(account), closed: histories.closed, curve: histories.curve };
  const positions = () => Object.keys(next.positions).sort().map(symbol => next.positions[symbol]);
  const fee = notional => finite(notional * feeRate, "fee");
  const equityAt = field => finite(next.cash + positions().reduce((sum, p) => {
    const value = finite(p.qty * closeFill(bars[p.symbol][field], "long", slip), "marked notional");
    return sum + value - fee(value);
  }, 0), "equity");
  const observeEquity = equity => {
    next.peak = Math.max(next.peak, equity);
    if (equity <= next.dayOpen * (1 - RISK.dailyHaltPct)) next.dayHalted = true;
    if (!shadow && equity <= next.peak * (1 - RISK.circuitBreakPct)) next.riskHalted = true;
  };
  const day = iso(time).slice(0, 10);
  if (next.day !== day) {
    next.dayOpen = next.curve.at(-1)?.equity ?? next.dayOpen;
    next.day = day;
    next.dayHalted = false;
  }
  const close = (p, mark, reason, at) => {
    const exit = closeFill(mark, "long", slip);
    const proceeds = finite(p.qty * exit, "exit notional");
    const exitFee = fee(proceeds);
    const pnl = finite(p.qty * (exit - p.entry_price) - p.entry_fee - exitFee, "realized P&L");
    next.cash = finite(next.cash + proceeds - exitFee, "cash");
    const record = snapshotHistoryRecord({ ...p, exit_price: exit, exit_fee: exitFee, pnl_usd: pnl,
      closed_at: iso(at), exit_reason: reason });
    const ended = validatePosition(record, record.symbol, at, true);
    ensure(ended >= histories.lastClosed, "unordered closed history");
    histories.lastClosed = ended;
    next.closed.push(record);
    delete next.positions[p.symbol];
  };
  observeEquity(equityAt(1));
  // Only opening stops free capital early; ambiguous ranges still lose at the stop.
  for (const p of positions()) {
    const open = bars[p.symbol][1];
    const pinned = candidateById(p.candidateId);
    if (open <= p.stop_price) close(p, Math.min(open, p.stop_price), "stop", time);
    else if (time - Date.parse(p.opened_at) >= pinned.maxHoldHours * HOUR) close(p, open, "time_exit", time);
    else if (studySignal(pinned.family, analyses[p.symbol], true).decision === "SELL") close(p, open, "signal_exit", time);
  }

  const ranked = candidate ? SYMBOLS.map(symbol => {
    const analysis = analyses[symbol];
    const signal = studySignal(candidate.family, analysis, false);
    finite(signal.score, "signal score");
    return { symbol, analysis, signal };
  }).filter(row => row.signal.decision === "BUY")
    .sort((a, b) => b.signal.score - a.signal.score || a.symbol.localeCompare(b.symbol)) : [];

  for (const { symbol, analysis } of ranked) {
    if (next.positions[symbol] || positions().length >= Math.min(RISK.maxOpenPositions, RISK.maxSameDirection)) continue;
    const lastClosed = next.closed.findLast(p => p.symbol === symbol);
    const cooldown = lastClosed?.exit_reason === "stop" ? RISK.stopCooldownMin : RISK.symbolCooldownMin;
    if (lastClosed && time - Date.parse(lastClosed.closed_at) < cooldown * 60_000) continue;
    const equity = equityAt(1);
    observeEquity(equity);
    // Three realized losses in the rolling past 24h; a win does not erase a loss.
    const recentLosses = next.closed.filter(p => p.pnl_usd < 0 &&
      Date.parse(p.closed_at) > time - DAY && Date.parse(p.closed_at) <= time).length;
    if (!shadow && (next.dayHalted || next.riskHalted ||
      recentLosses >= RISK.maxConsecutiveLosses)) continue;
    const open = bars[symbol][1];
    if (analysis.quoteVolume < RISK.minVolume24Usd || Math.abs(open - analysis.price) > 0.5 * analysis.atr1h) continue;
    const deployedUsd = finite(positions().reduce((sum, p) => sum + p.qty * bars[p.symbol][1], 0), "deployment");
    const size = sizePosition({ equity, cash: next.cash, entryPrice: open, atr: analysis.atr1h,
      side: "long", deployedUsd }, effectiveRisk);
    if (!size) continue;
    const entry = openFill(open, "long", slip);
    const unitCost = finite(entry + fee(entry), "entry cost");
    // In addition to the shared sizing constraints, reserve the entry fee inside the caps.
    const qty = Math.min(size.qty, next.cash / unitCost, equity * RISK.maxPositionPct / unitCost,
      Math.max(0, equity * RISK.maxDeployPct - deployedUsd) / unitCost);
    const notional = finite(qty * entry, "entry notional");
    if (!positive(qty) || notional < 25) continue;
    const entryFee = fee(notional);
    const debit = finite(notional + entryFee, "entry debit");
    if (debit > next.cash) continue; // Reject even a floating-point overdraft; never borrow.
    const stop = entry * (1 - stopDistance(entry, analysis.atr1h, "long", effectiveRisk));
    const target = candidate.targetR === null ? null : entry + candidate.targetR * (entry - stop);
    ensure(positive(stop) && (target === null || positive(target)), "invalid entry exit levels");
    next.cash -= debit;
    next.positions[symbol] = { symbol, candidateId: candidate.id, side: "long", qty,
      entry_price: entry, entry_fee: entryFee, stop_price: stop, target_price: target,
      best_price: entry, opened_at: iso(time), entry_regime: analysis.regime ?? analysis.trend4h ?? "unknown" };
  }
  observeEquity(equityAt(1));

  // No partial TP. The old/initial stop wins against any target in an ambiguous hour.
  for (const p of positions()) {
    const [, open, high, low] = bars[p.symbol];
    if (low <= p.stop_price) close(p, Math.min(open, p.stop_price), "stop", time + HOUR);
    else if (p.target_price !== null && high >= p.target_price) close(p, p.target_price, "target", time + HOUR);
    else {
      p.best_price = Math.max(p.best_price, high);
      const trail = candidateById(p.candidateId).trailPct;
      // This updated stop is only executable NEXT hour, never against this hour's low.
      if (trail !== null) p.stop_price = Math.max(p.stop_price, p.best_price * (1 - trail));
    }
  }
  const equity = equityAt(4);
  observeEquity(equity);
  ensure(nonnegative(equity), "invalid equity");
  next.curve.push(Object.freeze({ ts: time + HOUR, equity }));
  next.lastTime = time;
  return freezeHistories(next, histories.lastClosed, Math.max(histories.maxEquity, equity));
}
