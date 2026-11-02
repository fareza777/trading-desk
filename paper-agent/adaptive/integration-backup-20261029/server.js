/**
 * Dashboard server — premium UI + JSON API, controls the agent process.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { db, stats, openPositions, getCash, latestAnalyses, equityNow } from "./db.js";
import { loadWatchlist, RISK } from "./config.js";
import { connectAll } from "./mcp.js";
import { fetchCandles, fetchSummary } from "./fetchers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 7070;

let agentProc = null, agentStartedAt = null, agentLog = [];
const pushLog = (l) => { agentLog.push(l); if (agentLog.length > 400) agentLog = agentLog.slice(-400); };
const agentRunning = () => agentProc && agentProc.exitCode === null && !agentProc.killed;

function startAgent() {
  if (agentRunning()) return { ok: false, msg: "already running" };
  agentProc = spawn(process.execPath, [path.join(__dirname, "agent.js")], {
    cwd: __dirname, env: process.env, stdio: ["ignore", "pipe", "pipe"],
  });
  agentStartedAt = new Date().toISOString();
  const onData = (d) => d.toString().split("\n").filter(Boolean).forEach(pushLog);
  agentProc.stdout.on("data", onData);
  agentProc.stderr.on("data", onData);
  agentProc.on("exit", (c) => pushLog(`[dashboard] agent exited code=${c}`));
  return { ok: true };
}
function stopAgent() {
  if (!agentRunning()) return { ok: false, msg: "not running" };
  agentProc.kill();
  pushLog("[dashboard] agent stopped by user");
  return { ok: true };
}

let runOnceProc = null;
function runOnce() {
  if (runOnceProc && runOnceProc.exitCode === null) return { ok: false, msg: "cycle running" };
  runOnceProc = spawn(process.execPath, [path.join(__dirname, "agent.js"), "--once"], {
    cwd: __dirname, env: process.env, stdio: ["ignore", "pipe", "pipe"],
  });
  const onData = (d) => d.toString().split("\n").filter(Boolean).forEach(pushLog);
  runOnceProc.stdout.on("data", onData); runOnceProc.stderr.on("data", onData);
  runOnceProc.on("exit", () => pushLog("[dashboard] single cycle done"));
  return { ok: true };
}

let clients = null, connecting = null;
const getClients = () => {
  if (clients) return Promise.resolve(clients);
  if (!connecting) connecting = connectAll().then((c) => (clients = c)).finally(() => (connecting = null));
  return connecting;
};

const json = (res, obj, code = 200) => {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
};

async function api(pathname, query, res) {
  const wl = loadWatchlist();

  if (pathname === "/api/status") {
    const cash = getCash(), open = openPositions();
    const an = latestAnalyses();
    const priceMap = {};
    for (const s of Object.keys(an)) if (an[s].price) priceMap[s] = an[s].price;
    const snap = equityNow(priceMap);
    return json(res, {
      agent: { running: agentRunning(), startedAt: agentStartedAt, pid: agentProc?.pid ?? null },
      loopIntervalMin: wl.loopIntervalMinutes || 15,
      exchange: wl.exchange, cash, equity: snap.equity, deployedUsd: snap.deployedUsd, openCount: open.length,
      pnlTotal: snap.equity - RISK.startingBalance,
      pnlPct: ((snap.equity - RISK.startingBalance) / RISK.startingBalance) * 100,
      lastCycle: db.prepare("SELECT ts FROM equity_snapshots ORDER BY id DESC LIMIT 1").get()?.ts ?? null,
      stats: stats(), risk: RISK,
    });
  }

  if (pathname === "/api/assets") {
    const an = latestAnalyses();
    const open = openPositions();
    const openMap = Object.fromEntries(open.map((p) => [p.symbol, p]));
    return json(res, {
      assets: wl.assets.map((a) => {
        const x = an[a.symbol] || {}, pos = openMap[a.symbol];
        return {
          symbol: a.symbol, name: a.name, price: x.price ?? null,
          trend1h: x.trend1h, trend4h: x.trend4h, regime: x.regime, rsi1h: x.rsi1h,
          momentum1h: x.momentum1h_12h, momentum4h: x.momentum4h_28h,
          volatility: x.volatilityPct, volSpike: x.volumeSpike?.ratio,
          liquidityUsd: x.liquidityUsd, vol24: x.vol24, high24: x.high24, low24: x.low24,
          lastTs: x.ts ?? null,
          position: pos ? { qty: pos.qty_open ?? pos.qty, side: pos.side, entry: pos.entry_price, sizeUsd: pos.size_usd, id: pos.id } : null,
        };
      }),
    });
  }

  if (pathname === "/api/positions") {
    const an = latestAnalyses();
    return json(res, {
      positions: openPositions().map((p) => {
        const mark = an[p.symbol]?.price ?? null;
        const d = p.side === "short" ? -1 : 1;
        return { ...p, markPrice: mark, unrealized: mark ? d * (mark - p.entry_price) * (p.qty_open ?? p.qty) : null };
      }),
      closed: db.prepare("SELECT * FROM positions WHERE status='closed' ORDER BY closed_at DESC LIMIT 50").all(),
    });
  }

  if (pathname === "/api/trades")
    return json(res, { trades: db.prepare("SELECT * FROM trades ORDER BY id DESC LIMIT 100").all() });
  if (pathname === "/api/decisions")
    return json(res, { decisions: db.prepare("SELECT * FROM decisions ORDER BY id DESC LIMIT 100").all() });
  if (pathname === "/api/equity")
    return json(res, { curve: db.prepare("SELECT ts,cash,equity,open_positions FROM equity_snapshots ORDER BY id").all() });
  if (pathname === "/api/logs")
    return json(res, { logs: agentLog.slice(-150) });
  if (pathname === "/api/agent/start") return json(res, startAgent());
  if (pathname === "/api/agent/stop") return json(res, stopAgent());
  if (pathname === "/api/agent/run-once") return json(res, runOnce());

  if (pathname === "/api/export/trades") {
    const rows = db.prepare("SELECT * FROM trades ORDER BY id").all();
    const hdr = "id,ts,symbol,action,side,qty,price,value_usd,fee_usd,pnl_usd,reason\n";
    const csv = hdr + rows.map((t) => [t.id, t.ts, t.symbol, t.action, t.side, t.qty, t.price, t.value_usd, t.fee_usd, t.pnl_usd, `"${(t.reason || "").replace(/"/g, "'")}"`].join(",")).join("\n");
    res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=trades.csv" });
    return res.end(csv);
  }

  if (pathname === "/api/health")
    return json(res, { ok: true, agent: agentRunning(), mcp: !!clients, uptime: process.uptime() });

  if (pathname === "/api/reset") {
    if (agentRunning()) return json(res, { error: "stop agent first" }, 400);
    for (const t of ["trades", "positions", "decisions", "equity_snapshots", "analyses"]) db.prepare(`DELETE FROM ${t}`).run();
    db.prepare("INSERT INTO meta(key,value) VALUES('cash',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(RISK.startingBalance));
    return json(res, { ok: true, cash: RISK.startingBalance });
  }

  if (pathname === "/api/candles") {
    const symbol = query.get("symbol") || wl.assets[0].symbol;
    const tf = query.get("tf") || "1h";
    const tfDays = { "15m": 2, "1h": 7, "4h": 14, "1w": 30 };
    const days = Math.min(Number(query.get("days") || (tfDays[tf] ?? 7)), tf === "1w" ? 365 : 30);
    try {
      const c = await getClients();
      const candles = await fetchCandles(c.ccxt, symbol, tf, days, query.get("exchange") || wl.exchange);
      return json(res, { symbol, tf, candles: candles.map(([t, o, h, l, cl, v]) => ({ t: Math.floor(t / 1000), o, h, l, c: cl, v })) });
    } catch (e) { return json(res, { error: e.message }, 500); }
  }

  if (pathname === "/api/refresh") {
    try {
      const c = await getClients();
      const out = {};
      for (const a of wl.assets) {
        try { const s = await fetchSummary(c.ccxt, a.symbol, wl.exchange); out[a.symbol] = { last: s.last, vol24: s.vol24, high: s.high, low: s.low }; }
        catch (e) { out[a.symbol] = { error: e.message.slice(0, 80) }; }
      }
      return json(res, { ts: new Date().toISOString(), prices: out });
    } catch (e) { return json(res, { error: e.message }, 500); }
  }

  return json(res, { error: "not found" }, 404);
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const desk = async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (u.pathname.startsWith("/api/")) return await api(u.pathname, u.searchParams, res);
    const fp = u.pathname === "/" ? "/index.html" : u.pathname;
    const file = path.join(__dirname, "public", fp);
    if (!file.startsWith(path.join(__dirname, "public"))) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "text/plain", "Cache-Control": "no-store" });
      res.end(data);
    });
  } catch (e) { json(res, { error: e.message }, 500); }
};
// dashboard.bat opens 7070 while recent runs used 8080; answer both from one process.
for (const p of new Set([Number(PORT), 7070, 8080])) {
  http.createServer(desk)
    .on("error", (e) => console.log(`  port ${p} unavailable: ${e.code || e.message}`))
    .listen(p, () => console.log(`\n  ◉ Trading Desk → http://localhost:${p}\n`));
}
