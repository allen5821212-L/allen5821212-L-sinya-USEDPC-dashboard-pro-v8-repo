// 匯入匯出測試
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCSV, parseDateCell, parsePctCell, parseNumberCell, parseGrade, parseCategory, rowsToItems, mergeItems,
  itemsToAoa, policyToAoa, policyFromRows, parseLadderText, tagListAoa, aoaToCSV, templateAoa, ITEM_COLUMNS
} from "../js/io.js";
import { defaultPolicy, normalizeItem } from "../js/model.js";
import { computePrice } from "../js/pricing.js";

const TODAY = new Date(2026, 9, 12);

test("百分比：20%、0.2、20 都是 20%", () => {
  assert.equal(parsePctCell("20%"), 0.2);
  assert.equal(parsePctCell(0.2), 0.2);
  assert.equal(parsePctCell(20), 0.2);
  assert.equal(parsePctCell("-5"), -0.05);
  assert.equal(parsePctCell(""), "");
  assert.equal(parsePctCell("abc"), null);
});

test("數字、日期、成色、分類解析", () => {
  assert.equal(parseNumberCell("NT$18,500"), 18500);
  assert.equal(parseDateCell("114/8/4"), "2025-08-04");
  assert.equal(parseDateCell(20250105), "2025-01-05");
  assert.equal(parseDateCell(45900), "2025-08-31");
  assert.equal(parseDateCell("2025.09.15"), "2025-09-15");
  assert.equal(parseDateCell("abc"), null);
  assert.deepEqual(parseGrade("b級"), { value: "B", ok: true });
  assert.deepEqual(parseGrade("乙"), { value: "B", ok: true });
  assert.equal(parseGrade("X").ok, false);
  assert.equal(parseCategory("顯示器").value, "MON");
  assert.equal(parseCategory("平板").ok, false);
});

test("CSV 解析：引號、逗號、換行、BOM", () => {
  assert.deepEqual(parseCSV("﻿a,b\n\"x,1\",\"he said \"\"hi\"\"\"\n"), [["a", "b"], ["x,1", "he said \"hi\""]]);
});

test("v9 列匯入：欄位對應、電池、配件、標題列在第 2 列", () => {
  const rows = [
    ["庫存清單"],
    ["庫存編號", "名稱", "分類", "成色", "電池健康度", "配件齊全", "成本", "目標毛利率", "參考市價", "市價日期"],
    ["U1", "TUF", "筆電", "B", "86%", "否", "21,000", "20%", 26800, "2026/10/1"],
    ["", "", "", "", "", "", "", "", "", ""],
    ["U2", "螢幕", "螢幕", "Z", 0.7, "", "x", 25, "", ""]
  ];
  const r = rowsToItems(rows, { today: TODAY });
  assert.equal(r.headerRow, 2);
  assert.equal(r.legacy, false);
  assert.equal(r.items.length, 2);
  assert.equal(r.blank, 1);
  const [a, b] = r.items;
  assert.equal(a.battery, 86);
  assert.equal(a.accessoriesComplete, false);
  assert.equal(a.cost, 21000);
  assert.equal(a.margin, 0.2);
  assert.equal(a.marketDate, "2026-10-01");
  assert.equal(b.battery, 70);
  assert.equal(b.accessoriesComplete, true);
  assert.equal(b.margin, 0.25);
  assert.ok(r.warnings.some((w) => w.includes("成色「Z」")));
  assert.ok(r.warnings.some((w) => w.includes("成本「x」")));
});

test("v8 匯出檔：毛利率視為加價率並換算", () => {
  const rows = [["名稱", "分類", "購買日", "回收日", "成本", "毛利率", "市場價", "市價調整％", "維修", "維修備註", "月係數覆寫"],
    ["舊品", "NB", "2025-04-15", "2026-10-02", 10000, 0.2, "", "", "", "", ""]];
  const r = rowsToItems(rows, { today: TODAY });
  assert.equal(r.legacy, true);
  assert.ok(Math.abs(r.items[0].margin - 0.2 / 1.2) < 1e-6);
  assert.equal(computePrice(r.items[0], defaultPolicy(), TODAY).price, 11999);
});

test("合併：同編號更新、同序號更新、無編號用名稱＋回收日＋成本比對，重複匯入不會變兩份", () => {
  const existing = [normalizeItem({ sku: "U1", name: "A", cost: 100, date: "2026-10-01", priceHistory: [{ date: "2026-10-02", price: 120 }] }),
    normalizeItem({ sku: "U2", serial: "SN2", name: "B", cost: 200, date: "2026-10-01" })];
  const incoming = [normalizeItem({ sku: "U1", name: "A2", cost: 110 }), normalizeItem({ serial: "SN2", name: "B2" }),
    normalizeItem({ name: "B", cost: 200, date: "2026-10-01" }), normalizeItem({ name: "C", cost: 300, date: "2026-10-05" })];
  const { items, report } = mergeItems(existing, incoming, "upsert", TODAY);
  assert.equal(items.length, 3);
  assert.equal(report.updated, 3);
  assert.equal(report.added, 1);
  assert.equal(items[0].name, "A2");
  assert.equal(items[0].priceHistory.length, 1);
  assert.equal(items[0].id, existing[0].id);
  assert.ok(items[2].sku.startsWith("U20261005-"));
  const again = mergeItems(items, [normalizeItem({ name: "C", cost: 300, date: "2026-10-05" })], "upsert", TODAY);
  assert.equal(again.items.length, 3);
});

test("合併：附加模式略過同編號、檔內重複編號以後者為準、取代模式", () => {
  const existing = [normalizeItem({ sku: "U1", name: "A" })];
  const inc = [normalizeItem({ sku: "U1", name: "X" }), normalizeItem({ sku: "U9", name: "first" }), normalizeItem({ sku: "U9", name: "second" })];
  const ap = mergeItems(existing, inc, "append", TODAY);
  assert.deepEqual(ap.report.skipped, ["U1"]);
  assert.deepEqual(ap.report.dupInFile, ["U9"]);
  assert.equal(ap.items.find((x) => x.sku === "U9").name, "second");
  assert.equal(mergeItems(existing, inc, "replace", TODAY).items.length, 2);
});

test("匯出後再匯入：欄位與售價完全一致", () => {
  const items = [normalizeItem({ sku: "U1", name: "TUF", category: "NB", grade: "B", battery: 86, accessoriesComplete: false, repair: true,
    cost: 21000, market: 26800, marketDate: "2026-10-05", marketSource: "露天", date: "2026-09-01", purchaseDate: "2025-08-04", margin: 0.2 }),
  normalizeItem({ sku: "U2", name: "賣掉的", status: "sold", soldDate: "2026-10-10", soldPrice: 5000, cost: 4000, date: "2026-09-01" })];
  const aoa = itemsToAoa(items, defaultPolicy(), TODAY);
  assert.equal(aoa[0].length, ITEM_COLUMNS.length + 8);
  const back = rowsToItems(aoa, { today: TODAY }).items;
  const strip = (x) => { const { id, createdAt, sale, ...rest } = x; return rest; };
  assert.deepEqual(back.map(strip), items.map(strip));
  assert.equal(computePrice(back[0], defaultPolicy(), TODAY).price, computePrice(items[0], defaultPolicy(), TODAY).price);
});

test("政策參數表：匯出再匯入不變；可改單一欄位；階梯文字", () => {
  const p = defaultPolicy();
  p.ladders.MON = [{ days: 20, adj: -0.12 }];
  p.floorTier2CostPct = null;
  const rows = policyToAoa(p);
  assert.deepEqual(policyFromRows(rows, defaultPolicy()).policy, p);
  const edited = rows.map((r) => (r[2] === "grades.B" ? [r[0], 0.9, r[2], r[3]] : r));
  assert.equal(policyFromRows(edited, p).policy.grades.B, 0.9);
  assert.deepEqual(parseLadderText("30/-5%, 60天 -10, 90/-0.15").ladder, [{ days: 30, adj: -0.05 }, { days: 60, adj: -0.1 }, { days: 90, adj: -0.15 }]);
  assert.deepEqual(parseLadderText("abc, 30/-150%").invalid, ["abc", "30/-150%"]);
});

test("標價清單與 CSV、範本欄數", () => {
  const items = [normalizeItem({ sku: "U1", name: "A", cost: 100, date: "2026-10-01" }), normalizeItem({ sku: "U2", status: "sold" })];
  const t = tagListAoa(items, defaultPolicy(), TODAY);
  assert.equal(t.length, 2);
  assert.ok(aoaToCSV([["a", "b,c"]]).startsWith("﻿a,\"b,c\""));
  for (const row of templateAoa(TODAY)) assert.equal(row.length, ITEM_COLUMNS.length);
  const tpl = rowsToItems(templateAoa(TODAY), { today: TODAY });
  assert.equal(tpl.items.length, 2);
  assert.equal(tpl.warnings.length, 0);
});
