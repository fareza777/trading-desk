/**
 * Portfolio + execution engine — paper trades against REAL market prices.
 * Applies slippage & fees on every fill; supports long, short, partial exits,
 * breakeven move, and trailing stops. All fills use the mark price of the cycle.
 */
import { RISK } from "./config.js";

/** Apply slippage against the trader (always worse than mid). */
/** Apply slippage against the trader. Dynamic: half-spread + base impact. */
export const baseSlip = () => RISK.slippagePct;
export function slipFrac(summary) {
  if (!RISK.dynamicSlippage || !summary?.bid || !summary?.ask) return RISK.slippagePct;
  const spread = (summary.ask - summary.bid) / summary.bid;
  return Math.max(RISK.slippagePct, spread / 2 + 0.0002);
}
export const fillAt = (mark, side, slip) => side === "buy" ? mark * (1 + slip) : mark * (1 - slip);
export const openFill = (mark, side, slip = RISK.slippagePct) => fillAt(mark, side === "short" ? "sell" : "buy", slip);
export const closeFill = (mark, side, slip = RISK.slippagePct) => fillAt(mark, side === "short" ? "buy" : "sell", slip);
export function bookFill(book, side, qty, fallbackMark, baseSlip = RISK.slippagePct) {
  const levels = side === "buy" ? (book?.asks || []) : (book?.bids || []);
  if (!levels.length || !qty || !Number.isFinite(qty)) return { price: fillAt(fallbackMark, side, baseSlip), impactPct: baseSlip, filledQty: qty, levels: 0 };
  let remaining = qty, cost = 0, filled = 0;
  for (const [price, available] of levels) {
    const take = Math.min(remaining, Number(available));
    cost += take * Number(price); filled += take; remaining -= take;
    if (remaining <= 1e-12) break;
  }
  if (filled <= 0) return { price: fillAt(fallbackMark, side, baseSlip), impactPct: baseSlip, filledQty: qty, levels: 0 };
  const vwap = cost / filled;
  const impactPct = Math.abs(vwap - fallbackMark) / fallbackMark + baseSlip;
  return { price: vwap * (side === "buy" ? 1 + baseSlip : 1 - baseSlip), impactPct, filledQty: filled, levels: levels.length, partial: remaining > 1e-12 };
}

export const feeUsd = (notional) => notional * RISK.takerFeePct;

/** Direction helpers: +1 long, -1 short */
export const dir = (side) => (side === "short" ? -1 : 1);

/** Distance from entry to stop, in price. For sizing. */
export function stopDistance(entryPrice, atr, side) {
  const pctStop = RISK.stopLossPct;
  const atrStop = atr ? (2 * atr) / entryPrice : 0;
  return Math.max(pctStop, atrStop); // wider of fixed 3% or 2×ATR
}

/** Position size from risk budget. Returns {qty,sizeUsd,stopPrice} or null. */
export function sizePosition({ equity, cash, entryPrice, atr, side, deployedUsd }) {
  const riskBudget = equity * RISK.riskPerTradePct;
  const distFrac = stopDistance(entryPrice, atr, side);
  let sizeUsd = riskBudget / distFrac;                 // size so stop-out ≈ 1% equity
  sizeUsd = Math.min(sizeUsd, equity * RISK.maxPositionPct, cash);
  // don't exceed global deployment cap
  const room = equity * RISK.maxDeployPct - (deployedUsd || 0);
  sizeUsd = Math.min(sizeUsd, Math.max(room, 0));
  if (sizeUsd < 25) return null;
  const qty = sizeUsd / entryPrice;
  const stopPrice = side === "short"
    ? entryPrice * (1 + distFrac)
    : entryPrice * (1 - distFrac);
  return { qty, sizeUsd, stopPrice };
}

/** TP1 / TP2 / trailing levels for a side. */
export function exitLevels(entryPrice, atr, side) {
  const distFrac = stopDistance(entryPrice, atr, side);
  const r = distFrac; // 1R
  if (side === "short") {
    return {
      stop: entryPrice * (1 + r),
      tp1: entryPrice * (1 - RISK.tp1R * r),
      tp2: entryPrice * (1 - RISK.tp2Pct),
    };
  }
  return {
    stop: entryPrice * (1 - r),
    tp1: entryPrice * (1 + RISK.tp1R * r),
    tp2: entryPrice * (1 + RISK.tp2Pct),
  };
}

/** P&L for a (possibly partial) close. */
export function pnlOnClose(pos, qty, exitPrice) {
  return dir(pos.side) * (exitPrice - pos.entry_price) * qty;
}
