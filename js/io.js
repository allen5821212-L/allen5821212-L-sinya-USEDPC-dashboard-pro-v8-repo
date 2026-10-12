// SINYA USEDPC — 匯入匯出（純資料轉換；Excel 讀寫由介面層用 SheetJS 處理）
import {
  CATEGORIES, GRADES, isBlank, numOr, isoFromParts, toISODate, todayLocal, computePrice, retagCheck,
  saleStats, markupToMargin, fmtPct
} from "./pricing.js";
import {
  normalizeItem, normalizePolicy, POLICY_FIELDS, getPath, setPath, formatLadder, specSummary, ensureSkus
} from "./model.js";

// ============================================================
// 欄位定義
// ============================================================
export const ITEM_COLUMNS = [
  { key: "sku", label: "庫存編號", aliases: ["編號", "sku"], type: "text" },
  { key: "serial", label: "序號", aliases: ["serial", "s/n", "sn"], type: "text" },
  { key: "name", label: "名稱", aliases: ["品名", "商品名稱", "商品", "name"], type: "text" },
  { key: "category", label: "分類", aliases: ["類別", "category"], type: "category" },
  { key: "specCpu", label: "CPU", aliases: ["處理器"], type: "text" },
  { key: "specGpu", label: "GPU", aliases: ["顯示卡", "顯卡"], type: "text" },
  { key: "specRam", label: "記憶體", aliases: ["ram"], type: "text" },
  { key: "specSsd", label: "儲存", aliases: ["ssd", "硬碟", "儲存空間"], type: "text" },
  { key: "grade", label: "成色", aliases: ["成色等級", "等級", "grade"], type: "grade" },
  { key: "battery", label: "電池健康度", aliases: ["電池", "battery"], type: "battery" },
  { key: "warrantyMonths", label: "剩餘保固(月)", aliases: ["剩餘保固", "保固", "保固月數"], type: "num" },
  { key: "accessoriesComplete", label: "配件齊全", aliases: ["配件"], type: "boolDefaultTrue" },
  { key: "repair", label: "維修", aliases: ["有維修紀錄", "維修紀錄", "repair"], type: "bool" },
  { key: "repairNote", label: "維修備註", aliases: ["repairnote"], type: "text" },
  { key: "note", label: "備註", aliases: ["note"], type: "text" },
  { key: "purchaseDate", label: "購買日", aliases: ["購買日(原購)", "原購日", "原購買日", "purchasedate"], type: "date" },
  { key: "date", label: "回收日", aliases: ["回收日(入庫)", "入庫日", "date", "recycledate"], type: "date" },
  { key: "newPrice", label: "新品價", aliases: ["原價", "新品售價"], type: "num" },
  { key: "cost", label: "成本", aliases: ["回收成本", "回收價", "cost"], type: "num" },
  { key: "margin", label: "目標毛利率", aliases: ["毛利率", "margin"], type: "pct" },
  { key: "market", label: "參考市價", aliases: ["市場價", "市價", "market"], type: "num" },
  { key: "marketDate", label: "市價日期", aliases: ["查價日期", "查價日"], type: "date" },
  { key: "marketSource", label: "市價來源", aliases: ["查價來源", "來源"], type: "text" },
  { key: "marketAdj", label: "單品加成", aliases: ["市價調整％", "市價調整%", "單品市價調整％", "單品市價調整%", "marketadj"], type: "pct" },
  { key: "status", label: "狀態", aliases: ["status"], type: "status" },
  { key: "soldDate", label: "售出日", aliases: ["成交日"], type: "date" },
  { key: "soldPrice", label: "成交價", aliases: ["售出價"], type: "num" },
  { key: "listPrice", label: "標價", aliases: ["目前標價"], type: "num" },
  { key: "listDate", label: "標價日", aliases: ["標價日期"], type: "date" }
];
export const COMPUTED_HEADERS = ["庫齡(天)", "定價依據", "錨定價", "建議售價", "預估毛利", "預估毛利率", "標價狀態", "待辦與警示"];

export function normHeader(h) {
  return String(h ?? "").trim().toLowerCase()
    .replace(/[\s_]/g, "").replace(/％/g, "%").replace(/（/g, "(").replace(/）/g, ")");
}
const HEADER_MAP = (() => {
  const m = new Map();
  for (const c of ITEM_COLUMNS) for (const a of [c.label, ...c.aliases]) m.set(normHeader(a), c.key);
  return m;
})();
/** v8 匯出檔特徵：有這些欄位代表「毛利率」是加價率 */
const LEGACY_HEADERS = ["月係數覆寫", "第n月(購買)", "第n月(回收)", "市價調整％", "市價調整%", "市場價"].map(normHeader);

// ============================================================
// 儲存格解析
// ============================================================
export function parseNumberCell(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v ?? "").trim().replace(/^NT\$|^\$|元$/gi, "").replace(/[,，\s]/g, "");
  if (!s) return "";
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
/** 百分比：「20%」、0.2、20 都視為 20%（絕對值 ≥ 1 的數字視為百分比） */
export function parsePctCell(v) {
  if (typeof v === "string" && /%|％/.test(v)) {
    const n = Number(v.replace(/[%％\s,]/g, ""));
    return Number.isFinite(n) ? Math.round(n * 1e6) / 1e8 : null;
  }
  const n = parseNumberCell(v);
  if (n === "" || n === null) return n;
  return Math.abs(n) >= 1 ? Math.round(n * 1e6) / 1e8 : n;
}
export function parseBoolCell(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return ["是", "有", "y", "yes", "true", "1", "v", "✓", "✔", "o", "齊", "齊全"].includes(String(v ?? "").trim().toLowerCase());
}
const CATEGORY_ALIASES = {
  NB: ["nb", "筆電", "筆記型電腦", "筆記電腦", "notebook", "laptop"],
  DT: ["dt", "桌機", "桌上型", "桌上型電腦", "desktop", "pc", "主機"],
  MON: ["mon", "螢幕", "顯示器", "monitor"],
  DIY: ["diy", "零組件", "零件", "組件", "顯示卡", "顯卡"],
  OTH: ["oth", "其他", "other"]
};
export function parseCategory(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return { value: "OTH", ok: true };
  for (const [cat, list] of Object.entries(CATEGORY_ALIASES)) if (list.includes(s)) return { value: cat, ok: true };
  return { value: "OTH", ok: false };
}
export function parseGrade(v) {
  const s = String(v ?? "").trim().toUpperCase().replace(/級$/, "").replace(/^等級/, "");
  if (!s) return { value: "", ok: true };
  const map = { "甲": "A", "乙": "B", "丙": "C", "丁": "D" };
  const g = map[s] || s.charAt(0);
  return GRADES.includes(g) ? { value: g, ok: true } : { value: "", ok: false };
}
export function parseStatus(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (["已售出", "售出", "sold", "已售"].includes(s)) return "sold";
  return "stock";
}
function excelSerialToISO(n) {
  if (!(n > 0 && n < 2958466)) return "";
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
  return isoFromParts(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}
/** 回傳 ISO 日期；空白回傳 ""；無法辨識回傳 null。支援 2025-08-04、2025/8/4、民國 114/8/4、20250804、Excel 日期序號 */
export function parseDateCell(v) {
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
/** 簡易 CSV 解析（支援引號、逗號、換行、BOM） */
export function parseCSV(text) {
  text = String(text).replace(/^﻿/, "");
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

// ============================================================
// 列 → 商品
// ============================================================
/**
 * rows：二維陣列（第一個有 ≥2 個可辨識欄位的列為標題列）
 * 回傳 { items, warnings, blank, headerRow, legacy }
 * legacy=true（v8 檔）時，「毛利率」視為加價率並換算為財會毛利率。
 */
export function rowsToItems(rows, { today = todayLocal() } = {}) {
  const warnings = [];
  let headerIdx = -1, colMap = null, legacy = false;
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const map = {};
    const heads = (rows[r] || []).map(normHeader);
    heads.forEach((h, c) => { const key = HEADER_MAP.get(h); if (key && !(key in map)) map[key] = c; });
    if (Object.keys(map).length >= 2 && ("name" in map || "cost" in map || "sku" in map)) {
      headerIdx = r; colMap = map;
      legacy = heads.some((h) => LEGACY_HEADERS.includes(h)) && !heads.includes(normHeader("參考市價"));
      break;
    }
  }
  if (headerIdx < 0) throw new Error("找不到欄位標題列（至少需要「名稱」「成本」或「庫存編號」其中之一，加上任一其他欄位）");
  const items = [];
  let blank = 0;
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const raw = Object.fromEntries(Object.keys(colMap).map((k) => [k, row[colMap[k]]]));
    if (Object.values(raw).every((v) => v === "" || v === null || v === undefined || String(v).trim() === "")) { blank++; continue; }
    const line = r + 1;
    const w = (msg) => warnings.push(`第 ${line} 列：${msg}`);
    const it = {};
    for (const col of ITEM_COLUMNS) {
      if (!(col.key in raw)) continue;
      const v = raw[col.key];
      switch (col.type) {
        case "text": it[col.key] = String(v ?? "").trim(); break;
        case "category": {
          const c = parseCategory(v); it.category = c.value;
          if (!c.ok) w(`分類「${v}」無法辨識，設為 OTH`);
          break;
        }
        case "grade": {
          const g = parseGrade(v); it.grade = g.value;
          if (!g.ok) w(`成色「${v}」無法辨識（應為 A／B／C／D），已留空`);
          break;
        }
        case "battery": {
          const n = parsePctCell(v);
          if (n === null) { w(`電池健康度「${v}」不是數字，已留空`); it.battery = ""; }
          else it.battery = n === "" ? "" : Math.round(n * 100);
          break;
        }
        case "num": {
          const n = parseNumberCell(v);
          if (n === null) { w(`${col.label}「${v}」不是數字，已留空`); it[col.key] = ""; } else it[col.key] = n;
          break;
        }
        case "pct": {
          let n = parsePctCell(v);
          if (n === null) { w(`${col.label}「${v}」不是數字，已留空`); n = ""; }
          if (col.key === "margin" && legacy && n !== "") n = Math.round(markupToMargin(n) * 1e6) / 1e6;
          it[col.key] = n;
          break;
        }
        case "date": {
          const d = parseDateCell(v);
          if (d === null) { w(`${col.label}「${v}」無法辨識，已留空`); it[col.key] = ""; } else it[col.key] = d;
          break;
        }
        case "bool": it[col.key] = parseBoolCell(v); break;
        case "boolDefaultTrue": it[col.key] = isBlank(v) ? true : parseBoolCell(v); break;
        case "status": it.status = parseStatus(v); break;
      }
    }
    if (!it.name && !it.sku) w("名稱空白，設為「未命名」");
    if ("cost" in raw && it.cost === "" && String(raw.cost ?? "").trim() === "") w("成本空白");
    if (typeof it.margin === "number" && (it.margin >= 0.9 || it.margin < -0.5)) w(`目標毛利率 ${fmtPct(it.margin)} 不合理，請確認`);
    if (it.status === "sold" && (!it.soldDate || it.soldPrice === "" || it.soldPrice === undefined)) w("標為已售出但缺售出日或成交價");
    if (it.status === "sold") it.sale = { listPrice: it.listPrice ?? "" };
    items.push(normalizeItem(it));
  }
  return { items, warnings, blank, headerRow: headerIdx + 1, legacy };
}

/**
 * 合併匯入資料。mode：
 *   upsert  — 同庫存編號（或同序號）更新原資料，其餘新增（預設，重複匯入不會變兩份）
 *   append  — 同庫存編號略過，其餘新增
 *   replace — 整份取代
 * 檔案內重複的編號：以後面那列為準，並回報。
 */
export function mergeItems(existing, incoming, mode = "upsert", today = todayLocal()) {
  const report = { added: 0, updated: 0, skipped: [], dupInFile: [] };
  const seenInFile = new Map();
  const deduped = [];
  for (const it of incoming) {
    const key = it.sku ? `sku:${it.sku}` : (it.serial ? `sn:${it.serial}` : null);
    if (key && seenInFile.has(key)) { report.dupInFile.push(it.sku || it.serial); deduped[seenInFile.get(key)] = it; continue; }
    if (key) seenInFile.set(key, deduped.length);
    deduped.push(it);
  }
  if (mode === "replace") {
    const items = ensureSkus(deduped, today);
    report.added = items.length;
    return { items, report };
  }
  const items = existing.slice();
  const fp = (x) => `${x.name}|${x.date}|${x.cost}`;
  const bySku = new Map(items.map((x, i) => [x.sku, i]));
  const bySerial = new Map(items.filter((x) => x.serial).map((x) => [x.serial, items.indexOf(x)]));
  const byFp = new Map(items.map((x, i) => [fp(x), i]));
  for (const it of deduped) {
    // 比對順序：庫存編號 → 序號 → （兩者皆無時）名稱＋回收日＋成本
    let idx = -1;
    if (it.sku) idx = bySku.has(it.sku) ? bySku.get(it.sku) : -1;
    else if (it.serial && bySerial.has(it.serial)) idx = bySerial.get(it.serial);
    else if (!it.serial && byFp.has(fp(it))) idx = byFp.get(fp(it));
    if (idx >= 0) {
      if (mode === "append") { report.skipped.push(it.sku || it.serial); continue; }
      const old = items[idx];
      items[idx] = normalizeItem({ ...old, ...it, id: old.id, sku: old.sku, priceHistory: old.priceHistory, createdAt: old.createdAt });
      report.updated++;
    } else {
      items.push(it);
      report.added++;
    }
  }
  return { items: ensureSkus(items, today), report };
}

// ============================================================
// 匯出
// ============================================================
function cellOut(item, col) {
  const v = item[col.key];
  if (col.type === "bool") return v ? "是" : "";
  if (col.type === "boolDefaultTrue") return v === false ? "否" : "是";
  if (col.type === "status") return v === "sold" ? "已售出" : "在庫";
  if (col.type === "category" || col.type === "grade") return v || "";
  return v === undefined || v === null ? "" : v;
}
export function itemsToAoa(items, policy, today = todayLocal(), { computed = true } = {}) {
  const head = ITEM_COLUMNS.map((c) => c.label).concat(computed ? COMPUTED_HEADERS : []);
  const body = items.map((it) => {
    const base = ITEM_COLUMNS.map((c) => cellOut(it, c));
    if (!computed) return base;
    if (it.status === "sold") {
      const s = saleStats(it);
      return base.concat(["", "", "", "", s && s.profit !== null ? s.profit : "", s && s.margin !== null ? Math.round(s.margin * 10000) / 10000 : "", "", "已售出"]);
    }
    const r = computePrice(it, policy, today);
    const rt = retagCheck(it, r, policy);
    return base.concat([
      r.days, r.mode === "market" ? "市價" : r.mode === "cost" ? "成本加成" : "", Math.round(r.anchor), r.price, r.profit,
      r.margin === null ? "" : Math.round(r.margin * 10000) / 10000,
      rt ? rt.text : "已標價",
      r.warnings.map((x) => (x.level === "warn" ? "⚠" : "✎") + x.text).join("；")
    ]);
  });
  return [head, ...body];
}
export const ITEM_COL_WIDTHS = [15, 14, 28, 6, 12, 12, 8, 8, 5, 8, 9, 7, 5, 16, 16, 11, 11, 9, 9, 9, 9, 11, 18, 8, 6, 11, 9, 9, 11, 7, 8, 9, 9, 9, 10, 18, 50];

function policyCell(f, v) {
  if (v === null || v === undefined) return "";
  if (f.type === "bool") return v ? "TRUE" : "FALSE";
  if (f.type === "ladder") return Array.isArray(v) ? v.map((l) => `${l.days}/${Math.round(l.adj * 10000) / 100}%`).join(", ") : "";
  if (f.type === "coeffs") return Array.isArray(v) ? v.join(" ") : String(v);
  return v;
}
export function policyToAoa(policy) {
  const rows = [["參數", "值", "代碼", "說明"]];
  for (const f of POLICY_FIELDS) {
    const note = f.type === "pct" ? "小數，0.05 = 5%" : f.type === "costpct" ? "成本倍數，0.8 = 成本 8 成" :
      f.type === "ladder" ? "天數/降幅%，逗號分隔，例 30/-5%, 60/-10%" : f.type === "factor" ? "係數，0.93 = 九三折" :
      f.type === "coeffs" ? "18 個數字，空白分隔" : f.type === "enum" ? f.options.map((o) => `${o[0]}=${o[1]}`).join("／") : "";
    rows.push([`${f.group}／${f.label}`, policyCell(f, getPath(policy, f.key)), f.key, note]);
  }
  return rows;
}
/** 解析降價階梯文字：30/-5%, 60/-10 或 30/-0.05（無 % 且絕對值 < 1 視為小數） */
export function parseLadderText(text) {
  const ladder = [], invalid = [];
  String(text ?? "").split(/[,，、\n;]/).map((s) => s.trim()).filter(Boolean).forEach((seg) => {
    const m = /^(\d+)\s*(?:天)?\s*[\/:：\s]\s*([+-]?\d+(?:\.\d+)?)\s*(%|％)?$/.exec(seg);
    if (!m) { invalid.push(seg); return; }
    const days = Number(m[1]);
    let adj = Number(m[2]);
    if (m[3] || Math.abs(adj) >= 1) adj = adj / 100;
    if (!(adj > -1 && adj < 1)) { invalid.push(seg); return; }
    ladder.push({ days, adj: Math.round(adj * 1e6) / 1e6 });
  });
  ladder.sort((a, b) => a.days - b.days);
  return { ladder, invalid };
}
/** 從「參數表」列還原政策（以代碼欄為準）。回傳 { policy, applied, warnings } */
export function policyFromRows(rows, base) {
  const p = JSON.parse(JSON.stringify(base));
  const byCode = new Map(POLICY_FIELDS.map((f) => [f.key, f]));
  const warnings = [];
  let applied = 0;
  for (const row of rows.slice(1)) {
    if (!row) continue;
    const f = byCode.get(String(row[2] ?? "").trim());
    if (!f) continue;
    const v = row[1];
    let val;
    if (isBlank(v)) {
      if (!f.nullable && f.type !== "ladder") { warnings.push(`${f.label}：空白，維持原值`); continue; }
      val = null;
    } else if (f.type === "bool") val = parseBoolCell(v);
    else if (f.type === "ladder") {
      const lp = parseLadderText(v);
      if (lp.invalid.length) warnings.push(`${f.label}：無法解析 ${lp.invalid.join("、")}`);
      val = lp.ladder.length ? lp.ladder : null;
    } else if (f.type === "coeffs") val = String(v);
    else if (f.type === "enum") val = String(v).trim();
    else { val = numOr(v, NaN); if (!Number.isFinite(val)) { warnings.push(`${f.label}：「${v}」不是數字，維持原值`); continue; } }
    setPath(p, f.key, val);
    applied++;
  }
  return { policy: normalizePolicy(p), applied, warnings };
}

/** 標價清單（列印標籤用）：只含在庫商品 */
export function tagListAoa(items, policy, today = todayLocal(), { onlyRetag = false } = {}) {
  const head = ["庫存編號", "名稱", "規格", "成色", "建議售價", "目前標價", "狀態"];
  const rows = [];
  for (const it of items) {
    if (it.status === "sold") continue;
    const r = computePrice(it, policy, today);
    const rt = retagCheck(it, r, policy);
    if (onlyRetag && !rt) continue;
    rows.push([it.sku, it.name, specSummary(it), it.grade || "", r.price, it.listPrice === "" ? "" : it.listPrice, rt ? rt.text : "已標價"]);
  }
  return [head, ...rows];
}

export function aoaToCSV(aoa) {
  return "﻿" + aoa.map((r) => r.map((v) => {
    const s = String(v ?? "");
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, "\"\"")}"` : s;
  }).join(",")).join("\r\n");
}

/** 匯入範本（回收清單工作表） */
export function templateAoa(today = todayLocal()) {
  const iso = toISODate(today);
  return [
    ITEM_COLUMNS.map((c) => c.label),
    ["", "SN12345", "ASUS TUF Gaming A15", "筆電", "R7 7735HS", "RTX 4060", "16GB", "512GB", "B", "86%", 6, "是", "", "", "",
      "2025/8/4", iso, 36900, 21000, "", 26800, iso, "露天近 30 天成交均價", "", "在庫", "", "", "", ""],
    ["", "", "Dell 27 吋螢幕", "螢幕", "", "", "", "", "C", "", "", "否", "是", "更換背光模組", "",
      "114/03/15", iso, "", 6800, "20%", "", "", "", "", "在庫", "", "", "", ""]
  ];
}
export const TEMPLATE_HELP = [
  ["欄位", "說明"],
  ["庫存編號", "可留空，系統自動產生（U＋日期＋流水號）。匯入時同編號會更新原資料，不會變兩份"],
  ["序號", "機身序號，可留空；重複會提示"],
  ["分類", "NB／DT／MON／DIY／OTH，也可寫 筆電、桌機、螢幕、零組件、其他"],
  ["成色", "A 近全新／B 輕微使用痕跡／C 明顯刮傷磨損／D 外觀差・功能正常；未評以 ×1.00 計並列入待補"],
  ["電池健康度", "86、86% 或 0.86 皆可"],
  ["配件齊全", "是／否；空白視為齊全"],
  ["購買日、回收日、市價日期", "2025-08-04、2025/8/4、民國 114/8/4、20250804 或 Excel 日期"],
  ["新品價", "回收估價與殘值校正用，可留空"],
  ["目標毛利率", "毛利 ÷ 售價。20%、0.2 或 20 皆可；只在沒有參考市價時決定售價"],
  ["參考市價", "同型號 A 級良品的二手行情。有填就以市價為準"],
  ["單品加成", "空白＝用門市加成；5%、0.05 或 5 皆可"],
  ["狀態", "在庫／已售出；已售出需填售出日與成交價"],
  ["", ""],
  ["計算欄位", "「建議售價」「預估毛利」等匯入時略過、一律重新計算"]
];
