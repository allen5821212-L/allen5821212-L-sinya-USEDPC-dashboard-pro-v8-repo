// 經營分析測試
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateStock, inventorySummary, agingBuckets, soldSummary, categoryStats, staleList, ladderCalibration, residualCalibration
} from "../js/analytics.js";
import { defaultPolicy, normalizeItem } from "../js/model.js";
import { addDaysISO } from "../js/pricing.js";

const TODAY = new Date(2026, 9, 12);
const ago = (n) => addDaysISO(TODAY, -n);
const P = defaultPolicy();
const items = [
  normalizeItem({ sku: "A", category: "NB", cost: 10000, market: 15000, grade: "A", marketDate: ago(1), date: ago(10), listPrice: 15749 }),
  normalizeItem({ sku: "B", category: "NB", cost: 10000, margin: 0.2, date: ago(100) }),
  normalizeItem({ sku: "C", category: "MON", cost: 5000, market: 4000, grade: "A", marketDate: ago(1), date: ago(200) }),
  normalizeItem({ sku: "S1", category: "NB", status: "sold", cost: 8000, soldPrice: 10000, date: ago(70), soldDate: ago(10),
    newPrice: 30000, purchaseDate: "2025-10-01", sale: { anchor: 11000, listPrice: 10500, suggested: 10499, days: 60 } }),
  normalizeItem({ sku: "S2", category: "MON", status: "sold", cost: 3000, soldPrice: 2900, date: ago(300), soldDate: ago(200) })
];

test("在庫摘要：件數、成本、>90 天、低於成本、需重新標價", () => {
  const ev = evaluateStock(items, P, TODAY);
  assert.equal(ev.length, 3);
  const s = inventorySummary(ev);
  assert.equal(s.count, 3);
  assert.equal(s.cost, 25000);
  assert.equal(s.over90Count, 2);
  assert.equal(s.belowCostCount, 1); // C：市價 4,000 < 成本 5,000
  assert.equal(s.retagCount, 2);     // B、C 未標價；A 標價與建議價一致
  assert.ok(Math.abs(s.avgDays - (10 + 100 + 200) / 3) < 1e-9);
});

test("庫齡分布", () => {
  const b = agingBuckets(evaluateStock(items, P, TODAY));
  assert.deepEqual(b.map((x) => x.count), [1, 0, 0, 1, 1]);
});

test("售出分析：區間、實際毛利率、周轉天數、成交 vs 標價", () => {
  const s = soldSummary(items, ago(30), addDaysISO(TODAY, 0));
  assert.equal(s.count, 1);
  assert.equal(s.revenue, 10000);
  assert.equal(s.margin, 0.2);
  assert.equal(s.avgDaysToSell, 60);
  assert.ok(Math.abs(s.avgVsList - (10000 / 10500 - 1)) < 1e-9);
  assert.equal(soldSummary(items).count, 2);
  assert.equal(soldSummary(items).belowCost, 1);
});

test("分類統計與滯銷清單", () => {
  const ev = evaluateStock(items, P, TODAY);
  const nb = categoryStats(items, ev).find((c) => c.category === "NB");
  assert.equal(nb.stockCount, 2);
  assert.equal(nb.soldCount, 1);
  assert.deepEqual(staleList(ev).map((e) => e.item.sku), ["C", "B"]);
});

test("校正：階梯（成交 vs 錨定價）與殘值（成交 ÷ 新品價）", () => {
  const lc = ladderCalibration(items, P);
  const g = lc.find((x) => x.key === "31-60");
  assert.equal(g.n, 1);
  assert.ok(Math.abs(g.actual - (10000 / 11000 - 1)) < 1e-9);
  assert.equal(g.policy, -0.1);
  const rc = residualCalibration(items, P);
  const r = rc.find((x) => x.label === "7–12 個月");
  assert.equal(r.n, 1);
  assert.ok(Math.abs(r.actual - 10000 / 30000) < 1e-9);
});
