// SINYA USEDPC — 經營分析（純函式）
import {
  CATEGORIES, numOr, computePrice, retagCheck, saleStats, daysBetweenISO, monthsElapsed, dateFromISO,
  ladderFor, ladderStep, residualFor, todayLocal, parseISODate
} from "./pricing.js";

export const AGE_BUCKETS = [
  { key: "0-30", label: "0–30 天", min: 0, max: 30, mid: 15 },
  { key: "31-60", label: "31–60 天", min: 31, max: 60, mid: 45 },
  { key: "61-90", label: "61–90 天", min: 61, max: 90, mid: 75 },
  { key: "91-180", label: "91–180 天", min: 91, max: 180, mid: 135 },
  { key: "181+", label: "181 天以上", min: 181, max: Infinity, mid: 240 }
];
export const bucketOf = (days) => AGE_BUCKETS.find((b) => days >= b.min && days <= b.max) || AGE_BUCKETS[AGE_BUCKETS.length - 1];

/** 在庫商品逐筆計價 */
export function evaluateStock(items, policy, today = todayLocal()) {
  return items.filter((it) => it.status !== "sold").map((item) => {
    const r = computePrice(item, policy, today);
    return { item, r, retag: retagCheck(item, r, policy) };
  });
}

export function inventorySummary(evals) {
  const s = { count: 0, cost: 0, suggested: 0, profit: 0, margin: null, avgDays: null,
    over90Count: 0, over90Cost: 0, belowCostCount: 0, warnCount: 0, todoCount: 0, retagCount: 0 };
  let daySum = 0;
  for (const { item, r, retag } of evals) {
    const cost = numOr(item.cost, 0);
    s.count++; s.cost += cost; s.suggested += r.price; s.profit += r.price - cost; daySum += r.days;
    if (r.days > 90) { s.over90Count++; s.over90Cost += cost; }
    if (r.warnings.some((w) => w.code === "below_cost")) s.belowCostCount++;
    if (r.warnings.some((w) => w.level === "warn")) s.warnCount++;
    if (r.warnings.some((w) => w.level === "todo")) s.todoCount++;
    if (retag) s.retagCount++;
  }
  s.margin = s.suggested > 0 ? s.profit / s.suggested : null;
  s.avgDays = s.count ? daySum / s.count : null;
  return s;
}

export function agingBuckets(evals) {
  const out = AGE_BUCKETS.map((b) => ({ ...b, count: 0, cost: 0, suggested: 0 }));
  for (const { item, r } of evals) {
    const b = out.find((x) => r.days >= x.min && r.days <= x.max) || out[out.length - 1];
    b.count++; b.cost += numOr(item.cost, 0); b.suggested += r.price;
  }
  return out;
}

const inWindow = (iso, fromISO, toISO) => !!iso && (!fromISO || iso >= fromISO) && (!toISO || iso <= toISO);

/** 售出分析（依售出日區間） */
export function soldSummary(items, fromISO, toISO) {
  const sold = items.filter((it) => it.status === "sold" && inWindow(it.soldDate, fromISO, toISO));
  const s = { count: 0, revenue: 0, profit: 0, margin: null, avgDaysToSell: null, avgVsList: null, avgVsSuggested: null, belowCost: 0 };
  let dts = 0, nd = 0, vl = 0, nl = 0, vs = 0, ns = 0;
  for (const it of sold) {
    const st = saleStats(it);
    if (!st || st.price === null) continue;
    s.count++; s.revenue += st.price; s.profit += st.profit;
    if (st.profit < 0) s.belowCost++;
    if (st.daysToSell !== null && st.daysToSell >= 0) { dts += st.daysToSell; nd++; }
    if (st.vsList !== null) { vl += st.vsList; nl++; }
    if (st.vsSuggested !== null) { vs += st.vsSuggested; ns++; }
  }
  s.margin = s.revenue > 0 ? s.profit / s.revenue : null;
  s.avgDaysToSell = nd ? dts / nd : null;
  s.avgVsList = nl ? vl / nl : null;
  s.avgVsSuggested = ns ? vs / ns : null;
  return s;
}

/** 各分類：在庫件數／成本／平均庫齡；區間內售出件數／實際毛利率／平均周轉天數 */
export function categoryStats(items, evals, fromISO, toISO) {
  return CATEGORIES.map((c) => {
    const ev = evals.filter((e) => e.item.category === c);
    const sold = soldSummary(items.filter((it) => it.category === c), fromISO, toISO);
    const daySum = ev.reduce((a, e) => a + e.r.days, 0);
    return {
      category: c,
      stockCount: ev.length,
      stockCost: ev.reduce((a, e) => a + numOr(e.item.cost, 0), 0),
      avgDays: ev.length ? daySum / ev.length : null,
      over90: ev.filter((e) => e.r.days > 90).length,
      soldCount: sold.count, soldMargin: sold.margin, avgDaysToSell: sold.avgDaysToSell
    };
  });
}

export function staleList(evals, minDays = 90) {
  return evals.filter((e) => e.r.days > minDays).sort((a, b) => b.r.days - a.r.days);
}

/**
 * 降價階梯校正：已售出且有錨定價紀錄的商品，依售出時庫齡分組，
 * 比較「實際成交相對錨定價」與「現行階梯降幅」。
 */
export function ladderCalibration(items, policy) {
  const groups = AGE_BUCKETS.map((b) => ({ ...b, n: 0, sum: 0, policySum: 0 }));
  for (const it of items) {
    if (it.status !== "sold" || !it.sale) continue;
    const anchor = numOr(it.sale.anchor, null), price = numOr(it.soldPrice, null);
    const days = numOr(it.sale.days, daysBetweenISO(it.date, it.soldDate));
    if (!anchor || price === null || days === null || days < 0) continue;
    const g = groups.find((x) => days >= x.min && days <= x.max) || groups[groups.length - 1];
    g.n++; g.sum += price / anchor - 1;
    g.policySum += ladderStep(days, ladderFor(it.category, policy).ladder).adj;
  }
  return groups.map((g) => ({
    key: g.key, label: g.label, n: g.n,
    actual: g.n ? g.sum / g.n : null,
    policy: g.n ? g.policySum / g.n : ladderStep(g.mid, ladderFor("OTH", policy).ladder).adj
  }));
}

export const RESIDUAL_BUCKETS = [
  { label: "1–3 個月", min: 1, max: 3 }, { label: "4–6 個月", min: 4, max: 6 }, { label: "7–12 個月", min: 7, max: 12 },
  { label: "13–18 個月", min: 13, max: 18 }, { label: "19 個月以上", min: 19, max: Infinity }
];
/** 殘值係數校正：已售出且有新品價、購買日的商品，成交價 ÷ 新品價，依機齡分組 */
export function residualCalibration(items, policy) {
  const groups = RESIDUAL_BUCKETS.map((b) => ({ ...b, n: 0, sum: 0, policySum: 0 }));
  for (const it of items) {
    if (it.status !== "sold") continue;
    const np = numOr(it.newPrice, null), price = numOr(it.soldPrice, null);
    const sd = dateFromISO(it.soldDate);
    if (!np || price === null || !sd || !parseISODate(it.purchaseDate)) continue;
    const m = monthsElapsed(it.purchaseDate, sd);
    if (m === null || m < 1) continue;
    const g = groups.find((x) => m >= x.min && m <= x.max);
    if (!g) continue;
    g.n++; g.sum += price / np; g.policySum += residualFor(m, policy).coeff;
  }
  return groups.map((g) => ({ label: g.label, n: g.n, actual: g.n ? g.sum / g.n : null, policy: g.n ? g.policySum / g.n : null }));
}
