// 查價作業：新增、篩選、清單、批次、商品明細（標價／售出）
import {
  computePrice, retagCheck, saleStats, fmtN, fmtPct, fmtFactor, numOr, isBlank, toISODate, daysBetweenISO,
  CATEGORY_LABELS, GRADES
} from "./pricing.js";
import { normalizeItem, nextSku, specSummary, duplicateSerials } from "./model.js";
import { tagListAoa, aoaToCSV } from "./io.js";
import { $, $$, esc, on, delegate, pctIn, pctOut, numIn, downloadBlob, stampForFile } from "./dom.js";

const PCT_RANGE = { margin: [-0.5, 0.89], marketAdj: [-0.9, 1] };

// ============================================================
// 欄位定義（明細表單）
// ============================================================
const FIELDS = [
  { k: "name", l: "名稱", span: 2 }, { k: "category", l: "分類", t: "cat" }, { k: "grade", l: "成色", t: "grade" },
  { k: "sku", l: "庫存編號" }, { k: "serial", l: "序號" }, { k: "specCpu", l: "CPU" }, { k: "specGpu", l: "GPU" },
  { k: "specRam", l: "記憶體" }, { k: "specSsd", l: "儲存" }, { k: "battery", l: "電池健康度（%）", t: "int" },
  { k: "warrantyMonths", l: "剩餘保固（月）", t: "int" },
  { k: "accessoriesComplete", l: "配件齊全", t: "bool" }, { k: "repair", l: "有維修紀錄", t: "bool" },
  { k: "repairNote", l: "維修備註", span: 2 },
  { k: "purchaseDate", l: "購買日（原購）", t: "date" }, { k: "date", l: "回收日", t: "date" },
  { k: "newPrice", l: "新品價", t: "money" }, { k: "cost", l: "成本", t: "money" },
  { k: "market", l: "參考市價（A 級）", t: "money" }, { k: "marketDate", l: "市價日期", t: "date" },
  { k: "marketSource", l: "市價來源", span: 2 },
  { k: "margin", l: "目標毛利率（%，無市價時用）", t: "pct" }, { k: "marketAdj", l: "單品加成（%，空白＝門市加成）", t: "pct" },
  { k: "listPrice", l: "目前標價", t: "money" }, { k: "listDate", l: "標價日", t: "date" },
  { k: "note", l: "備註", span: 4 }
];
const SOLD_FIELDS = [{ k: "soldDate", l: "售出日", t: "date" }, { k: "soldPrice", l: "成交價", t: "money" }];
const LOGGED = new Set(["sku", "category", "grade", "battery", "accessoriesComplete", "repair", "date", "cost", "market",
  "marketDate", "margin", "marketAdj", "listPrice", "soldDate", "soldPrice", "purchaseDate", "newPrice"]);

function fieldHtml(f, v, prefix = "") {
  const id = `${prefix}${f.k}`;
  const span = f.span ? ` span-${f.span}` : "";
  if (f.t === "bool") return `<label class="check${span}"><input type="checkbox" data-k="${f.k}" id="${id}" ${v ? "checked" : ""}/> ${f.l}</label>`;
  let input;
  if (f.t === "cat") input = `<select data-k="${f.k}" id="${id}">${Object.entries(CATEGORY_LABELS).map(([c, l]) => `<option value="${c}" ${v === c ? "selected" : ""}>${l}</option>`).join("")}</select>`;
  else if (f.t === "grade") input = `<select data-k="${f.k}" id="${id}"><option value="">未評</option>${GRADES.map((g) => `<option value="${g}" ${v === g ? "selected" : ""}>${g}</option>`).join("")}</select>`;
  else if (f.t === "date") input = `<input type="date" data-k="${f.k}" id="${id}" value="${esc(v)}"/>`;
  else if (f.t === "pct") input = `<input type="number" step="0.1" data-k="${f.k}" id="${id}" value="${esc(pctOut(v))}"/>`;
  else if (f.t === "money" || f.t === "int") input = `<input type="number" step="1" min="0" inputmode="numeric" data-k="${f.k}" id="${id}" value="${esc(v)}"/>`;
  else input = `<input type="text" data-k="${f.k}" id="${id}" value="${esc(v)}"/>`;
  return `<label class="field${span}" for="${id}">${f.l}${input}</label>`;
}
/** 讀表單欄位 → { value } 或 { error } */
function readField(f, el) {
  if (f.t === "bool") return { value: el.checked };
  const raw = el.value;
  if (f.t === "pct") {
    const v = pctIn(raw);
    if (Number.isNaN(v)) return { error: "需為數字" };
    const rg = PCT_RANGE[f.k];
    if (v !== "" && rg && (v < rg[0] || v > rg[1])) return { error: `需在 ${fmtPct(rg[0], 0)}～${fmtPct(rg[1], 0)}` };
    return { value: v };
  }
  if (f.t === "money" || f.t === "int") {
    const v = numIn(raw);
    if (Number.isNaN(v)) return { error: "需為數字" };
    if (v !== "" && v < 0) return { error: "不可為負數" };
    if (f.k === "battery" && v !== "" && v > 100) return { error: "需在 0–100" };
    return { value: v };
  }
  return { value: String(raw ?? "").trim() };
}
function display(f, v) {
  if (v === "" || v === null || v === undefined) return "（空白）";
  if (f.t === "pct") return fmtPct(v);
  if (f.t === "money") return fmtN(v);
  if (f.t === "bool") return v ? "是" : "否";
  return String(v);
}

// ============================================================
// 篩選、排序
// ============================================================
function evaluate(ctx) {
  const today = ctx.today();
  const dupes = duplicateSerials(ctx.state.items);
  return ctx.state.items.map((item) => {
    if (item.status === "sold") return { item, sold: saleStats(item) };
    const r = computePrice(item, ctx.state.policy, today);
    if (item.serial && dupes.has(item.serial)) r.warnings.push({ level: "warn", code: "serial_dup", text: `序號重複（${dupes.get(item.serial)} 筆）` });
    return { item, r, retag: retagCheck(item, r, ctx.state.policy) };
  });
}
function matches(ctx, e) {
  const f = ctx.state.list;
  const it = e.item;
  if (f.status !== "all" && it.status !== f.status) return false;
  if (f.category && it.category !== f.category) return false;
  const k = (f.keyword || "").trim().toLowerCase();
  if (k) {
    const hay = [it.sku, it.name, it.serial, specSummary(it), it.note, it.repairNote, it.marketSource].join(" ").toLowerCase();
    if (!k.split(/\s+/).every((t) => hay.includes(t))) return false;
  }
  const days = e.r ? e.r.days : (e.sold && e.sold.daysToSell) ?? 0;
  if (f.minDays !== null && days < f.minDays) return false;
  if (f.view) {
    if (!e.r) return false;
    const w = e.r.warnings;
    if (f.view === "warn" && !w.some((x) => x.level === "warn")) return false;
    if (f.view === "todo" && !w.some((x) => x.level === "todo")) return false;
    if (f.view === "retag" && !e.retag) return false;
    if (f.view === "below" && !w.some((x) => x.code === "below_cost")) return false;
    if (f.view === "over90" && e.r.days <= 90) return false;
  }
  return true;
}
const SORTERS = {
  sku: (e) => e.item.sku, name: (e) => e.item.name, category: (e) => e.item.category, grade: (e) => e.item.grade || "Z",
  days: (e) => (e.r ? e.r.days : e.sold && e.sold.daysToSell) ?? -1, cost: (e) => numOr(e.item.cost, 0),
  market: (e) => numOr(e.item.market, -1), price: (e) => (e.r ? e.r.price : numOr(e.item.soldPrice, 0)),
  list: (e) => numOr(e.item.listPrice, -1), margin: (e) => (e.r ? e.r.margin : e.sold && e.sold.margin) ?? -9,
  flags: (e) => (e.r ? e.r.warnings.filter((w) => w.level === "warn").length * 100 + e.r.warnings.length + (e.retag ? 1 : 0) : -1),
  soldDate: (e) => e.item.soldDate || ""
};
function sortEntries(entries, sort) {
  const fn = SORTERS[sort.key] || SORTERS.days;
  const dir = sort.dir === "asc" ? 1 : -1;
  return entries.slice().sort((a, b) => {
    const x = fn(a), y = fn(b);
    if (x === y) return 0;
    return (x > y ? 1 : -1) * dir;
  });
}

// ============================================================
// 清單
// ============================================================
const STOCK_COLS = [
  ["sku", "編號"], ["name", "名稱／規格"], ["category", "分類"], ["grade", "成色"], ["days", "庫齡"], ["cost", "成本"],
  ["market", "參考市價"], ["price", "建議售價"], ["list", "標價"], ["margin", "預估毛利率"], ["flags", "狀態"], [null, ""]
];
const SOLD_COLS = [
  ["sku", "編號"], ["name", "名稱／規格"], ["category", "分類"], ["grade", "成色"], ["soldDate", "售出日"], ["days", "周轉天數"],
  ["cost", "成本"], ["list", "售出時標價"], ["price", "成交價"], ["margin", "實際毛利率"], [null, ""]
];
function chips(e) {
  if (!e.r) return `<span class="chip sold">已售出</span>`;
  const out = [];
  const warns = e.r.warnings.filter((w) => w.level === "warn");
  const todos = e.r.warnings.filter((w) => w.level === "todo");
  if (warns.length) out.push(`<span class="chip warn" title="${esc(warns.map((w) => w.text).join("\n"))}">⚠ ${esc(warns[0].text.split("（")[0])}${warns.length > 1 ? ` +${warns.length - 1}` : ""}</span>`);
  if (e.retag) out.push(`<span class="chip tag" title="${esc(e.retag.text)}">🏷 ${e.retag.reason === "untagged" ? "未標價" : "需重新標價"}</span>`);
  if (todos.length) out.push(`<span class="chip todo" title="${esc(todos.map((w) => w.text).join("\n"))}">✎ ${esc(todos[0].text.split("（")[0])}${todos.length > 1 ? ` +${todos.length - 1}` : ""}</span>`);
  return out.join("") || `<span class="chip ok">正常</span>`;
}
function nameCell(it) {
  const spec = specSummary(it);
  return `<span class="nm">${esc(it.name)}</span>${spec ? `<span class="sub">${esc(spec)}</span>` : ""}`;
}
function stockRow(e) {
  const { item: it, r } = e;
  const mk = isBlank(it.market) ? `<span class="muted">—</span>` : `${fmtN(it.market)}<span class="sub">${esc(it.marketDate || "無日期")}</span>`;
  const basis = r.mode === "market" ? "市價" : r.mode === "cost" ? "成本加成" : "";
  const list = isBlank(it.listPrice) ? `<span class="muted">—</span>` : `${fmtN(it.listPrice)}<span class="sub">${esc(it.listDate)}</span>`;
  return `<tr data-id="${esc(it.id)}" class="${r.warnings.some((w) => w.level === "warn") ? "has-warn" : ""}">
    <td data-label="編號" class="mono">${esc(it.sku)}</td>
    <td data-label="名稱" class="namecol">${nameCell(it)}</td>
    <td data-label="分類">${esc(CATEGORY_LABELS[it.category] || it.category)}</td>
    <td data-label="成色">${it.grade ? esc(it.grade) : `<span class="muted">未評</span>`}</td>
    <td data-label="庫齡" class="num">${r.days} 天</td>
    <td data-label="成本" class="num">${fmtN(numOr(it.cost, null))}</td>
    <td data-label="參考市價" class="num">${mk}</td>
    <td data-label="建議售價" class="num price">${fmtN(r.price)}<span class="sub">${basis}</span></td>
    <td data-label="標價" class="num">${list}</td>
    <td data-label="預估毛利率" class="num ${r.margin !== null && r.margin < 0 ? "neg" : ""}">${fmtPct(r.margin)}</td>
    <td data-label="狀態" class="chips">${chips(e)}</td>
    <td class="actions"><button class="btn small" data-act="tag" type="button">標價</button><button class="btn small" data-act="sell" type="button">售出</button><button class="btn ghost small" data-act="open" type="button">明細</button></td>
  </tr>`;
}
function soldRow(e) {
  const { item: it, sold: s } = e;
  return `<tr data-id="${esc(it.id)}">
    <td data-label="編號" class="mono">${esc(it.sku)}</td>
    <td data-label="名稱" class="namecol">${nameCell(it)}</td>
    <td data-label="分類">${esc(CATEGORY_LABELS[it.category] || it.category)}</td>
    <td data-label="成色">${it.grade ? esc(it.grade) : `<span class="muted">未評</span>`}</td>
    <td data-label="售出日">${esc(it.soldDate || "—")}</td>
    <td data-label="周轉天數" class="num">${s && s.daysToSell !== null ? s.daysToSell + " 天" : "—"}</td>
    <td data-label="成本" class="num">${fmtN(numOr(it.cost, null))}</td>
    <td data-label="售出時標價" class="num">${fmtN(s ? s.listPrice : null)}</td>
    <td data-label="成交價" class="num price">${fmtN(s ? s.price : null)}</td>
    <td data-label="實際毛利率" class="num ${s && s.margin < 0 ? "neg" : ""}">${fmtPct(s ? s.margin : null)}</td>
    <td class="actions"><button class="btn ghost small" data-act="open" type="button">明細</button></td>
  </tr>`;
}

export function render(ctx) {
  const f = ctx.state.list;
  const all = evaluate(ctx);
  const entries = sortEntries(all.filter((e) => matches(ctx, e)), f.sort);
  const soldView = f.status === "sold";
  const cols = soldView ? SOLD_COLS : STOCK_COLS;
  $("#itemsTable thead").innerHTML = `<tr>${cols.map(([k, l]) => k
    ? `<th data-sort="${k}" class="${["days", "cost", "market", "price", "list", "margin"].includes(k) ? "num" : ""}" aria-sort="${f.sort.key === k ? (f.sort.dir === "asc" ? "ascending" : "descending") : "none"}"><button type="button">${l}${f.sort.key === k ? (f.sort.dir === "asc" ? " ▲" : " ▼") : ""}</button></th>`
    : `<th></th>`).join("")}</tr>`;
  $("#itemsTable tbody").innerHTML = entries.map((e) => (e.r ? stockRow(e) : soldRow(e))).join("");
  const stock = entries.filter((e) => e.r);
  const cost = entries.reduce((a, e) => a + numOr(e.item.cost, 0), 0);
  let foot = "";
  if (soldView) {
    const rev = entries.reduce((a, e) => a + numOr(e.item.soldPrice, 0), 0);
    foot = `<tr><td colspan="6" class="right">合計 ${entries.length} 筆</td><td class="num">${fmtN(cost)}</td><td></td><td class="num">${fmtN(rev)}</td><td class="num">${rev ? fmtPct((rev - cost) / rev) : "—"}</td><td></td></tr>`;
  } else {
    const sug = stock.reduce((a, e) => a + e.r.price, 0);
    const sc = stock.reduce((a, e) => a + numOr(e.item.cost, 0), 0);
    foot = `<tr><td colspan="5" class="right">合計 ${entries.length} 筆</td><td class="num">${fmtN(cost)}</td><td></td><td class="num">${fmtN(sug)}</td><td></td><td class="num">${sug ? fmtPct((sug - sc) / sug) : "—"}</td><td colspan="2"></td></tr>`;
  }
  $("#itemsTable tfoot").innerHTML = entries.length ? foot : "";
  $("#emptyHint").hidden = entries.length > 0;
  const total = ctx.state.items.length;
  const nStock = ctx.state.items.filter((x) => x.status !== "sold").length;
  $("#listCount").textContent = `顯示 ${entries.length} 筆（在庫 ${nStock}、已售出 ${total - nStock}）`;
  $("#batchBox").hidden = soldView;
}
export function refreshDrawer(ctx) { if (openId) renderDrawer(ctx); }

export function syncFilterUI(ctx) {
  const f = ctx.state.list;
  for (const b of $$("#statusSeg button")) b.classList.toggle("on", b.dataset.status === f.status);
  $("#fCategory").value = f.category;
  $("#fKeyword").value = f.keyword;
  $("#fMinDays").value = f.minDays ?? "";
  $("#fView").value = f.view;
}

// ============================================================
// 標價、售出
// ============================================================
async function tagItem(ctx, item, { silent = false } = {}) {
  const r = computePrice(item, ctx.state.policy, ctx.today());
  if (numOr(item.listPrice, null) === r.price) { if (!silent) ctx.toast("標價已是建議售價"); return false; }
  const cost = numOr(item.cost, 0);
  if (cost > 0 && r.price < cost) {
    if (!(await ctx.requireUnlock(`「${item.name}」建議售價 ${fmtN(r.price)} 低於成本 ${fmtN(cost)}，標價需主管核准`))) return false;
    ctx.audit("approve", `${item.sku} 低於成本標價 ${fmtN(r.price)}（成本 ${fmtN(cost)}）${ctx.state.pin ? "，主管已核准" : "，未設主管 PIN"}`);
  }
  const old = item.listPrice;
  item.listPrice = r.price;
  item.listDate = toISODate(ctx.today());
  item.priceHistory.push({ date: item.listDate, price: r.price, note: isBlank(old) ? "首次標價" : `由 ${fmtN(old)} 調整` });
  ctx.audit("price", `${item.sku} 標價 ${isBlank(old) ? "—" : fmtN(old)} → ${fmtN(r.price)}`);
  if (!silent) { ctx.changed(); ctx.toast(`已標價 ${fmtN(r.price)}：${item.name}`); }
  return true;
}
async function sellItem(ctx, item, soldDate, soldPrice) {
  const cost = numOr(item.cost, 0);
  if (cost > 0 && soldPrice < cost) {
    if (!(await ctx.requireUnlock(`成交價 ${fmtN(soldPrice)} 低於成本 ${fmtN(cost)}，需主管核准`))) return false;
    ctx.audit("approve", `${item.sku} 低於成本售出 ${fmtN(soldPrice)}（成本 ${fmtN(cost)}）${ctx.state.pin ? "，主管已核准" : "，未設主管 PIN"}`);
  }
  const r = computePrice(item, ctx.state.policy, ctx.today());
  ctx.withUndo(`已售出：${item.name}`, () => {
    item.status = "sold";
    item.soldDate = soldDate;
    item.soldPrice = soldPrice;
    item.sale = { suggested: r.price, anchor: Math.round(r.anchor), listPrice: item.listPrice, days: daysBetweenISO(item.date, soldDate) ?? r.days, mode: r.mode };
  });
  ctx.audit("price", `${item.sku} 售出 ${fmtN(soldPrice)}（建議 ${fmtN(r.price)}、標價 ${isBlank(item.listPrice) ? "—" : fmtN(item.listPrice)}）`);
  ctx.changed();
  return true;
}

// ============================================================
// 商品明細
// ============================================================
let openId = null;
let sellMode = false;

export function openDrawer(ctx, id, { sell = false } = {}) {
  openId = id;
  sellMode = sell;
  const item = ctx.findItem(id);
  if (!item) return;
  $("#drawer").classList.add("open");
  $("#drawer").setAttribute("aria-hidden", "false");
  $("#drawerShade").hidden = false;
  renderDrawer(ctx, true);
  setTimeout(() => (sell ? $("#sellPrice") : $("#drawerClose"))?.focus(), 50);
}
export function closeDrawer() {
  if (!openId) return;
  openId = null;
  $("#drawer").classList.remove("open");
  $("#drawer").setAttribute("aria-hidden", "true");
  $("#drawerShade").hidden = true;
}
function summaryHtml(ctx, item) {
  if (item.status === "sold") {
    const s = saleStats(item);
    return `<div class="sum-grid">
      <div><span class="k">成交價</span><span class="v big">${fmtN(s.price)}</span></div>
      <div><span class="k">實際毛利</span><span class="v ${s.profit < 0 ? "neg" : ""}">${fmtN(s.profit)}（${fmtPct(s.margin)}）</span></div>
      <div><span class="k">售出日／周轉</span><span class="v">${esc(item.soldDate)}・${s.daysToSell ?? "—"} 天</span></div>
      <div><span class="k">售出時建議價／標價</span><span class="v">${fmtN(item.sale && item.sale.suggested)}／${fmtN(s.listPrice)}</span></div>
    </div>`;
  }
  const r = computePrice(item, ctx.state.policy, ctx.today());
  const rt = retagCheck(item, r, ctx.state.policy);
  const q = r.quality.parts.length ? r.quality.parts.map((p) => `${p.label} ${fmtFactor(p.factor)}`).join("、") : "無";
  return `<div class="sum-grid">
      <div><span class="k">建議售價</span><span class="v big">${fmtN(r.price)}</span><span class="sub">${r.mode === "market" ? "市價錨定" : r.mode === "cost" ? "成本加成（缺市價）" : "無法定價"}</span></div>
      <div><span class="k">目前標價</span><span class="v">${isBlank(item.listPrice) ? "未標價" : `${fmtN(item.listPrice)}（${esc(item.listDate)}）`}</span>${rt ? `<span class="sub warn-text">${esc(rt.text)}</span>` : ""}</div>
      <div><span class="k">預估毛利</span><span class="v ${r.profit < 0 ? "neg" : ""}">${fmtN(r.profit)}（${fmtPct(r.margin)}）</span></div>
      <div><span class="k">庫齡／品況</span><span class="v">${r.days} 天・${esc(q)}</span></div>
    </div>`;
}
/** 按鈕列只在開啟／狀態改變時重建，避免編輯欄位後按按鈕時被重畫吃掉點擊 */
function actionsHtml(ctx, item) {
  if (item.status === "sold") {
    return `<div class="btn-row"><button class="btn small" data-dact="unsell" type="button">改回在庫</button><button class="btn danger small" data-dact="delete" type="button">刪除</button></div>`;
  }
  return `<div class="btn-row">
      <button class="btn success small" data-dact="tag" type="button"></button>
      <button class="btn small" data-dact="sell" type="button">售出</button>
      <button class="btn danger small" data-dact="delete" type="button">刪除</button>
    </div>
    <form id="sellForm" class="sell-form" hidden>
      <label class="field">售出日<input id="sellDate" type="date" required/></label>
      <label class="field">成交價（元）<input id="sellPrice" type="number" min="0" step="1" required/></label>
      <button class="btn primary small" type="submit">確認售出</button>
      <button class="btn ghost small" type="button" data-dact="cancelSell">取消</button>
    </form>`;
}
function showSellForm(ctx, item, show) {
  const form = $("#sellForm");
  if (!form) return;
  form.hidden = !show;
  if (show) {
    const r = computePrice(item, ctx.state.policy, ctx.today());
    $("#sellDate").value = toISODate(ctx.today());
    $("#sellPrice").value = isBlank(item.listPrice) ? r.price : item.listPrice;
  }
}
function issuesHtml(ctx, item) {
  if (item.status === "sold") return "";
  const r = computePrice(item, ctx.state.policy, ctx.today());
  if (!r.warnings.length) return `<p class="ok-text small">✓ 沒有待處理事項</p>`;
  return `<ul class="issues">${r.warnings.map((w) => `<li class="${w.level}">${w.level === "warn" ? "⚠" : "✎"} ${esc(w.text)}</li>`).join("")}</ul>`;
}
function stepsHtml(ctx, item) {
  if (item.status === "sold") return "";
  const r = computePrice(item, ctx.state.policy, ctx.today());
  return `<details class="steps"><summary>計算過程</summary><ol>${r.steps.map((s) => `<li class="${s.hit ? "hit" : ""}"><span>${esc(s.label)}</span><span class="mono">${fmtN(s.value)}</span></li>`).join("")}</ol></details>`;
}
function historyHtml(item) {
  if (!item.priceHistory.length) return `<p class="muted small">尚無標價紀錄</p>`;
  return `<table class="mini"><thead><tr><th>日期</th><th class="num">標價</th><th>說明</th></tr></thead><tbody>${item.priceHistory.slice().reverse().map((h) => `<tr><td>${esc(h.date)}</td><td class="num">${fmtN(h.price)}</td><td>${esc(h.note)}</td></tr>`).join("")}</tbody></table>`;
}
function renderDrawer(ctx, full = false) {
  const item = ctx.findItem(openId);
  if (!item) { closeDrawer(); return; }
  $("#drawerSku").textContent = `${item.sku}${item.status === "sold" ? "・已售出" : ""}`;
  $("#drawerTitle").textContent = item.name;
  if (!$("#dwForm")) full = true;
  if (full) {
    const fields = item.status === "sold" ? [...FIELDS, ...SOLD_FIELDS] : FIELDS;
    $("#drawerBody").innerHTML = `
      <section id="dwSummary"></section>
      <section id="dwActions"></section>
      <section id="dwIssues"></section>
      <section id="dwSteps"></section>
      <h3>資料</h3>
      <form id="dwForm" class="grid four" autocomplete="off">${fields.map((f) => fieldHtml(f, item[f.k], "dw-")).join("")}</form>
      <p class="muted small">修改後自動儲存；影響售價的欄位會寫入修改紀錄。</p>
      <h3>標價紀錄</h3><div id="dwHistory"></div>`;
  }
  if (full) {
    $("#dwActions").innerHTML = actionsHtml(ctx, item);
    showSellForm(ctx, item, sellMode && item.status !== "sold");
  }
  $("#dwSummary").innerHTML = summaryHtml(ctx, item);
  const tagBtn = $("#dwActions [data-dact=tag]");
  if (tagBtn) tagBtn.textContent = `標價（套用建議價 ${fmtN(computePrice(item, ctx.state.policy, ctx.today()).price)}）`;
  $("#dwIssues").innerHTML = issuesHtml(ctx, item);
  const wasOpen = $("#dwSteps details")?.open;
  $("#dwSteps").innerHTML = stepsHtml(ctx, item);
  if (wasOpen && $("#dwSteps details")) $("#dwSteps details").open = true;
  $("#dwHistory").innerHTML = historyHtml(item);
}
function onDrawerFieldChange(ctx, el) {
  const item = ctx.findItem(openId);
  if (!item) return;
  const k = el.dataset.k;
  const f = [...FIELDS, ...SOLD_FIELDS].find((x) => x.k === k);
  const res = readField(f, el);
  el.classList.toggle("invalid", !!res.error);
  if (res.error) { ctx.toast(`${f.l}：${res.error}，未儲存`); return; }
  let v = res.value;
  if (k === "sku") {
    if (!v) { el.value = item.sku; ctx.toast("庫存編號不可空白"); return; }
    if (ctx.state.items.some((x) => x !== item && x.sku === v)) { el.classList.add("invalid"); ctx.toast(`庫存編號 ${v} 已存在，未儲存`); return; }
  }
  if (k === "name" && !v) v = "未命名";
  const old = item[k];
  if (String(old ?? "") === String(v ?? "")) return;
  Object.assign(item, normalizeItem({ ...item, [k]: v }), { id: item.id });
  // 市價改了就是新的一次查價：查價日期改為今天（除非這次改的就是日期本身）
  if (k === "market" && !isBlank(v)) {
    item.marketDate = toISODate(ctx.today());
    const md = $("#dw-marketDate");
    if (md) md.value = item.marketDate;
  }
  if (k === "listPrice" && !isBlank(v)) {
    item.listDate = item.listDate || toISODate(ctx.today());
    item.priceHistory.push({ date: toISODate(ctx.today()), price: v, note: "手動修改" });
  }
  if (LOGGED.has(k)) ctx.audit(k === "listPrice" ? "price" : "item", `${item.sku} ${f.l.replace(/（.*）/, "")}：${display(f, old)} → ${display(f, item[k])}`);
  ctx.changed();
}

// ============================================================
// 新增
// ============================================================
function readAddForm(ctx) {
  const form = $("#addForm");
  const data = {};
  const errors = [];
  for (const el of form.elements) {
    if (!el.name) continue;
    const f = FIELDS.find((x) => x.k === el.name) || { k: el.name, l: el.name };
    const res = readField(f, el);
    if (res.error) { errors.push(`${f.l}：${res.error}`); continue; }
    data[el.name] = res.value;
  }
  return { data, errors };
}
function updatePreview(ctx) {
  const { data, errors } = readAddForm(ctx);
  const box = $("#addPreview");
  if (errors.length) { box.innerHTML = `<span class="warn-text">${esc(errors.join("；"))}</span>`; return; }
  if (isBlank(data.cost) && isBlank(data.market)) { box.innerHTML = `<span class="muted">填入成本或參考市價後顯示建議售價</span>`; return; }
  const item = normalizeItem({ ...data, date: data.date || toISODate(ctx.today()), marketDate: data.marketDate || (isBlank(data.market) ? "" : toISODate(ctx.today())) });
  const r = computePrice(item, ctx.state.policy, ctx.today());
  const issues = r.warnings.filter((w) => w.code !== "recycle_missing").map((w) => `${w.level === "warn" ? "⚠" : "✎"} ${w.text}`);
  box.innerHTML = `<span class="pv-label">建議售價</span><span class="pv-price">${fmtN(r.price)}</span>
    <span class="muted small">${r.mode === "market" ? `市價錨定・品況 ${fmtFactor(r.quality.total)}` : "成本加成"}・預估毛利率 ${fmtPct(r.margin)}</span>
    ${issues.length ? `<span class="pv-issues small">${esc(issues.join("　"))}</span>` : ""}`;
}
function submitAdd(ctx, e) {
  e.preventDefault();
  const { data, errors } = readAddForm(ctx);
  if (errors.length) { ctx.toast(errors.join("；")); return; }
  const today = toISODate(ctx.today());
  if (data.sku && ctx.state.items.some((x) => x.sku === data.sku)) { ctx.toast(`庫存編號 ${data.sku} 已存在`); return; }
  const item = normalizeItem({
    ...data, date: data.date || today, createdAt: today,
    marketDate: data.marketDate || (isBlank(data.market) ? "" : today)
  });
  if (!item.sku) item.sku = nextSku(ctx.state.items, item.date);
  ctx.state.items.push(item);
  ctx.audit("item", `新增 ${item.sku} ${item.name}（成本 ${fmtN(numOr(item.cost, null))}、市價 ${fmtN(numOr(item.market, null))}）`);
  const form = $("#addForm");
  form.reset();
  form.elements.date.value = today;
  updatePreview(ctx);
  ctx.changed();
  const visible = matches(ctx, { item, r: computePrice(item, ctx.state.policy, ctx.today()) });
  ctx.toast(`已加入 ${item.sku}「${item.name}」${visible ? "" : "（不符合目前篩選，暫未顯示）"}`);
}
export function prefillAdd(ctx, data) {
  const form = $("#addForm");
  form.reset();
  for (const [k, v] of Object.entries(data)) {
    const el = form.elements[k];
    if (!el) continue;
    if (el.type === "checkbox") el.checked = !!v;
    else el.value = (k === "margin" || k === "marketAdj") ? pctOut(v) : v;
  }
  form.elements.date.value = form.elements.date.value || toISODate(ctx.today());
  $("#addCard").open = true;
  if (["purchaseDate", "newPrice", "battery", "repair"].some((k) => k in data)) form.querySelector("details.more").open = true;
  updatePreview(ctx);
}

// ============================================================
// 批次
// ============================================================
function filteredStock(ctx) {
  return evaluate(ctx).filter((e) => e.r && matches(ctx, e));
}
async function batchApply(ctx) {
  const c = $("#bCategory").value, g = $("#bGrade").value;
  const m = pctIn($("#bMargin").value), a = pctIn($("#bAdj").value);
  if (Number.isNaN(m) || Number.isNaN(a)) { ctx.toast("百分比需為數字"); return; }
  if (m !== "" && (m < PCT_RANGE.margin[0] || m > PCT_RANGE.margin[1])) { ctx.toast("目標毛利率需在 -50%～89%"); return; }
  if (!c && !g && m === "" && a === "") { ctx.toast("請先選擇要變更的欄位"); return; }
  const list = filteredStock(ctx);
  if (!list.length) { ctx.toast("目前篩選結果沒有在庫商品"); return; }
  ctx.withUndo(`已批次更新 ${list.length} 筆`, () => {
    for (const { item } of list) {
      if (c) item.category = c;
      if (g) item.grade = g;
      if (m !== "") item.margin = m;
      if (a !== "") item.marketAdj = a;
    }
  });
  ctx.audit("item", `批次更新 ${list.length} 筆：${[c && `分類→${CATEGORY_LABELS[c]}`, g && `成色→${g}`, m !== "" && `目標毛利率→${fmtPct(m)}`, a !== "" && `單品加成→${fmtPct(a)}`].filter(Boolean).join("、")}`);
  ctx.changed();
}
async function batchRetag(ctx) {
  const list = filteredStock(ctx).filter((e) => e.retag);
  if (!list.length) { ctx.toast("篩選結果中沒有需要重新標價的商品"); return; }
  const below = list.filter((e) => e.r.warnings.some((w) => w.code === "below_cost"));
  if (below.length && !(await ctx.requireUnlock(`其中 ${below.length} 筆建議售價低於成本，批次標價需主管核准`))) return;
  const snap = ctx.beginUndo();
  let n = 0;
  for (const { item } of list) if (await tagItem(ctx, item, { silent: true })) n++;
  ctx.commitUndo(snap, `已重新標價 ${n} 筆`);
  ctx.audit("price", `批次重新標價 ${n} 筆${below.length ? `（含低於成本 ${below.length} 筆）` : ""}`);
  ctx.changed();
}
function exportTagList(ctx) {
  const items = filteredStock(ctx).map((e) => e.item);
  if (!items.length) { ctx.toast("目前篩選結果沒有在庫商品"); return; }
  const aoa = tagListAoa(items, ctx.state.policy, ctx.today());
  if (typeof XLSX !== "undefined") {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [16, 30, 30, 6, 10, 10, 18].map((w) => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws, "標價清單");
    XLSX.writeFile(wb, `usedpc_標價清單_${stampForFile()}.xlsx`);
  } else {
    downloadBlob(new Blob([aoaToCSV(aoa)], { type: "text/csv;charset=utf-8" }), `usedpc_標價清單_${stampForFile()}.csv`);
  }
  ctx.toast(`已匯出標價清單 ${items.length} 筆`);
}
async function batchDelete(ctx) {
  const list = evaluate(ctx).filter((e) => matches(ctx, e));
  if (!list.length) { ctx.toast("目前篩選結果沒有資料"); return; }
  if (!(await ctx.requireUnlock(`刪除 ${list.length} 筆資料需主管核准`))) return;
  const ids = new Set(list.map((e) => e.item.id));
  ctx.withUndo(`已刪除 ${ids.size} 筆`, () => { ctx.state.items = ctx.state.items.filter((x) => !ids.has(x.id)); });
  ctx.audit("item", `批次刪除 ${ids.size} 筆：${list.slice(0, 10).map((e) => e.item.sku).join("、")}${ids.size > 10 ? "…" : ""}`);
  ctx.changed();
}

// ============================================================
// 初始化
// ============================================================
export function init(ctx) {
  const form = $("#addForm");
  form.elements.category.innerHTML = ctx.options.category();
  form.elements.grade.innerHTML = ctx.options.grade();
  form.elements.date.value = toISODate(ctx.today());
  $("#fCategory").innerHTML = ctx.options.category("全部");
  $("#bCategory").innerHTML = ctx.options.category("不變更");
  $("#bGrade").innerHTML = ctx.options.grade("不變更");
  on(form, "input", () => updatePreview(ctx));
  on(form, "change", () => updatePreview(ctx));
  on(form, "submit", (e) => submitAdd(ctx, e));
  updatePreview(ctx);

  // 篩選
  delegate($("#statusSeg"), "click", "button", (e, b) => {
    ctx.state.list.status = b.dataset.status;
    if (b.dataset.status === "sold") { ctx.state.list.view = ""; ctx.state.list.sort = { key: "soldDate", dir: "desc" }; }
    else if (ctx.state.list.sort.key === "soldDate") ctx.state.list.sort = { key: "days", dir: "desc" };
    syncFilterUI(ctx); render(ctx);
  });
  on("#fCategory", "change", (e) => { ctx.state.list.category = e.target.value; render(ctx); });
  let kt = null;
  on("#fKeyword", "input", (e) => { clearTimeout(kt); kt = setTimeout(() => { ctx.state.list.keyword = e.target.value; render(ctx); }, 150); });
  on("#fMinDays", "input", (e) => { const v = e.target.value.trim(); ctx.state.list.minDays = v === "" || !Number.isFinite(Number(v)) ? null : Number(v); render(ctx); });
  on("#fView", "change", (e) => { ctx.state.list.view = e.target.value; if (e.target.value) ctx.state.list.status = "stock"; syncFilterUI(ctx); render(ctx); });
  on("#fClear", "click", () => { Object.assign(ctx.state.list, { category: "", keyword: "", minDays: null, view: "" }); syncFilterUI(ctx); render(ctx); });

  // 排序
  delegate($("#itemsTable thead"), "click", "th[data-sort]", (e, th) => {
    const s = ctx.state.list.sort;
    const k = th.dataset.sort;
    ctx.state.list.sort = s.key === k ? { key: k, dir: s.dir === "asc" ? "desc" : "asc" } : { key: k, dir: ["sku", "name", "category", "grade"].includes(k) ? "asc" : "desc" };
    render(ctx);
  });
  // 列動作
  delegate($("#itemsTable tbody"), "click", "tr[data-id]", (e, tr) => {
    const item = ctx.findItem(tr.dataset.id);
    if (!item) return;
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "tag") tagItem(ctx, item);
    else if (act === "sell") openDrawer(ctx, item.id, { sell: true });
    else if (!e.target.closest("button, a, input, select")) openDrawer(ctx, item.id);
    else if (act === "open") openDrawer(ctx, item.id);
  });

  // 批次
  on("#bApply", "click", () => batchApply(ctx));
  on("#bRetag", "click", () => batchRetag(ctx));
  on("#bTagList", "click", () => exportTagList(ctx));
  on("#bDelete", "click", () => batchDelete(ctx));

  // 明細
  on("#drawerClose", "click", () => closeDrawer(ctx));
  on("#drawerShade", "click", () => closeDrawer(ctx));
  delegate($("#drawerBody"), "change", "[data-k]", (e, el) => onDrawerFieldChange(ctx, el));
  delegate($("#drawerBody"), "click", "[data-dact]", async (e, b) => {
    const item = ctx.findItem(openId);
    if (!item) return;
    const act = b.dataset.dact;
    if (act === "tag") await tagItem(ctx, item);
    else if (act === "sell") { sellMode = true; showSellForm(ctx, item, true); $("#sellPrice")?.focus(); }
    else if (act === "cancelSell") { sellMode = false; showSellForm(ctx, item, false); }
    else if (act === "unsell") {
      ctx.withUndo(`已改回在庫：${item.name}`, () => { item.status = "stock"; item.soldDate = ""; item.soldPrice = ""; item.sale = null; });
      ctx.audit("price", `${item.sku} 取消售出，改回在庫`);
      renderDrawer(ctx, true); ctx.changed();
    } else if (act === "delete") {
      if (!(await ctx.requireUnlock(`刪除「${item.name}」需主管核准`))) return;
      ctx.withUndo(`已刪除「${item.name}」`, () => { ctx.state.items = ctx.state.items.filter((x) => x.id !== item.id); });
      ctx.audit("item", `刪除 ${item.sku} ${item.name}`);
      closeDrawer(ctx); ctx.changed();
    }
  });
  on($("#drawerBody"), "submit", async (e) => {
    if (e.target.id !== "sellForm") return;
    e.preventDefault();
    const item = ctx.findItem(openId);
    const d = $("#sellDate").value, p = numIn($("#sellPrice").value);
    if (!d || p === "" || Number.isNaN(p) || p < 0) { ctx.toast("請填售出日與成交價"); return; }
    if (await sellItem(ctx, item, d, p)) { sellMode = false; renderDrawer(ctx, true); }
  });
}
