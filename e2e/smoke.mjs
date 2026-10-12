// 瀏覽器煙霧測試：npm run test:e2e
// 啟動本機靜態伺服器 → 用 Playwright（Chromium）走過主要流程。任何頁面錯誤或斷言失敗都會讓測試失敗。
// 環境變數 XLSX_PATH：指定本機 SheetJS 檔（離線環境用）；未指定則從 CDN 載入。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".md": "text/plain; charset=utf-8", ".json": "application/json" };

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.join(ROOT, p === "/" ? "index.html" : p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const URL_ = `http://127.0.0.1:${server.address().port}/index.html`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: "Asia/Taipei", acceptDownloads: true });
await ctx.route("**/*", (route) => {
  const u = route.request().url();
  if (u.startsWith("http://127.0.0.1")) return route.continue();
  if (/fonts\.(googleapis|gstatic)/.test(u)) return route.abort();
  if (/xlsx/.test(u) && process.env.XLSX_PATH) return route.fulfill({ path: process.env.XLSX_PATH, contentType: "text/javascript" });
  return route.continue();
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("dialog", (d) => { errors.push(`unexpected dialog: ${d.message()}`); d.dismiss(); });

// 存檔有 200ms 防抖，讀取前先等一下
const store = async (expr) => {
  await page.waitForTimeout(350);
  return page.evaluate(`(() => { const s = JSON.parse(localStorage.getItem("sinya-usedpc-v9")); return ${expr}; })()`);
};
const toast = () => page.textContent("#toastMsg");
let step = "";
const results = [];
async function check(name, fn) {
  step = name;
  await fn();
  results.push(name);
  console.log(`✓ ${name}`);
}

try {
  await page.goto(URL_);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector("#itemsTable tbody tr");

  await check("載入範例資料，沒有錯誤", async () => {
    assert.equal(await page.locator("#itemsTable tbody tr").count(), 5);
    assert.deepEqual(errors, []);
  });

  await check("新增回收品：即時試算、自動編號與市價日期", async () => {
    const f = page.locator("#addForm");
    await f.locator("[name=name]").fill("煙霧測試筆電");
    await f.locator("[name=cost]").fill("15000");
    await f.locator("[name=market]").fill("20000");
    await f.locator("[name=grade]").selectOption("B");
    assert.match(await page.textContent("#addPreview"), /19,529/);
    await f.locator("button[type=submit]").click();
    assert.match(await toast(), /已加入 U\d{8}-\d{3}/);
    const it = await store(`s.items.find((i) => i.name === "煙霧測試筆電")`);
    assert.ok(it.sku && it.marketDate);
  });

  await check("標價與售出", async () => {
    await page.fill("#fKeyword", "煙霧測試");
    await page.waitForTimeout(250);
    await page.locator("#itemsTable tbody tr").first().locator("[data-act=tag]").click();
    assert.equal(await store(`s.items.find((i) => i.name === "煙霧測試筆電").listPrice`), 19529);
    await page.locator("#itemsTable tbody tr").first().locator("[data-act=sell]").click();
    await page.fill("#sellPrice", "19000");
    await page.click("#sellForm button[type=submit]");
    await page.waitForTimeout(200);
    const it = await store(`s.items.find((i) => i.name === "煙霧測試筆電")`);
    assert.equal(it.status, "sold");
    assert.equal(it.soldPrice, 19000);
    assert.equal(it.sale.suggested, 19529);
    await page.click("#drawerClose");
    await page.fill("#fKeyword", "");
  });

  await check("主管 PIN：鎖定後不能改政策；解鎖後改政策需先預覽再套用，並寫入紀錄", async () => {
    await page.click(".tabs [data-tab=policy]");
    await page.fill("#pinSetForm [name=p1]", "2468");
    await page.fill("#pinSetForm [name=p2]", "2468");
    await page.click("#pinSetForm button");
    await page.click("#pinLockNow");
    assert.equal(await page.$eval("#policyForm fieldset", (e) => e.disabled), true);
    await page.fill("#pinUnlockForm [name=p]", "0000");
    await page.click("#pinUnlockForm button");
    assert.match(await toast(), /不正確/);
    await page.fill("#pinUnlockForm [name=p]", "2468");
    await page.click("#pinUnlockForm button");
    await page.fill('[data-pk="grades.B"]', "0.9");
    assert.match(await page.textContent("#policyDiff"), /影響預覽/);
    await page.click("#polApply");
    assert.equal(await store("s.policy.grades.B"), 0.9);
    assert.ok(await store(`s.audit.some((a) => a.type === "policy" && a.text.includes("成色 B"))`));
  });

  await check("低於成本標價需輸入 PIN 核准", async () => {
    await page.click("#pinLockNow");
    await page.click(".tabs [data-tab=list]");
    await page.selectOption("#fView", "below");
    await page.locator("#itemsTable tbody tr").first().locator("[data-act=tag]").click();
    assert.equal(await page.isVisible("#pinModal"), true);
    await page.fill("#pinInput", "2468");
    await page.click("#pinForm button[type=submit]");
    await page.waitForTimeout(200);
    assert.ok(await store(`s.audit.some((a) => a.type === "approve")`));
    await page.selectOption("#fView", "");
  });

  await check("經營總覽：指標卡可跳到對應清單", async () => {
    await page.click(".tabs [data-tab=overview]");
    await page.click('button.kpi:has-text("需重新標價")');
    assert.equal(await page.inputValue("#fView"), "retag");
    assert.equal(await page.evaluate(() => location.hash), "#list");
  });

  await check("回收估價：建議收購價並帶入新增表單", async () => {
    await page.click(".tabs [data-tab=estimate]");
    await page.fill("#estForm [name=refPrice]", "20000");
    await page.selectOption("#estForm [name=grade]", "A");
    await page.fill("#estForm [name=refurbCost]", "500");
    await page.fill("#estForm [name=targetMargin]", "20");
    assert.match(await page.textContent("#estResult"), /16,200/);
    await page.click("#estToItem");
    assert.equal(await page.inputValue("#addForm [name=cost]"), "16700");
  });

  await check("CSV 匯出後再匯入：依編號更新，不會變兩份", async () => {
    await page.click(".tabs [data-tab=data]");
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#dExportCSV")]);
    const file = path.join(ROOT, "test-results", "export.csv");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await dl.saveAs(file);
    const before = await store("s.items.length");
    await page.setInputFiles("#dFile", file);
    await page.waitForSelector("#dReport:not([hidden])");
    assert.match(await page.textContent("#dReport"), /新增 0 筆、更新/);
    assert.equal(await store("s.items.length"), before);
  });

  await check("手機寬度：每個分頁都沒有橫向捲動", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const t of ["list", "overview", "estimate", "policy", "data"]) {
      await page.click(`.tabs [data-tab=${t}]`);
      await page.waitForTimeout(150);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390), `${t} 分頁出現橫向捲動`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await check("v8 舊資料升級：毛利率換算後售價不變，舊資料保留", async () => {
    const v8 = { version: "8.7.1", globals: { minMarginFloor: 0.1, defaultMarketAdj: 0.05, ladder: [{ days: 30, adj: -0.05 }] },
      items: [{ id: "a", name: "舊筆電", category: "NB", date: new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10), cost: 10000, margin: 0.2, market: "" }] };
    await page.evaluate((v) => { localStorage.clear(); localStorage.setItem("sinya-usedpc-dashboard", JSON.stringify(v)); }, v8);
    await page.reload();
    await page.click(".tabs [data-tab=list]");
    await page.waitForSelector("#itemsTable tbody tr");
    assert.match(await page.textContent("#itemsTable tbody tr td.price"), /11,999/);
    assert.ok(await page.evaluate(() => !!localStorage.getItem("sinya-usedpc-dashboard")));
  });

  assert.deepEqual(errors, [], `頁面錯誤：${errors.join("；")}`);
  console.log(`\n全部通過（${results.length} 項）`);
} catch (e) {
  console.error(`\n✗ ${step}\n`, e);
  if (errors.length) console.error("頁面錯誤：", errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
