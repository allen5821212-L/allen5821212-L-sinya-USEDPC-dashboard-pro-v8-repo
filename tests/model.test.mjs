// 資料模型與 v8 升級測試
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultPolicy, normalizePolicy, policyDiff, policyFromV8, itemFromV8, migrateFromV8, nextSku, ensureSkus,
  normalizeItem, duplicateSerials, seedItems, validatePolicyValue, POLICY_FIELDS
} from "../js/model.js";
import { computePrice, addDaysISO } from "../js/pricing.js";

const TODAY = new Date(2026, 9, 12);

test("政策正規化：空白可設為不設、超出範圍會夾住、分類階梯", () => {
  const p = normalizePolicy({ floorTier2CostPct: "", minMargin: 5, ladders: { MON: [{ days: 30, adj: -0.2 }], NB: [] } });
  assert.equal(p.floorTier2CostPct, null);
  assert.equal(p.minMargin, 0.89);
  assert.deepEqual(p.ladders.MON, [{ days: 30, adj: -0.2 }]);
  assert.equal(p.ladders.NB, null);
  assert.equal(normalizePolicy({}).floorTier2CostPct, 0.8);
});

test("政策差異：列出改了哪些欄位", () => {
  const a = defaultPolicy(), b = defaultPolicy();
  b.grades.B = 0.9;
  b.ladders.NB = [{ days: 45, adj: -0.1 }];
  const d = policyDiff(a, b);
  assert.equal(d.length, 2);
  assert.ok(d.some((x) => x.key === "grades.B" && x.to === "×0.9"));
});

test("欄位驗證", () => {
  const f = POLICY_FIELDS.find((x) => x.key === "minMargin");
  assert.equal(validatePolicyValue(f, 0.1), null);
  assert.ok(validatePolicyValue(f, 0.95));
  assert.ok(validatePolicyValue(f, ""));
  assert.equal(validatePolicyValue(POLICY_FIELDS.find((x) => x.key === "floorTier2CostPct"), null), null);
});

test("v8 政策升級：加價率底線 → 成本 %、階梯與月係數搬移", () => {
  const p = policyFromV8({ minMarginFloor: 0.1, defaultMarketAdj: 0.05, floorRelaxOn: true, floorTier1Days: 90, floorTier1Margin: 0,
    floorTier2Days: 180, floorTier2Margin: -0.2, ladder: [{ days: 30, adj: -0.05 }], monthlyCoeffs: Array(18).fill(0.9), notBelowMarketPct: -0.05 });
  assert.equal(p.floorTier1CostPct, 1);
  assert.equal(p.floorTier2CostPct, 0.8);
  assert.equal(p.storePremium, 0.05);
  assert.equal(p.minMargin, 0.1);
  assert.deepEqual(p.ladders.default, [{ days: 30, adj: -0.05 }]);
  assert.equal(p.residualCoeffs[0], 0.9);
  assert.equal(policyFromV8({ floorTier2Margin: null }).floorTier2CostPct, null);
  assert.equal(policyFromV8({}).floorTier2CostPct, 0.8); // v8.6 沒有這欄 → 預設
});

test("v8 商品升級：加價率換算為毛利率，無市價時售價不變", () => {
  const it = itemFromV8({ name: "舊", category: "NB", cost: 10000, margin: 0.2, date: addDaysISO(TODAY, -10) });
  assert.ok(Math.abs(it.margin - 0.2 / 1.2) < 1e-6);
  assert.equal(computePrice(it, defaultPolicy(), TODAY).price, 11999);
});

test("整包升級：補庫存編號、附說明", () => {
  const r = migrateFromV8({ version: "8.7.1", globals: {}, items: [
    { name: "a", cost: 1, date: "2026-10-01" }, { name: "b", cost: 1, date: "2026-10-01" }, { name: "c", cost: 1 }
  ] }, TODAY);
  assert.deepEqual(r.items.map((x) => x.sku), ["U20261001-001", "U20261001-002", "U20261012-001"]);
  assert.equal(r.notes.length, 3);
});

test("庫存編號：流水號遞增、重複自動改號", () => {
  assert.equal(nextSku([{ sku: "U20261012-007" }, { sku: "U20261011-099" }], "2026-10-12"), "U20261012-008");
  const out = ensureSkus([normalizeItem({ sku: "X1" }), normalizeItem({ sku: "X1", date: "2026-10-12" })], TODAY);
  assert.equal(out[0].sku, "X1");
  assert.equal(out[1].sku, "U20261012-001");
});

test("商品正規化：電池 0.85 → 85%、成色大寫、配件預設齊全", () => {
  const it = normalizeItem({ battery: 0.85, grade: "b" });
  assert.equal(it.battery, 85);
  assert.equal(it.grade, "B");
  assert.equal(it.accessoriesComplete, true);
  assert.equal(it.status, "stock");
});

test("序號重複偵測", () => {
  const m = duplicateSerials([{ serial: "S1" }, { serial: "S1" }, { serial: "S2" }, { serial: "" }]);
  assert.deepEqual([...m.entries()], [["S1", 2]]);
});

test("範例資料可正常計價、編號唯一", () => {
  const items = seedItems(TODAY);
  assert.equal(new Set(items.map((x) => x.sku)).size, items.length);
  for (const it of items) assert.ok(Number.isFinite(computePrice(it, defaultPolicy(), TODAY).price));
});
