import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { AdaptiveStore } from "./adaptive/v2/store.js";
import { fingerprint } from "./adaptive/v2/runner.js";
import { VERSION } from "./adaptive/v2/config.js";
import { SYMBOLS } from "./candidate/config.js";
import { buildDashboard } from "./adaptive/dashboard-data.js";
import { DashboardMarket } from "./adaptive/dashboard-market.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "public");
const DB_FILE = path.join(HERE, "adaptive/v2/adaptive-state.db");
const runFile = promisify(execFile);
const market = new DashboardMarket();
const servers = [];
let cached = null;
let lastRead = 0;
let lastDbChange = null;
let startingObserver = null;

function checkpoint() {
  const changed = fs.statSync(DB_FILE).mtimeMs;
  if (cached && changed === lastDbChange && Date.now() - lastRead < 3000) return cached;
  const store = new AdaptiveStore(DB_FILE, { readOnly: true });
  try {
    const saved = store.load();
    if (!saved || saved.state.mode !== "FORWARD_SHADOW" || saved.state.version !== VERSION || saved.state.codeHash !== fingerprint())
      throw new Error("The registered adaptive forward checkpoint is unavailable or has a different source version.");
    const events = store.events().filter(event => event.revision <= saved.revision);
    cached = { ...saved, events };
    lastDbChange = changed;
    lastRead = Date.now();
    return cached;
  } finally { store.close(); }
}
function dashboard() {
  const { state, revision, events } = checkpoint();
  let snapshot = null;
  try { snapshot = JSON.parse(fs.readFileSync(path.join(PUBLIC, "adaptive-status.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const quotes = market.data;
  const result = buildDashboard(state, events, { revision, snapshot, market: quotes });
  result.status.tradingEngine = "adaptive";
  result.status.legacyTradingEnabled = false;
  result.status.realOrdersEnabled = false;
  result.status.marketFresh = SYMBOLS.every(symbol => {
    const quote = quotes[symbol];
    const age = Date.now() - Number(quote?.priceTs);
    return Number.isFinite(quote?.price) && quote.price > 0 && age >= -5000 && age <= 60_000 && !quote.error;
  });
  return result;
}
async function startObserver() {
  if (!startingObserver) {
    startingObserver = runFile("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", "Start-ScheduledTask -TaskName 'V7-Adaptive-Observer' -ErrorAction Stop"
    ], { windowsHide: true, timeout: 15_000 }).finally(() => { startingObserver = null; });
  }
  await startingObserver;
  return { ok: true, automatic: true, tradingEngine: "adaptive", msg: "Automatic adaptive observation requested; strategy and risk rules are unchanged." };
}
const json = (res, body, code = 200) => {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(body));
};
const csvCell = value => {
  if (value == null) return "";
  const text = String(value);
  return `"${(typeof value === "string" && /^[=+@-]/.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`;
};

async function api(req, url, res) {
  const route = url.pathname;
  if (["/api/agent/start", "/api/agent/stop", "/api/agent/run-once", "/api/reset"].includes(route)) {
    if (req.method !== "POST") return json(res, { error: "POST required" }, 405);
    if (route === "/api/agent/start") return json(res, await startObserver());
    return json(res, { ok: false, automatic: true, msg: "Adaptive trading is scheduled automatically. Manual cycles, legacy trading, and audit resets are disabled." }, 409);
  }
  if (req.method !== "GET" && req.method !== "HEAD") return json(res, { error: "Read-only endpoint" }, 405);
  if (route === "/api/candles") {
    const symbol = url.searchParams.get("symbol") || SYMBOLS[0];
    const tf = url.searchParams.get("tf") || "1h";
    if (!SYMBOLS.includes(symbol) || !["15m", "1h", "4h", "1w"].includes(tf)) return json(res, { error: "Unsupported symbol or timeframe" }, 400);
    return json(res, { symbol, tf, candles: await market.candles(symbol, tf), source: "public-okx-closed-candles" });
  }
  if (route === "/api/refresh") {
    await market.refresh();
    return json(res, { ts: new Date().toISOString(), prices: market.data });
  }
  const data = dashboard();
  if (route === "/api/dashboard") return json(res, data);
  if (route === "/api/status") return json(res, data.status);
  if (route === "/api/assets") return json(res, { assets: data.assets });
  if (route === "/api/positions") return json(res, { positions: data.positions, closed: data.closed.slice(0, 50) });
  if (route === "/api/trades") return json(res, { trades: data.trades.slice(0, 100) });
  if (route === "/api/decisions") return json(res, { decisions: data.decisions.slice(0, 100) });
  if (route === "/api/equity") return json(res, { curve: data.curve });
  if (route === "/api/logs") return json(res, { logs: data.logs.slice(-150) });
  if (route === "/api/health") return json(res, {
    ok: true, agent: data.status.agent.running, tradingEngine: "adaptive", automatic: true,
    legacyTradingEnabled: false, realOrdersEnabled: false, uptime: process.uptime()
  });
  if (route === "/api/export/trades") {
    const keys = ["id", "ts", "symbol", "action", "side", "qty", "price", "value_usd", "fee_usd", "pnl_usd", "reason"];
    const rows = [...data.trades].reverse();
    res.writeHead(200, { "Content-Type": "text/csv", "Cache-Control": "no-store", "Content-Disposition": "attachment; filename=adaptive-trades.csv" });
    return res.end(`${keys.join(",")}\n${rows.map(row => keys.map(key => csvCell(row[key])).join(",")).join("\n")}`);
  }
  return json(res, { error: "not found" }, 404);
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };
async function desk(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) return await api(req, url, res);
    const relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = path.resolve(PUBLIC, `.${relative}`);
    const inside = path.relative(PUBLIC, file);
    if (inside.startsWith("..") || path.isAbsolute(inside)) return json(res, { error: "forbidden" }, 403);
    fs.readFile(file, (error, body) => {
      if (error) return json(res, { error: "not found" }, 404);
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(body);
    });
  } catch (error) { json(res, { error: error.message, tradingEngine: "adaptive", legacyTradingEnabled: false }, 503); }
}

market.refresh().catch(error => console.error(`[market] ${error.message}`));
const refreshTimer = setInterval(() => market.refresh().catch(error => console.error(`[market] ${error.message}`)), 15_000);
refreshTimer.unref();
const ports = process.env.PORT ? [Number(process.env.PORT)] : [7070, 8080];
for (const port of ports) {
  const server = http.createServer(desk);
  server.on("error", error => { console.error(`Dashboard port ${port}: ${error.message}`); process.exitCode = 1; });
  server.listen(port, () => console.log(`Adaptive paper dashboard listening on ${port}`));
  servers.push(server);
}
async function close() {
  clearInterval(refreshTimer);
  for (const server of servers) { server.closeAllConnections(); server.close(); }
  await market.close();
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
