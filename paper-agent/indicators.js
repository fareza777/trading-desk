/** Technical indicators. Candle = [ts, open, high, low, close, volume]. */

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
      if (i === period) { gain /= period; loss /= period; out[i] = 100 - 100 / (1 + gain / (loss || 1e-9)); }
    } else {
      gain = (gain * (period - 1) + g) / period;
      loss = (loss * (period - 1) + l) / period;
      out[i] = 100 - 100 / (1 + gain / (loss || 1e-9));
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
  const valid = macd.map(v => v ?? 0);
  const signal = ema(valid, 9);
  const hist = macd.map((m, i) => (m != null && signal[i] != null) ? m - signal[i] : null);
  return { macd, signal, hist, last: hist.at(-1), prev: hist.at(-2) };
}

export function analyze(candles1h, candles4h) {
  const c1 = closes(candles1h), v1 = volumes(candles1h), c4 = closes(candles4h);
  const ema20_1h = ema(c1, 20), ema50_1h = ema(c1, 50), ema200_1h = ema(c1, Math.min(200, c1.length - 1));
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
    price: last,
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
