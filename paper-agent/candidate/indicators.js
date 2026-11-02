import { RISK } from "./config.js";
import { closedCandles } from "./market.js";

export const closes = (c) => c.map((x) => x[4]);
export const highs = (c) => c.map((x) => x[2]);
export const lows = (c) => c.map((x) => x[3]);
export const volumes = (c) => c.map((x) => x[5]);

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null, sum = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < period) { sum += values[i]; if (i === period - 1) { prev = sum / period; out[i] = prev; } continue; }
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function rsi(closesArr, period = 14) {
  const out = new Array(closesArr.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i < closesArr.length; i++) {
    const d = closesArr[i] - closesArr[i - 1];
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= period) {
      gain += g; loss += l;
      if (i === period) { gain /= period; loss /= period; out[i] = gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss); }
    } else {
      gain = (gain * (period - 1) + g) / period;
      loss = (loss * (period - 1) + l) / period;
      out[i] = gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }
  return out;
}

/** Average True Range — for volatility-aware stops. */
export function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  for (let i = 1; i < candles.length; i++) {
    const [, , h, l, pc] = [0, 0, candles[i][2], candles[i][3], candles[i - 1][4]];
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    if (i <= period) { out[i] = (out[i - 1] ?? 0) + tr; if (i === period) out[i] /= period; }
    else out[i] = (out[i - 1] * (period - 1) + tr) / period;
  }
  return out;
}

export function pctChange(arr, lookback) {
  const n = arr.length;
  if (n <= lookback) return 0;
  return ((arr[n - 1] - arr[n - 1 - lookback]) / arr[n - 1 - lookback]) * 100;
}

export function volatility(closesArr, lookback = 24) {
  const rets = [];
  for (let i = Math.max(1, closesArr.length - lookback); i < closesArr.length; i++)
    rets.push(Math.log(closesArr[i] / closesArr[i - 1]));
  if (rets.length < 2) return 0;
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  return Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1)) * 100;
}

export function volumeSpike(volumesArr, lookback = 20) {
  const n = volumesArr.length;
  if (n <= lookback + 1) return { ratio: 1, latest: volumesArr[n - 1] || 0, avg: 0 };
  const recent = volumesArr.slice(-lookback - 1, -1);
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const latest = volumesArr[n - 1];
  return { ratio: avg > 0 ? latest / avg : 1, latest, avg };
}

/** MACD histogram (12,26,9) → momentum direction + strength. */
export function macdHist(closesArr) {
  const e12 = ema(closesArr, 12), e26 = ema(closesArr, 26);
  const macd = closesArr.map((_, i) => (e12[i] != null && e26[i] != null) ? e12[i] - e26[i] : null);
  const signal = [...new Array(25).fill(null), ...ema(macd.slice(25), 9)].slice(0, closesArr.length);
  const hist = macd.map((m, i) => (m != null && signal[i] != null) ? m - signal[i] : null);
  return { macd, signal, hist, last: hist.at(-1), prev: hist.at(-2) };
}

export function adx(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  let trSum = 0, plusSum = 0, minusSum = 0, dxSum = 0, previous = null;
  for (let i = 1; i < candles.length; i++) {
    const up = candles[i][2] - candles[i - 1][2];
    const down = candles[i - 1][3] - candles[i][3];
    const plus = up > down && up > 0 ? up : 0;
    const minus = down > up && down > 0 ? down : 0;
    const tr = Math.max(candles[i][2] - candles[i][3], Math.abs(candles[i][2] - candles[i - 1][4]), Math.abs(candles[i][3] - candles[i - 1][4]));
    trSum = i <= period ? trSum + tr : trSum - trSum / period + tr;
    plusSum = i <= period ? plusSum + plus : plusSum - plusSum / period + plus;
    minusSum = i <= period ? minusSum + minus : minusSum - minusSum / period + minus;
    if (i < period) continue;
    const total = plusSum + minusSum;
    const dx = total > 0 && trSum > 0 ? 100 * Math.abs(plusSum - minusSum) / total : 0;
    if (i < 2 * period - 1) { dxSum += dx; continue; }
    previous = previous == null ? (dxSum + dx) / period : (previous * (period - 1) + dx) / period;
    out[i] = previous;
  }
  return out;
}

export function analyze(candles1h, candles4h, asOf = Date.now()) {
  candles1h = closedCandles(candles1h, 3_600_000, asOf).slice(-RISK.startupCandles1h);
  candles4h = closedCandles(candles4h, 14_400_000, asOf).slice(-RISK.startupCandles4h);
  const continuous = (rows, step) => rows.every((row, i) => i === 0 || row[0] === rows[i - 1][0] + step);
  if (candles1h.length < RISK.startupCandles1h || candles4h.length < RISK.startupCandles4h ||
      !continuous(candles1h, 3_600_000) || !continuous(candles4h, 14_400_000) ||
      candles1h.at(-1)[0] + 7_200_000 <= asOf || candles4h.at(-1)[0] + 28_800_000 <= asOf)
    return { ready: false, reason: "insufficient, gapped or stale closed candles" };
  const c1 = closes(candles1h), v1 = volumes(candles1h), c4 = closes(candles4h);
  const ema20_1h = ema(c1, 20), ema50_1h = ema(c1, 50), ema200_1h = ema(c1, 200);
  const ema20_4h = ema(c4, 20), ema50_4h = ema(c4, 50);
  const atr1h = atr(candles1h, 14);
  const rsi1h = rsi(c1, 14);
  const macd4h = macdHist(c4);
  const last = c1[c1.length - 1];

  const trend1h = ema20_1h.at(-1) > ema50_1h.at(-1) ? "up" : "down";
  const trend4h = ema20_4h.at(-1) > ema50_4h.at(-1) ? "up" : "down";
  const aboveEma200 = ema200_1h.at(-1) != null ? last > ema200_1h.at(-1) : null;
  const regime = trend4h === "up" ? "bull" : trend4h === "down" && aboveEma200 === false ? "bear" : "neutral";

  return {
    ready: true, candleTs: candles1h.at(-1)[0], price: last,
    previousClose: c1.at(-2), previousHigh: candles1h.at(-2)[2],
    pullbackTouched: candles1h.slice(-4, -1).some((c, i) => c[3] <= ema20_1h.at(-4 + i)),
    ema50Slope: ema50_1h.at(-1) - ema50_1h.at(-7),
    ema200_1h: ema200_1h.at(-1),
    adx4h: adx(candles4h).at(-1),
    trend1h, trend4h, regime, aboveEma200,
    ema20_1h: ema20_1h.at(-1), ema50_1h: ema50_1h.at(-1),
    ema20_4h: ema20_4h.at(-1), ema50_4h: ema50_4h.at(-1),
    rsi1h: rsi1h.at(-1),
    rsiSlope: rsi1h.at(-1) != null && rsi1h.at(-4) != null ? rsi1h.at(-1) - rsi1h.at(-4) : 0,
    atr1h: atr1h.at(-1), atrPct: atr1h.at(-1) ? (atr1h.at(-1) / last) * 100 : 0,
    macd4hHist: macd4h.last, macd4hHistPrev: macd4h.prev,
    momentum1h_12h: pctChange(c1, 12),
    momentum4h_28h: pctChange(c4, 7),
    volatilityPct: volatility(c1, 24),
    volumeSpike: volumeSpike(v1, 20),
  };
}
