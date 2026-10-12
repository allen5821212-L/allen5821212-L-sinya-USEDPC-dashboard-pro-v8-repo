// 定價引擎單元測試：node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computePrice, floorFor, qualityFactors, retagCheck, estimateBuyback, monthsElapsed, daysSince,
  tailDown, tailUp, addDaysISO, residualFor, markupToMargin
} from "../js/pricing.js";
import { defaultPolicy } from "../js/model.js";

const TODAY = new Date(2026, 9, 12); // 2026-10-12
const ago = (n) => addDaysISO(TODAY, -n);
const P = () => defaultPolicy();
const price = (item, g = P()) => computePrice(item, g, TODAY);
const codes = (r) => r.warnings.map((w) => w.code);

test("市價錨定：A 級、10 天 → 市價 × 1.05，尾數往下", () => {
  const r = price({ cost: 20000, market: 26000, grade: "A", date: ago(10), marketDate: ago(5) });
  assert.equal(r.mode, "market");
  assert.equal(r.anchor, 27300);
  assert.equal(r.price, 27299);
  assert.deepEqual(codes(r), []);
});

test("品況係數：成色 B × 維修 × 電池 <80% × 配件不齊，價格不高於錨定價", () => {
  const item = { grade: "B", repair: true, battery: 70, accessoriesComplete: false };
  const q = qualityFactors(item, P());
  assert.equal(q.parts.length, 4);
  assert.ok(Math.abs(q.total - 0.93 * 0.95 * 0.95 * 0.97) < 1e-6);
  const r = price({ ...item, cost: 20000, market: 26000, date: ago(10), marketDate: ago(5) });
  assert.ok(r.price <= r.anchor);
  assert.equal(r.price, 22226); // 尾數價會跌破底線 22,222 → 取錨定價整數
});

test("電池剛好 80% 不扣分，79% 才扣", () => {
  assert.equal(qualityFactors({ battery: 80 }, P()).total, 1);
  assert.equal(qualityFactors({ battery: 79 }, P()).total, 0.95);
});

test("市價錨定：庫齡 100 天降 15%，底線放寬到成本", () => {
  const r = price({ cost: 20000, market: 26000, grade: "A", date: ago(100), marketDate: ago(5) });
  assert.equal(r.floorTier, 1);
  assert.equal(r.price, 23209);
});

test("市價錨定：庫齡 200 天降 25%（底線成本 8 成未觸及）", () => {
  const r = price({ cost: 20000, market: 26000, grade: "A", date: ago(200), marketDate: ago(5) });
  assert.equal(r.floorTier, 2);
  assert.equal(r.price, 20479);
});

test("收購成本高於市價：底線無法達成 → 依市價定價並標示", () => {
  const r = price({ cost: 26000, market: 26000, grade: "A", date: ago(10), marketDate: ago(5) });
  assert.equal(r.price, 27299);
  assert.ok(codes(r).includes("cost_over_market"));
  const r2 = price({ cost: 28000, market: 26000, grade: "A", date: ago(10), marketDate: ago(5) });
  assert.equal(r2.price, 27299);
  assert.ok(codes(r2).includes("below_cost"));
});

test("無市價：成本 ÷ (1 − 毛利率)，並列入待補", () => {
  const r = price({ cost: 10000, margin: 0.2, date: ago(10) });
  assert.equal(r.mode, "cost");
  assert.equal(r.price, 12499);
  assert.ok(r.warnings.some((w) => w.code === "market_missing" && w.level === "todo"));
  assert.equal(price({ cost: 10000, date: ago(10) }).price, 11759); // 預設 15%
});

test("毛利率不合理（≥90%）→ 標示並改用預設", () => {
  const r = price({ cost: 10000, margin: 1.5, date: ago(10) });
  assert.ok(codes(r).includes("margin_range"));
  assert.equal(r.price, 11759);
});

test("無市價、60 天：降價被基本底線擋住，取整往上不破底線", () => {
  const r = price({ cost: 10000, margin: 0.15, date: ago(60) });
  assert.equal(r.price, 11119); // 底線 10000/0.9 = 11,111.1
  assert.ok(r.price >= 10000 / 0.9);
});

test("v8 換算一致：加價 20% → 毛利率 16.67%，售價相同", () => {
  const r = price({ cost: 10000, margin: markupToMargin(0.2), date: ago(10) });
  assert.equal(r.price, 11999); // v8：10000 × 1.2 = 12000 → 尾數 11999
});

test("分類專用階梯優先於預設階梯", () => {
  const g = P();
  g.ladders.MON = [{ days: 30, adj: -0.2 }];
  const item = { category: "MON", cost: 5000, market: 10000, grade: "A", date: ago(40), marketDate: ago(1) };
  assert.equal(computePrice(item, g, TODAY).price, 8399);
  assert.equal(computePrice({ ...item, category: "NB" }, g, TODAY).price, 9979);
});

test("待補資料：成色未評、市價無日期、市價過期", () => {
  const base = { cost: 10000, market: 15000, date: ago(5) };
  assert.ok(codes(price(base)).includes("grade_missing"));
  assert.ok(codes(price(base)).includes("market_nodate"));
  assert.ok(codes(price({ ...base, grade: "A", marketDate: ago(40) })).includes("market_stale"));
  assert.ok(!codes(price({ ...base, grade: "A", marketDate: ago(30) })).includes("market_stale"));
});

test("資料檢查：成本空白、回收日空白／未來、購買日晚於回收日", () => {
  assert.ok(codes(price({ market: 1000, grade: "A", marketDate: ago(1), date: ago(1) })).includes("cost_missing"));
  assert.ok(codes(price({ cost: 1000 })).includes("recycle_missing"));
  assert.ok(codes(price({ cost: 1000, date: addDaysISO(TODAY, 3) })).includes("recycle_future"));
  assert.ok(codes(price({ cost: 1000, date: ago(20), purchaseDate: ago(10) })).includes("purchase_after_recycle"));
});

test("成本底線分階：89／90／179／180 天", () => {
  const g = P();
  assert.ok(Math.abs(floorFor(89, 10000, g).price - 11111.111111) < 1e-3);
  assert.equal(floorFor(90, 10000, g).price, 10000);
  assert.equal(floorFor(179, 10000, g).price, 10000);
  assert.equal(floorFor(180, 10000, g).price, 8000);
  g.floorTier2CostPct = null;
  assert.equal(floorFor(180, 10000, g).price, null);
  g.floorRelaxOn = false;
  assert.ok(floorFor(400, 10000, g).price > 11111);
});

test("標價檢查：未標價、差距未達門檻、差距達門檻", () => {
  const g = P();
  assert.equal(retagCheck({ status: "stock", listPrice: "" }, { price: 100 }, g).reason, "untagged");
  assert.equal(retagCheck({ status: "stock", listPrice: 10000 }, { price: 10200 }, g), null);
  assert.equal(retagCheck({ status: "stock", listPrice: 10000 }, { price: 10400 }, g).reason, "diff");
  assert.equal(retagCheck({ status: "sold", listPrice: 10000 }, { price: 1 }, g), null);
});

test("回收估價：二手行情 → 建議收價與 180 天不虧上限", () => {
  const e = estimateBuyback({ refType: "used", refPrice: 20000, grade: "A", targetMargin: 0.2, refurbCost: 500 }, P(), TODAY);
  assert.equal(e.price0, 20999);
  assert.equal(e.suggested, 16200);
  assert.equal(e.maxBuy, 15200);
  assert.equal(e.scenarios.length, 5);
});

test("回收估價：新品價需要購買日；殘值係數未設定會提示", () => {
  assert.ok(estimateBuyback({ refType: "new", refPrice: 30000 }, P(), TODAY).error);
  const e = estimateBuyback({ refType: "new", refPrice: 30000, purchaseDate: "2025-10-12", grade: "A" }, P(), TODAY);
  assert.equal(e.coeffMonth, 12);
  assert.equal(e.notes.length, 1);
  const g = P();
  g.residualCoeffs = Array.from({ length: 18 }, (_, i) => 0.9 - 0.02 * i);
  const e2 = estimateBuyback({ refType: "new", refPrice: 30000, purchaseDate: "2025-10-12", grade: "A" }, g, TODAY);
  assert.equal(e2.usedMarket, Math.round(30000 * (0.9 - 0.02 * 11)));
  assert.equal(e2.notes.length, 0);
});

test("殘值係數：未滿 1 月為 1、超過 18 月用第 18 月、累乘模式", () => {
  const g = P();
  g.residualCoeffs = Array.from({ length: 18 }, () => 0.9);
  assert.equal(residualFor(0, g).coeff, 1);
  assert.equal(residualFor(30, g).month, 18);
  g.cumulativeMode = true;
  assert.ok(Math.abs(residualFor(2, g).coeff - 0.81) < 1e-9);
});

test("日期：曆法月、月底對齊、天數", () => {
  const T = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  assert.equal(monthsElapsed("2025-08-04", T("2025-10-04")), 2);
  assert.equal(monthsElapsed("2025-08-04", T("2025-10-03")), 1);
  assert.equal(monthsElapsed("2025-01-31", T("2025-02-28")), 1);
  assert.equal(monthsElapsed("2024-01-31", T("2024-02-29")), 1);
  assert.equal(monthsElapsed("2026-01-01", T("2025-10-04")), 0);
  assert.equal(daysSince("2026-10-02", TODAY), 10);
  assert.equal(daysSince("", TODAY), null);
});

test("尾數：往下取與往上取", () => {
  assert.equal(tailDown(11450, "9"), 11449);
  assert.equal(tailDown(11450, "99"), 11399);
  assert.equal(tailUp(11000.000000000002, "9"), 11009);
  assert.equal(tailUp(11000, "99"), 11099);
});
