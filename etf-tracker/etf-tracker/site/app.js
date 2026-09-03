/* app.js — 汇金证金 ETF 持仓追踪（复刻验证版）
 * 架构验证目标：浏览器只做 fetch 静态 JSON + 渲染，零后端依赖。
 */
"use strict";

/* ---------- 全局状态 ---------- */
const state = {
  universe: [],
  groups: [],
  byCode: new Map(),
  currentCode: null,
  cache: new Map(),        // code -> payload
  range: "all",
  charts: { main: null, turnover: null, units: null },
  dates: [],
};

const $ = (id) => document.getElementById(id);
const UP = () => getCSS("--up");
const DOWN = () => getCSS("--down");
const MUTED = () => getCSS("--muted");
const INK = () => getCSS("--ink");
const LINE = () => getCSS("--line");
const BRAND = () => getCSS("--brand");

function getCSS(v) {
  return getComputedStyle(document.documentElement).getPropertyValue(v).trim();
}
const fmtPct = (v) => (v == null ? "—" : (v > 0 ? "+" : "") + v.toFixed(2) + "%");
const fmtNum = (v, d = 2) => (v == null ? "—" : Number(v).toLocaleString("zh-CN", { maximumFractionDigits: d }));
const cls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");

/* ---------- 启动 ---------- */
document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindTheme();
  bindRangeButtons();
  window.addEventListener("hashchange", onHashChange);

  showLoading(true, "加载清单数据…");
  try {
    const [universe, groups] = await Promise.all([
      fetchJSON("data/universe.json"),
      fetchJSON("data/groups.json"),
    ]);
    state.universe = universe;
    state.groups = groups;
    state.byCode = new Map(universe.map((u) => [u.code, u]));
    $("railCount").textContent = `${universe.length} 只`;
    renderDataSourceBadge();
    renderEtfList();
    const fromHash = location.hash.replace("#", "");
    const initial = state.byCode.has(fromHash) ? fromHash
      : (universe.find((u) => u.code === "510310") || universe[0]).code;
    await selectEtf(initial);
  } catch (err) {
    $("metaLine").textContent = "数据加载失败：" + err.message + "（请通过 http 服务访问，勿直接双击打开）";
  } finally {
    showLoading(false);
  }
}

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

function showLoading(on, text) {
  $("loadingMask").hidden = !on;
  if (text) $("loadingText").textContent = text;
}

/* ---------- 主题 ---------- */
function bindTheme() {
  const saved = localStorage.getItem("etf_theme") || "light";
  applyTheme(saved);
  $("themeToggleBtn").addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });
}
function applyTheme(mode) {
  document.documentElement.dataset.theme = mode;
  localStorage.setItem("etf_theme", mode);
  $("themeToggleBtn").textContent = mode === "dark" ? "日间" : "夜间";
  // 重绘图表以应用新配色
  const code = state.currentCode;
  if (code && state.cache.has(code)) {
    const p = state.cache.get(code);
    if (state.charts.main) renderCharts(p);
  }
}

/* ---------- 左侧清单 ---------- */
function renderEtfList() {
  const box = $("etfList");
  box.innerHTML = "";
  for (const g of state.groups) {
    const t = document.createElement("div");
    t.className = "group-title";
    t.textContent = g.group;
    box.appendChild(t);
    for (const u of g.etfs) {
      const btn = document.createElement("button");
      btn.className = "etf-item";
      btn.dataset.code = u.code;
      const demoCls = u.disclosure_is_demo ? " demo" : "";
      btn.innerHTML = `
        <span class="nm">${u.name}</span>
        <span class="rt${demoCls}">${u.latest_disclosure_ratio_pct != null ? u.latest_disclosure_ratio_pct.toFixed(2) + "%" : "—"}</span>
        <span class="cd">${u.code}.${u.exchange}</span>`;
      btn.addEventListener("click", () => { location.hash = u.code; });
      box.appendChild(btn);
    }
  }
  markActiveItem();
}
function markActiveItem() {
  document.querySelectorAll(".etf-item").forEach((el) => {
    el.classList.toggle("is-active", el.dataset.code === state.currentCode);
  });
}

/* ---------- 路由与数据加载 ---------- */
function onHashChange() {
  const code = location.hash.replace("#", "");
  if (state.byCode.has(code) && code !== state.currentCode) selectEtf(code);
}

async function selectEtf(code) {
  state.currentCode = code;
  markActiveItem();
  showLoading(true, `加载 ${code} 序列…`);
  try {
    let payload = state.cache.get(code);
    if (!payload) {
      payload = await fetchJSON(`data/etfs/${code}.json`);
      state.cache.set(code, payload);
    }
    renderHeader(payload);
    renderMetrics(payload);
    renderStatsStrip(payload);
    prepareCharts(payload);
    renderCharts(payload);
    renderCompareTable(payload);
  } catch (err) {
    $("metaLine").textContent = "加载失败：" + err.message;
  } finally {
    showLoading(false);
  }
}

/* ---------- 头部与指标卡 ---------- */
function renderHeader(p) {
  const m = p.meta;
  $("etfTitle").textContent = `${m.name} ${m.code}`;
  $("groupTag").textContent = m.display_group;
  $("demoTag").hidden = !m.disclosure_is_demo;
  const srcText = { "eastmoney(qfq)": "东方财富·前复权", "sina(raw)": "新浪财经·未复权", "demo": "本地演示数据" }[m.data_source] || m.data_source;
  $("metaLine").textContent =
    `数据截至 ${m.latest_series_date} · 行情口径：${srcText} · 数据生成：${m.data_refreshed_at}`;
  $("turnoverSub").textContent = m.data_source === "sina(raw)" ? "新浪源口径（百万元成交额换算亿元）" : "";
}

function renderMetrics(p) {
  const m = p.meta;
  const prev = p.series.length > 1 ? p.series[p.series.length - 2].qfq_close : null;
  const chg = prev ? (m.latest_qfq_price / prev - 1) * 100 : null;
  const cards = [
    { k: "最新日期", v: m.latest_series_date, s: "", plain: true },
    { k: "收盘价（未复权）", v: fmtNum(m.latest_qfq_price, 3), s: chg == null ? "" : `较前日 ${fmtPct(chg)}`, c: cls(chg) },
    { k: "日成交额", v: fmtNum(m.latest_qfq_turnover_est_yi) + " 亿", s: "" },
    { k: "基金份额", v: m.latest_units_yi != null ? fmtNum(m.latest_units_yi) + " 亿份" : "暂无数据", s: m.latest_units_yi == null ? "接口未提供日度份额" : "" },
    { k: "披露持仓比例", v: m.latest_disclosure_ratio_pct != null ? m.latest_disclosure_ratio_pct.toFixed(2) + "%" : "—", s: m.latest_disclosure_report_date ? `披露日 ${m.latest_disclosure_report_date}${m.disclosure_is_demo ? "（演示值）" : ""}` : "" },
    { k: "披露持仓金额", v: m.latest_disclosure_value_yi != null ? fmtNum(m.latest_disclosure_value_yi, 2) + " 亿" : "—", s: m.disclosure_is_demo ? "演示口径" : "" },
  ];
  $("metricCards").innerHTML = cards.map((c) => `
    <div class="card">
      <div class="k">${c.k}</div>
      <div class="v ${c.c || ""}">${c.v}</div>
      <div class="s">${c.s || "&nbsp;"}</div>
    </div>`).join("");
}

function renderStatsStrip(p) {
  const m = p.meta;
  const names = { week: "近一周", month: "近一月", quarter: "近三月" };
  const rows = ["week", "month", "quarter"].map((k) => {
    const s = m.stats[k];
    if (!s) return "";
    const sub = s.net_amount_est_yi != null
      ? `<div class="row"><span>净申赎金额</span><span class="${cls(s.net_amount_est_yi)}">${fmtNum(s.net_amount_est_yi)} 亿</span></div>`
      : "";
    return `
      <div class="stat-box">
        <div class="h">${names[k]}（${s.days} 个交易日）</div>
        <div class="row"><span>价格</span><span class="${cls(s.price_pct)}">${fmtPct(s.price_pct)}</span></div>
        <div class="row"><span>成交额合计</span><span>${fmtNum(s.turnover_yi)} 亿</span></div>
        ${sub}
      </div>`;
  }).join("");
  $("statsStrip").innerHTML = rows;
}

/* ---------- 图表 ---------- */
const RANGES = { "1m": 21, "3m": 63, "1y": 244, all: Infinity };

function prepareCharts(p) {
  state.dates = p.series.map((r) => r.date);
  const hasUnits = p.series.some((r) => r.total_units_yi != null);
  $("unitsCard").hidden = !hasUnits;
  if (!state.charts.main) {
    state.charts.main = echarts.init($("chartMain"));
    state.charts.turnover = echarts.init($("chartTurnover"));
    state.charts.units = hasUnits ? echarts.init($("chartUnits")) : null;
    echarts.connect("etf-group");
    Object.values(state.charts).forEach((c) => c && c.group === undefined);
    [state.charts.main, state.charts.turnover, state.charts.units].forEach((c) => { if (c) c.group = "etf-group"; });
    window.addEventListener("resize", () => Object.values(state.charts).forEach((c) => c && c.resize()));
  } else if (state.charts.units && !hasUnits) {
    state.charts.units.dispose();
    state.charts.units = null;
  } else if (!state.charts.units && hasUnits) {
    state.charts.units = echarts.init($("chartUnits"));
    state.charts.units.group = "etf-group";
  }
  $("unitsCard").hidden = !hasUnits;
}

function applyRangeZoom() {
  const w = RANGES[state.range];
  const n = state.dates.length;
  const startIdx = w >= n ? 0 : n - w;
  const dz = [{ startValue: state.dates[startIdx], endValue: state.dates[n - 1] }];
  const opts = {};
  if (state.charts.main) opts.main = dz;
  if (state.charts.turnover) opts.turnover = dz;
  if (state.charts.units) opts.units = dz;
  if (opts.main) state.charts.main.setOption({ dataZoom: opts.main });
  if (opts.turnover) state.charts.turnover.setOption({ dataZoom: opts.turnover });
  if (opts.units) state.charts.units.setOption({ dataZoom: opts.units });
}

function disclosureMap(p) {
  const map = new Map();
  for (const d of p.disclosures) map.set(d.report_date, d);
  return map;
}

function renderCharts(p) {
  const discByDate = disclosureMap(p);
  const m = p.meta;
  const demoMark = m.disclosure_is_demo ? "（演示值）" : "";

  /* ---- 主图 ---- */
  const priceSeries = {
    name: "收盘价", type: "line", xAxisIndex: 0, yAxisIndex: 0,
    data: p.series.map((r) => r.qfq_close),
    showSymbol: false, smooth: false, lineStyle: { width: 1.6, color: BRAND() },
    areaStyle: {
      color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
        { offset: 0, color: BRAND() + "55" }, { offset: 1, color: BRAND() + "05" }]),
    },
    z: 2,
  };
  const stepData = p.series.map((r) => {
    const d = discByDate.get(r.date);
    return d ? d.combined_ratio_pct : null;
  });
  // 阶梯填充：从首个披露日起延续到最后
  const firstDiscIdx = stepData.findIndex((v) => v != null);
  let carry = null;
  const stepFilled = stepData.map((v, i) => {
    if (v != null) carry = v;
    return i >= firstDiscIdx ? carry : null;
  });
  const ratioSeries = {
    name: "披露比例", type: "line", xAxisIndex: 0, yAxisIndex: 1,
    data: stepFilled, step: "end", showSymbol: false,
    lineStyle: { width: 1.4, type: "dashed", color: UP() },
    itemStyle: { color: UP() }, z: 3,
  };
  const points = p.disclosures.map((d) => {
    const i = state.dates.indexOf(d.report_date);
    return i >= 0 ? [state.dates[i], d.combined_ratio_pct] : null;
  }).filter(Boolean);
  const pointSeries = {
    name: "披露点", type: "scatter", xAxisIndex: 0, yAxisIndex: 1,
    data: points, symbolSize: 9, itemStyle: { color: UP(), borderColor: "#fff", borderWidth: 1 },
    z: 4,
  };
  state.charts.main.setOption({
    animation: false,
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    tooltip: {
      trigger: "axis", backgroundColor: INK() === "#e7eaf2" ? "#1a1f2b" : "#fff",
      borderColor: LINE(), textStyle: { color: INK(), fontSize: 12 },
      formatter: (params) => {
        const date = params[0].axisValue;
        const price = params.find((x) => x.seriesName === "收盘价");
        const ratio = params.find((x) => x.seriesName === "披露比例");
        const d = discByDate.get(date);
        let html = `<b>${date}</b><br/>收盘价：${price ? price.value : "—"}`;
        if (ratio && ratio.value != null) html += `<br/>披露比例：${ratio.value.toFixed(2)}%${demoMark}`;
        if (d) html += `<br/><span style="color:${UP()}">◈ 披露点</span> 金额：${fmtNum(d.combined_value_yi)} 亿${d.est ? demoMark : ""}`;
        return html;
      },
    },
    grid: { left: 56, right: 56, top: 18, bottom: 64 },
    xAxis: {
      type: "category", data: state.dates, boundaryGap: false,
      axisLine: { lineStyle: { color: LINE() } }, axisLabel: { color: MUTED() },
    },
    yAxis: [
      { type: "value", scale: true, axisLabel: { color: MUTED() }, splitLine: { lineStyle: { color: LINE() } } },
      { type: "value", min: 0, max: 100, position: "right",
        axisLabel: { color: MUTED(), formatter: "{value}%" }, splitLine: { show: false } },
    ],
    dataZoom: [
      { type: "inside", xAxisIndex: 0, filterMode: "none" },
      { type: "slider", xAxisIndex: 0, height: 20, bottom: 12, borderColor: LINE(),
        fillerColor: BRAND() + "22", handleStyle: { color: BRAND() }, textStyle: { color: MUTED() } },
    ],
    series: [priceSeries, ratioSeries, pointSeries],
  }, true);

  /* ---- 成交额 ---- */
  state.charts.turnover.setOption({
    animation: false,
    tooltip: { trigger: "axis", textStyle: { color: INK(), fontSize: 12 },
      backgroundColor: INK() === "#e7eaf2" ? "#1a1f2b" : "#fff", borderColor: LINE(),
      formatter: (ps) => `<b>${ps[0].axisValue}</b><br/>成交额：${fmtNum(ps[0].value)} 亿` },
    grid: { left: 56, right: 20, top: 10, bottom: 24 },
    xAxis: { type: "category", data: state.dates, axisLine: { lineStyle: { color: LINE() } },
      axisLabel: { show: false } },
    yAxis: { type: "value", axisLabel: { color: MUTED() }, splitLine: { lineStyle: { color: LINE() } } },
    dataZoom: [{ type: "inside", xAxisIndex: 0, filterMode: "none" }],
    series: [{
      name: "成交额", type: "bar", data: p.series.map((r) => r.turnover_yi),
      itemStyle: { color: BRAND() + "99" }, barMaxWidth: 6,
    }],
  }, true);

  /* ---- 份额 + 申赎（仅有份额数据时） ---- */
  if (state.charts.units) {
    const units = p.series.map((r) => r.total_units_yi);
    const deltas = p.series.map((r) => r.delta_units_yi);
    state.charts.units.setOption({
      animation: false,
      tooltip: { trigger: "axis", textStyle: { color: INK(), fontSize: 12 },
        backgroundColor: INK() === "#e7eaf2" ? "#1a1f2b" : "#fff", borderColor: LINE() },
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      grid: [{ left: 56, right: 20, top: 10, height: "52%" },
             { left: 56, right: 20, top: "68%", bottom: 24 }],
      xAxis: [
        { type: "category", data: state.dates, gridIndex: 0, axisLabel: { show: false }, axisLine: { lineStyle: { color: LINE() } } },
        { type: "category", data: state.dates, gridIndex: 1, axisLabel: { color: MUTED() }, axisLine: { lineStyle: { color: LINE() } } },
      ],
      yAxis: [
        { type: "value", scale: true, gridIndex: 0, axisLabel: { color: MUTED() }, splitLine: { lineStyle: { color: LINE() } }, name: "份额(亿份)", nameTextStyle: { color: MUTED() } },
        { type: "value", gridIndex: 1, axisLabel: { color: MUTED() }, splitLine: { show: false }, name: "申赎(亿份)", nameTextStyle: { color: MUTED() } },
      ],
      dataZoom: [
        { type: "inside", xAxisIndex: [0, 1], filterMode: "none" },
      ],
      series: [
        { name: "份额", type: "line", xAxisIndex: 0, yAxisIndex: 0, data: units,
          showSymbol: false, lineStyle: { width: 1.5, color: BRAND() } },
        { name: "申赎份额", type: "bar", xAxisIndex: 1, yAxisIndex: 1, data: deltas,
          itemStyle: { color: (x) => (x.value >= 0 ? UP() : DOWN()) }, barMaxWidth: 5 },
      ],
    }, true);
  }
  applyRangeZoom();
}

/* ---------- 区间按钮 ---------- */
function bindRangeButtons() {
  document.querySelectorAll(".range-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".range-btn").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      state.range = btn.dataset.range;
      applyRangeZoom();
    });
  });
}

/* ---------- 组内对比表 ---------- */
function renderCompareTable(p) {
  const group = state.groups.find((g) => g.group === p.meta.display_group);
  if (!group) return;
  $("compareTitle").textContent = `${group.group} · 组内对比（${group.etf_count} 只）`;
  const hasNet = group.etfs.some((u) => u.stats?.month?.net_amount_est_yi != null);
  const head = `<tr>
    <th>标的</th><th>披露比例</th><th>披露金额(亿)</th>
    <th>近1周</th><th>近1月</th><th>近3月</th>
    <th>近1周成交额(亿)</th>${hasNet ? "<th>近1月净申赎(亿)</th>" : ""}<th>最新收盘</th></tr>`;
  const body = group.etfs.map((u) => {
    const st = u.stats || {};
    const cur = u.code === state.currentCode;
    const demo = u.disclosure_is_demo ? '<span class="tbl-tag">演示</span>' : "";
    return `<tr class="${cur ? "is-current" : ""}">
      <td>${u.name} <span style="color:var(--muted);font-size:11px">${u.code}</span>${demo}</td>
      <td>${u.latest_disclosure_ratio_pct != null ? u.latest_disclosure_ratio_pct.toFixed(2) + "%" : "—"}</td>
      <td>${fmtNum(u.latest_disclosure_value_yi)}</td>
      <td class="${cls(st.week?.price_pct)}">${fmtPct(st.week?.price_pct)}</td>
      <td class="${cls(st.month?.price_pct)}">${fmtPct(st.month?.price_pct)}</td>
      <td class="${cls(st.quarter?.price_pct)}">${fmtPct(st.quarter?.price_pct)}</td>
      <td>${fmtNum(st.week?.turnover_yi)}</td>
      ${hasNet ? `<td class="${cls(st.month?.net_amount_est_yi)}">${fmtNum(st.month?.net_amount_est_yi)}</td>` : ""}
      <td></td>
    </tr>`;
  }).join("");
  $("compareTable").querySelector("thead").innerHTML = head;
  $("compareTable").querySelector("tbody").innerHTML = body.replace(/<td>\s*<\/td>$/, "<td></td>");
  // 补最新收盘列（从 universe 中无该字段——用 cache 中各标的最后价；仅当前标的已知，其余留待懒加载）
  fillLatestColumn(group);
}

async function fillLatestColumn(group) {
  const tds = document.querySelectorAll("#compareTable tbody tr td:last-child");
  const rows = Array.from(document.querySelectorAll("#compareTable tbody tr"));
  for (let i = 0; i < group.etfs.length; i++) {
    const u = group.etfs[i];
    try {
      let p = state.cache.get(u.code);
      if (!p) {
        p = await fetchJSON(`data/etfs/${u.code}.json`);
        state.cache.set(u.code, p);
      }
      const last = p.series[p.series.length - 1];
      rows[i].lastElementChild.textContent = fmtNum(last.qfq_close, 3);
    } catch { /* 忽略单个失败 */ }
  }
}

/* ---------- 数据源徽标 ---------- */
function renderDataSourceBadge() {
  const demoCount = state.universe.filter((u) => u.disclosure_is_demo).length;
  $("dataSourceBadge").textContent =
    `静态 JSON · ${state.universe.length} 只标的` + (demoCount ? ` · ${demoCount} 只披露为演示值` : "");
}
