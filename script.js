// SINYA USEDPC Dashboard — v8.7 Pro
// 修正 v8.5 載入當機；新增自動存檔、Excel／CSV 匯入匯出、篩選與批次、刪除可復原。
// 月序規則：滿 N 個曆法月 = 第 N 月；未滿 1 個月不套係數（1.00）；滿 18 個月以上固定第 18 月。
// 尾數規則：往下取（11,450 → 11,449／11,399），會跌破底線時才往上取。
// 底線規則（v8.7）：庫存 ≥90 天成本底線降為成本、≥180 天不設成本底線（可低於成本，標示需主管核准）；市價下限以原始市價計。
"use strict";

const $ = (sel) => document.querySelector(sel);
const on = (target, ev, fn) => {
  const el = typeof target === "string" ? $(target) : target;
  if (el) el.addEventListener(ev, fn);
  return el;
};

const APP_VERSION = "8.7";
const STORAGE_KEY = "sinya-usedpc-dashboard";
const CATEGORIES = ["NB", "DT", "MON", "DIY", "OTH"];
const COEFF_MONTHS = 18;
const EPS = 1e-6;

const defaultGlobals = () => ({
  roundUnit: 10,
  roundMode: "nearest",
  tailMode: "9",
  defaultMarketAdj: 0.05,
  minMarginFloor: 0.10,
  notBelowMarketPct: -0.05,
  ladder: [{ days: 30, adj: -0.05 }, { days: 60, adj: -0.10 }, { days: 90, adj: -0.15 }],
  monthlyCoeffs: Array.from({ length: COEFF_MONTHS }, () => 1),
  cumulativeMode: false,
  coeffBasis: "purchase", // "purchase" | "recycle"
  // 底線依庫齡放寬（v8.7）：庫存 ≥ 第一階天數 → 底線毛利率改為第一階值；≥ 第二階天數 → 第二階值（null = 不設底線，可低於成本）
  floorRelaxOn: true,
  floorTier1Days: 90,
  floorTier1Margin: 0,
  floorTier2Days: 180,
  floorTier2Margin: null
});

const state = {
  items: [],
  filter: { category: "", keyword: "", minDays: null, repairOnly: false, warnOnly: false },
  diagnostics: false,
  globals: defaultGlobals()
};

// ============================================================
// 基本工具
// ============================================================
function newId() {
  try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) { /* ignore */ }
  return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}
function isBlank(v) {
  return v === "" || v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v));
}
function numOr(v, fallback) {
  if (isBlank(v)) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const pad2 = (n) => String(n).padStart(2, "0");
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[m]));
}
function fmtN(x) {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return Math.round(x).toLocaleString("en-US");
}
function fmtPct(x) {
  if (!Number.isFinite(x)) return "—";
  return (Math.round(x * 1000) / 10).toString() + "%";
}
function fmtCoeff(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "1.00";
  const s = String(Math.round(n * 10000) / 10000);
  return s.includes(".") ? (s.split(".")[1].length < 2 ? s + "0" : s) : s + ".00";
}

// ---- 日期（一律以「本地日期」計算，避免 UTC 時差造成早上 8 點前少一天） ----
function todayLocal() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function toISODate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }
function parseISODate(str) {
  if (!str) return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(str).trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d };
}
function isoFromParts(y, m, d) {
  if (!(y >= 1900 && y <= 2999) || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return "";
  return `${y}-${pad2(m)}-${pad2(d)}`;
}
function addMonthsISO(base, months, extraDays = 0) {
  const d = new Date(base.getFullYear(), base.getMonth() + months, base.getDate() + extraDays);
  return toISODate(d);
}

/** 已滿幾個曆法月（同月日未到不算新的一個月；月底日自動對齊，例 1/31 → 2/28 算滿 1 個月）。無日期回傳 null。 */
function monthsElapsed(dateStr, today) {
  const p = parseISODate(dateStr);
  if (!p) return null;
  const y2 = today.getFullYear(), m2 = today.getMonth() + 1, d2 = today.getDate();
  let months = (y2 - p.y) * 12 + (m2 - p.m);
  const anchor = Math.min(p.d, daysInMonth(y2, m2));
  if (d2 < anchor) months -= 1;
  return Math.max(0, months);
}
/** 距今天數（未來日期為負數）。無日期回傳 null。 */
function daysSince(dateStr, today) {
  const p = parseISODate(dateStr);
  if (!p) return null;
  const a = Date.UTC(p.y, p.m - 1, p.d);
  const b = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((b - a) / 86400000);
}

// ---- 解析 ----
function parseLadder(str) {
  const ladder = [], invalid = [], suspicious = [];
  String(str || "").split(",").map((s) => s.trim()).filter(Boolean).forEach((seg) => {
    const [d, p] = seg.split("/").map((x) => (x ?? "").trim());
    const days = Number(d), adj = Number(p);
    if (d === "" || p === "" || !Number.isFinite(days) || !Number.isFinite(adj)) { invalid.push(seg); return; }
    if (Math.abs(adj) >= 1) suspicious.push(seg);
    ladder.push({ days, adj });
  });
  ladder.sort((a, b) => a.days - b.days);
  return { ladder, invalid, suspicious };
}
function parseCoeffRow(str) {
  if (str === null || str === undefined) return null;
  const parts = String(str).split(/[\s,，、]+/).filter(Boolean).slice(0, COEFF_MONTHS);
  if (parts.length === 0) return null;
  const arr = parts.map((x) => Number(x));
  if (arr.some((x) => !Number.isFinite(x) || x <= 0)) return null;
  while (arr.length < COEFF_MONTHS) arr.push(arr[arr.length - 1]);
  return arr;
}

// ---- 取整與尾數 ----
function roundByMode(value, unit, mode) {
  const q = value / unit;
  if (mode === "ceil") return Math.ceil(q - EPS) * unit;
  if (mode === "floor") return Math.floor(q + EPS) * unit;
  return Math.round(q) * unit;
}
function tailStep(tailMode) { return tailMode === "9" ? 10 : tailMode === "99" ? 100 : 0; }
/** 小於等於 x 的最大尾數價（尾數9：…9；尾數99：…99） */
function tailDown(x, tailMode) { const s = tailStep(tailMode), t = s - 1; return Math.floor((x - t + EPS) / s) * s + t; }
/** 大於等於 x 的最小尾數價 */
function tailUp(x, tailMode) { const s = tailStep(tailMode), t = s - 1; return Math.ceil((x - t - EPS) / s) * s + t; }
/** 把上限價整理成好看的價格（往下取） */
function tidyDown(x, unit, tailMode) {
  if (tailStep(tailMode)) return tailDown(x, tailMode);
  return Math.floor((x + EPS) / unit) * unit;
}

/** 依庫存天數決定成本底線的毛利率。回傳 { margin: number|null（null = 不設底線）, tier: 0|1|2 } */
function floorMarginFor(days, g) {
  const base = Math.max(0, numOr(g.minMarginFloor, 0));
  let res = { margin: base, tier: 0 };
  if (!g.floorRelaxOn) return res;
  const t1 = numOr(g.floorTier1Days, null);
  const t2 = numOr(g.floorTier2Days, null);
  if (t1 !== null && days >= t1) res = { margin: numOr(g.floorTier1Margin, 0), tier: 1 };
  if (t2 !== null && days >= t2) res = { margin: isBlank(g.floorTier2Margin) ? null : numOr(g.floorTier2Margin, null), tier: 2 };
  return res;
}

// ============================================================
// 核心計算
// 順序：毛利 → 階梯 → 月係數 → 最低毛利底線 → 市價下限 → 取整（不破底線）→ 尾數（往下、不破底線）→ 市價上限
// ============================================================
function computePrice(item, g, today) {
  today = today || todayLocal();
  const steps = { notes: [] };
  const warnings = [];

  const cost = numOr(item.cost, 0);
  const margin = numOr(item.margin, 0);
  const market = isBlank(item.market) ? null : numOr(item.market, null);
  const marketAdj = isBlank(item.marketAdj) ? numOr(g.defaultMarketAdj, 0) : numOr(item.marketAdj, 0);
  const roundUnit = Math.max(1, numOr(g.roundUnit, 1));
  const roundMode = g.roundMode || "nearest";
  const tailMode = g.tailMode || "none";
  const notBelowMarketPct = numOr(g.notBelowMarketPct, 0);
  const ladder = Array.isArray(g.ladder) ? g.ladder : [];

  // ---- 日期與月序 ----
  const dRec = daysSince(item.date, today);
  const dPur = daysSince(item.purchaseDate, today);
  const daysInStock = dRec === null ? 0 : Math.max(0, dRec);
  const monthByPurchase = monthsElapsed(item.purchaseDate, today);
  const monthByRecycle = monthsElapsed(item.date, today);
  Object.assign(steps, { daysInStock, monthByPurchase, monthByRecycle, hasRecycleDate: dRec !== null });

  if (cost <= 0) warnings.push("成本未填或為 0");
  if (margin < 0) warnings.push("毛利率為負數");
  if (margin >= 1) warnings.push(`毛利率 ${margin} ≥ 100%，請確認是否應為 ${margin / 100}`);
  if (dRec === null) warnings.push("回收日空白（庫存天數以 0 計）");
  if (dRec !== null && dRec < 0) warnings.push("回收日在未來");
  if (dPur !== null && dPur < 0) warnings.push("購買日在未來");
  if (dRec !== null && dPur !== null && dPur < dRec) warnings.push("購買日晚於回收日");

  let basisUsed = g.coeffBasis === "recycle" ? "recycle" : "purchase";
  let elapsed = basisUsed === "purchase" ? monthByPurchase : monthByRecycle;
  if (basisUsed === "purchase" && elapsed === null && monthByRecycle !== null) {
    basisUsed = "recycle";
    elapsed = monthByRecycle;
    steps.notes.push("購買日空白，月序改用回收日");
  }
  const coeffMonth = Math.min(elapsed ?? 0, COEFF_MONTHS); // 0 = 未滿 1 個月，不套係數
  Object.assign(steps, { basisUsed, elapsed, coeffMonth });

  // ---- 市價 ----
  const adjustedMarket = market === null ? null : r6(market * (1 + marketAdj));
  steps.adjustedMarket = adjustedMarket;

  // ---- 毛利 ----
  let price = r6(cost * (1 + margin));
  steps.initial = price;

  // ---- 階梯（取符合的最大門檻，不累加） ----
  let ladderAdj = 0, ladderDays = null;
  for (const l of ladder) { if (daysInStock >= l.days) { ladderAdj = l.adj; ladderDays = l.days; } }
  if (ladderAdj !== 0) price = r6(price * (1 + ladderAdj));
  Object.assign(steps, { ladderAdj, ladderDays, afterLadder: price });

  // ---- 月係數 ----
  const own = Array.isArray(item.monthlyCoeffs) && item.monthlyCoeffs.length ? item.monthlyCoeffs : null;
  const src = own || g.monthlyCoeffs || [];
  const at = (i) => { const v = Number(src[i]); return Number.isFinite(v) && v > 0 ? v : 1; };
  let coeff = 1;
  if (coeffMonth > 0) {
    if (g.cumulativeMode) { for (let i = 0; i < coeffMonth; i++) coeff *= at(i); }
    else coeff = at(coeffMonth - 1);
  }
  price = r6(price * coeff);
  Object.assign(steps, { coeff, coeffSource: own ? "單品覆寫" : "全域", afterCoeff: price });

  // ---- 下限 ----
  // 成本底線依庫齡放寬；市價下限以「原始市價」為基準（v8.6 以前誤用調整後市價，-5% 實際只低 0.25%），且不高於市價上限
  const fm = floorMarginFor(daysInStock, g);
  const minByMargin = fm.margin === null ? null : r6(cost * (1 + fm.margin));
  const marketFloor = market === null ? null : Math.min(r6(market * (1 + notBelowMarketPct)), adjustedMarket);
  const floor = Math.max(minByMargin ?? -Infinity, marketFloor ?? -Infinity);
  const ceil = adjustedMarket === null ? Infinity : adjustedMarket;
  Object.assign(steps, { floorTier: fm.tier, floorMargin: fm.margin, minByMargin, marketFloor, floor, ceil });

  if (minByMargin !== null && price < minByMargin) price = minByMargin;
  steps.afterMinMargin = price;
  if (marketFloor !== null && price < marketFloor) price = marketFloor;
  steps.afterMarketFloor = price;

  // ---- 取整（不破底線） ----
  let rounded = roundByMode(price, roundUnit, roundMode);
  if (rounded < floor - EPS) rounded = Math.ceil((floor - EPS) / roundUnit) * roundUnit;
  price = rounded;
  steps.afterRounding = price;

  // ---- 尾數（往下取、不破底線） ----
  if (tailStep(tailMode)) {
    let c = tailDown(price, tailMode);
    if (c < floor - EPS) c = tailUp(floor, tailMode);
    price = c;
  }
  steps.afterTail = price;

  // ---- 市價上限（最後關卡，與 v8.5 相同：上限優先） ----
  let conflict = false;
  if (price > ceil + EPS) {
    conflict = ceil < floor - EPS;
    const tidy = Math.max(0, tidyDown(ceil, roundUnit, tailMode));
    price = conflict || tidy >= floor - EPS ? tidy : Math.floor(ceil + EPS);
    steps.ceilApplied = true;
  }
  steps.afterCeil = price;
  if (conflict) warnings.push(`市價上限 ${fmtN(ceil)} 低於底線 ${fmtN(floor)}，已以市價上限計`);

  price = Math.max(0, Math.round(price));
  const profit = Math.round(price - cost);
  if (cost > 0 && price < cost) warnings.push(`低於成本 ${fmtN(cost - price)} 元（庫存 ${daysInStock} 天），需主管核准`);
  return { price, profit, steps, warnings, conflict };
}

// ============================================================
// 資料正規化
// ============================================================
function normalizeGlobals(g) {
  const d = defaultGlobals();
  const src = g && typeof g === "object" ? g : {};
  const out = { ...d };
  out.roundUnit = Math.max(1, numOr(src.roundUnit, d.roundUnit));
  out.roundMode = ["nearest", "ceil", "floor"].includes(src.roundMode) ? src.roundMode : d.roundMode;
  out.tailMode = ["none", "9", "99"].includes(String(src.tailMode)) ? String(src.tailMode) : d.tailMode;
  out.defaultMarketAdj = numOr(src.defaultMarketAdj, d.defaultMarketAdj);
  out.minMarginFloor = Math.max(0, numOr(src.minMarginFloor, d.minMarginFloor));
  out.notBelowMarketPct = numOr(src.notBelowMarketPct, d.notBelowMarketPct);
  if (Array.isArray(src.ladder)) {
    out.ladder = src.ladder.map((l) => ({ days: Number(l && l.days), adj: Number(l && l.adj) }))
      .filter((l) => Number.isFinite(l.days) && Number.isFinite(l.adj)).sort((a, b) => a.days - b.days);
  } else if (typeof src.ladder === "string") {
    out.ladder = parseLadder(src.ladder).ladder;
  }
  if (Array.isArray(src.monthlyCoeffs)) {
    const arr = src.monthlyCoeffs.slice(0, COEFF_MONTHS).map((v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 1; });
    while (arr.length < COEFF_MONTHS) arr.push(1);
    out.monthlyCoeffs = arr;
  }
  out.cumulativeMode = !!src.cumulativeMode;
  out.coeffBasis = src.coeffBasis === "recycle" ? "recycle" : "purchase";
  // 底線放寬：舊存檔沒有這些欄位 → 用預設；欄位存在但空白 → 視為停用該階（第二階毛利率空白 = 不設底線）
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
  const blankOrNum = (v) => (isBlank(v) || String(v).trim() === "" ? null : numOr(v, null));
  out.floorRelaxOn = has("floorRelaxOn") ? (typeof src.floorRelaxOn === "string" ? parseBoolCell(src.floorRelaxOn) : !!src.floorRelaxOn) : d.floorRelaxOn;
  out.floorTier1Days = has("floorTier1Days") ? blankOrNum(src.floorTier1Days) : d.floorTier1Days;
  out.floorTier1Margin = has("floorTier1Margin") ? (blankOrNum(src.floorTier1Margin) ?? 0) : d.floorTier1Margin;
  out.floorTier2Days = has("floorTier2Days") ? blankOrNum(src.floorTier2Days) : d.floorTier2Days;
  out.floorTier2Margin = has("floorTier2Margin") ? blankOrNum(src.floorTier2Margin) : d.floorTier2Margin;
  return out;
}
function normalizeItem(it) {
  const src = it && typeof it === "object" ? it : {};
  const numField = (v) => (isBlank(v) ? "" : (Number.isFinite(Number(v)) ? Number(v) : ""));
  const dateField = (v) => { const p = parseISODate(v); return p ? isoFromParts(p.y, p.m, p.d) : ""; };
  let coeffs = [];
  if (Array.isArray(src.monthlyCoeffs) && src.monthlyCoeffs.length) coeffs = parseCoeffRow(src.monthlyCoeffs.join(" ")) || [];
  else if (typeof src.monthlyCoeffs === "string" && src.monthlyCoeffs.trim()) coeffs = parseCoeffRow(src.monthlyCoeffs) || [];
  return {
    id: src.id ? String(src.id) : newId(),
    name: String(src.name ?? "").trim() || "未命名",
    category: CATEGORIES.includes(src.category) ? src.category : "OTH",
    purchaseDate: dateField(src.purchaseDate),
    date: dateField(src.date),
    cost: numField(src.cost),
    margin: numField(src.margin),
    market: numField(src.market),
    marketAdj: numField(src.marketAdj),
    repair: !!src.repair,
    repairNote: String(src.repairNote ?? ""),
    monthlyCoeffs: coeffs
  };
}
function seedItems() {
  const t = todayLocal();
  return [
    { name: "範例A｜電競筆電 15吋", category: "NB", purchaseDate: addMonthsISO(t, -4, -10), date: addMonthsISO(t, 0, -33), cost: 10000, margin: 0.20, market: "", marketAdj: "", repair: false, repairNote: "" },
    { name: "範例B｜商務筆電 14吋", category: "NB", purchaseDate: addMonthsISO(t, -9), date: addMonthsISO(t, 0, -14), cost: 10000, margin: 0.05, market: 11000, marketAdj: "", repair: false, repairNote: "" },
    { name: "範例C｜桌機 i7／RTX", category: "DT", purchaseDate: addMonthsISO(t, -16), date: addMonthsISO(t, 0, -86), cost: 20000, margin: 0.30, market: 26000, marketAdj: 0, repair: false, repairNote: "" },
    { name: "範例D｜剛滿 1 個月 → 第1月", category: "OTH", purchaseDate: addMonthsISO(t, -1), date: addMonthsISO(t, 0, -20), cost: 10000, margin: 0.10, market: "", marketAdj: "", repair: false, repairNote: "" },
    { name: "範例E｜27吋螢幕（未滿 1 個月）", category: "MON", purchaseDate: addMonthsISO(t, 0, -20), date: addMonthsISO(t, 0, -5), cost: 3000, margin: 0.25, market: "", marketAdj: "", repair: true, repairNote: "更換背光模組" }
  ].map(normalizeItem);
}

// ============================================================
// 存檔、復原、提示
// ============================================================
let saveTimer = null;
let storageOK = true;
function setSaveStatus(text, warn = false) {
  const el = $("#saveStatus");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("warn-text", warn);
}
function hhmm(d) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 250); }
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: APP_VERSION, savedAt: new Date().toISOString(), globals: state.globals, items: state.items }));
    storageOK = true;
    setSaveStatus(`已自動儲存 ${hhmm(new Date())}`);
  } catch (e) {
    storageOK = false;
    setSaveStatus("無法自動儲存（瀏覽器封鎖儲存空間）— 請用「下載備份」", true);
  }
}
function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return d && Array.isArray(d.items) ? d : null;
  } catch (e) { return null; }
}

let undoSnapshot = null;
let toastTimer = null;
function snapshot() { return JSON.parse(JSON.stringify({ globals: state.globals, items: state.items })); }
function withUndo(message, mutate) {
  const snap = snapshot();
  mutate();
  undoSnapshot = snap;
  showToast(message, true);
}
function doUndo() {
  if (!undoSnapshot) return;
  state.globals = normalizeGlobals(undoSnapshot.globals);
  state.items = undoSnapshot.items.map(normalizeItem);
  undoSnapshot = null;
  pushGlobalsToUI();
  render();
  scheduleSave();
  showToast("已復原");
}
function showToast(msg, undoable = false) {
  const t = $("#toast");
  if (!t) return;
  $("#toastMsg").textContent = msg;
  $("#toastUndo").hidden = !undoable;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, undoable ? 9000 : 3500);
}

// ============================================================
// 篩選
// ============================================================
function itemMatches(item, r) {
  const f = state.filter;
  if (f.category && item.category !== f.category) return false;
  const k = (f.keyword || "").trim().toLowerCase();
  if (k && !((item.name || "").toLowerCase().includes(k) || (item.repairNote || "").toLowerCase().includes(k))) return false;
  if (f.minDays !== null && r.steps.daysInStock < f.minDays) return false;
  if (f.repairOnly && !item.repair) return false;
  if (f.warnOnly && r.warnings.length === 0) return false;
  return true;
}
function filteredEntries(today = todayLocal()) {
  return state.items
    .map((item) => ({ item, r: computePrice(item, state.globals, today) }))
    .filter((e) => itemMatches(e.item, e.r));
}
function isFilterActive() {
  const f = state.filter;
  return !!(f.category || (f.keyword || "").trim() || f.minDays !== null || f.repairOnly || f.warnOnly);
}
function findItem(id) { return state.items.find((x) => x.id === id); }

// ============================================================
// 表格渲染
// ============================================================
function monthCell(n, isBasis) {
  const cls = isBasis ? "basis" : "";
  if (n === null) return `<span class="muted" title="無日期">—</span>`;
  if (n === 0) return `<span class="muted ${cls}" title="未滿 1 個月，不套係數">0</span>`;
  if (n > COEFF_MONTHS) return `<span class="${cls}" title="超過 ${COEFF_MONTHS} 個月，以第 ${COEFF_MONTHS} 月係數計">${n}</span>`;
  return `<span class="${cls}">${n}</span>`;
}
function computedCells(r) {
  const s = r.steps;
  const warnIcon = r.warnings.length
    ? ` <span class="warn-icon" title="${esc(r.warnings.join("\n"))}">⚠</span>`
    : "";
  return {
    days: s.hasRecycleDate ? String(s.daysInStock) : `<span class="muted">—</span>`,
    mP: monthCell(s.monthByPurchase, s.basisUsed === "purchase"),
    mR: monthCell(s.monthByRecycle, s.basisUsed === "recycle"),
    price: fmtN(r.price) + warnIcon,
    profit: `<span class="${r.profit < 0 ? "neg" : ""}">${fmtN(r.profit)}</span>`
  };
}
function floorLabel(s) {
  const g = state.globals;
  const tierTxt = s.floorTier === 1 ? `≥${g.floorTier1Days}天放寬` : s.floorTier === 2 ? `≥${g.floorTier2Days}天放寬` : "最低毛利";
  if (s.floorMargin === null) return `成本底線（${tierTxt}：不設，可低於成本）`;
  return `成本底線（${tierTxt} ${fmtPct(s.floorMargin)}）${fmtN(s.minByMargin)}`;
}
function diagHtml(r) {
  const s = r.steps;
  const step = (label, val, cls = "") => `<span class="dstep ${cls}"><span class="dl">${label}</span><span class="dv mono">${val}</span></span>`;
  const basisLabel = s.basisUsed === "purchase" ? "購買" : "回收";
  const parts = [
    step("市價調整後", fmtN(s.adjustedMarket)),
    step("初步（成本×(1+毛利率)）", fmtN(s.initial)),
    step(s.ladderDays !== null ? `階梯（≥${s.ladderDays}天 ${fmtPct(s.ladderAdj)}）` : "階梯（未達門檻）", fmtN(s.afterLadder)),
    step(s.coeffMonth > 0
      ? `月係數（${basisLabel}第${s.coeffMonth}月 ×${fmtCoeff(s.coeff)}${s.coeffSource === "單品覆寫" ? "・單品覆寫" : ""}）`
      : `月係數（${s.elapsed === null ? "無日期" : "未滿1月"}，不套）`, fmtN(s.afterCoeff)),
    step(floorLabel(s), fmtN(s.afterMinMargin), s.floorTier > 0 ? "hit" : ""),
    step(`市價下限 ${fmtN(s.marketFloor)}`, fmtN(s.afterMarketFloor)),
    step("取整", fmtN(s.afterRounding)),
    step("尾數", fmtN(s.afterTail)),
    step(`市價上限 ${fmtN(s.adjustedMarket)}`, fmtN(s.afterCeil), s.ceilApplied ? "hit" : ""),
    step("最終售價", fmtN(r.price), "final")
  ];
  const notes = s.notes.length ? `<div class="diag-note muted">ℹ ${esc(s.notes.join("；"))}</div>` : "";
  const warns = r.warnings.length ? `<div class="diag-note warn-text">⚠ ${esc(r.warnings.join("；"))}</div>` : "";
  return `<div class="diag-inner"><div class="diag-flow">${parts.join('<span class="arrow">→</span>')}</div>${notes}${warns}</div>`;
}
function numVal(v) { return isBlank(v) ? "" : esc(v); }
function rowHtml(e, i) {
  const { item, r } = e;
  const c = computedCells(r);
  const defAdj = numOr(state.globals.defaultMarketAdj, 0);
  const row = `
    <tr data-id="${esc(item.id)}" class="${r.warnings.length ? "has-warn" : ""}">
      <td class="mono muted idx">${i + 1}</td>
      <td class="namecol"><input class="cell cell-name" type="text" data-field="name" value="${esc(item.name)}" aria-label="名稱"/></td>
      <td><select class="cell" data-field="category" aria-label="分類">${CATEGORIES.map((cat) => `<option ${item.category === cat ? "selected" : ""}>${cat}</option>`).join("")}</select></td>
      <td><input class="cell cell-date" type="date" data-field="purchaseDate" value="${esc(item.purchaseDate)}" aria-label="購買日"/></td>
      <td><input class="cell cell-date" type="date" data-field="date" value="${esc(item.date)}" aria-label="回收日"/></td>
      <td class="mono" data-c="days">${c.days}</td>
      <td class="mono" data-c="mP">${c.mP}</td>
      <td class="mono" data-c="mR">${c.mR}</td>
      <td><input class="cell cell-num" type="number" step="1" data-field="cost" value="${numVal(item.cost)}" aria-label="成本"/></td>
      <td><input class="cell cell-pct" type="number" step="0.01" data-field="margin" value="${numVal(item.margin)}" aria-label="毛利率"/></td>
      <td><input class="cell cell-num" type="number" step="1" data-field="market" value="${numVal(item.market)}" placeholder="—" aria-label="市場價"/></td>
      <td><input class="cell cell-pct" type="number" step="0.01" data-field="marketAdj" value="${numVal(item.marketAdj)}" placeholder="${esc(defAdj)}" title="空白＝使用全域預設 ${esc(defAdj)}" aria-label="市價調整％"/></td>
      <td class="mono price" data-c="price">${c.price}</td>
      <td class="mono" data-c="profit">${c.profit}</td>
      <td class="center"><input type="checkbox" data-field="repair" ${item.repair ? "checked" : ""} aria-label="維修"/></td>
      <td><input class="cell cell-note" type="text" data-field="repairNote" value="${esc(item.repairNote)}" aria-label="備註"/></td>
      <td><input class="cell cell-coeff" type="text" data-field="monthlyCoeffs" value="${esc(item.monthlyCoeffs.length ? item.monthlyCoeffs.map(fmtCoeff).join(", ") : "")}" placeholder="用全域" aria-label="月係數覆寫"/></td>
      <td><button class="btn ghost small" data-action="delete" type="button">刪除</button></td>
    </tr>`;
  const diag = state.diagnostics ? `<tr class="diag-row" data-diag-for="${esc(item.id)}"><td colspan="18" data-c="diag">${diagHtml(r)}</td></tr>` : "";
  return row + diag;
}
function render() {
  const today = todayLocal();
  const entries = filteredEntries(today);
  const tbody = $("#itemsTable tbody");
  tbody.innerHTML = entries.map(rowHtml).join("");
  updateTotals(entries);
  $("#emptyHint").hidden = state.items.length > 0;
}
/** 只更新單一列的計算欄位（不重繪整表，避免編輯時游標跳掉） */
function refreshRow(tr, item) {
  const r = computePrice(item, state.globals, todayLocal());
  const c = computedCells(r);
  for (const key of Object.keys(c)) {
    const cell = tr.querySelector(`[data-c="${key}"]`);
    if (cell) cell.innerHTML = c[key];
  }
  tr.classList.toggle("has-warn", r.warnings.length > 0);
  const diag = tr.nextElementSibling;
  if (diag && diag.classList.contains("diag-row")) diag.querySelector("[data-c=diag]").innerHTML = diagHtml(r);
}
function updateTotals(entries) {
  if (!entries) {
    const today = todayLocal();
    const ids = Array.from(document.querySelectorAll("#itemsTable tbody tr[data-id]")).map((tr) => tr.dataset.id);
    entries = ids.map(findItem).filter(Boolean).map((item) => ({ item, r: computePrice(item, state.globals, today) }));
  }
  let sumCost = 0, sumPrice = 0, sumProfit = 0;
  for (const { item, r } of entries) { sumCost += numOr(item.cost, 0); sumPrice += r.price; sumProfit += r.profit; }
  $("#sumPrice").textContent = fmtN(sumPrice);
  $("#sumProfit").textContent = fmtN(sumProfit);
  $("#kpiCount").textContent = entries.length.toLocaleString("en-US");
  $("#kpiCost").textContent = fmtN(sumCost);
  $("#kpiPrice").textContent = fmtN(sumPrice);
  $("#kpiProfit").textContent = fmtN(sumProfit);
  $("#kpiMargin").textContent = sumPrice > 0 ? fmtPct(sumProfit / sumPrice) : "—";
  $("#filterCount").textContent = entries.length.toLocaleString("en-US");
  $("#totalCount").textContent = state.items.length.toLocaleString("en-US");
}

// ============================================================
// 全域參數 ↔ UI
// ============================================================
function pullGlobalsFromUI() {
  const g = state.globals;
  g.roundUnit = Math.max(1, numOr($("#roundUnit").value, 1));
  g.roundMode = $("#roundMode").value;
  g.tailMode = $("#tailMode").value;
  g.defaultMarketAdj = numOr($("#defaultMarketAdj").value, 0);
  g.minMarginFloor = Math.max(0, numOr($("#minMarginFloor").value, 0));
  g.notBelowMarketPct = numOr($("#notBelowMarketPct").value, 0);
  const lp = parseLadder($("#ladderInput").value);
  g.ladder = lp.ladder;
  showLadderWarn(lp);
  g.cumulativeMode = $("#cumulativeMode").checked;
  g.coeffBasis = $("#coeffBasis").value;
  const blankOrNum = (sel) => { const v = $(sel).value.trim(); return v === "" ? null : numOr(v, null); };
  g.floorRelaxOn = $("#floorRelaxOn").checked;
  g.floorTier1Days = blankOrNum("#floorTier1Days");
  g.floorTier1Margin = blankOrNum("#floorTier1Margin") ?? 0;
  g.floorTier2Days = blankOrNum("#floorTier2Days");
  g.floorTier2Margin = blankOrNum("#floorTier2Margin");
  showFloorWarn();
}
function showFloorWarn() {
  const g = state.globals, el = $("#floorWarn");
  if (!el) return;
  const msgs = [];
  if (g.floorRelaxOn) {
    if (g.floorTier1Days !== null && g.floorTier2Days !== null && g.floorTier2Days <= g.floorTier1Days) msgs.push("第二階天數應大於第一階");
    if (g.floorTier1Margin > Math.max(0, numOr(g.minMarginFloor, 0))) msgs.push("第一階底線高於基本底線，庫存越久反而越貴");
    if (g.floorTier2Margin !== null && g.floorTier2Margin > g.floorTier1Margin) msgs.push("第二階底線高於第一階");
  }
  el.textContent = msgs.join("；");
  el.hidden = msgs.length === 0;
  $$floorInputs().forEach((inp) => { inp.disabled = !g.floorRelaxOn; });
}
function $$floorInputs() {
  return ["#floorTier1Days", "#floorTier1Margin", "#floorTier2Days", "#floorTier2Margin"].map((s) => $(s)).filter(Boolean);
}
function showLadderWarn(lp) {
  const el = $("#ladderWarn");
  const msgs = [];
  if (lp.invalid.length) msgs.push(`無法解析、已略過：${lp.invalid.join("、")}`);
  if (lp.suspicious.length) msgs.push(`降幅看起來像百分比整數（請用 -0.05 表示 5%）：${lp.suspicious.join("、")}`);
  el.textContent = msgs.join("；");
  el.hidden = msgs.length === 0;
}
function pushGlobalsToUI() {
  const g = state.globals;
  $("#roundUnit").value = g.roundUnit;
  $("#roundMode").value = g.roundMode;
  $("#tailMode").value = g.tailMode;
  $("#defaultMarketAdj").value = g.defaultMarketAdj;
  $("#minMarginFloor").value = g.minMarginFloor;
  $("#notBelowMarketPct").value = g.notBelowMarketPct;
  $("#ladderInput").value = g.ladder.map((x) => `${x.days}/${x.adj}`).join(",");
  showLadderWarn(parseLadder($("#ladderInput").value));
  $("#cumulativeMode").checked = !!g.cumulativeMode;
  $("#coeffBasis").value = g.coeffBasis;
  const show = (v) => (v === null || v === undefined ? "" : v);
  $("#floorRelaxOn").checked = !!g.floorRelaxOn;
  $("#floorTier1Days").value = show(g.floorTier1Days);
  $("#floorTier1Margin").value = show(g.floorTier1Margin);
  $("#floorTier2Days").value = show(g.floorTier2Days);
  $("#floorTier2Margin").value = show(g.floorTier2Margin);
  showFloorWarn();
  buildCoeffGrid();
}
function buildCoeffGrid() {
  const grid = $("#coeffGrid");
  grid.innerHTML = state.globals.monthlyCoeffs.map((v, i) => `
    <div class="form-row">
      <label for="coeff${i + 1}">${i + 1} 月</label>
      <input id="coeff${i + 1}" type="number" step="0.01" min="0" data-coeff-index="${i}" value="${fmtCoeff(v)}"/>
    </div>`).join("");
}

// ---- 階梯生成 ----
function buildGeneratedLadder() {
  const s = Math.round(numOr($("#genStartMonth").value, NaN));
  const e = Math.round(numOr($("#genEndMonth").value, NaN));
  const p = numOr($("#genPerMonthPct").value, NaN);
  const mode = $("#genMode").value;
  if (!Number.isFinite(s) || !Number.isFinite(e) || s < 1 || e < 1) return { error: "起始月／結束月需為 ≥1 的整數" };
  if (e < s) return { error: "結束月不可小於起始月" };
  if (!Number.isFinite(p)) return { error: "請輸入每月調整％" };
  if (e - s > 60) return { error: "區間過長（最多 60 個月）" };
  const parts = [];
  let clamped = false;
  for (let m = s; m <= e; m++) {
    const k = m - s + 1;
    let adj = mode === "compound" ? Math.pow(1 + p, k) - 1 : p * k;
    if (adj < -0.95) { adj = -0.95; clamped = true; }
    adj = Math.round(adj * 10000) / 10000;
    parts.push({ days: m * 30, adj });
  }
  return { parts, clamped };
}
function updateGenPreview() {
  const out = buildGeneratedLadder();
  const el = $("#genPreview");
  if (out.error) { el.textContent = `⚠ ${out.error}`; return; }
  const list = out.parts;
  const show = list.length > 6 ? [...list.slice(0, 3), null, ...list.slice(-2)] : list;
  el.textContent = "預覽：" + show.map((x) => (x ? `${x.days}天 ${fmtPct(x.adj)}` : "…")).join("、") + (out.clamped ? "（降幅上限 -95%）" : "");
}

// ============================================================
// Excel／CSV
// ============================================================
const ITEM_COLUMNS = [
  { key: "name", label: "名稱", aliases: ["品名", "商品名稱", "商品", "name"] },
  { key: "category", label: "分類", aliases: ["類別", "category"] },
  { key: "purchaseDate", label: "購買日", aliases: ["購買日(原購)", "購買日（原購）", "原購日", "原購買日", "purchasedate"] },
  { key: "date", label: "回收日", aliases: ["回收日(入庫)", "回收日（入庫）", "入庫日", "date", "recycledate"] },
  { key: "cost", label: "成本", aliases: ["回收成本", "回收價", "cost"] },
  { key: "margin", label: "毛利率", aliases: ["margin"] },
  { key: "market", label: "市場價", aliases: ["市價", "market"] },
  { key: "marketAdj", label: "市價調整％", aliases: ["市價調整%", "單品市價調整％", "單品市價調整%", "marketadj"] },
  { key: "repair", label: "維修", aliases: ["有維修紀錄", "維修紀錄", "repair"] },
  { key: "repairNote", label: "維修備註", aliases: ["備註", "repairnote", "note"] },
  { key: "monthlyCoeffs", label: "月係數覆寫", aliases: ["月係數", "monthlycoeffs"] }
];
const COMPUTED_HEADERS = ["庫存天數", "第N月(購買)", "第N月(回收)", "最終售價", "毛利額", "警示"];
const GLOBAL_FIELDS = [
  { key: "roundUnit", label: "四捨五入單位", note: "≥1 的整數" },
  { key: "roundMode", label: "四捨五入方式", note: "nearest（四捨五入）／ceil（進位）／floor（捨去）" },
  { key: "tailMode", label: "尾數優化", note: "none／9／99（往下取、不破底線）" },
  { key: "defaultMarketAdj", label: "預設市價調整％", note: "例 0.05" },
  { key: "minMarginFloor", label: "最低毛利率底線", note: "例 0.10" },
  { key: "notBelowMarketPct", label: "不得低於市場價X％", note: "例 -0.05" },
  { key: "ladder", label: "逾期降價階梯", note: "天數/百分比，逗號分隔，例 30/-0.05,60/-0.10" },
  { key: "coeffBasis", label: "係數月序基準", note: "purchase（購買日）／recycle（回收日）" },
  { key: "cumulativeMode", label: "累積降幅模式", note: "TRUE／FALSE" },
  { key: "floorRelaxOn", label: "底線依庫齡放寬", note: "TRUE／FALSE" },
  { key: "floorTier1Days", label: "放寬第一階天數", note: "庫存 ≥ 此天數，例 90；空白 = 不用此階" },
  { key: "floorTier1Margin", label: "第一階底線毛利率", note: "0 = 成本" },
  { key: "floorTier2Days", label: "放寬第二階天數", note: "庫存 ≥ 此天數，例 180；空白 = 不用此階" },
  { key: "floorTier2Margin", label: "第二階底線毛利率", note: "空白 = 不設底線（可低於成本）；-0.2 = 成本 8 折" }
];

function normHeader(h) {
  return String(h ?? "").trim().toLowerCase()
    .replace(/[\s_]/g, "").replace(/％/g, "%").replace(/（/g, "(").replace(/）/g, ")");
}
const HEADER_MAP = (() => {
  const m = new Map();
  for (const col of ITEM_COLUMNS) for (const a of [col.label, ...col.aliases]) m.set(normHeader(a), col.key);
  return m;
})();
const CATEGORY_ALIASES = {
  NB: ["nb", "筆電", "筆記型電腦", "筆記電腦", "notebook", "laptop"],
  DT: ["dt", "桌機", "桌上型", "桌上型電腦", "desktop", "pc"],
  MON: ["mon", "螢幕", "顯示器", "monitor"],
  DIY: ["diy", "零組件", "零件", "組件"],
  OTH: ["oth", "其他", "other"]
};
function parseCategory(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return { value: "OTH", ok: true };
  for (const [cat, list] of Object.entries(CATEGORY_ALIASES)) if (list.includes(s)) return { value: cat, ok: true };
  return { value: "OTH", ok: false };
}
function parseNumberCell(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v ?? "").trim().replace(/^NT\$|^\$|元$/gi, "").replace(/[,，\s]/g, "");
  if (!s) return "";
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function parsePctCell(v) {
  if (typeof v === "string" && /%|％/.test(v)) {
    const n = Number(v.replace(/[%％\s]/g, ""));
    return Number.isFinite(n) ? Math.round(n * 1e6) / 1e8 : null;
  }
  return parseNumberCell(v);
}
function parseBoolCell(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return ["是", "有", "y", "yes", "true", "1", "v", "✓", "✔", "o"].includes(String(v ?? "").trim().toLowerCase());
}
function excelSerialToISO(n) {
  if (!(n > 0 && n < 2958466)) return "";
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
  return isoFromParts(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}
/** 回傳 ISO 日期字串；空白回傳 ""；無法辨識回傳 null */
function parseDateCell(v) {
  if (v === null || v === undefined || v === "") return "";
  if (v instanceof Date && !isNaN(v)) return isoFromParts(v.getFullYear(), v.getMonth() + 1, v.getDate()) || null;
  if (typeof v === "number") {
    if (v >= 19000101 && v <= 29991231) return isoFromParts(Math.floor(v / 10000), Math.floor(v / 100) % 100, v % 100) || null;
    return excelSerialToISO(v) || null;
  }
  const s = String(v).trim();
  if (!s) return "";
  let m = /^(\d{2,4})\s*[\/\-.年]\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})/.exec(s);
  if (m) {
    let y = +m[1];
    if (y < 1000) y += 1911; // 民國年
    return isoFromParts(y, +m[2], +m[3]) || null;
  }
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return isoFromParts(+m[1], +m[2], +m[3]) || null;
  if (/^\d+(\.\d+)?$/.test(s)) return excelSerialToISO(Number(s)) || null;
  return null;
}
/** 簡易 CSV 解析（支援引號、逗號、換行） */
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", i = 0, q = false;
  while (i < text.length) {
    const ch = text[i];
    if (q) {
      if (ch === "\"") { if (text[i + 1] === "\"") { field += "\""; i += 2; continue; } q = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === "\"") { q = true; i++; continue; }
    if (ch === ",") { row.push(field); field = ""; i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += ch; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function rowsToItems(rows) {
  const warnings = [];
  let headerIdx = -1, colMap = null;
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const map = {};
    (rows[r] || []).forEach((h, c) => { const key = HEADER_MAP.get(normHeader(h)); if (key && !(key in map)) map[key] = c; });
    const n = Object.keys(map).length;
    if (n >= 2 && ("name" in map || "cost" in map)) { headerIdx = r; colMap = map; break; }
  }
  if (headerIdx < 0) throw new Error("找不到欄位標題列（至少需要「名稱」或「成本」，以及其他任一欄位）");
  const items = [];
  let blank = 0;
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const get = (key) => (key in colMap ? row[colMap[key]] : "");
    const lineNo = r + 1;
    const raw = Object.fromEntries(Object.keys(colMap).map((k) => [k, get(k)]));
    if (Object.values(raw).every((v) => v === "" || v === null || v === undefined || String(v).trim() === "")) { blank++; continue; }
    const w = (msg) => warnings.push(`第 ${lineNo} 列：${msg}`);

    const item = {};
    item.name = String(raw.name ?? "").trim();
    if (!item.name) { item.name = "未命名"; w("名稱空白，設為「未命名」"); }
    const cat = parseCategory(raw.category);
    item.category = cat.value;
    if (!cat.ok) w(`分類「${raw.category}」無法辨識，設為 OTH`);
    for (const [key, label] of [["purchaseDate", "購買日"], ["date", "回收日"]]) {
      const d = parseDateCell(raw[key]);
      if (d === null) { w(`${label}「${raw[key]}」無法辨識，已留空`); item[key] = ""; } else item[key] = d;
    }
    for (const [key, label, parser] of [["cost", "成本", parseNumberCell], ["margin", "毛利率", parsePctCell], ["market", "市場價", parseNumberCell], ["marketAdj", "市價調整％", parsePctCell]]) {
      const n = parser(raw[key]);
      if (n === null) { w(`${label}「${raw[key]}」不是數字，已留空`); item[key] = ""; } else item[key] = n;
    }
    if (item.cost === "" && String(raw.cost ?? "").trim() === "") w("成本空白");
    if (typeof item.margin === "number" && item.margin >= 1) w(`毛利率 ${item.margin} ≥ 100%，請確認是否應為 ${item.margin / 100}`);
    item.repair = parseBoolCell(raw.repair);
    item.repairNote = String(raw.repairNote ?? "").trim();
    const coeffRaw = String(raw.monthlyCoeffs ?? "").trim();
    if (coeffRaw) {
      const arr = parseCoeffRow(coeffRaw);
      if (arr) item.monthlyCoeffs = arr; else { w("月係數覆寫格式錯誤，已略過"); item.monthlyCoeffs = []; }
    } else item.monthlyCoeffs = [];
    items.push(normalizeItem(item));
  }
  return { items, warnings, blank, headerRow: headerIdx + 1 };
}
function rowsToGlobals(rows) {
  const byKey = new Map();
  const labelToKey = new Map(GLOBAL_FIELDS.map((f) => [normHeader(f.label), f.key]));
  for (let i = 1; i <= COEFF_MONTHS; i++) labelToKey.set(normHeader(`第${i}月係數`), `coeff${i}`);
  for (const row of rows.slice(1)) {
    if (!row) continue;
    const code = String(row[2] ?? "").trim();
    const key = code || labelToKey.get(normHeader(row[0]));
    if (key) byKey.set(key, row[1]);
  }
  const g = { ...state.globals, monthlyCoeffs: state.globals.monthlyCoeffs.slice() };
  for (const f of GLOBAL_FIELDS) {
    if (!byKey.has(f.key)) continue;
    const v = byKey.get(f.key);
    if (f.key === "cumulativeMode" || f.key === "floorRelaxOn") g[f.key] = parseBoolCell(v);
    else if (f.key === "ladder") g.ladder = String(v ?? "");
    else g[f.key] = typeof v === "string" ? v.trim() : v;
  }
  for (let i = 1; i <= COEFF_MONTHS; i++) {
    if (byKey.has(`coeff${i}`)) { const n = Number(byKey.get(`coeff${i}`)); if (Number.isFinite(n) && n > 0) g.monthlyCoeffs[i - 1] = n; }
  }
  return normalizeGlobals(g);
}

function cellValueForExport(item, key) {
  const v = item[key];
  if (key === "repair") return v ? "是" : "";
  if (key === "monthlyCoeffs") return Array.isArray(v) && v.length ? v.join(", ") : "";
  return v === undefined || v === null ? "" : v;
}
function itemsToAoa(items, includeComputed) {
  const today = todayLocal();
  const head = ITEM_COLUMNS.map((c) => c.label).concat(includeComputed ? COMPUTED_HEADERS : []);
  const body = items.map((item) => {
    const base = ITEM_COLUMNS.map((c) => cellValueForExport(item, c.key));
    if (!includeComputed) return base;
    const r = computePrice(item, state.globals, today);
    const s = r.steps;
    return base.concat([s.hasRecycleDate ? s.daysInStock : "", s.monthByPurchase ?? "", s.monthByRecycle ?? "", r.price, r.profit, r.warnings.join("；")]);
  });
  return [head, ...body];
}
function globalsToAoa() {
  const g = state.globals;
  const rows = [["參數", "值", "代碼", "說明"]];
  for (const f of GLOBAL_FIELDS) {
    let v = g[f.key];
    if (f.key === "ladder") v = g.ladder.map((x) => `${x.days}/${x.adj}`).join(",");
    if (f.key === "cumulativeMode" || f.key === "floorRelaxOn") v = g[f.key] ? "TRUE" : "FALSE";
    if (v === null || v === undefined) v = "";
    rows.push([f.label, v, f.key, f.note]);
  }
  g.monthlyCoeffs.forEach((v, i) => rows.push([`第${i + 1}月係數`, v, `coeff${i + 1}`, i === 0 ? "滿 N 個月套第 N 月；未滿 1 個月不套" : ""]));
  return rows;
}
function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}
function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function requireXLSX() {
  if (typeof XLSX === "undefined") {
    showToast("Excel 函式庫尚未載入（需連網）；可先改用 CSV");
    return false;
  }
  return true;
}
function sheetFromAoa(aoa, widths) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  if (widths) ws["!cols"] = widths.map((w) => ({ wch: w }));
  return ws;
}
const ITEM_WIDTHS = [28, 6, 12, 12, 10, 8, 10, 10, 6, 24, 40];
function exportXLSX() {
  if (!requireXLSX()) return;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheetFromAoa(itemsToAoa(state.items, true), ITEM_WIDTHS.concat([8, 10, 10, 10, 10, 40])), "回收清單");
  XLSX.utils.book_append_sheet(wb, sheetFromAoa(globalsToAoa(), [20, 28, 18, 44]), "全域參數");
  XLSX.writeFile(wb, `usedpc_清單_${stamp()}.xlsx`);
  showToast(`已匯出 ${state.items.length} 筆（含全域參數工作表）`);
}
function exportTemplate() {
  if (!requireXLSX()) return;
  const today = todayLocal();
  const sample = [
    ITEM_COLUMNS.map((c) => c.label),
    ["ROG Strix G16 電競筆電", "NB", addMonthsISO(today, -10), addMonthsISO(today, 0, -7), 28000, 0.2, 36000, "", "", "", ""],
    ["27吋 IPS 螢幕", "螢幕", "114/03/15", addMonthsISO(today, 0, -40), 3500, "25%", "", "", "是", "更換背光模組", "1 1 0.98 0.96 0.95"]
  ];
  const help = [
    ["欄位", "必填", "格式／說明"],
    ["名稱", "建議", "文字"],
    ["分類", "", "NB／DT／MON／DIY／OTH，也可寫 筆電、桌機、螢幕、零組件、其他；空白或無法辨識為 OTH"],
    ["購買日", "", "原購日期。2025-08-04、2025/8/4、民國 114/8/4、20250804 或 Excel 日期皆可"],
    ["回收日", "建議", "入庫日期，用來算庫存天數與逾期階梯；格式同上"],
    ["成本", "是", "數字，可含千分位逗號"],
    ["毛利率", "", "0.2 或 20%（售價 = 成本 × (1+毛利率)）"],
    ["市場價", "", "數字，可空"],
    ["市價調整％", "", "0.05 或 5%；空白則用全域預設"],
    ["維修", "", "是／有／Y／1 表示有維修紀錄，其餘視為無"],
    ["維修備註", "", "文字"],
    ["月係數覆寫", "", "1–18 月係數，用逗號或空白分隔；不足 18 個會以最後一個補齊；空白則用全域"],
    ["", "", ""],
    ["匯入說明", "", "系統依第一列標題辨識欄位，順序不拘；「最終售價」「毛利額」等計算欄位會略過並重新計算"],
    ["", "", "勾選「一併匯入全域參數」時，會讀取「全域參數」工作表（代碼欄為準）"]
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheetFromAoa(sample, ITEM_WIDTHS), "回收清單");
  XLSX.utils.book_append_sheet(wb, sheetFromAoa(globalsToAoa(), [20, 28, 18, 44]), "全域參數");
  XLSX.utils.book_append_sheet(wb, sheetFromAoa(help, [14, 6, 90]), "說明");
  XLSX.writeFile(wb, "usedpc_匯入範本.xlsx");
  showToast("已下載匯入範本");
}
function exportCSV() {
  const aoa = itemsToAoa(state.items, true);
  const csv = aoa.map((r) => r.map((v) => {
    const s = String(v ?? "");
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, "\"\"")}"` : s;
  }).join(",")).join("\r\n");
  downloadBlob(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }), `usedpc_清單_${stamp()}.csv`);
  showToast(`已匯出 ${state.items.length} 筆 CSV`);
}
function showImportReport(lines, isError = false) {
  const el = $("#importReport");
  el.hidden = false;
  el.classList.toggle("error", isError);
  el.innerHTML = lines.map((l) => `<div>${l}</div>`).join("");
}
async function importSpreadsheet(file) {
  let rows, globalsRows = null;
  if (/\.csv$/i.test(file.name)) {
    rows = parseCSV((await file.text()).replace(/^﻿/, ""));
  } else {
    if (!requireXLSX()) return;
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const sheetName = wb.SheetNames.find((n) => n.trim() === "回收清單") || wb.SheetNames[0];
    rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: "" });
    const gName = wb.SheetNames.find((n) => n.trim() === "全域參數");
    if (gName) globalsRows = XLSX.utils.sheet_to_json(wb.Sheets[gName], { header: 1, raw: true, defval: "" });
  }
  const res = rowsToItems(rows);
  const wantGlobals = $("#importGlobals").checked;
  const mode = $("#importMode").value;
  const report = [`<b>${esc(file.name)}</b>：讀到 ${res.items.length} 筆${res.blank ? `，略過空白列 ${res.blank} 列` : ""}（標題在第 ${res.headerRow} 列）`];
  if (wantGlobals) report.push(globalsRows ? "已一併匯入「全域參數」工作表" : "檔案中沒有「全域參數」工作表，全域參數未變更");
  if (res.warnings.length) {
    report.push(`<span class="warn-text">⚠ ${res.warnings.length} 項需要確認：</span>`);
    res.warnings.slice(0, 20).forEach((w) => report.push(`・${esc(w)}`));
    if (res.warnings.length > 20) report.push(`…另有 ${res.warnings.length - 20} 項`);
  }
  if (res.items.length === 0 && !(wantGlobals && globalsRows)) {
    showImportReport(report.concat(["沒有可匯入的資料，清單未變更"]), true);
    showToast("檔案中沒有可匯入的資料");
    return;
  }
  withUndo(`已匯入 ${res.items.length} 筆${mode === "replace" ? "（取代原清單）" : ""}`, () => {
    if (mode === "replace") state.items = res.items;
    else state.items.push(...res.items);
    if (wantGlobals && globalsRows) state.globals = rowsToGlobals(globalsRows);
  });
  showImportReport(report);
  pushGlobalsToUI();
  render();
  scheduleSave();
}
function exportJSON() {
  const data = { app: "SINYA USEDPC Dashboard", version: APP_VERSION, exportedAt: new Date().toISOString(), globals: state.globals, items: state.items };
  downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), `usedpc_備份_${stamp()}.json`);
  showToast(`已下載備份（${state.items.length} 筆＋全域參數）`);
}
async function importJSON(file) {
  const data = JSON.parse(await file.text());
  if (!data || !Array.isArray(data.items)) throw new Error("不是有效的備份檔（缺少 items）");
  withUndo(`已從備份還原 ${data.items.length} 筆`, () => {
    state.items = data.items.map(normalizeItem);
    if (data.globals) state.globals = normalizeGlobals(data.globals);
  });
  pushGlobalsToUI();
  render();
  scheduleSave();
}

// ============================================================
// 事件
// ============================================================
function onItemChange(e) {
  const el = e.target;
  const field = el.dataset && el.dataset.field;
  if (!field) return;
  const tr = el.closest("tr[data-id]");
  const item = tr && findItem(tr.dataset.id);
  if (!item) return;
  switch (field) {
    case "cost": case "margin": case "market": case "marketAdj":
      item[field] = el.value.trim() === "" ? "" : numOr(el.value, "");
      break;
    case "repair":
      item.repair = el.checked;
      break;
    case "monthlyCoeffs": {
      const raw = el.value.trim();
      if (!raw) { item.monthlyCoeffs = []; el.classList.remove("invalid"); break; }
      const arr = parseCoeffRow(raw);
      if (!arr) { el.classList.add("invalid"); showToast("月係數格式錯誤（需為正數，以逗號或空白分隔），未套用"); return; }
      item.monthlyCoeffs = arr;
      el.value = arr.map(fmtCoeff).join(", ");
      el.classList.remove("invalid");
      break;
    }
    case "name":
      item.name = el.value.trim() || "未命名";
      el.value = item.name;
      break;
    default:
      item[field] = el.value;
  }
  refreshRow(tr, item);
  updateTotals();
  scheduleSave();
}
function onTableClick(e) {
  const btn = e.target.closest("[data-action=delete]");
  if (!btn) return;
  const tr = btn.closest("tr[data-id]");
  const item = tr && findItem(tr.dataset.id);
  if (!item) return;
  withUndo(`已刪除「${item.name}」`, () => { state.items = state.items.filter((x) => x.id !== item.id); });
  render();
  scheduleSave();
}
function onGlobalChange() { pullGlobalsFromUI(); render(); scheduleSave(); }

function readFilterFromUI() {
  const md = $("#filterMinDays").value.trim();
  state.filter = {
    category: $("#filterCategory").value,
    keyword: $("#searchKeyword").value,
    minDays: md === "" || !Number.isFinite(Number(md)) ? null : Number(md),
    repairOnly: $("#filterRepair").checked,
    warnOnly: $("#filterWarn").checked
  };
  render();
}

function bindEvents() {
  const tbody = $("#itemsTable tbody");
  on(tbody, "change", onItemChange);
  on(tbody, "click", onTableClick);

  // 全域參數：文字／數字即時、選單／勾選在 change
  ["#roundUnit", "#defaultMarketAdj", "#minMarginFloor", "#notBelowMarketPct", "#ladderInput",
    "#floorTier1Days", "#floorTier1Margin", "#floorTier2Days", "#floorTier2Margin"].forEach((sel) => on(sel, "input", onGlobalChange));
  ["#roundMode", "#tailMode", "#cumulativeMode", "#coeffBasis", "#floorRelaxOn"].forEach((sel) => on(sel, "change", onGlobalChange));
  on("#roundUnit", "change", () => { $("#roundUnit").value = state.globals.roundUnit; });

  // 月係數格
  on("#coeffGrid", "input", (e) => {
    const idx = Number(e.target.dataset.coeffIndex);
    if (!Number.isInteger(idx)) return;
    const v = Number(e.target.value);
    state.globals.monthlyCoeffs[idx] = e.target.value.trim() !== "" && Number.isFinite(v) && v > 0 ? v : 1;
    render();
    scheduleSave();
  });
  on("#coeffGrid", "change", (e) => {
    const idx = Number(e.target.dataset.coeffIndex);
    if (Number.isInteger(idx)) e.target.value = fmtCoeff(state.globals.monthlyCoeffs[idx]);
  });
  const getPasteCoeffs = () => {
    const arr = parseCoeffRow($("#coeffPaste").value);
    if (!arr) showToast("無法解析係數：請輸入正數，以逗號或空白分隔");
    return arr;
  };
  on("#btnCoeffPasteGlobal", "click", () => {
    const arr = getPasteCoeffs(); if (!arr) return;
    withUndo("已套用到全域 1–18 月係數", () => { state.globals.monthlyCoeffs = arr; });
    buildCoeffGrid(); render(); scheduleSave();
  });
  on("#btnCoeffPasteItems", "click", () => {
    const arr = getPasteCoeffs(); if (!arr) return;
    const entries = filteredEntries();
    if (!entries.length) { showToast("目前篩選結果沒有資料"); return; }
    withUndo(`已覆寫 ${entries.length} 筆單品的月係數`, () => { entries.forEach(({ item }) => { item.monthlyCoeffs = arr.slice(); }); });
    render(); scheduleSave();
  });
  on("#btnCoeffReset", "click", () => {
    withUndo("全域月係數已重置為 1.00", () => { state.globals.monthlyCoeffs = Array.from({ length: COEFF_MONTHS }, () => 1); });
    buildCoeffGrid(); render(); scheduleSave();
  });

  // 階梯生成
  ["#genStartMonth", "#genEndMonth", "#genPerMonthPct", "#genMode"].forEach((sel) => { on(sel, "input", updateGenPreview); on(sel, "change", updateGenPreview); });
  on("#btnGenLadder", "click", () => {
    const out = buildGeneratedLadder();
    if (out.error) { showToast(out.error); return; }
    withUndo(`已生成 ${out.parts.length} 階並套用`, () => {
      $("#ladderInput").value = out.parts.map((x) => `${x.days}/${x.adj}`).join(",");
      pullGlobalsFromUI();
    });
    render(); scheduleSave();
  });

  // 新增
  const toggleRepairNoteRow = () => { $("#repairNoteRow").style.display = $("#newRepair").checked ? "" : "none"; };
  on("#newRepair", "change", toggleRepairNoteRow);
  on("#btnAdd", "click", () => {
    const it = normalizeItem({
      name: $("#newName").value.trim() || "未命名",
      category: $("#newCategory").value,
      purchaseDate: $("#newPurchaseDate").value || "",
      date: $("#newDate").value || toISODate(todayLocal()),
      cost: $("#newCost").value === "" ? "" : Number($("#newCost").value),
      margin: $("#newMargin").value === "" ? "" : Number($("#newMargin").value),
      market: $("#newMarket").value === "" ? "" : Number($("#newMarket").value),
      marketAdj: $("#newMarketAdj").value === "" ? "" : Number($("#newMarketAdj").value),
      repair: $("#newRepair").checked,
      repairNote: $("#newRepair").checked ? $("#newRepairNote").value.trim() : ""
    });
    state.items.push(it);
    ["#newName", "#newPurchaseDate", "#newCost", "#newMargin", "#newMarket", "#newMarketAdj", "#newRepairNote"].forEach((sel) => { $(sel).value = ""; });
    $("#newDate").value = toISODate(todayLocal());
    $("#newRepair").checked = false;
    toggleRepairNoteRow();
    render();
    scheduleSave();
    const hidden = !itemMatches(it, computePrice(it, state.globals, todayLocal()));
    showToast(`已加入「${it.name}」${hidden ? "（不符合目前篩選，暫未顯示）" : ""}`);
  });

  // 篩選
  let kwTimer = null;
  on("#filterCategory", "change", readFilterFromUI);
  on("#searchKeyword", "input", () => { clearTimeout(kwTimer); kwTimer = setTimeout(readFilterFromUI, 150); });
  on("#filterMinDays", "input", readFilterFromUI);
  on("#filterRepair", "change", readFilterFromUI);
  on("#filterWarn", "change", readFilterFromUI);
  on("#btnClearFilter", "click", () => {
    $("#filterCategory").value = "";
    $("#searchKeyword").value = "";
    $("#filterMinDays").value = "";
    $("#filterRepair").checked = false;
    $("#filterWarn").checked = false;
    readFilterFromUI();
  });

  // 批次
  on("#btnBatchApply", "click", () => {
    const m = $("#batchMargin").value.trim();
    const a = $("#batchMarketAdj").value.trim();
    const c = $("#batchCategory").value;
    if (m === "" && a === "" && !c) { showToast("請先填入要批次變更的欄位"); return; }
    const entries = filteredEntries();
    if (!entries.length) { showToast("目前篩選結果沒有資料"); return; }
    withUndo(`已批次更新 ${entries.length} 筆`, () => {
      for (const { item } of entries) {
        if (m !== "") item.margin = Number(m);
        if (a !== "") item.marketAdj = Number(a);
        if (c) item.category = c;
      }
    });
    render(); scheduleSave();
  });
  on("#btnBatchClearCoeffs", "click", () => {
    const entries = filteredEntries().filter(({ item }) => item.monthlyCoeffs.length);
    if (!entries.length) { showToast("篩選結果中沒有單品覆寫月係數"); return; }
    withUndo(`已清除 ${entries.length} 筆的月係數覆寫`, () => { entries.forEach(({ item }) => { item.monthlyCoeffs = []; }); });
    render(); scheduleSave();
  });
  on("#btnBatchDelete", "click", () => {
    const entries = filteredEntries();
    if (!entries.length) { showToast("目前篩選結果沒有資料"); return; }
    const ids = new Set(entries.map((e) => e.item.id));
    withUndo(`已刪除 ${ids.size} 筆${isFilterActive() ? "" : "（未設篩選＝全部）"}`, () => { state.items = state.items.filter((x) => !ids.has(x.id)); });
    render(); scheduleSave();
  });

  // 匯入匯出
  on("#btnExportXLSX", "click", exportXLSX);
  on("#btnExportCSV", "click", exportCSV);
  on("#btnTemplate", "click", exportTemplate);
  on("#btnExportJSON", "click", exportJSON);
  on("#fileImport", "change", async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try { await importSpreadsheet(file); }
    catch (err) { showImportReport([`<b>${esc(file.name)}</b> 匯入失敗：${esc(err.message || err)}`], true); showToast("匯入失敗，清單未變更"); }
  });
  on("#fileImportJSON", "change", async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try { await importJSON(file); }
    catch (err) { showToast(`還原失敗：${err.message || err}`); }
  });
  on("#btnLoadSample", "click", () => {
    withUndo("已改用範例資料", () => { state.items = seedItems(); });
    render(); scheduleSave();
  });
  on("#btnClearAll", "click", () => {
    if (!state.items.length) { showToast("清單已經是空的"); return; }
    withUndo(`已清空 ${state.items.length} 筆`, () => { state.items = []; });
    render(); scheduleSave();
  });

  // 其他
  on("#toastUndo", "click", doUndo);
  on("#toggleDiagnostics", "change", (e) => { state.diagnostics = e.target.checked; render(); });
  window.addEventListener("beforeunload", () => { if (saveTimer) saveNow(); });
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY) setSaveStatus("另一個分頁已修改資料 — 重新整理以載入最新版", true);
  });
}

function init() {
  const saved = loadSaved();
  if (saved) {
    state.globals = normalizeGlobals(saved.globals);
    state.items = saved.items.map(normalizeItem);
    const t = saved.savedAt ? new Date(saved.savedAt) : null;
    setSaveStatus(t && !isNaN(t) ? `已載入上次存檔（${t.getMonth() + 1}/${t.getDate()} ${hhmm(t)}）` : "已載入上次存檔");
  } else {
    state.globals = defaultGlobals();
    state.items = seedItems();
    setSaveStatus("目前為範例資料（變更會自動儲存）");
  }
  pushGlobalsToUI();
  bindEvents();
  updateGenPreview();
  $("#newDate").value = toISODate(todayLocal());
  render();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
