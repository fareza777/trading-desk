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
const COLORS = ["#4c8dff", "#14d18f", "#f0b90b", "#7c5cff", "#f6465d", "#38bdf8"];

let curSymbol = "BTC/USDT", curTF = "1h";
let tapeSymbols = "";
let candleChart, candleSeries, volSeries, equityChart, equitySeries;
let lastStatus = null, lastAssets = [], lastPosCount = 0, prevDecisionsLen = 0;
const seenTrades = new Set();

/* toast on new fills */
function toast(msg, kind) {
  const el = document.createElement("div");
  el.className = "toast " + (kind || "");
  el.textContent = msg;
  document.getElementById("toasts").appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

/* ── init charts ── */
function initCharts() {
  const opt = {
    layout: { background: { color: "transparent" }, textColor: "#8b96ab", fontFamily: "JetBrains Mono, monospace", fontSize: 10 },
    grid: { vertLines: { color: "rgba(26,36,54,.5)" }, horzLines: { color: "rgba(26,36,54,.5)" } },
    timeScale: { borderColor: "#1a2436", timeVisible: true },
    rightPriceScale: { borderColor: "#1a2436" },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  };
  candleChart = LightweightCharts.createChart($("#candleChart"), { ...opt, width: $("#candleChart").clientWidth, height: $("#candleChart").clientHeight });
  candleSeries = candleChart.addCandlestickSeries({ upColor: "#14d18f", downColor: "#f6465d", wickUpColor: "#14d18f", wickDownColor: "#f6465d", borderVisible: false });
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
  equitySeries = equityChart.addAreaSeries({ lineColor: "#4c8dff", topColor: "rgba(76,141,255,.28)", bottomColor: "rgba(76,141,255,0)", lineWidth: 2, priceLineVisible: false });
  new ResizeObserver(() => {
    candleChart.applyOptions({ width: $("#candleChart").clientWidth, height: $("#candleChart").clientHeight });
    equityChart.applyOptions({ width: $("#equityChart").clientWidth, height: $("#equityChart").clientHeight });
  }).observe($(".chart-panel"));
}

async function loadCandles() {
  const r = await fetch(`/api/candles?symbol=${encodeURIComponent(curSymbol)}&tf=${curTF}`).then((r) => r.json()).catch(() => null);
  if (!r || r.error || !r.candles?.length) return;
  candleSeries.setData(r.candles.map((c) => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c })));
  volSeries.setData(r.candles.map((c) => ({ time: c.t, value: c.v, color: c.c >= c.o ? "rgba(20,209,143,.35)" : "rgba(246,70,93,.35)" })));
  // trade markers on chart
  try {
    const { trades } = await fetch("/api/trades").then((x) => x.json());
    const marks = (trades || []).filter((t) => t.symbol === curSymbol).map((t) => ({
      time: Math.floor(new Date(t.ts).getTime() / 1000),
      position: t.action === "BUY" || t.action === "COVER" ? "belowBar" : "aboveBar",
      color: t.action === "BUY" ? "#14d18f" : t.action === "TAKE_PROFIT" ? "#f0b90b" : "#f6465d",
      shape: t.action === "BUY" || t.action === "COVER" ? "arrowUp" : "arrowDown",
      text: t.action,
    })).sort((a, b) => a.time - b.time);
    candleSeries.setMarkers(marks);
  } catch {}
  candleChart.timeScale().fitContent();
}
async function loadEquity() {
  const { curve } = await fetch("/api/equity").then((r) => r.json()).catch(() => ({ curve: [] }));
  if (!curve?.length) { equitySeries.setData([{ time: Math.floor(Date.now() / 1000), value: 10000 }]); return; }
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
function renderStatus(s) {
  lastStatus = s;
  $("#kEquity").textContent = fmt$(s.equity);
  $("#kEquitySub").textContent = "cash " + fmt$(s.cash);
  $("#kPnl").textContent = fmt$(s.pnlTotal);
  $("#kPnl").className = "kpi-val " + (s.pnlTotal > 0 ? "pos" : s.pnlTotal < 0 ? "neg" : "");
  $("#kPnlPct").textContent = fmtPct(s.pnlPct) + " all-time";
  const depPct = s.equity > 0 ? (s.deployedUsd || 0) / s.equity * 100 : 0;
  $("#kDep").textContent = fmt$(s.deployedUsd || 0, 0);
  $("#kDepPct").textContent = depPct.toFixed(0) + "% of equity";
  $("#kOpen").innerHTML = `${s.openCount}<span class="dim">/${s.risk?.maxOpenPositions ?? 4}</span>`;
  $("#kWin").textContent = s.stats.closedCount ? s.stats.winRate.toFixed(0) + "%" : "—";
  $("#kClosed").textContent = s.stats.closedCount + " closed";
  $("#kDD").textContent = (s.stats.maxDrawdownPct || 0).toFixed(2) + "%";
  $("#kDDSub").textContent = "from " + (s.stats.equityPeak ? fmt$(s.stats.equityPeak, 0) : "peak");
  $("#exchangeTag").textContent = s.exchange;
  const on = s.agent.running;
  $("#agentDot").className = "dot" + (on ? " on" : "");
  $("#agentState").textContent = on ? "AGENT LIVE" : "AGENT OFF";
  $("#btnStart").disabled = on; $("#btnStop").disabled = !on;
  $("#liveBadge").className = "live-badge" + (on ? "" : " off");
  $("#liveBadge").textContent = on ? "● live" : "○ idle";
  if (s.lastCycle) {
    const next = new Date(new Date(s.lastCycle).getTime() + (s.loopIntervalMin || 15) * 60000);
    $("#kLast").textContent = "last " + ago(s.lastCycle);
    const tick = () => { const ms = next - Date.now(); $("#kNext").textContent = ms > 0 ? `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}` : "running…"; };
    if (!window._nt) window._nt = setInterval(tick, 1000); tick();
  }
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
      `<span class="score-dial" title="signal score">${dial}</span>`,
      a.position ? `<span class="bdg ${a.position.side === "short" ? "sh" : "pos-b"}">${a.position.side === "short" ? "SHORT" : "LONG"}</span>` : "",
      a.volSpike > 2 ? `<span class="bdg neu">×${a.volSpike.toFixed(1)}v</span>` : "",
    ].join("");
      const d = a.liquidity?.liquidityUsd ?? a.liquidityUsd;
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
  $("#posCount").textContent = list.length + " open";
  if (!list.length) { $("#posRows").innerHTML = `<div class="empty">No open positions.</div>`; return; }
  $("#posRows").innerHTML = list.map((p) => {
    const mark = p.markPrice ?? p.entry_price, d = p.side === "short" ? -1 : 1;
    const unr = d * (mark - p.entry_price) * p.qty_open;
    const pc = d * (mark - p.entry_price) / p.entry_price * 100;
    const lo = p.side === "short" ? p.tp2_price : p.stop_price;
    const hi = p.side === "short" ? p.stop_price : p.tp2_price;
    const pct = hi > lo ? Math.max(0, Math.min(100, (mark - lo) / (hi - lo) * 100)) : 50;
    return `<div class="pos-card ${p.side}">
      <div class="pos-top"><span class="pos-sym">${p.symbol}</span><span class="pos-side ${p.side}">${p.side.toUpperCase()}</span><span class="pos-pnl ${unr >= 0 ? "pos" : "neg"}">${unr >= 0 ? "+" : ""}${fmt$(unr)} <span class="dim">${pc.toFixed(1)}%</span></span></div>
      <div class="pos-meta"><span>qty <b>${p.qty_open.toFixed(5)}</b></span><span>entry <b>${fmtN(p.entry_price, 4)}</b></span><span>mark <b>${fmtN(mark, 4)}</b></span><span>size <b>${fmt$(p.size_usd, 0)}</b></span><span>age <b>${agoRel(p.opened_at)}</b></span></div>
      <div class="slbar"><div class="slmark" style="left:${pct}%"></div></div>
      <div class="pos-lv"><span>SL ${fmtN(p.stop_price, 4)}</span>${p.trail_active ? '<span class="trail-tag">⟲ TRAILING</span>' : ""}<span>TP1 ${fmtN(p.tp1_price, 4)}</span><span>TP2 ${fmtN(p.tp2_price, 4)}</span></div></div>`;
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
    html += `<div class="sig">
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
        <div class="sig-reason">no decision recorded yet — start the agent or run a cycle</div>
      </div>
    </div>`;
  }
  $("#feedRows").innerHTML = html || `<div class="f-feed-empty"><div style="font-size:22px">◌</div><div>Waiting for the first cycle…</div><div style="font-style:normal;font-size:10.5px">press <b>C</b> or the ⟳ Cycle button</div></div>`;
}

function renderTrades(list) {
  // toast new fills
  for (const t of list) {
    if (!seenTrades.has(t.id)) {
      seenTrades.add(t.id);
      if (seenTrades.size > 1) toast(`${t.action} ${t.symbol} @${fmtN(t.price, 4)}${t.pnl_usd != null ? " · " + fmt$(t.pnl_usd) : ""}`, t.action === "BUY" ? "buy" : t.action === "SELL" || t.action === "STOP" || t.action === "COVER" ? "sell" : "");
    }
  }
  if (!list.length) { $("#pTradeBody").innerHTML = `<tr><td colspan="10" class="empty">no fills</td></tr>`; return; }
  $("#pTradeBody").innerHTML = list.map((t) =>
    `<tr><td>${ago(t.ts)}</td><td>${t.symbol}</td><td class="side-${t.action}">${t.action}</td><td>${t.side || "long"}</td>
      <td>${t.qty.toFixed(5)}</td><td>${fmtN(t.price, 4)}</td><td>${fmt$(t.value_usd)}</td><td>${fmt$(t.fee_usd || 0)}</td>
      <td class="${t.pnl_usd > 0 ? "pos" : t.pnl_usd < 0 ? "neg" : ""}">${t.pnl_usd != null ? fmt$(t.pnl_usd) : "—"}</td>
      <td class="rsn">${t.reason || ""}</td></tr>`).join("");
}

function renderLogs(list) { $("#logBox").textContent = list.length ? list.join("\n") : "agent not started."; $("#logBox").scrollTop = $("#logBox").scrollHeight; }

/* ── portfolio page ── */
function renderPortfolio(st, pos, trades) {
  $("#pEquity").textContent = fmt$(st.equity);
  $("#pCash").textContent = fmt$(st.cash);
  $("#pDeployed").textContent = fmt$(st.deployedUsd || 0);
  const unr = pos.reduce((s, p) => s + (p.unrealized || 0), 0);
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
  const alloc = lastAssets.map((a, i) => ({ sym: a.symbol, v: a.position ? a.position.sizeUsd : 0, c: COLORS[i % COLORS.length] })).filter((x) => x.v > 0);
  const cash = st.cash;
  const tot = st.equity || 1;
  let html = "";
  for (const a of alloc) html += `<div class="alloc-row"><div class="alloc-top"><span>${a.sym}</span><span>${(a.v / tot * 100).toFixed(1)}% · ${fmt$(a.v, 0)}</span></div><div class="alloc-bar"><div class="alloc-fill" style="width:${(a.v / tot * 100).toFixed(1)}%;background:${a.c}"></div></div></div>`;
  html += `<div class="alloc-row"><div class="alloc-top"><span>CASH</span><span>${(cash / tot * 100).toFixed(1)}% · ${fmt$(cash, 0)}</span></div><div class="alloc-bar"><div class="alloc-fill" style="width:${(cash / tot * 100).toFixed(1)}%;background:#56637a"></div></div></div>`;
  $("#allocBars").innerHTML = html;

  // positions table
  $("#pPosCount").textContent = pos.length + " open";
  $("#pPosBody").innerHTML = pos.length ? pos.map((p) => {
    const mark = p.markPrice ?? p.entry_price, d = p.side === "short" ? -1 : 1;
    const unr = d * (mark - p.entry_price) * p.qty_open, pc = d * (mark - p.entry_price) / p.entry_price * 100;
    return `<tr><td>${p.symbol}</td><td class="side-${p.side === "short" ? "SHORT" : "LONG"}">${p.side.toUpperCase()}</td>
      <td>${p.qty_open.toFixed(5)}</td><td>${fmtN(p.entry_price, 4)}</td><td>${fmtN(mark, 4)}</td><td>${fmt$(mark * p.qty_open)}</td>
      <td class="${unr >= 0 ? "pos" : "neg"}">${fmt$(unr)}</td><td class="${pc >= 0 ? "pos" : "neg"}">${pc.toFixed(2)}%</td>
      <td>${fmtN(p.stop_price, 4)}</td><td>${fmtN(p.tp1_price, 4)}</td><td>${fmtN(p.tp2_price, 4)}</td>
      <td>${p.trail_active ? '<span class="trail-tag">ON</span>' : "—"}</td><td>${agoRel(p.opened_at)}</td></tr>`;
  }).join("") : `<tr><td colspan="13" class="empty">none</td></tr>`;
}

/* ── tabs ── */
$$(".tab").forEach((t) => t.onclick = () => {
  $$(".tab").forEach((x) => x.classList.toggle("active", x === t));
  $$(".page").forEach((page) => page.classList.toggle("hidden", page.id !== `page-${t.dataset.page}`));
  $(".app").classList.toggle("adaptive-view", t.dataset.page === "adaptive");
});

/* ── poll ── */
async function tick() {
  try {
    const [st, as, ps, ds, ts, lg] = await Promise.all([
      fetch("/api/status").then((r) => r.json()),
      fetch("/api/assets").then((r) => r.json()),
      fetch("/api/positions").then((r) => r.json()),
      fetch("/api/decisions").then((r) => r.json()),
      fetch("/api/trades").then((r) => r.json()),
      fetch("/api/logs").then((r) => r.json()),
    ]);
    renderStatus(st); renderAssets(as.assets || []); renderPositions(ps.positions || []);
    renderFeed(ds.decisions || []); renderTrades(ts.trades || []); renderLogs(lg.logs || []);
    renderPortfolio(st, ps.positions || [], ts.trades || []);
  } catch (e) {}
}

$("#btnStart").onclick = () => fetch("/api/agent/start", { method: "POST" }).then(tick);
$("#btnStop").onclick = () => fetch("/api/agent/stop", { method: "POST" }).then(tick);
$("#btnOnce").onclick = () => fetch("/api/agent/run-once", { method: "POST" }).then((r) => r.json()).then((x) => toast(x.ok ? "cycle started" : x.msg || "busy")).then(tick);
$("#btnReset").onclick = async () => {
  if (!confirm("Reset ledger to $10,000 and wipe all history?")) return;
  await fetch("/api/agent/stop", { method: "POST" });
  await fetch("/api/reset", { method: "POST" });
  toast("ledger reset"); tick();
};
$$(".tf-btn").forEach((b) => b.onclick = () => { $$(".tf-btn").forEach((x) => x.classList.toggle("active", x === b)); curTF = b.dataset.tf; loadCandles(); });
document.getElementById("watchFilter").addEventListener("input", () => renderAssets(lastAssets));

/* keyboard shortcuts: 1-5 = pick asset, S = start/stop, C = run cycle, T = toggle page */
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  const k = e.key;
  if ($(".app").classList.contains("adaptive-view") && k.toLowerCase() !== "t") return;
  if (/^[1-5]$/.test(k) && lastAssets[k - 1]) { curSymbol = lastAssets[k - 1].symbol; $("#chartSym").textContent = curSymbol; renderAssets(lastAssets); loadCandles(); }
  else if (k === "s" || k === "S") fetch(lastStatus?.agent?.running ? "/api/agent/stop" : "/api/agent/start", { method: "POST" }).then(tick);
  else if (k === "c" || k === "C") fetch("/api/agent/run-once", { method: "POST" }).then(tick);
  else if (k === "t" || k === "T") { const d = $("#page-dashboard").classList.contains("hidden"); $$(".tab")[d ? 0 : 1].click(); }
});

initCharts(); tick(); loadCandles(); loadEquity();
setInterval(tick, 4000); setInterval(loadEquity, 20000); setInterval(loadCandles, 30000);
setInterval(() => { $("#clock").textContent = new Date().toLocaleString("en-GB"); }, 1000);
