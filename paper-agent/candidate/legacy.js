import { RISK } from "../config.js";
export { RISK as LEGACY_RISK };
export { analyze as legacyAnalyze } from "../indicators.js";

export function legacySignal(a, hasPos) {
  const r = [];
  let score = 0;
  const tUp = a.trend1h === "up" && a.trend4h === "up";
  const tDn = a.trend1h === "down" && a.trend4h === "down";
  if (tUp) { score += 3; r.push("1h+4h uptrend"); }
  else if (a.trend4h === "up") { score += 1; r.push("4h up"); }
  else if (tDn) { score -= 3; r.push("1h+4h downtrend"); }
  else if (a.trend4h === "down") { score -= 1; r.push("4h down"); }
  if (a.aboveEma200 === true) { score += 1; r.push(">EMA200"); }
  if (a.aboveEma200 === false && a.trend4h === "down") { score -= 1; r.push("<EMA200"); }
  if (a.macd4hHist > 0 && a.macd4hHist > a.macd4hHistPrev) { score += 1; r.push("MACD↑"); }
  if (a.macd4hHist < 0 && a.macd4hHist < a.macd4hHistPrev) { score -= 1; r.push("MACD↓"); }
  if (a.rsi1h != null) {
    if (a.rsi1h < 30 && a.trend4h === "up") { score += 1; r.push("RSI pullback"); }
    if (a.rsi1h > RISK.rsiEntryMax) { score -= 1; r.push(`RSI ${a.rsi1h.toFixed(0)} hot`); }
    if (a.rsi1h > 70 && tDn) { score -= 1; r.push("overbought in dn"); }
  }
  if (a.volumeSpike.ratio > 2 && a.momentum1h_12h > 0) { score += 1; r.push(`vol×${a.volumeSpike.ratio.toFixed(1)}`); }
  if (a.volatilityPct > 3) { score -= 1; r.push(`vol ${a.volatilityPct.toFixed(1)}% hi`); }
  if (a.momentum4h_28h > 2) { score += 1; r.push(`mom4h +${a.momentum4h_28h.toFixed(1)}%`); }
  if (a.momentum4h_28h < -2) { score -= 1; r.push(`mom4h ${a.momentum4h_28h.toFixed(1)}%`); }
  let decision = "HOLD";
  if (hasPos) {
    if (score <= -2 && a.side === "long") decision = "SELL";
    else if (score >= 2 && a.side === "short") decision = "COVER";
    if (decision !== "HOLD") r.unshift("exit signal");
  } else {
    if (score >= 4 && a.volatilityPct <= 3 && a.rsi1h < RISK.rsiEntryMax) decision = "BUY";
    else if (RISK.allowShort && score <= -4 && a.volatilityPct <= 3.5 && a.rsi1h > 30) decision = "SHORT";
  }
  return { decision, score, reason: r.join("; ") || "no edge" };
}
