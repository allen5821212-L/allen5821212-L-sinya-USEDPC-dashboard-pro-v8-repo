// 經營總覽：在庫與售出指標、庫齡分布、分類統計、滯銷清單、校正建議
import { fmtN, fmtPct, numOr, toISODate, addDaysISO, CATEGORY_LABELS } from "./pricing.js";
import {
  evaluateStock, inventorySummary, agingBuckets, soldSummary, categoryStats, staleList, ladderCalibration, residualCalibration
} from "./analytics.js";
import { $, $$, esc, delegate } from "./dom.js";

const MIN_SAMPLE = 5;

function tile(label, value, sub = "", go = null, tone = "") {
  const tag = go ? "button" : "div";
  return `<${tag} class="kpi ${tone}" ${go ? `type="button" data-go='${esc(JSON.stringify(go))}'` : ""}>
    <span class="kpi-label">${label}</span><span class="kpi-value">${value}</span>${sub ? `<span class="kpi-sub">${sub}</span>` : ""}</${tag}>`;
}
function agingChart(buckets) {
  const max = Math.max(1, ...buckets.map((b) => b.cost));
  const rows = buckets.map((b, i) => {
    const w = b.cost > 0 ? Math.max(1.5, (b.cost / max) * 68) : 0; // 留 32% 給數值標籤，避免被截掉
    const label = `${fmtN(b.cost)}・${b.count} 件`;
    return `<div class="bar-row">
      <span class="bar-label">${b.label}${b.min > 90 ? ` <span class="badge-mini">滯銷</span>` : ""}</span>
      <div class="bar-track">
        <div class="bar" style="width:${w}%" tabindex="0" data-i="${i}" aria-label="${esc(`${b.label}：${b.count} 件，在庫成本 ${fmtN(b.cost)} 元，建議售價合計 ${fmtN(b.suggested)} 元`)}"></div>
        <span class="bar-value">${label}</span>
      </div>
    </div>`;
  }).join("");
  const table = `<details class="table-view"><summary>以表格檢視</summary><table class="mini"><thead><tr><th>庫齡</th><th class="num">件數</th><th class="num">在庫成本</th><th class="num">建議售價合計</th></tr></thead>
    <tbody>${buckets.map((b) => `<tr><td>${b.label}</td><td class="num">${b.count}</td><td class="num">${fmtN(b.cost)}</td><td class="num">${fmtN(b.suggested)}</td></tr>`).join("")}</tbody></table></details>`;
  return `<div class="bar-chart" id="agingChart">${rows}</div><div class="viz-tip" id="vizTip" hidden></div>${table}`;
}
function calRow(label, n, actual, policy, fmt) {
  const small = n < MIN_SAMPLE;
  let hint = "—";
  if (n && actual !== null && policy !== null) {
    const d = actual - policy;
    hint = Math.abs(d) < 0.02 ? "接近現行設定" : d < 0 ? `實際比設定低 ${fmtPct(-d)}` : `實際比設定高 ${fmtPct(d)}`;
    if (small) hint += "（樣本不足）";
  }
  return `<tr class="${small ? "dim" : ""}"><td>${label}</td><td class="num">${n}</td><td class="num">${n ? fmt(actual) : "—"}</td><td class="num">${policy === null ? "—" : fmt(policy)}</td><td>${hint}</td></tr>`;
}

export function render(ctx) {
  const { items, policy } = ctx.state;
  const today = ctx.today();
  const evals = evaluateStock(items, policy, today);
  const inv = inventorySummary(evals);
  const days = ctx.state.periodDays;
  const from = days ? addDaysISO(today, -days) : null;
  const to = toISODate(today);
  const sold = soldSummary(items, from, to);
  const periodTxt = days ? `近 ${days} 天` : "全部";
  const cats = categoryStats(items, evals, from, to);
  const stale = staleList(evals).slice(0, 12);
  const lc = ladderCalibration(items, policy);
  const rc = residualCalibration(items, policy);
  const soldTotal = items.filter((x) => x.status === "sold").length;

  $("#ovContent").innerHTML = `
    <h2 class="sec-title">在庫</h2>
    <div class="kpis">
      ${tile("在庫件數", fmtN(inv.count), `平均庫齡 ${inv.avgDays === null ? "—" : Math.round(inv.avgDays) + " 天"}`, { status: "stock" })}
      ${tile("在庫成本", fmtN(inv.cost))}
      ${tile("建議售價合計", fmtN(inv.suggested), `預估毛利率 ${fmtPct(inv.margin)}`)}
      ${tile("庫齡超過 90 天", `${fmtN(inv.over90Count)} 件`, `成本 ${fmtN(inv.over90Cost)}`, { view: "over90" }, inv.over90Count ? "attn" : "")}
      ${tile("低於成本（需核准）", `${fmtN(inv.belowCostCount)} 件`, "", { view: "below" }, inv.belowCostCount ? "attn" : "")}
      ${tile("需重新標價", `${fmtN(inv.retagCount)} 件`, `差距 ≥ ${fmtPct(policy.retagThreshold, 0)} 或未標價`, { view: "retag" }, inv.retagCount ? "attn" : "")}
      ${tile("需處理 ⚠", `${fmtN(inv.warnCount)} 件`, "資料錯誤、收價偏高等", { view: "warn" })}
      ${tile("待補資料 ✎", `${fmtN(inv.todoCount)} 件`, "缺市價、市價過期、成色未評", { view: "todo" })}
    </div>

    <h2 class="sec-title">售出（${periodTxt}）</h2>
    <div class="kpis five">
      ${tile("售出件數", fmtN(sold.count), sold.belowCost ? `其中低於成本 ${sold.belowCost} 件` : "", { status: "sold" })}
      ${tile("營收", fmtN(sold.revenue))}
      ${tile("實際毛利率", fmtPct(sold.margin), `毛利 ${fmtN(sold.profit)}`)}
      ${tile("平均周轉天數", sold.avgDaysToSell === null ? "—" : `${Math.round(sold.avgDaysToSell)} 天`, "回收日 → 售出日")}
      ${tile("成交價 vs 標價", sold.avgVsList === null ? "—" : `${sold.avgVsList >= 0 ? "+" : ""}${fmtPct(sold.avgVsList)}`, "平均議價幅度")}
    </div>
    ${soldTotal === 0 ? `<p class="callout">還沒有任何售出紀錄。商品賣出時在清單按「售出」並填成交價，累積一段時間後，下方的「校正建議」就能用實際成交回推降價階梯與殘值係數。</p>` : ""}

    <div class="grid two">
      <section class="card">
        <h3 class="card-title">在庫成本・依庫齡</h3>
        ${inv.count ? agingChart(agingBuckets(evals)) : `<p class="muted">沒有在庫商品</p>`}
      </section>
      <section class="card">
        <h3 class="card-title">分類</h3>
        <div class="table-wrap plain"><table class="mini">
          <thead><tr><th>分類</th><th class="num">在庫</th><th class="num">在庫成本</th><th class="num">平均庫齡</th><th class="num">&gt;90 天</th><th class="num">售出（${periodTxt}）</th><th class="num">實際毛利率</th><th class="num">平均周轉</th></tr></thead>
          <tbody>${cats.map((c) => `<tr><td>${CATEGORY_LABELS[c.category]}</td><td class="num">${c.stockCount}</td><td class="num">${fmtN(c.stockCost)}</td>
            <td class="num">${c.avgDays === null ? "—" : Math.round(c.avgDays) + " 天"}</td><td class="num">${c.over90 || ""}</td><td class="num">${c.soldCount || ""}</td>
            <td class="num">${fmtPct(c.soldMargin)}</td><td class="num">${c.avgDaysToSell === null ? "—" : Math.round(c.avgDaysToSell) + " 天"}</td></tr>`).join("")}</tbody>
        </table></div>
      </section>
    </div>

    <section class="card">
      <h3 class="card-title">滯銷清單（庫齡超過 90 天，最久的 12 筆）</h3>
      ${stale.length ? `<div class="table-wrap plain"><table class="mini clickable">
        <thead><tr><th>編號</th><th>名稱</th><th class="num">庫齡</th><th class="num">成本</th><th class="num">建議售價</th><th class="num">標價</th><th>依據</th><th>狀態</th></tr></thead>
        <tbody>${stale.map(({ item, r, retag }) => `<tr data-open="${esc(item.id)}" tabindex="0"><td class="mono">${esc(item.sku)}</td><td>${esc(item.name)}</td><td class="num">${r.days} 天</td>
          <td class="num">${fmtN(numOr(item.cost, null))}</td><td class="num">${fmtN(r.price)}</td><td class="num">${fmtN(numOr(item.listPrice, null))}</td>
          <td>${r.mode === "market" ? "市價" : "成本加成"}</td><td>${r.warnings.some((w) => w.code === "below_cost") ? "⚠ 低於成本" : retag ? "🏷 需重新標價" : ""}</td></tr>`).join("")}</tbody>
      </table></div>` : `<p class="muted">沒有庫齡超過 90 天的商品。</p>`}
    </section>

    <section class="card">
      <h3 class="card-title">校正建議（依實際售出紀錄）</h3>
      <p class="muted small">樣本少於 ${MIN_SAMPLE} 筆的列僅供參考。調整請到「定價政策」，套用前可先看影響預覽。</p>
      <div class="grid two">
        <div>
          <h4>降價階梯：成交價相對錨定價</h4>
          <div class="table-wrap plain"><table class="mini"><thead><tr><th>售出時庫齡</th><th class="num">樣本</th><th class="num">實際</th><th class="num">現行階梯</th><th>判讀</th></tr></thead>
            <tbody>${lc.map((g) => calRow(g.label, g.n, g.actual, g.policy, (v) => `${v >= 0 ? "+" : ""}${fmtPct(v)}`)).join("")}</tbody></table></div>
        </div>
        <div>
          <h4>殘值係數：成交價 ÷ 新品價</h4>
          <div class="table-wrap plain"><table class="mini"><thead><tr><th>機齡</th><th class="num">樣本</th><th class="num">實際</th><th class="num">現行係數</th><th>判讀</th></tr></thead>
            <tbody>${rc.map((g) => calRow(g.label, g.n, g.actual, g.policy, (v) => (v === null ? "—" : `×${(Math.round(v * 1000) / 1000)}`))).join("")}</tbody></table></div>
          <p class="muted small">需要商品有「新品價」與「購買日」才會納入。</p>
        </div>
      </div>
    </section>`;

  // 圖表提示（滑鼠與鍵盤）
  const tip = $("#vizTip");
  const buckets = inv.count ? agingBuckets(evals) : [];
  const show = (bar, x, y) => {
    const b = buckets[Number(bar.dataset.i)];
    tip.replaceChildren();
    const v = document.createElement("strong"); v.textContent = `在庫成本 ${fmtN(b.cost)}`;
    const l1 = document.createElement("span"); l1.textContent = `${b.label}・${b.count} 件`;
    const l2 = document.createElement("span"); l2.textContent = `建議售價合計 ${fmtN(b.suggested)}`;
    tip.append(v, l1, l2);
    tip.hidden = false;
    const box = $("#agingChart").getBoundingClientRect();
    tip.style.left = `${Math.min(x - box.left + 12, box.width - 180)}px`;
    tip.style.top = `${y - box.top + 12}px`;
  };
  for (const bar of $$("#agingChart .bar")) {
    bar.addEventListener("pointermove", (e) => show(bar, e.clientX, e.clientY));
    bar.addEventListener("pointerleave", () => { tip.hidden = true; });
    bar.addEventListener("focus", () => { const r = bar.getBoundingClientRect(); show(bar, r.right, r.top); });
    bar.addEventListener("blur", () => { tip.hidden = true; });
  }
}

export function init(ctx) {
  delegate($("#periodSeg"), "click", "button", (e, b) => {
    ctx.state.periodDays = Number(b.dataset.days);
    for (const x of $$("#periodSeg button")) x.classList.toggle("on", x === b);
    render(ctx);
  });
  delegate($("#ovContent"), "click", "[data-go]", (e, el) => ctx.goList(JSON.parse(el.dataset.go)));
  delegate($("#ovContent"), "click", "[data-open]", (e, el) => ctx.openItem(el.dataset.open));
  delegate($("#ovContent"), "keydown", "[data-open]", (e, el) => { if (e.key === "Enter") ctx.openItem(el.dataset.open); });
}
