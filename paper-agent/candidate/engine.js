/**
 * Portfolio + execution engine — paper trades against REAL market prices.
 * Applies slippage & fees on every fill; supports long, short, partial exits,
 * breakeven move, and trailing stops. All fills use the mark price of the cycle.
 */
import { RISK } from "./config.js";

export const baseSlip = () => RISK.slippagePct;
export function slipFrac() {
  return RISK.slippagePct;
}

const positive = (v) => Number.isFinite(v) && v > 0;
const validSide = (side) => side === "long" || side === "short";
const validSlip = (slip) => Number.isFinite(slip) && slip >= 0 && slip < 1;

export function fillAt(mark, side, slip = RISK.slippagePct) {
  if (!positive(mark) || !["buy", "sell"].includes(side) || !validSlip(slip)) throw new Error("invalid fill inputs");
  const price = mark * (side === "buy" ? 1 + slip : 1 - slip);
  if (!positive(price)) throw new Error("invalid fill price");
  return price;
}
export function openFill(mark, side, slip = RISK.slippagePct) {
  if (!validSide(side)) throw new Error("invalid position side");
  return fillAt(mark, side === "short" ? "sell" : "buy", slip);
}
export function closeFill(mark, side, slip = RISK.slippagePct) {
  if (!validSide(side)) throw new Error("invalid position side");
  return fillAt(mark, side === "short" ? "buy" : "sell", slip);
}
export function bookFill(book, side, qty, fallbackMark, baseSlip = RISK.slippagePct, nowMs = Date.now()) {
  const fallback = fillAt(fallbackMark, side, baseSlip);
  if (!positive(qty)) throw new Error("invalid order quantity");
  if (book === undefined) return { price: fallback, impactPct: baseSlip, filledQty: qty, levels: 0 };
  if (!book || !Number.isFinite(book.timestamp) || !Number.isFinite(nowMs)
    || book.timestamp > nowMs || nowMs - book.timestamp > RISK.maxDataAgeMs) throw new Error("invalid or stale order book timestamp");
  const number = (v) => typeof v === "number" || (typeof v === "string" && v.trim() !== "") ? Number(v) : NaN;
  const parsed = {};
  for (const key of ["bids", "asks"]) {
    if (!Array.isArray(book[key]) || !book[key].length) throw new Error("empty or malformed order book");
    parsed[key] = book[key].map((level) => {
      if (!Array.isArray(level) || level.length < 2) throw new Error("malformed order book level");
      const price = number(level[0]), available = number(level[1]);
      if (!positive(price) || !positive(available)) throw new Error("invalid or depleted order book level");
      return [price, available];
    });
    for (let i = 1; i < parsed[key].length; i++) {
      if (key === "bids" ? parsed[key][i][0] > parsed[key][i - 1][0] : parsed[key][i][0] < parsed[key][i - 1][0]) throw new Error("unordered order book");
    }
  }
  if (parsed.bids[0][0] >= parsed.asks[0][0]) throw new Error("crossed order book");
  const levels = side === "buy" ? parsed.asks : parsed.bids;
  let remaining = qty, cost = 0, filled = 0, used = 0;
  for (const [price, available] of levels) {
    const take = Math.min(remaining, available);
    cost += take * price; filled += take; remaining -= take; used++;
    if (remaining <= 0) break;
  }
  if (remaining > Number.EPSILON * qty * 8) throw new Error("paper order rejected: insufficient order book depth");
  const price = fillAt(cost / filled, side, baseSlip);
  const impactPct = Math.abs(price - fallbackMark) / fallbackMark;
  return { price, impactPct, filledQty: filled, levels: used, partial: false };
}

export const feeUsd = (notional) => notional * RISK.takerFeePct;

/** Direction helpers: +1 long, -1 short */
export const dir = (side) => (side === "short" ? -1 : 1);

export function stopDistance(entryPrice, atr = 0, side = "long", risk = RISK) {
  if (!positive(entryPrice) || !Number.isFinite(atr) || atr < 0 || !validSide(side)) return NaN;
  return Math.min(risk.maxStopPct, Math.max(risk.stopLossPct, risk.atrStopMultiple * atr / entryPrice));
}

/** Position size from risk budget. sizeUsd is mark notional; stopPrice uses the actual entry fill. */
export function sizePosition({ equity, cash, entryPrice, atr, side = "long", deployedUsd = 0 } = {}, risk = RISK) {
  if (!positive(equity) || !Number.isFinite(cash) || cash < 0 || !Number.isFinite(deployedUsd) || deployedUsd < 0) return null;
  if (!positive(entryPrice) || !validSide(side) || !validSlip(risk.slippagePct) || !validSlip(risk.takerFeePct)
    || !positive(entryPrice * (1 + risk.slippagePct))) return null;
  const entry = openFill(entryPrice, side, risk.slippagePct);
  const distFrac = stopDistance(entry, atr, side, risk);
  if (!Number.isFinite(distFrac)) return null;
  const stopPrice = entry * (1 - dir(side) * distFrac);
  if (!positive(stopPrice * (1 + risk.slippagePct))) return null;
  const exit = closeFill(stopPrice, side, risk.slippagePct);
  const fee = notional => notional * risk.takerFeePct;
  const lossPerUnit = dir(side) * (entry - exit) + fee(entry) + fee(exit);
  if (!positive(lossPerUnit)) return null;
  const room = Math.max(equity * risk.maxDeployPct - deployedUsd, 0);
  const qty = Math.min(equity * risk.riskPerTradePct / lossPerUnit,
    equity * risk.maxPositionPct / entry, cash / (entry + fee(entry)), room / entry);
  const sizeUsd = qty * entryPrice;
  if (!positive(qty) || !Number.isFinite(sizeUsd) || qty * entry < 25) return null;
  return { qty, sizeUsd, stopPrice };
}

/** TP1 / TP2 / trailing levels for a side. */
export function exitLevels(entryPrice, atr, side = "long", risk = RISK) {
  const r = stopDistance(entryPrice, atr, side, risk);
  if (!Number.isFinite(r)) throw new Error("invalid exit level inputs");
  const d = dir(side);
  return {
    stop: entryPrice * (1 - d * r),
    tp1: entryPrice * (1 + d * risk.tp1R * r),
    tp2: entryPrice * (1 + d * risk.tp2R * r),
  };
}

export function costBreakEven(entry, side, entryFeePerUnit = entry * RISK.takerFeePct, carryPerUnit = 0, slip = RISK.slippagePct, feeRate = RISK.takerFeePct) {
  if (!positive(entry) || !validSide(side) || !validSlip(slip) || !validSlip(feeRate)
    || !Number.isFinite(entryFeePerUnit) || entryFeePerUnit < 0
    || !Number.isFinite(carryPerUnit) || carryPerUnit < 0) throw new Error("invalid break-even inputs");
  const d = dir(side);
  const mark = (entry + d * (entryFeePerUnit + carryPerUnit)) / ((1 - d * slip) * (1 - d * feeRate));
  if (!positive(mark)) throw new Error("unreachable break-even price");
  return mark;
}

/** P&L for a (possibly partial) close. */
export function pnlOnClose(pos, qty, exitPrice) {
  return dir(pos.side) * (exitPrice - pos.entry_price) * qty;
}
