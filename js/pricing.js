// SINYA USEDPC — 定價引擎（純函式：不碰 DOM、不讀寫儲存；瀏覽器、Node 測試與日後二手平台共用）
//
// 售價模型（v9）
//   有參考市價（市價錨定）：
//     品況市價 = 參考市價（A 級良品行情）× 品況係數（成色 × 維修 × 電池 × 配件）
//     錨定價   = 品況市價 × (1 + 門市加成)
//   沒有參考市價（暫用成本加成，標示「請補市價」）：
//     錨定價   = 成本 ÷ (1 − 目標毛利率)        ← 毛利率一律為財會口徑：毛利 ÷ 售價
//   → 庫齡折扣：依分類的降價階梯，取符合的最大門檻（不累加）
//   → 成本底線：依庫齡放寬（基本：毛利率 ≥ 10%；≥90 天：成本；≥180 天：成本 × 80%）
//       市價錨定時，若成本底線高於錨定價（收購成本偏高）→ 底線無法達成，改依市價定價並標示
//   → 取整（不破底線）→ 尾數（往下取、不破底線）→ 市價錨定時不高於錨定價
//
// 月係數（殘值係數：新品價 → 二手行情）只用於「回收估價」，不影響售價。

export const CATEGORIES = ["NB", "DT", "MON", "DIY", "OTH"];
export const CATEGORY_LABELS = { NB: "筆電", DT: "桌機", MON: "螢幕", DIY: "零組件", OTH: "其他" };
export const GRADES = ["A", "B", "C", "D"];
export const GRADE_LABELS = { A: "A 近全新", B: "B 輕微使用痕跡", C: "C 明顯刮傷磨損", D: "D 外觀差・功能正常" };
export const COEFF_MONTHS = 18;
export const EPS = 1e-6;

// ============================================================
// 基本工具
// ============================================================
export function isBlank(v) {
  return v === "" || v === null || v === undefined ||
    (typeof v === "number" && !Number.isFinite(v)) ||
    (typeof v === "string" && v.trim() === "");
}
export function numOr(v, fallback) {
  if (isBlank(v)) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
export const r6 = (x) => Math.round(x * 1e6) / 1e6;
export const pad2 = (n) => String(n).padStart(2, "0");
export function fmtN(x) {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return Math.round(x).toLocaleString("en-US");
}
export function fmtPct(x, digits = 1) {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  const v = Math.round(x * 100 * 10 ** digits) / 10 ** digits;
  return `${v}%`;
}
export function fmtFactor(x) {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return `×${Math.round(x * 10000) / 10000}`;
}
/** 舊版「加價率」換算為財會毛利率：售價 = 成本 × (1 + 加價率) = 成本 ÷ (1 − 毛利率) */
export const markupToMargin = (m) => m / (1 + m);
export const marginToMarkup = (m) => m / (1 - m);

// ============================================================
// 日期（一律用本地日期，避免 UTC 時差少算一天）
// ============================================================
export function todayLocal() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
export function toISODate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
export function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }
export function parseISODate(str) {
  if (!str) return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(str).trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d };
}
export function isoFromParts(y, m, d) {
  if (!(y >= 1900 && y <= 2999) || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return "";
  return `${y}-${pad2(m)}-${pad2(d)}`;
}
export function dateFromISO(str) { const p = parseISODate(str); return p ? new Date(p.y, p.m - 1, p.d) : null; }
export function addDaysISO(base, days) {
  return toISODate(new Date(base.getFullYear(), base.getMonth(), base.getDate() + days));
}
export function addMonthsISO(base, months, extraDays = 0) {
  return toISODate(new Date(base.getFullYear(), base.getMonth() + months, base.getDate() + extraDays));
}
/** 已滿幾個曆法月（同月日未到不算；月底自動對齊：1/31 → 2/28 算滿 1 個月）。無日期回傳 null。 */
export function monthsElapsed(dateStr, today) {
  const p = parseISODate(dateStr);
  if (!p) return null;
  const y2 = today.getFullYear(), m2 = today.getMonth() + 1, d2 = today.getDate();
  let months = (y2 - p.y) * 12 + (m2 - p.m);
  if (d2 < Math.min(p.d, daysInMonth(y2, m2))) months -= 1;
  return Math.max(0, months);
}
/** 距今天數（未來為負數）。無日期回傳 null。 */
export function daysSince(dateStr, today) {
  const p = parseISODate(dateStr);
  if (!p) return null;
  const a = Date.UTC(p.y, p.m - 1, p.d);
  const b = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((b - a) / 86400000);
}
/** b − a 的天數；任一無效回傳 null */
export function daysBetweenISO(a, b) {
  const d = dateFromISO(b);
  return d ? daysSince(a, d) : null;
}

// ============================================================
// 降價階梯（內部存小數；介面以百分比顯示）
// ============================================================
export function normalizeLadder(v) {
  if (!Array.isArray(v)) return null;
  return v.map((l) => ({ days: Number(l && l.days), adj: Number(l && l.adj) }))
    .filter((l) => Number.isFinite(l.days) && l.days >= 0 && Number.isFinite(l.adj) && l.adj > -1 && l.adj < 1)
    .sort((a, b) => a.days - b.days);
}
/** 分類有自己的階梯就用自己的，否則用預設階梯 */
export function ladderFor(category, g) {
  const own = g.ladders && g.ladders[category];
  if (Array.isArray(own) && own.length) return { ladder: own, source: category };
  return { ladder: (g.ladders && g.ladders.default) || [], source: "default" };
}
/** 取符合的最大門檻（不累加） */
export function ladderStep(days, ladder) {
  let adj = 0, at = null;
  for (const l of ladder) if (days >= l.days) { adj = l.adj; at = l.days; }
  return { adj, at };
}

// ============================================================
// 殘值係數（回收估價用）
// ============================================================
export function parseCoeffRow(str) {
  if (str === null || str === undefined) return null;
  const parts = String(str).split(/[\s,，、]+/).filter(Boolean).slice(0, COEFF_MONTHS);
  if (!parts.length) return null;
  const arr = parts.map(Number);
  if (arr.some((x) => !Number.isFinite(x) || x <= 0)) return null;
  while (arr.length < COEFF_MONTHS) arr.push(arr[arr.length - 1]);
  return arr;
}
/** 滿 N 個月 = 第 N 月；未滿 1 個月 = 1.00；滿 18 個月以上用第 18 月 */
export function residualFor(months, g) {
  const m = Math.min(Math.max(0, months ?? 0), COEFF_MONTHS);
  if (m === 0) return { coeff: 1, month: 0 };
  const src = g.residualCoeffs || [];
  const at = (i) => { const v = Number(src[i]); return Number.isFinite(v) && v > 0 ? v : 1; };
  let coeff = 1;
  if (g.cumulativeMode) for (let i = 0; i < m; i++) coeff *= at(i);
  else coeff = at(m - 1);
  return { coeff: r6(coeff), month: m };
}
export function residualTableUnset(g) {
  return !Array.isArray(g.residualCoeffs) || g.residualCoeffs.every((v) => Number(v) === 1);
}

// ============================================================
// 取整與尾數
// ============================================================
export function roundByMode(value, unit, mode) {
  const q = value / unit;
  if (mode === "ceil") return Math.ceil(q - EPS) * unit;
  if (mode === "floor") return Math.floor(q + EPS) * unit;
  return Math.round(q) * unit;
}
export function tailStep(tailMode) { return tailMode === "9" ? 10 : tailMode === "99" ? 100 : 0; }
/** ≤ x 的最大尾數價 */
export function tailDown(x, tailMode) { const s = tailStep(tailMode), t = s - 1; return Math.floor((x - t + EPS) / s) * s + t; }
/** ≥ x 的最小尾數價 */
export function tailUp(x, tailMode) { const s = tailStep(tailMode), t = s - 1; return Math.ceil((x - t - EPS) / s) * s + t; }
/** 上限價整理成好看的價格（往下取） */
export function tidyDown(x, unit, tailMode) {
  if (tailStep(tailMode)) return tailDown(x, tailMode);
  return Math.floor((x + EPS) / unit) * unit;
}

// ============================================================
// 品況係數、成本底線
// ============================================================
/** 品況係數：成色 × 維修 × 電池 × 配件（未評成色以 1.00 計） */
export function qualityFactors(item, g) {
  const parts = [];
  const grade = String(item.grade || "").toUpperCase();
  if (GRADES.includes(grade)) parts.push({ label: `成色 ${grade}`, factor: numOr(g.grades && g.grades[grade], 1) });
  if (item.repair) parts.push({ label: "有維修紀錄", factor: numOr(g.repairFactor, 1) });
  const b = numOr(item.battery, null);
  if (b !== null && b < numOr(g.batteryThreshold, 0)) parts.push({ label: `電池 ${b}%`, factor: numOr(g.batteryFactor, 1) });
  if (item.accessoriesComplete === false) parts.push({ label: "配件不齊", factor: numOr(g.accessoriesMissingFactor, 1) });
  const total = r6(parts.reduce((p, x) => p * x.factor, 1));
  return { total, parts };
}
/**
 * 依庫齡決定成本底線價。
 * 基本：毛利率 ≥ minMargin → 成本 ÷ (1 − minMargin)；≥ 第一階天數：成本 × tier1CostPct；≥ 第二階天數：成本 × tier2CostPct（null = 不設）
 */
export function floorFor(days, cost, g) {
  const minMargin = Math.min(0.9, Math.max(0, numOr(g.minMargin, 0)));
  let tier = 0, pct = null, price = cost > 0 ? r6(cost / (1 - minMargin)) : null;
  let text = `基本：毛利率 ≥ ${fmtPct(minMargin)}`;
  if (g.floorRelaxOn && cost > 0) {
    const t1 = numOr(g.floorTier1Days, null), t2 = numOr(g.floorTier2Days, null);
    if (t1 !== null && days >= t1) {
      tier = 1; pct = numOr(g.floorTier1CostPct, 1); price = r6(cost * pct);
      text = `≥${t1} 天：成本 × ${fmtPct(pct, 0)}`;
    }
    if (t2 !== null && days >= t2) {
      tier = 2; pct = isBlank(g.floorTier2CostPct) ? null : numOr(g.floorTier2CostPct, null);
      price = pct === null ? null : r6(cost * pct);
      text = pct === null ? `≥${t2} 天：不設底線` : `≥${t2} 天：成本 × ${fmtPct(pct, 0)}`;
    }
  }
  return { price, tier, text };
}

// ============================================================
// 建議售價
// ============================================================
/**
 * 回傳 { price, profit, margin, mode('market'|'cost'|'none'), days, anchor, marketValue, quality,
 *        floor, floorTier, ageMonths, steps[{label,value,hit}], warnings[{level:'warn'|'todo', code, text}] }
 *   warn = 需處理（資料錯誤、低於成本需核准）；todo = 待補資料（缺市價、市價過期、成色未評…）
 */
export function computePrice(item, g, today = todayLocal()) {
  const warnings = [];
  const W = (level, code, text) => warnings.push({ level, code, text });
  const steps = [];
  const S = (label, value, hit = false) => steps.push({ label, value, hit });

  const cost = numOr(item.cost, 0);
  const market = isBlank(item.market) ? null : numOr(item.market, null);
  const premium = isBlank(item.marketAdj) ? numOr(g.storePremium, 0) : numOr(item.marketAdj, 0);
  const unit = Math.max(1, numOr(g.roundUnit, 1));
  const roundMode = g.roundMode || "nearest";
  const tailMode = g.tailMode || "none";

  // ---- 資料檢查 ----
  const dRec = daysSince(item.date, today);
  const dPur = daysSince(item.purchaseDate, today);
  const days = dRec === null ? 0 : Math.max(0, dRec);
  if (cost <= 0) W("warn", "cost_missing", "成本未填");
  if (dRec === null) W("warn", "recycle_missing", "回收日空白（庫齡以 0 天計）");
  else if (dRec < 0) W("warn", "recycle_future", "回收日在未來");
  if (dPur !== null && dPur < 0) W("warn", "purchase_future", "購買日在未來");
  if (dRec !== null && dPur !== null && dPur < dRec) W("warn", "purchase_after_recycle", "購買日晚於回收日");
  const b = numOr(item.battery, null);
  if (b !== null && (b < 0 || b > 100)) W("warn", "battery_range", "電池健康度需在 0–100%");

  // ---- 錨定價 ----
  const quality = qualityFactors(item, g);
  let mode, anchor, marketValue = null;
  if (market !== null && market > 0) {
    mode = "market";
    marketValue = r6(market * quality.total);
    anchor = r6(marketValue * (1 + premium));
    S(`參考市價 ${fmtN(market)} × 品況 ${fmtFactor(quality.total)}`, marketValue);
    S(`門市加成 ${fmtPct(premium)}`, anchor);
    if (!GRADES.includes(String(item.grade || "").toUpperCase())) W("todo", "grade_missing", "成色未評（暫以 ×1.00 計）");
    const md = daysSince(item.marketDate, today);
    if (md === null) W("todo", "market_nodate", "市價沒有查價日期");
    else if (md > numOr(g.marketStaleDays, 30)) W("todo", "market_stale", `市價已 ${md} 天未更新`);
  } else if (cost > 0) {
    mode = "cost";
    let m = isBlank(item.margin) ? numOr(g.defaultTargetMargin, 0) : numOr(item.margin, 0);
    if (m >= 0.9 || m < -0.5) {
      W("warn", "margin_range", `目標毛利率 ${fmtPct(m)} 不合理（應在 -50%～90%），改用預設 ${fmtPct(g.defaultTargetMargin)}`);
      m = numOr(g.defaultTargetMargin, 0);
    }
    anchor = r6(cost / (1 - m));
    S(`成本 ${fmtN(cost)} ÷ (1 − 目標毛利率 ${fmtPct(m)})`, anchor);
    W("todo", "market_missing", "未填參考市價，暫用成本加成");
  } else {
    mode = "none";
    anchor = 0;
    S("缺成本與市價，無法定價", 0);
    W("todo", "market_missing", "未填參考市價");
  }

  // ---- 庫齡折扣 ----
  const { ladder, source } = ladderFor(item.category, g);
  const step = ladderStep(days, ladder);
  let price = r6(anchor * (1 + step.adj));
  const srcTxt = source === "default" ? "" : `・${CATEGORY_LABELS[source] || source}專用`;
  S(step.at !== null ? `庫齡 ${days} 天（≥${step.at} 天 ${fmtPct(step.adj)}${srcTxt}）` : `庫齡 ${days} 天（未達降價門檻）`, price, step.at !== null);

  // ---- 成本底線 ----
  const fl = floorFor(days, cost, g);
  let floorEff = fl.price ?? -Infinity;
  let conflict = false;
  if (mode === "market" && fl.price !== null && fl.price > anchor + EPS) {
    conflict = true;
    floorEff = -Infinity;
    W("warn", "cost_over_market", `成本底線 ${fmtN(fl.price)} 高於市價錨定價 ${fmtN(anchor)}（收購成本偏高），依市價定價`);
  }
  if (price < floorEff) { price = floorEff; S(`成本底線（${fl.text}）${fmtN(fl.price)}`, price, true); }
  else S(fl.price === null ? `成本底線（${fl.text}）` : `成本底線（${fl.text}）${fmtN(fl.price)}${conflict ? "：無法達成，略過" : ""}`, price, conflict);

  // ---- 取整（不破底線）----
  let rounded = roundByMode(price, unit, roundMode);
  if (rounded < floorEff - EPS) rounded = Math.ceil((floorEff - EPS) / unit) * unit;
  price = rounded;
  S("取整", price);

  // ---- 尾數（往下取、不破底線）----
  if (tailStep(tailMode)) {
    let c = tailDown(price, tailMode);
    if (c < floorEff - EPS) c = tailUp(floorEff, tailMode);
    price = c;
    S(`尾數 ${tailMode}`, price);
  }

  // ---- 市價錨定：不高於錨定價 ----
  if (mode === "market" && price > anchor + EPS) {
    const tidy = Math.max(0, tidyDown(anchor, unit, tailMode));
    price = tidy >= floorEff - EPS ? tidy : Math.floor(anchor + EPS);
    S(`不高於錨定價 ${fmtN(anchor)}`, price, true);
  }

  price = Math.max(0, Math.round(price));
  const profit = Math.round(price - cost);
  if (cost > 0 && price < cost) W("warn", "below_cost", `低於成本 ${fmtN(cost - price)} 元（庫齡 ${days} 天），需主管核准`);
  return {
    price, profit, margin: price > 0 ? profit / price : null,
    mode, days, anchor, marketValue, quality,
    floor: fl.price, floorTier: fl.tier, conflict,
    ageMonths: monthsElapsed(item.purchaseDate, today),
    steps, warnings
  };
}

/** 售出商品的實際成交數字（不重算） */
export function saleStats(item) {
  if (item.status !== "sold") return null;
  const price = numOr(item.soldPrice, null);
  const cost = numOr(item.cost, 0);
  const sale = item.sale || {};
  const list = numOr(sale.listPrice, null);
  const suggested = numOr(sale.suggested, null);
  return {
    price,
    profit: price === null ? null : price - cost,
    margin: price ? (price - cost) / price : null,
    daysToSell: daysBetweenISO(item.date, item.soldDate),
    listPrice: list,
    vsList: price !== null && list ? price / list - 1 : null,
    vsSuggested: price !== null && suggested ? price / suggested - 1 : null,
    vsAnchor: price !== null && numOr(sale.anchor, null) ? price / sale.anchor - 1 : null
  };
}

/** 標價是否需要更新：沒標價，或系統建議價與標價差距 ≥ 門檻 */
export function retagCheck(item, r, g) {
  if (item.status === "sold") return null;
  const list = numOr(item.listPrice, null);
  if (list === null) return { reason: "untagged", text: "尚未標價", diff: null };
  const diff = r.price / list - 1;
  if (Math.abs(diff) >= numOr(g.retagThreshold, 0.03) - EPS) {
    return { reason: "diff", text: `建議價與標價差 ${diff > 0 ? "+" : ""}${fmtPct(diff)}`, diff };
  }
  return null;
}

// ============================================================
// 回收估價
// ============================================================
/**
 * input: { category, refType:'used'|'new', refPrice, purchaseDate, grade, battery, accessoriesComplete,
 *          repair, refurbCost, targetMargin }
 * 二手行情（used）直接當參考市價；新品價（new）× 殘值係數（依購買日）推算二手行情。
 */
export function estimateBuyback(input, g, today = todayLocal()) {
  const refPrice = numOr(input.refPrice, null);
  if (refPrice === null || refPrice <= 0) return { error: "請輸入參考價格" };
  const months = monthsElapsed(input.purchaseDate, today);
  let coeff = 1, coeffMonth = 0;
  const notes = [];
  if (input.refType === "new") {
    if (months === null) return { error: "用新品價估算時需要購買日" };
    const c = residualFor(months, g);
    coeff = c.coeff; coeffMonth = c.month;
    if (residualTableUnset(g)) notes.push("殘值係數尚未設定（全為 1.00），用新品價估算會偏高；請到「定價政策」設定，或改用二手行情");
  }
  const usedMarket = Math.round(refPrice * coeff);
  const tm = numOr(input.targetMargin, numOr(g.defaultTargetMargin, 0.15));
  if (tm >= 0.9 || tm < 0) return { error: "目標毛利率需在 0%～90%" };
  const refurb = Math.max(0, numOr(input.refurbCost, numOr(g.estimatorRefurbCost, 0)));
  const virtual = (cost, days) => ({
    ...input, name: "估價", market: usedMarket, marketDate: toISODate(today), marketAdj: "",
    cost, date: addDaysISO(today, -days)
  });
  // 成本 0 → 不套成本底線，得到純市價推算的售價
  const r0 = computePrice(virtual(0, 0), g, today);
  const suggested = Math.max(0, Math.floor((r0.price * (1 - tm) - refurb) / 100) * 100);
  const effCost = suggested + refurb;
  const scenarios = [0, 30, 60, 90, 180].map((d) => {
    const r = computePrice(virtual(effCost, d), g, today);
    return { days: d, price: r.price, profit: r.price - effCost, margin: r.price ? (r.price - effCost) / r.price : null };
  });
  // 放到 180 天出清仍不虧本的最高收價
  const r180 = computePrice(virtual(0, 180), g, today);
  const maxBuy = Math.max(0, Math.floor((r180.price - refurb) / 100) * 100);
  return {
    months, coeffMonth, coeff, usedMarket, quality: r0.quality, marketValue: r0.marketValue,
    price0: r0.price, targetMargin: tm, refurb, suggested, maxBuy, scenarios, notes
  };
}
