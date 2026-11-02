/**
 * Daily markdown report: trades, P&L, win rate, max drawdown, and mistakes.
 * Usage: node report.js [YYYY-MM-DD]   (defaults to today UTC)
 */
import * as L from "./db.js";
import { REPORT_DIR, RISK } from "./config.js";
import fs from "node:fs";
import path from "node:path";

const day = process.argv[2] || new Date().toISOString().slice(0, 10);
const start = `${day}T00:00:00`;
const end = `${day}T23:59:59`;

const trades = L.db.prepare("SELECT * FROM trades WHERE ts BETWEEN ? AND ? ORDER BY ts").all(start, end);
const decisions = L.db.prepare("SELECT * FROM decisions WHERE ts BETWEEN ? AND ? ORDER BY ts").all(start, end);
const closedToday = L.db.prepare("SELECT * FROM positions WHERE status='closed' AND closed_at BETWEEN ? AND ?").all(start, end);
const snapshots = L.db.prepare("SELECT * FROM equity_snapshots WHERE ts BETWEEN ? AND ? ORDER BY ts").all(start, end);
const s = L.stats();
const open = L.openPositions();
const cash = L.getCash();
const lastSnap = snapshots.at(-1);
const equity = lastSnap ? lastSnap.equity : cash;

const wins = closedToday.filter((p) => (p.pnl_usd || 0) > 0);
const winRate = closedToday.length ? ((wins.length / closedToday.length) * 100).toFixed(1) : "0.0";
const dayPnl = closedToday.reduce((a, p) => a + (p.pnl_usd || 0), 0);

let md = `# Paper-Trading Report — ${day}

> **Not predictive.** All trades are paper trades against historical/live public data. Past results do not predict future performance. No real orders were placed.

## Summary
| Metric | Value |
|---|---|
| Cash balance | $${cash.toFixed(2)} |
| Equity (incl. open MTM) | $${equity.toFixed(2)} |
| Open positions | ${open.length} |
| Closed trades today | ${closedToday.length} |
| Day P&L (realized) | $${dayPnl.toFixed(2)} |
| Win rate today | ${winRate}% |
| All-time closed | ${s.closedCount} |
| All-time realized P&L | $${s.totalPnl.toFixed(2)} |
| Max drawdown (session) | ${s.maxDrawdownPct.toFixed(2)}% |

## Trades executed (${trades.length})
`;

md += trades.length
  ? "| Time | Symbol | Action | Qty | Price | Value | Reason |\n|---|---|---|---|---|---|---|\n" +
    trades.map((t) => `| ${t.ts.slice(11, 19)} | ${t.symbol} | ${t.action} | ${t.qty.toFixed(6)} | ${t.price.toFixed(4)} | $${t.value_usd.toFixed(2)} | ${(t.reason || "").replace(/\|/g, "/")} |`).join("\n") + "\n"
  : "_None._\n";

md += `\n## Decisions (${decisions.length})
| Time | Symbol | Decision | Price | Reason |
|---|---|---|---|---|
`;
md += decisions.map((d) => `| ${d.ts.slice(11, 19)} | ${d.symbol} | ${d.decision} | ${d.price ? d.price.toFixed(4) : "-"} | ${d.reason.replace(/\|/g, "/")} |`).join("\n");

md += `\n\n## Open positions
`;
md += open.length
  ? "| Symbol | Side | Qty | Entry | Stop | TP1 | TP2 | Size | Opened |\n|---|---|---|---|---|---|---|\n" +
    open.map((p) => `| ${p.symbol} | ${p.side} | ${(p.qty_open ?? p.qty).toFixed(5)} | ${p.entry_price.toFixed(4)} | ${p.stop_price.toFixed(4)} | ${p.tp1_price ? p.tp1_price.toFixed(4) : "-"} | ${p.tp2_price ? p.tp2_price.toFixed(4) : "-"} | $${p.size_usd.toFixed(2)} | ${p.opened_at.slice(11, 19)} |`).join("\n") + "\n"
  : "_None._\n";

// ---- what the agent got wrong -----------------------------------------
md += `\n## Review — what the agent got wrong
`;
const mistakes = [];
const losers = closedToday.filter((p) => (p.pnl_usd || 0) < 0);
if (losers.length) {
  mistakes.push(`- ${losers.length} losing trade(s): ${losers.map((p) => `${p.symbol} (${(p.pnl_usd || 0).toFixed(2)} USD, exit: ${p.exit_reason || "n/a"})`).join(", ")}.`);
}
const stopsHit = closedToday.filter((p) => p.exit_reason === "stop");
if (stopsHit.length) {
  mistakes.push(`- ${stopsHit.length} position(s) hit the ${(RISK.stopLossPct * 100).toFixed(0)}% stop-loss — entries may have chased momentum or entered against the higher-timeframe trend.`);
}
const skippedLiq = decisions.filter((d) => /liquidity|blocked/i.test(d.reason));
if (skippedLiq.length) {
  mistakes.push(`- ${skippedLiq.length} intended BUY(s) were blocked by risk filters (liquidity or position limits) — review whether the watchlist is too illiquid or sizing is too tight.`);
}
const noCandles = decisions.filter((d) => d.decision === "SKIP");
if (noCandles.length) {
  mistakes.push(`- ${noCandles.length} asset(s) skipped due to data errors / missing candles — check symbol→exchange mapping in watchlist.json.`);
}
if (!mistakes.length) mistakes.push("- No closed losers and no blocked/skipped signals today. Review remains qualitative: confirm signals were not taken purely on short-term momentum against the 4h trend.");
md += mistakes.join("\n");

md += `

---
*Generated automatically. This is a research / paper-trading log only and is not financial advice.*
`;

const out = path.join(REPORT_DIR, `report-${day}.md`);
fs.writeFileSync(out, md);
console.log(out);
