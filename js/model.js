// SINYA USEDPC — 資料模型：定價政策、商品欄位、庫存編號、舊版（v8）資料升級、範例資料
import {
  CATEGORIES, CATEGORY_LABELS, GRADES, COEFF_MONTHS, isBlank, numOr, parseISODate, isoFromParts,
  toISODate, todayLocal, addDaysISO, addMonthsISO, normalizeLadder, parseCoeffRow, fmtPct, fmtFactor,
  markupToMargin
} from "./pricing.js";

export const APP_VERSION = "9.0";

// ============================================================
// 定價政策
// ============================================================
export function defaultPolicy() {
  return {
    roundUnit: 10,
    roundMode: "nearest",
    tailMode: "9",
    storePremium: 0.05,          // 門市加成（相對品況市價）
    marketStaleDays: 30,         // 市價有效天數
    defaultTargetMargin: 0.15,   // 沒有參考市價時的目標毛利率（毛利 ÷ 售價）
    minMargin: 0.10,             // 基本成本底線：毛利率 ≥ 10%
    floorRelaxOn: true,
    floorTier1Days: 90,
    floorTier1CostPct: 1.0,      // ≥90 天：最低到成本
    floorTier2Days: 180,
    floorTier2CostPct: 0.8,      // ≥180 天：最低到成本 8 成；null = 不設底線
    ladders: {
      default: [{ days: 30, adj: -0.05 }, { days: 60, adj: -0.10 }, { days: 90, adj: -0.15 }, { days: 180, adj: -0.25 }],
      NB: null, DT: null, MON: null, DIY: null, OTH: null
    },
    grades: { A: 1.00, B: 0.93, C: 0.85, D: 0.75 },
    repairFactor: 0.95,
    batteryThreshold: 80,
    batteryFactor: 0.95,
    accessoriesMissingFactor: 0.97,
    retagThreshold: 0.03,        // 建議價與標價差距 ≥ 3% 列入「需重新標價」
    residualCoeffs: Array.from({ length: COEFF_MONTHS }, () => 1),
    cumulativeMode: false,
    estimatorRefurbCost: 0
  };
}

/** 政策欄位定義（介面、差異紀錄、Excel 參數表共用） */
export const POLICY_FIELDS = [
  { key: "storePremium", group: "錨定與市價", label: "門市加成（相對品況市價）", type: "pct" },
  { key: "marketStaleDays", group: "錨定與市價", label: "市價有效天數（超過列入待補）", type: "int", min: 1 },
  { key: "defaultTargetMargin", group: "錨定與市價", label: "無市價時目標毛利率（毛利÷售價）", type: "pct", min: -0.5, max: 0.89 },
  { key: "minMargin", group: "成本底線", label: "基本底線：毛利率至少", type: "pct", min: 0, max: 0.89 },
  { key: "floorRelaxOn", group: "成本底線", label: "底線依庫齡放寬", type: "bool" },
  { key: "floorTier1Days", group: "成本底線", label: "第一階：庫齡 ≥ 天", type: "int", nullable: true, min: 0 },
  { key: "floorTier1CostPct", group: "成本底線", label: "第一階：最低到成本的", type: "costpct", min: 0, max: 2 },
  { key: "floorTier2Days", group: "成本底線", label: "第二階：庫齡 ≥ 天", type: "int", nullable: true, min: 0 },
  { key: "floorTier2CostPct", group: "成本底線", label: "第二階：最低到成本的（空白＝不設）", type: "costpct", nullable: true, min: 0, max: 2 },
  { key: "ladders.default", group: "降價階梯", label: "預設階梯", type: "ladder" },
  ...CATEGORIES.map((c) => ({ key: `ladders.${c}`, group: "降價階梯", label: `${CATEGORY_LABELS[c]}（空白＝用預設）`, type: "ladder", nullable: true })),
  ...GRADES.map((c) => ({ key: `grades.${c}`, group: "品況係數", label: `成色 ${c}`, type: "factor", min: 0.1, max: 1.5 })),
  { key: "repairFactor", group: "品況係數", label: "有維修紀錄", type: "factor", min: 0.1, max: 1.5 },
  { key: "batteryThreshold", group: "品況係數", label: "電池健康度低於（%）", type: "int", min: 0, max: 100 },
  { key: "batteryFactor", group: "品況係數", label: "電池偏低係數", type: "factor", min: 0.1, max: 1.5 },
  { key: "accessoriesMissingFactor", group: "品況係數", label: "配件不齊", type: "factor", min: 0.1, max: 1.5 },
  { key: "roundUnit", group: "取整與標價", label: "取整單位", type: "int", min: 1 },
  { key: "roundMode", group: "取整與標價", label: "取整方式", type: "enum", options: [["nearest", "四捨五入"], ["ceil", "無條件進位"], ["floor", "無條件捨去"]] },
  { key: "tailMode", group: "取整與標價", label: "尾數（往下取、不破底線）", type: "enum", options: [["none", "不調整"], ["9", "尾數 9"], ["99", "尾數 99"]] },
  { key: "retagThreshold", group: "取整與標價", label: "建議價與標價差距達此比例需重新標價", type: "pct", min: 0, max: 0.5 },
  { key: "residualCoeffs", group: "回收估價", label: "殘值係數（第 1–18 月，相對新品價）", type: "coeffs" },
  { key: "cumulativeMode", group: "回收估價", label: "殘值係數累乘", type: "bool" },
  { key: "estimatorRefurbCost", group: "回收估價", label: "預設整新成本（元）", type: "int", min: 0 }
];

export function getPath(obj, path) { return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj); }
export function setPath(obj, path, value) {
  const keys = path.split(".");
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]] == null || typeof o[keys[i]] !== "object") o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
}
export function formatLadder(ladder) {
  if (!Array.isArray(ladder) || !ladder.length) return "";
  return ladder.map((l) => `${l.days}天 ${Math.round(l.adj * 10000) / 100}%`).join("、");
}
export function formatPolicyValue(field, v) {
  if (v === null || v === undefined || v === "") return field.nullable ? "（不設）" : "—";
  switch (field.type) {
    case "pct": return fmtPct(v, 2);
    case "costpct": return `成本 ${fmtPct(v, 0)}`;
    case "factor": return fmtFactor(v);
    case "bool": return v ? "開" : "關";
    case "ladder": return formatLadder(v) || (field.nullable ? "（用預設）" : "（無）");
    case "coeffs": return Array.isArray(v) ? v.join(" ") : String(v);
    case "enum": { const o = (field.options || []).find((x) => x[0] === String(v)); return o ? o[1] : String(v); }
    default: return String(v);
  }
}
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** 兩份政策的差異（給修改紀錄用） */
export function policyDiff(from, to) {
  const out = [];
  for (const f of POLICY_FIELDS) {
    const a = getPath(from, f.key), b = getPath(to, f.key);
    if (!same(a, b)) out.push({ key: f.key, label: `${f.group}／${f.label}`, from: formatPolicyValue(f, a), to: formatPolicyValue(f, b) });
  }
  return out;
}
/** 驗證單一欄位值；回傳錯誤訊息或 null */
export function validatePolicyValue(field, v) {
  if (v === null || v === undefined || v === "") return field.nullable ? null : "此欄不可空白";
  if (["int", "pct", "factor", "costpct"].includes(field.type)) {
    if (!Number.isFinite(v)) return "需為數字";
    if (field.min !== undefined && v < field.min) return `不可小於 ${field.type === "pct" || field.type === "costpct" ? fmtPct(field.min, 0) : field.min}`;
    if (field.max !== undefined && v > field.max) return `不可大於 ${field.type === "pct" || field.type === "costpct" ? fmtPct(field.max, 0) : field.max}`;
  }
  return null;
}

export function normalizePolicy(src) {
  const d = defaultPolicy();
  const s = src && typeof src === "object" ? src : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(s, k);
  const num = (k, { min = -Infinity, max = Infinity, nullable = false } = {}) => {
    if (!has(k)) return d[k];
    if (isBlank(s[k])) return nullable ? null : d[k];
    const n = Number(s[k]);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d[k];
  };
  const bool = (k) => (has(k)
    ? (typeof s[k] === "string" ? ["true", "1", "是", "開", "y", "yes", "on"].includes(s[k].trim().toLowerCase()) : !!s[k])
    : d[k]);
  const out = {
    roundUnit: Math.max(1, num("roundUnit")),
    roundMode: ["nearest", "ceil", "floor"].includes(s.roundMode) ? s.roundMode : d.roundMode,
    tailMode: ["none", "9", "99"].includes(String(s.tailMode)) ? String(s.tailMode) : d.tailMode,
    storePremium: num("storePremium", { min: -0.9, max: 1 }),
    marketStaleDays: num("marketStaleDays", { min: 1 }),
    defaultTargetMargin: num("defaultTargetMargin", { min: -0.5, max: 0.89 }),
    minMargin: num("minMargin", { min: 0, max: 0.89 }),
    floorRelaxOn: bool("floorRelaxOn"),
    floorTier1Days: num("floorTier1Days", { min: 0, nullable: true }),
    floorTier1CostPct: num("floorTier1CostPct", { min: 0, max: 2 }),
    floorTier2Days: num("floorTier2Days", { min: 0, nullable: true }),
    floorTier2CostPct: num("floorTier2CostPct", { min: 0, max: 2, nullable: true }),
    ladders: { ...d.ladders },
    grades: { ...d.grades },
    repairFactor: num("repairFactor", { min: 0.1, max: 1.5 }),
    batteryThreshold: num("batteryThreshold", { min: 0, max: 100 }),
    batteryFactor: num("batteryFactor", { min: 0.1, max: 1.5 }),
    accessoriesMissingFactor: num("accessoriesMissingFactor", { min: 0.1, max: 1.5 }),
    retagThreshold: num("retagThreshold", { min: 0, max: 0.5 }),
    residualCoeffs: d.residualCoeffs,
    cumulativeMode: bool("cumulativeMode"),
    estimatorRefurbCost: num("estimatorRefurbCost", { min: 0 })
  };
  if (s.ladders && typeof s.ladders === "object") {
    for (const k of ["default", ...CATEGORIES]) {
      if (!Object.prototype.hasOwnProperty.call(s.ladders, k)) continue;
      const l = normalizeLadder(s.ladders[k]);
      out.ladders[k] = k === "default" ? (l || []) : (l && l.length ? l : null);
    }
  }
  if (s.grades && typeof s.grades === "object") {
    for (const c of GRADES) { const n = numOr(s.grades[c], null); if (n !== null && n > 0) out.grades[c] = n; }
  }
  if (Array.isArray(s.residualCoeffs)) {
    const arr = s.residualCoeffs.slice(0, COEFF_MONTHS).map((v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 1; });
    while (arr.length < COEFF_MONTHS) arr.push(arr[arr.length - 1] ?? 1);
    out.residualCoeffs = arr;
  } else if (typeof s.residualCoeffs === "string") {
    out.residualCoeffs = parseCoeffRow(s.residualCoeffs) || d.residualCoeffs;
  }
  return out;
}

// ============================================================
// 商品
// ============================================================
export function newId() {
  try { if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) { /* ignore */ }
  return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}
const str = (v) => String(v ?? "").trim();
const numField = (v) => (isBlank(v) ? "" : (Number.isFinite(Number(v)) ? Number(v) : ""));
const dateField = (v) => { const p = parseISODate(v); return p ? isoFromParts(p.y, p.m, p.d) : ""; };

export function normalizeItem(it) {
  const s = it && typeof it === "object" ? it : {};
  let battery = numField(s.battery);
  if (battery !== "" && battery > 0 && battery <= 1) battery = Math.round(battery * 100);
  const grade = str(s.grade).toUpperCase();
  const sale = s.sale && typeof s.sale === "object" ? {
    suggested: numField(s.sale.suggested), anchor: numField(s.sale.anchor), listPrice: numField(s.sale.listPrice),
    days: numField(s.sale.days), mode: ["market", "cost", "none"].includes(s.sale.mode) ? s.sale.mode : ""
  } : null;
  return {
    id: s.id ? String(s.id) : newId(),
    sku: str(s.sku),
    serial: str(s.serial),
    name: str(s.name) || "未命名",
    category: CATEGORIES.includes(s.category) ? s.category : "OTH",
    specCpu: str(s.specCpu), specGpu: str(s.specGpu), specRam: str(s.specRam), specSsd: str(s.specSsd),
    grade: GRADES.includes(grade) ? grade : "",
    battery,
    accessoriesComplete: s.accessoriesComplete === undefined || s.accessoriesComplete === "" ? true : !!s.accessoriesComplete,
    warrantyMonths: numField(s.warrantyMonths),
    repair: !!s.repair,
    repairNote: String(s.repairNote ?? ""),
    note: String(s.note ?? ""),
    purchaseDate: dateField(s.purchaseDate),
    date: dateField(s.date),
    newPrice: numField(s.newPrice),
    cost: numField(s.cost),
    margin: numField(s.margin),
    market: numField(s.market),
    marketDate: dateField(s.marketDate),
    marketSource: str(s.marketSource),
    marketAdj: numField(s.marketAdj),
    status: s.status === "sold" ? "sold" : "stock",
    soldDate: dateField(s.soldDate),
    soldPrice: numField(s.soldPrice),
    sale,
    listPrice: numField(s.listPrice),
    listDate: dateField(s.listDate),
    priceHistory: Array.isArray(s.priceHistory)
      ? s.priceHistory.map((h) => ({ date: dateField(h && h.date), price: numField(h && h.price), note: str(h && h.note) }))
        .filter((h) => h.date && h.price !== "")
      : [],
    createdAt: dateField(s.createdAt) || dateField(s.date) || toISODate(todayLocal())
  };
}

/** 下一個庫存編號：U + 日期 + 流水號（例 U20261012-001） */
export function nextSku(items, dateISO) {
  const prefix = `U${String(dateISO).replace(/-/g, "")}-`;
  let max = 0;
  for (const it of items) {
    if (it.sku && it.sku.startsWith(prefix)) { const n = parseInt(it.sku.slice(prefix.length), 10); if (n > max) max = n; }
  }
  return prefix + String(max + 1).padStart(3, "0");
}
/** 補齊缺少或重複的庫存編號（依回收日） */
export function ensureSkus(items, today = todayLocal()) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    let sku = it.sku;
    if (!sku || seen.has(sku)) sku = nextSku(out, it.date || toISODate(today));
    seen.add(sku);
    out.push(sku === it.sku ? it : { ...it, sku });
  }
  return out;
}
export function specSummary(item) {
  return [item.specCpu, item.specGpu, item.specRam, item.specSsd].filter(Boolean).join(" / ");
}
/** 序號重複檢查：回傳 Map(serial → 筆數)（僅 >1 者） */
export function duplicateSerials(items) {
  const m = new Map();
  for (const it of items) if (it.serial) m.set(it.serial, (m.get(it.serial) || 0) + 1);
  for (const [k, v] of m) if (v < 2) m.delete(k);
  return m;
}

// ============================================================
// v8 → v9 升級
// ============================================================
/** 舊版政策 → v9。加價率口徑的底線換成「成本的 %」；基本底線數字沿用但改為財會毛利率（依決議）。 */
export function policyFromV8(g8) {
  const g = g8 && typeof g8 === "object" ? g8 : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(g, k);
  const d = defaultPolicy();
  const p = {
    roundUnit: g.roundUnit, roundMode: g.roundMode, tailMode: g.tailMode,
    storePremium: has("defaultMarketAdj") ? g.defaultMarketAdj : d.storePremium,
    minMargin: has("minMarginFloor") ? g.minMarginFloor : d.minMargin,
    floorRelaxOn: has("floorRelaxOn") ? g.floorRelaxOn : d.floorRelaxOn,
    floorTier1Days: has("floorTier1Days") ? g.floorTier1Days : d.floorTier1Days,
    floorTier1CostPct: has("floorTier1Margin") ? 1 + numOr(g.floorTier1Margin, 0) : d.floorTier1CostPct,
    floorTier2Days: has("floorTier2Days") ? g.floorTier2Days : d.floorTier2Days,
    floorTier2CostPct: has("floorTier2Margin") ? (isBlank(g.floorTier2Margin) ? null : 1 + numOr(g.floorTier2Margin, 0)) : d.floorTier2CostPct,
    ladders: { default: Array.isArray(g.ladder) ? g.ladder : d.ladders.default },
    residualCoeffs: Array.isArray(g.monthlyCoeffs) ? g.monthlyCoeffs : d.residualCoeffs,
    cumulativeMode: !!g.cumulativeMode
  };
  return normalizePolicy(p);
}
/** 舊版商品 → v9：毛利率由「加價率」換算成財會毛利率（換算後成本加成售價不變） */
export function itemFromV8(it8) {
  const s = it8 && typeof it8 === "object" ? it8 : {};
  const m = numOr(s.margin, null);
  return normalizeItem({
    id: s.id, name: s.name, category: s.category, purchaseDate: s.purchaseDate, date: s.date,
    cost: s.cost, margin: m === null || m <= -1 ? "" : Math.round(markupToMargin(m) * 1e6) / 1e6,
    market: s.market, marketAdj: s.marketAdj, repair: s.repair, repairNote: s.repairNote
  });
}
export function migrateFromV8(data, today = todayLocal()) {
  const items = ensureSkus((Array.isArray(data && data.items) ? data.items : []).map(itemFromV8), today);
  const policy = policyFromV8(data && data.globals);
  const notes = [
    `已從 ${data && data.version ? "v" + data.version : "舊版"} 升級 ${items.length} 筆資料`,
    "毛利率改為財會口徑（毛利 ÷ 售價），舊值已換算，例：加價 20% → 毛利率 16.7%",
    "停用：「不得低於市價 X%」與單品月係數覆寫（月係數改為回收估價用的殘值係數）"
  ];
  return { policy, items, notes };
}

// ============================================================
// 範例資料
// ============================================================
export function seedItems(today = todayLocal()) {
  const d = (n) => addDaysISO(today, -n);
  const raw = [
    { name: "ASUS TUF Gaming A15", category: "NB", specCpu: "R7 7735HS", specGpu: "RTX 4060", specRam: "16GB", specSsd: "512GB",
      grade: "B", battery: 86, purchaseDate: addMonthsISO(today, -14), date: d(12), cost: 21000, newPrice: 36900,
      market: 26800, marketDate: d(5), marketSource: "露天／蝦皮 近 30 天成交均價" },
    { name: "Lenovo ThinkPad T14 Gen 3", category: "NB", specCpu: "i5-1245U", specRam: "16GB", specSsd: "512GB",
      grade: "A", battery: 74, purchaseDate: addMonthsISO(today, -22), date: d(48), cost: 14500, newPrice: 42000,
      market: 18900, marketDate: d(41), marketSource: "露天" },
    { name: "自組桌機 i7-12700／RTX 3070", category: "DT", specCpu: "i7-12700", specGpu: "RTX 3070", specRam: "32GB", specSsd: "1TB",
      grade: "B", purchaseDate: addMonthsISO(today, -30), date: d(95), cost: 23000, market: 25500, marketDate: d(8), marketSource: "PTT hardware 版" },
    { name: "Dell 27 吋 IPS 螢幕 U2723QE", category: "MON", grade: "C", repair: true, repairNote: "更換背光模組",
      purchaseDate: addMonthsISO(today, -18), date: d(190), cost: 6800, market: 9800, marketDate: d(3), marketSource: "露天" },
    { name: "Acer Aspire 5（未查市價）", category: "NB", specCpu: "i5-1235U", specRam: "8GB", specSsd: "512GB",
      purchaseDate: addMonthsISO(today, -10), date: d(20), cost: 9000, margin: 0.18, accessoriesComplete: false },
    { name: "MSI RTX 3060 12G 顯示卡", category: "DIY", grade: "A", purchaseDate: addMonthsISO(today, -26), date: d(70), soldDate: d(9),
      cost: 5200, market: 7200, marketDate: d(20), status: "sold", soldPrice: 6890, listPrice: 6999, listDate: d(25),
      sale: { suggested: 6999, anchor: 7560, listPrice: 6999, days: 61, mode: "market" } }
  ];
  return ensureSkus(raw.map((r) => normalizeItem({ ...r, createdAt: r.date })), today);
}
