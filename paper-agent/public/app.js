/* Trading Desk — live UI. Ticker tape, charts, positions, portfolio. */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const fmt$ = (v, d = 2) => v == null ? "—" : (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtN = (v, d = 2) => v == null ? "—" : Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtPct = (v) => v == null ? "—" : (v >= 0 ? "+" : "") + Number(v).toFixed(2) + "%";
const fmtBig = (v) => v == null ? "n/a" : v >= 1e9 ? "$" + (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? "$" + (v / 1e6).toFixed(1) + "M" : "$" + fmtN(v, 0);
const ago = (ts) => ts ? new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
const agoRel = (ts) => { if (!ts) return "—"; const s = (Date.now() - new Date(ts)) / 1000; return s < 60 ? `${s | 0}s` : s < 3600 ? `${s / 60 | 0}m` : `${s / 3600 | 0}h${(s / 60 % 60 | 0)}m`; };
const ICONS = { "BTC/USDT": "₿", "ETH/USDT": "Ξ", "SOL/USDT": "◎", "LINK/USDT": "⬡", "AVAX/USDT": "▲" };
const icon = (s) => ICONS[s] || s.slice(0, 3);
const COLORS = ["var(--acc)", "var(--up)", "var(--gold)", "var(--acc2)", "var(--down)", "var(--alloc-cyan)"];

let curSymbol = "BTC/USDT", curTF = "1h";
let tapeSymbols = "";
let candleChart, candleSeries, volSeries, equityChart, equitySeries;
let lastCandles = null, lastTradeMarks = null;
let lastStatus = null, lastAssets = [], lastPosCount = 0, prevDecisionsLen = 0;
const seenTrades = new Set();
let fillsInitialized = false, dashboardBusy = false;
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* toast on new fills */
function toast(msg, kind) {
  const el = document.createElement("div");
  el.className = "toast " + (kind || "");
  el.textContent = msg;
  document.getElementById("toasts").appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

/* ── theme ── */
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function chartTheme() {
  return {
    text: cssVar("--chart-text"), grid: cssVar("--chart-grid"), border: cssVar("--chart-border"),
    up: cssVar("--chart-up"), down: cssVar("--chart-down"),
    volUp: cssVar("--chart-vol-up"), volDown: cssVar("--chart-vol-down"),
    acc: cssVar("--chart-acc"), accTop: cssVar("--chart-acc-top"), accBottom: cssVar("--chart-acc-bottom"),
    crosshair: cssVar("--chart-crosshair"), gold: cssVar("--chart-gold"),
  };
}
function chartOptions() {
  const t = chartTheme();
  return {
    layout: { textColor: t.text },
    grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
    timeScale: { borderColor: t.border },
    rightPriceScale: { borderColor: t.border },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: { color: t.crosshair, labelBackgroundColor: t.acc },
      horzLine: { color: t.crosshair, labelBackgroundColor: t.acc },
    },
  };
}
function paintVolume() {
  if (!lastCandles || !volSeries) return;
  const t = chartTheme();
  volSeries.setData(lastCandles.map((c) => ({ time: c.t, value: c.v, color: c.c >= c.o ? t.volUp : t.volDown })));
}
function paintMarkers() {
  if (!lastTradeMarks || !candleSeries) return;
  const t = chartTheme();
  candleSeries.setMarkers(lastTradeMarks.map((m) => ({
    ...m, color: m.action === "BUY" || m.action === "COVER" ? t.up : m.action === "TAKE_PROFIT" ? t.gold : t.down,
  })));
}
function applyChartTheme() {
  if (!candleChart || !equityChart) return;
  const t = chartTheme();
  const base = chartOptions();
  candleChart.applyOptions(base);
  equityChart.applyOptions(base);
  candleSeries.applyOptions({ upColor: t.up, downColor: t.down, wickUpColor: t.up, wickDownColor: t.down });
  equitySeries.applyOptions({ lineColor: t.acc, topColor: t.accTop, bottomColor: t.accBottom });
  paintVolume();
  paintMarkers();
}
function currentTheme() { return document.documentElement.dataset.theme === "dark" ? "dark" : "light"; }
function syncThemeUi() {
  const light = currentTheme() === "light";
  const toggle = $("#themeToggle");
  if (toggle) {
    const label = light ? "Switch to dark mode" : "Switch to light mode";
    toggle.setAttribute("aria-checked", String(light));
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
  }
  const meta = document.getElementById("themeColor");
  if (meta) meta.setAttribute("content", light ? "#f3f0e8" : "#06080c");
  applyChartTheme();
}
function initTheme() {
  $("#themeToggle")?.addEventListener("click", () => {
    const next = currentTheme() === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("td-theme", next); } catch {}
    syncThemeUi();
  });
  syncThemeUi();
}

/* ── init charts ── */
function initCharts() {
  const t = chartTheme();
  const base = chartOptions();
  const opt = {
    ...base,
    layout: { ...base.layout, background: { color: "transparent" }, fontFamily: "JetBrains Mono, monospace", fontSize: 10 },
  };
  candleChart = LightweightCharts.createChart($("#candleChart"), { ...opt, width: $("#candleChart").clientWidth, height: $("#candleChart").clientHeight });
  candleSeries = candleChart.addCandlestickSeries({ upColor: t.up, downColor: t.down, wickUpColor: t.up, wickDownColor: t.down, borderVisible: false });
  volSeries = candleChart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" } });
  candleChart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.22 } });

  /* hover tooltip: shows OHLC + % change of the hovered candle */
  const tip = $("#candleTip");
  candleChart.subscribeCrosshairMove((param) => {
    if (!param.time || !param.seriesData || !param.point) { tip.classList.add("hidden"); return; }
    const d = param.seriesData.get(candleSeries);
    if (!d) { tip.classList.add("hidden"); return; }
    const chg = d.open ? (d.close - d.open) / d.open * 100 : 0;
    const range = d.open ? (d.high - d.low) / d.open * 100 : 0;
    const cls = chg >= 0 ? "pos" : "neg";
    const when = new Date(param.time * 1000).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
    tip.innerHTML = `<div class="ct-head"><b>${when}</b><span class="${cls}">${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%</span></div>
      <div class="ct-row"><span>O</span><b>${fmtN(d.open, 2)}</b><span>H</span><b>${fmtN(d.high, 2)}</b></div>
      <div class="ct-row"><span>L</span><b>${fmtN(d.low, 2)}</b><span>C</span><b>${fmtN(d.close, 2)}</b></div>
      <div class="ct-row dim"><span>range</span><b>${range.toFixed(2)}%</b></div>`;
    tip.classList.remove("hidden");
    const wrap = $(".chart-wrap");
    const x = Math.min(param.point.x + 14, wrap.clientWidth - tip.offsetWidth - 8);
    const y = Math.max(8, Math.min(param.point.y - tip.offsetHeight - 10, wrap.clientHeight - tip.offsetHeight - 8));
    tip.style.left = x + "px"; tip.style.top = y + "px";
  });
  equityChart = LightweightCharts.createChart($("#equityChart"), { ...opt, width: $("#equityChart").clientWidth, height: $("#equityChart").clientHeight });
  equitySeries = equityChart.addAreaSeries({ lineColor: t.acc, topColor: t.accTop, bottomColor: t.accBottom, lineWidth: 2, priceLineVisible: false });
  new ResizeObserver(() => {
    candleChart.applyOptions({ width: $("#candleChart").clientWidth, height: $("#candleChart").clientHeight });
    equityChart.applyOptions({ width: $("#equityChart").clientWidth, height: $("#equityChart").clientHeight });
  }).observe($(".chart-panel"));
}

async function loadCandles() {
  const r = await fetch(`/api/candles?symbol=${encodeURIComponent(curSymbol)}&tf=${curTF}`).then((r) => r.json()).catch(() => null);
  if (!r || r.error || !r.candles?.length) return;
  lastCandles = r.candles;
  candleSeries.setData(lastCandles.map((c) => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c })));
  paintVolume();
  // trade markers on chart
  lastTradeMarks = [];
  paintMarkers();
  try {
    const { trades } = await fetch("/api/trades").then((x) => x.json());
    lastTradeMarks = (trades || []).filter((t) => t.symbol === curSymbol).map((t) => ({
      time: Math.floor(new Date(t.ts).getTime() / 1000),
      position: t.action === "BUY" || t.action === "COVER" ? "belowBar" : "aboveBar",
      shape: t.action === "BUY" || t.action === "COVER" ? "arrowUp" : "arrowDown",
      text: t.action,
      action: t.action,
    })).sort((a, b) => a.time - b.time);
    paintMarkers();
  } catch {}
  candleChart.timeScale().fitContent();
}
async function loadEquity() {
  const { curve } = await fetch("/api/equity").then((r) => r.json()).catch(() => ({ curve: [] }));
  if (!curve?.length) return;
  equitySeries.setData(curve.map((p) => ({ time: Math.floor(new Date(p.ts).getTime() / 1000), value: p.equity })));
  equityChart.timeScale().fitContent();
}

/* ── ticker tape ── */
function renderTape(assets) {
  const symbols = assets.map((a) => a.symbol).join("|");
  // Rebuilding this node restarts CSS animation. Only rebuild when the watchlist changes.
  if (symbols === tapeSymbols) {
    assets.forEach((a) => {
      const els = document.querySelectorAll(`#tapeTrack [data-tape-symbol="${CSS.escape(a.symbol)}"]`);
      els.forEach((el) => {
        const price = el.querySelector(".tk-price");
        const change = el.querySelector(".tk-change");
        if (price) price.textContent = a.price ? fmtN(a.price, a.price < 1 ? 4 : 2) : "—";
        if (change) { change.textContent = fmtPct(a.momentum1h); change.className = `tk-change c ${a.momentum1h > 0 ? "up" : a.momentum1h < 0 ? "dn" : ""}`; }
      });
    });
    return;
  }
  tapeSymbols = symbols;
  const items = assets.map((a) => {
    const c = a.momentum1h;
    return `<span class="tk" data-tape-symbol="${a.symbol}"><span class="s">${a.symbol}</span><b class="tk-price">${a.price ? fmtN(a.price, a.price < 1 ? 4 : 2) : "—"}</b><span class="tk-change c ${c > 0 ? "up" : c < 0 ? "dn" : ""}">${fmtPct(c)}</span></span>`;
  }).join("");
  $("#tapeTrack").innerHTML = items + items; // duplicate for seamless loop
}

/* ── status / assets / positions / feed / trades / logs ── */
function renderStatus(s, decisions = []) {
  lastStatus = s;
  $("#kEquity").textContent = fmt$(s.equity);
  $("#kEquitySub").textContent = "adaptive cash " + fmt$(s.cash);
  $("#kPnl").textContent = fmt$(s.pnlTotal);
  $("#kPnl").className = "kpi-val " + (s.pnlTotal > 0 ? "pos" : s.pnlTotal < 0 ? "neg" : "");
  $("#kPnlPct").textContent = fmtPct(s.pnlPct) + " fee-net";
  const depPct = s.equity > 0 ? s.deployedUsd / s.equity * 100 : 0;
  $("#kDep").textContent = fmt$(s.deployedUsd, 0);
  $("#kDepPct").textContent = depPct.toFixed(0) + "% · liquidation value";
  $("#kOpen").innerHTML = `${s.openCount}<span class="dim">/${s.risk.maxOpenPositions}</span>`;
  $("#kWin").textContent = s.stats.closedCount ? s.stats.winRate.toFixed(0) + "%" : "—";
  $("#kClosed").textContent = s.stats.closedCount + " adaptive closes";
  $("#kDD").textContent = s.stats.maxDrawdownPct.toFixed(2) + "%";
  $("#kDDSub").textContent = "closed-hour curve";
  $("#exchangeTag").textContent = s.exchange;
  const on = s.observerFresh;
  $("#agentDot").className = "dot" + (on ? " on" : "");
  $("#agentState").textContent = !on ? "ADAPTIVE STALE" : s.riskHalted ? "RISK HALT" : "ADAPTIVE AUTO";
  const activeStrategy = s.activeStrategy ?? s.champion;
  const stateLabel = s.champion === "CASH" && s.exploration ? `Exploration: ${s.exploration.candidateId}` : `Selected: ${activeStrategy}`;
  $("#agentState").title = `${stateLabel} · valued ${s.valuationTime || "awaiting first closed hour"}`;
  $("#btnStart").disabled = true; $("#btnStop").disabled = true; $("#btnReset").disabled = true;
  $("#liveBadge").className = "live-badge" + (s.marketFresh ? "" : " off");
  $("#liveBadge").textContent = s.marketFresh ? "market data" : "quotes delayed";
  $("#kLast").textContent = s.openCount === 0 && s.stats.closedCount === 0
    ? `${activeStrategy} · waiting entry`
    : `${activeStrategy} · ${s.reviewCount} reviews`;
  const latestWait = decisions.find(d => d.kind === "STATUS")?.reason;
  if (latestWait) $("#kLast").title = latestWait;
  updateObserverClock();
}
function updateObserverClock() {
  if (!lastStatus) return;
  if (!lastStatus.observerFresh) { $("#kNext").textContent = "delayed"; return; }
  const ms = new Date(lastStatus.nextObservationAt).getTime() - Date.now();
  $("#kNext").textContent = Number.isFinite(ms) && ms > 0 ? `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}` : "due";
}

function scoreFrom(a) {
  const tUp = a.trend1h === "up" && a.trend4h === "up", tDn = a.trend1h === "down" && a.trend4h === "down";
  let s = 0;
  if (tUp) s += 3; else if (a.trend4h === "up") s += 1; else if (tDn) s -= 3; else if (a.trend4h === "down") s -= 1;
  if (a.regime === "bear") s -= 1;
  if (a.momentum4h > 2) s += 1; if (a.momentum4h < -2) s -= 1;
  if (a.rsi1h > 72) s -= 1;
  return Math.max(-4, Math.min(4, s));
}

function renderAssets(list) {
  lastAssets = list;
  const q = (document.getElementById("watchFilter")?.value || "").toUpperCase();
  const shown = list.filter((a) => !q || a.symbol.includes(q)).slice(0, 60);
  const cnt = document.getElementById("watchCount");
  if (cnt) cnt.textContent = `${list.length} tracked${q ? ` · ${shown.length} shown` : ""}`;
  $("#watchRows").innerHTML = shown.map((a) => {
    const c = a.momentum1h;
    const score = scoreFrom(a);
    const dial = Array.from({ length: 9 }, (_, i) => {
      const v = i - 4;
      const on = (score > 0 && v > 0 && v <= score) || (score < 0 && v < 0 && v >= score) || (score === 0 && v === 0);
      return `<i class="${on ? (score > 0 ? "on-up" : score < 0 ? "on-dn" : "on-mid") : ""}"></i>`;
    }).join("");
    const badges = [
      a.trend1h ? `<span class="bdg ${a.trend1h}">1H${a.trend1h === "up" ? "▲" : "▼"}</span>` : "",
      a.trend4h ? `<span class="bdg ${a.trend4h}">4H${a.trend4h === "up" ? "▲" : "▼"}</span>` : "",
      a.rsi1h ? `<span class="bdg neu">RSI${a.rsi1h.toFixed(0)}</span>` : "",
      `<span class="score-dial" title="Market context only; entries are selected by the adaptive engine">${dial}</span>`,
      a.position ? `<span class="bdg ${a.position.side === "short" ? "sh" : "pos-b"}">${a.position.side === "short" ? "SHORT" : "LONG"}</span>` : "",
      a.volSpike > 2 ? `<span class="bdg neu">×${a.volSpike.toFixed(1)}v</span>` : "",
    ].join("");
      const d = a.vol24;
      return `<div class="w-row ${a.symbol === curSymbol ? "active" : ""}" data-sym="${a.symbol}">
      <div class="w-ico">${icon(a.symbol)}</div>
      <div class="w-mid"><div class="w-sym">${a.symbol}</div><div class="w-name">${a.name || ""}</div><div class="w-badges">${badges}</div></div>
      <div class="w-right"><div class="w-px">${a.price ? fmtN(a.price, a.price < 1 ? 4 : 2) : "—"}</div>
        <div class="w-chg ${c > 0 ? "pos" : c < 0 ? "neg" : ""}">${fmtPct(c)}</div>
        <div class="w-extra">${fmtBig(d)}</div></div></div>`;
    }).join("");
  $$(".w-row").forEach((r) => r.onclick = () => {
    curSymbol = r.dataset.sym;
    $$(".w-row").forEach((x) => x.classList.toggle("active", x === r));
    $("#chartSym").textContent = curSymbol; loadCandles();
  });
  const cur = list.find((a) => a.symbol === curSymbol);
  if (cur) {
    $("#chartPrice").textContent = cur.price ? fmtN(cur.price, cur.price < 1 ? 4 : 2) : "—";
    $("#chartChg").textContent = fmtPct(cur.momentum1h);
    $("#chartChg").className = "price-chg " + (cur.momentum1h > 0 ? "pos" : cur.momentum1h < 0 ? "neg" : "");
  }
  renderTape(list);
}

function renderPositions(list) {
  $("#posCount").textContent = list.length + " adaptive open";
  if (!list.length) { $("#posRows").innerHTML = `<div class="empty">No adaptive positions. Entries are automatic when a strategy qualifies.</div>`; return; }
  $("#posRows").innerHTML = list.map((p) => {
    const mark = p.markPrice, unr = p.unrealizedNet;
    const pc = unr == null ? null : unr / (p.entry_price * p.qty_open + p.entry_fee) * 100;
    const pct = mark != null && p.target_price > p.stop_price ? Math.max(0, Math.min(100, (mark - p.stop_price) / (p.target_price - p.stop_price) * 100)) : null;
    return `<div class="pos-card long">
      <div class="pos-top"><span class="pos-sym">${escapeHtml(p.symbol)}</span><span class="pos-side long">LONG</span><span class="pos-pnl ${unr > 0 ? "pos" : unr < 0 ? "neg" : ""}">${fmt$(unr)} <span class="dim">${fmtPct(pc)} net</span></span></div>
      <div class="pos-meta"><span>qty <b>${p.qty_open.toFixed(5)}</b></span><span>entry <b>${fmtN(p.entry_price, 4)}</b></span><span>hour close <b>${fmtN(mark, 4)}</b></span><span>size <b>${fmt$(p.size_usd, 0)}</b></span><span>age <b>${agoRel(p.opened_at)}</b></span><span>${escapeHtml(p.candidateId)}</span></div>
      <div class="slbar">${pct === null ? "" : `<div class="slmark" style="left:${pct}%"></div>`}</div>
      <div class="pos-lv"><span>SL ${fmtN(p.stop_price, 4)}</span>${p.trail_active ? '<span class="trail-tag">TRAILING</span>' : ""}<span>Target ${p.target_price === null ? "runner" : fmtN(p.target_price, 4)}</span></div></div>`;
  }).join("");
}

/* ── decision feed — dedupe repeated HOLDs, latest-per-symbol, clean text ── */
function cleanReason(r) {
  return (r || "").replace(/\s*\|\s*(max \d+ positions|cooldown.*|circuit breaker|size<.*|liq .*|vol24.*|spread.*|size < .*)/g, "").trim();
}
function decisionMeta(d) {
  const isShort = d.decision === "SHORT" || d.decision === "COVER" || /\(short\)/.test(d.decision);
  if (d.decision === "BUY") return { cls: "f-buy", ico: "B", label: "BUY", col: "var(--up)" };
  if (d.decision === "SHORT") return { cls: "f-sell", ico: "S", label: "SHORT", col: "var(--down)" };
  if (d.decision === "SELL") return { cls: "f-sell", ico: "S", label: "SELL", col: "var(--down)" };
  if (d.decision === "COVER") return { cls: "f-buy", ico: "C", label: "COVER", col: "var(--up)" };
  if (d.decision === "SKIP") return { cls: "f-hold", ico: "!", label: "SKIP", col: "var(--warn)" };
  return { cls: "f-hold", ico: "·", label: isShort ? "HOLD·S" : "HOLD", col: "var(--tx2)" };
}
function renderFeed(list) {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  // newest decision per symbol
  const bySym = new Map();
  for (const d of list) if (!bySym.has(d.symbol)) bySym.set(d.symbol, d);
  const rows = [...bySym.values()].sort((a, b) => new Date(b.ts) - new Date(a.ts));
  const missing = (lastAssets || []).filter((a) => !bySym.has(a.symbol)).map((a) => a.symbol);

  let html = "";
  for (const d of rows) {
    const m = decisionMeta(d);
    const sigCls = m.cls === "f-buy" ? " sig-buy" : m.cls === "f-sell" ? " sig-sell" : "";
    html += `<div class="sig${sigCls}">
      <div class="sig-ico ${m.cls}">${m.ico}</div>
      <div class="sig-main">
        <div class="sig-line1">
          <span class="sig-sym">${esc(d.symbol)}</span>
          <span class="sig-badge" style="color:${m.col};border-color:${m.col}">${m.label}</span>
          ${d.price ? `<span class="sig-px">${fmtN(d.price, 2)}</span>` : ""}
          <span class="sig-time">${ago(d.ts)}</span>
        </div>
        <div class="sig-reason">${esc(cleanReason(d.reason)) || "—"}</div>
      </div>
    </div>`;
  }
  for (const sym of missing) {
    html += `<div class="sig sig-wait">
      <div class="sig-ico f-hold">?</div>
      <div class="sig-main">
        <div class="sig-line1"><span class="sig-sym">${esc(sym)}</span><span class="sig-badge" style="color:var(--tx3);border-color:var(--tx3)">WAITING</span></div>
        <div class="sig-reason">automatic observation — awaiting a completed trading interval</div>
      </div>
    </div>`;
  }
  $("#feedRows").innerHTML = html || `<div class="f-feed-empty"><div style="font-size:22px">◌</div><div>Waiting for the first cycle…</div><div style="font-style:normal;font-size:10.5px">The adaptive engine runs automatically.</div></div>`;
}

function renderTrades(list) {
  // toast new fills
  for (const t of list) {
    if (!seenTrades.has(t.id)) {
      seenTrades.add(t.id);
      if (fillsInitialized) toast(`${t.action} ${t.symbol} @${fmtN(t.price, 4)}${t.pnl_usd != null ? " · " + fmt$(t.pnl_usd) : ""}`, t.action === "BUY" ? "buy" : t.action === "SELL" || t.action === "STOP" || t.action === "COVER" ? "sell" : "");
    }
  }
  fillsInitialized = true;
  if (!list.length) { $("#pTradeBody").innerHTML = `<tr><td colspan="10" class="empty">no adaptive fills yet</td></tr>`; return; }
  $("#pTradeBody").innerHTML = list.map((t) =>
    `<tr><td>${ago(t.ts)}</td><td>${t.symbol}</td><td class="side-${t.action}">${t.action}</td><td>${t.side || "long"}</td>
      <td>${t.qty.toFixed(5)}</td><td>${fmtN(t.price, 4)}</td><td>${fmt$(t.value_usd)}</td><td>${fmt$(t.fee_usd || 0)}</td>
      <td class="${t.pnl_usd > 0 ? "pos" : t.pnl_usd < 0 ? "neg" : ""}">${t.pnl_usd != null ? fmt$(t.pnl_usd) : "—"}</td>
      <td class="rsn">${escapeHtml(t.reason)}</td></tr>`).join("");
}

function renderLogs(list) { $("#logBox").textContent = list.length ? list.join("\n") : "agent not started."; $("#logBox").scrollTop = $("#logBox").scrollHeight; }

/* ── portfolio page ── */
function renderPortfolio(st, pos, trades) {
  $("#pEquity").textContent = fmt$(st.equity);
  $("#pCash").textContent = fmt$(st.cash);
  $("#pDeployed").textContent = fmt$(st.deployedUsd || 0);
  const unr = st.stats.unrealizedNet;
  $("#pUnreal").textContent = fmt$(unr);
  $("#pUnreal").className = unr >= 0 ? "pos" : "neg";
  const real = st.stats.totalPnl;
  $("#pReal").textContent = fmt$(real);
  $("#pReal").className = real >= 0 ? "pos" : "neg";
  $("#pFees").textContent = fmt$(-st.stats.totalFees);
  $("#pRet").textContent = fmtPct(st.pnlPct);
  $("#sTrades").textContent = st.stats.totalFills || 0;
  $("#sWin").textContent = st.stats.closedCount ? st.stats.winRate.toFixed(0) + "%" : "—";
  const wins = st.stats.closed.filter((p) => p.pnl_usd > 0), losses = st.stats.closed.filter((p) => p.pnl_usd < 0);
  $("#sAvg").textContent = wins.length ? fmt$(wins.reduce((a, p) => a + p.pnl_usd, 0) / wins.length) : "—";
  $("#sAvgL").textContent = losses.length ? fmt$(losses.reduce((a, p) => a + p.pnl_usd, 0) / losses.length) : "—";
  $("#sDD").textContent = (st.stats.maxDrawdownPct || 0).toFixed(1) + "%";

  // allocation
  const alloc = pos.filter(p => Number.isFinite(p.liquidationValue)).map((p, i) => ({ sym: p.symbol, v: p.liquidationValue, c: COLORS[i % COLORS.length] }));
  const cash = st.cash;
  const tot = st.equity || 1;
  let html = pos.some(p => p.liquidationValue == null) ? '<div class="hint">Some closed-hour marks are unavailable.</div>' : "";
  for (const a of alloc) html += `<div class="alloc-row"><div class="alloc-top"><span>${escapeHtml(a.sym)}</span><span>${(a.v / tot * 100).toFixed(1)}% · ${fmt$(a.v, 0)}</span></div><div class="alloc-bar"><div class="alloc-fill" style="width:${(a.v / tot * 100).toFixed(1)}%;background:${a.c}"></div></div></div>`;
  html += `<div class="alloc-row"><div class="alloc-top"><span>CASH</span><span>${(cash / tot * 100).toFixed(1)}% · ${fmt$(cash, 0)}</span></div><div class="alloc-bar"><div class="alloc-fill" style="width:${(cash / tot * 100).toFixed(1)}%;background:var(--cash)"></div></div></div>`;
  $("#allocBars").innerHTML = html;

  // positions table
  $("#pPosCount").textContent = pos.length + " open";
  $("#pPosBody").innerHTML = pos.length ? pos.map((p) => {
    const mark = p.markPrice, unr = p.unrealizedNet;
    const pc = unr == null ? null : unr / (p.entry_price * p.qty_open + p.entry_fee) * 100;
    return `<tr><td>${escapeHtml(p.symbol)}</td><td class="side-LONG">LONG</td>
      <td>${p.qty_open.toFixed(5)}</td><td>${fmtN(p.entry_price, 4)}</td><td>${fmtN(mark, 4)}</td><td>${fmt$(p.liquidationValue)}</td>
      <td class="${unr > 0 ? "pos" : unr < 0 ? "neg" : ""}">${fmt$(unr)}</td><td class="${pc > 0 ? "pos" : pc < 0 ? "neg" : ""}">${fmtPct(pc)}</td>
      <td>${fmtN(p.stop_price, 4)}</td><td>${p.target_price === null ? "runner" : fmtN(p.target_price, 4)}</td><td>${escapeHtml(p.candidateId)}</td>
      <td>${p.trail_active ? '<span class="trail-tag">ON</span>' : "—"}</td><td>${agoRel(p.opened_at)}</td></tr>`;
  }).join("") : `<tr><td colspan="13" class="empty">no adaptive positions</td></tr>`;
}

/* ── tabs ── */
$$(".tab").forEach((t) => t.onclick = () => {
  $$(".tab").forEach((x) => x.classList.toggle("active", x === t));
  $$(".page").forEach((page) => page.classList.toggle("hidden", page.id !== `page-${t.dataset.page}`));
  $(".app").classList.toggle("adaptive-view", t.dataset.page === "adaptive");
  if (t.dataset.page === "adaptive") document.dispatchEvent(new CustomEvent("td:refresh"));
});

/* ── poll ── */
async function tick() {
  if (dashboardBusy) return;
  dashboardBusy = true;
  try {
    const response = await fetch("/api/dashboard", { cache: "no-store", signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Adaptive dashboard unavailable (HTTP ${response.status})`);
    const data = await response.json();
    if (data.status?.tradingEngine !== "adaptive" || !data.status.automatic) throw new Error("Unexpected trading engine; refusing mixed account data");
    renderStatus(data.status, data.decisions); renderAssets(data.assets); renderPositions(data.positions);
    renderFeed(data.decisions); renderTrades(data.trades); renderLogs(data.logs);
    renderPortfolio(data.status, data.positions, data.trades);
  } catch (error) {
    if (lastStatus) lastStatus.observerFresh = false;
    $("#agentDot").className = "dot";
    $("#agentState").textContent = "DATA UNAVAILABLE";
    $("#kNext").textContent = "delayed";
    if (!lastStatus) for (const id of ["kEquity", "kPnl", "kDep", "kOpen", "kWin", "kDD", "pEquity", "pCash", "pDeployed", "pUnreal", "pReal", "pFees", "pRet"]) document.getElementById(id).textContent = "—";
    renderLogs([error.message, "Last displayed values are retained, not current. The automatic observer is independent of this page."]);
  } finally { dashboardBusy = false; }
}

$("#btnOnce").onclick = () => { tick(); loadCandles(); loadEquity(); document.dispatchEvent(new CustomEvent("td:refresh")); };
$$(".tf-btn").forEach((b) => b.onclick = () => { $$(".tf-btn").forEach((x) => x.classList.toggle("active", x === b)); curTF = b.dataset.tf; loadCandles(); });
document.getElementById("watchFilter").addEventListener("input", () => renderAssets(lastAssets));

/* Shortcuts: 1-5 asset, C refresh, T page. Trading remains automatic. */
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  const k = e.key;
  if ($(".app").classList.contains("adaptive-view") && k.toLowerCase() !== "t") return;
  if (/^[1-5]$/.test(k) && lastAssets[k - 1]) { curSymbol = lastAssets[k - 1].symbol; $("#chartSym").textContent = curSymbol; renderAssets(lastAssets); loadCandles(); }
  else if (k === "c" || k === "C") tick();
  else if (k === "t" || k === "T") { const d = $("#page-dashboard").classList.contains("hidden"); $$(".tab")[d ? 0 : 1].click(); }
});

initTheme(); initCharts(); tick(); loadCandles(); loadEquity();
setInterval(tick, 4000); setInterval(loadEquity, 20000); setInterval(loadCandles, 30000);
setInterval(() => { $("#clock").textContent = new Date().toLocaleString("en-GB"); updateObserverClock(); }, 1000);
