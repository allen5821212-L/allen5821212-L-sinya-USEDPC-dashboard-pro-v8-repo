// 資料管理：Excel／CSV 匯入匯出、範本、完整備份與還原
import { normalizeItem, normalizePolicy, ensureSkus, migrateFromV8, seedItems, APP_VERSION } from "./model.js";
import {
  rowsToItems, mergeItems, itemsToAoa, policyToAoa, policyFromRows, tagListAoa, aoaToCSV, parseCSV,
  templateAoa, TEMPLATE_HELP, ITEM_COL_WIDTHS
} from "./io.js";
import { hasV8Data, readV8Raw } from "./store.js";
import { $, esc, on, downloadBlob, stampForFile } from "./dom.js";

function needXLSX(ctx) {
  if (typeof XLSX === "undefined") { ctx.toast("Excel 函式庫尚未載入（需連網）；可先改用 CSV"); return false; }
  return true;
}
function sheet(aoa, widths) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  if (widths) ws["!cols"] = widths.map((w) => ({ wch: w }));
  return ws;
}
function report(lines, isError = false) {
  const el = $("#dReport");
  el.hidden = false;
  el.classList.toggle("error", isError);
  el.innerHTML = lines.map((l) => `<div>${l}</div>`).join("");
}

function exportXLSX(ctx) {
  if (!needXLSX(ctx)) return;
  const { items, policy } = ctx.state;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet(itemsToAoa(items, policy, ctx.today()), ITEM_COL_WIDTHS), "回收清單");
  XLSX.utils.book_append_sheet(wb, sheet(policyToAoa(policy), [36, 30, 22, 40]), "定價政策");
  XLSX.utils.book_append_sheet(wb, sheet(tagListAoa(items, policy, ctx.today()), [16, 30, 30, 6, 10, 10, 18]), "標價清單");
  XLSX.writeFile(wb, `usedpc_清單_${stampForFile()}.xlsx`);
  ctx.toast(`已匯出 ${items.length} 筆（含定價政策、標價清單工作表）`);
}
function exportCSV(ctx) {
  const aoa = itemsToAoa(ctx.state.items, ctx.state.policy, ctx.today());
  downloadBlob(new Blob([aoaToCSV(aoa)], { type: "text/csv;charset=utf-8" }), `usedpc_清單_${stampForFile()}.csv`);
  ctx.toast(`已匯出 ${ctx.state.items.length} 筆 CSV`);
}
function exportTemplate(ctx) {
  if (!needXLSX(ctx)) return;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet(templateAoa(ctx.today()), ITEM_COL_WIDTHS), "回收清單");
  XLSX.utils.book_append_sheet(wb, sheet(TEMPLATE_HELP, [22, 90]), "說明");
  XLSX.utils.book_append_sheet(wb, sheet(policyToAoa(ctx.state.policy), [36, 30, 22, 40]), "定價政策");
  XLSX.writeFile(wb, "usedpc_匯入範本.xlsx");
  ctx.toast("已下載匯入範本");
}

async function importFile(ctx, file) {
  let rows, policyRows = null;
  if (/\.csv$/i.test(file.name)) rows = parseCSV(await file.text());
  else {
    if (!needXLSX(ctx)) return;
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const name = wb.SheetNames.find((n) => n.trim() === "回收清單") || wb.SheetNames[0];
    rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: "" });
    const pn = wb.SheetNames.find((n) => ["定價政策", "全域參數"].includes(n.trim()));
    if (pn) policyRows = XLSX.utils.sheet_to_json(wb.Sheets[pn], { header: 1, raw: true, defval: "" });
  }
  const res = rowsToItems(rows, { today: ctx.today() });
  const mode = $("#dMode").value;
  const withPolicy = $("#dWithPolicy").checked;
  const lines = [`<b>${esc(file.name)}</b>：讀到 ${res.items.length} 筆${res.blank ? `，略過空白列 ${res.blank} 列` : ""}（標題在第 ${res.headerRow} 列）${res.legacy ? "・偵測為 v8 檔，毛利率已由加價率換算" : ""}`];
  if (mode === "replace" || withPolicy) {
    const why = mode === "replace" ? "取代整份清單" : "匯入定價政策";
    if (!(await ctx.requireUnlock(`${why}需主管 PIN`))) { report(lines.concat(["已取消"]), true); return; }
  }
  let policyNote = null, newPolicy = null;
  if (withPolicy) {
    if (!policyRows) policyNote = "檔案中沒有「定價政策」工作表，政策未變更";
    else if (res.legacy) policyNote = "v8 的「全域參數」格式不同，未匯入政策（請到「定價政策」手動設定）";
    else {
      const pr = policyFromRows(policyRows, ctx.state.policy);
      newPolicy = pr.policy;
      policyNote = `已匯入定價政策 ${pr.applied} 項${pr.warnings.length ? `（${pr.warnings.length} 項有問題：${esc(pr.warnings.slice(0, 3).join("；"))}）` : ""}`;
    }
  }
  if (!res.items.length && !newPolicy) {
    report(lines.concat([policyNote, "沒有可匯入的資料，清單未變更"].filter(Boolean)), true);
    ctx.toast("檔案中沒有可匯入的資料");
    return;
  }
  const merged = mergeItems(ctx.state.items, res.items, mode, ctx.today());
  const r = merged.report;
  ctx.withUndo(`已匯入：新增 ${r.added}、更新 ${r.updated}${r.skipped.length ? `、略過 ${r.skipped.length}` : ""}`, () => {
    ctx.state.items = merged.items;
    if (newPolicy) ctx.setPolicy(newPolicy);
  });
  lines.push(`結果：新增 ${r.added} 筆、更新 ${r.updated} 筆${r.skipped.length ? `、同編號略過 ${r.skipped.length} 筆` : ""}${mode === "replace" ? "（已取代原清單）" : ""}`);
  if (r.dupInFile.length) lines.push(`<span class="warn-text">檔案內重複編號 ${r.dupInFile.length} 個（以後面那列為準）：${esc(r.dupInFile.slice(0, 10).join("、"))}</span>`);
  if (policyNote) lines.push(policyNote);
  if (res.warnings.length) {
    lines.push(`<span class="warn-text">⚠ ${res.warnings.length} 項需要確認：</span>`);
    res.warnings.slice(0, 20).forEach((w) => lines.push(`・${esc(w)}`));
    if (res.warnings.length > 20) lines.push(`…另有 ${res.warnings.length - 20} 項`);
  }
  report(lines);
  ctx.audit("data", `匯入 ${file.name}（${({ upsert: "依編號更新", append: "只新增", replace: "取代" })[mode]}）：新增 ${r.added}、更新 ${r.updated}${newPolicy ? "、含定價政策" : ""}`);
  ctx.changed();
}

function backup(ctx) {
  const s = ctx.state;
  const data = { app: "SINYA USEDPC Dashboard", version: APP_VERSION, exportedAt: new Date().toISOString(), policy: s.policy, items: s.items, audit: s.audit, pin: s.pin };
  downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), `usedpc_備份_${stampForFile()}.json`);
  ctx.audit("data", `下載完整備份（${s.items.length} 筆）`);
  ctx.save();
  ctx.toast(`已下載備份（${s.items.length} 筆＋定價政策＋修改紀錄）`);
}
async function restore(ctx, file) {
  const data = JSON.parse(await file.text());
  if (!data || !Array.isArray(data.items)) throw new Error("不是有效的備份檔（缺少 items）");
  if (!(await ctx.requireUnlock("從備份還原會取代目前所有資料與定價政策，需主管 PIN"))) return;
  const isV9 = !!data.policy;
  const m = isV9 ? null : migrateFromV8(data, ctx.today());
  ctx.withUndo(`已從備份還原 ${data.items.length} 筆`, () => {
    if (isV9) {
      ctx.setPolicy(normalizePolicy(data.policy));
      ctx.state.items = ensureSkus(data.items.map(normalizeItem), ctx.today());
      if (Array.isArray(data.audit)) ctx.state.audit = data.audit.slice();
      if (data.pin && data.pin.hash) ctx.state.pin = data.pin;
    } else {
      ctx.setPolicy(m.policy);
      ctx.state.items = m.items;
    }
  });
  ctx.audit("data", `從備份還原 ${file.name}（${isV9 ? "v9" : "v8 格式，已升級"}，${data.items.length} 筆）`);
  ctx.changed();
}

export function render(ctx) {
  const s = ctx.state;
  const sold = s.items.filter((x) => x.status === "sold").length;
  $("#dInfo").textContent = `目前 ${s.items.length} 筆（在庫 ${s.items.length - sold}、已售出 ${sold}），修改紀錄 ${s.audit.length} 則。`;
  const v8 = $("#dV8");
  if (hasV8Data()) {
    v8.hidden = false;
    v8.innerHTML = `舊版（v8）的資料仍保留在這個瀏覽器，未刪除。<button id="dV8Export" class="btn ghost small" type="button">下載舊版原始資料</button>`;
  } else v8.hidden = true;
}

export function init(ctx) {
  on("#dExportXLSX", "click", () => exportXLSX(ctx));
  on("#dExportCSV", "click", () => exportCSV(ctx));
  on("#dTemplate", "click", () => exportTemplate(ctx));
  on("#dBackup", "click", () => backup(ctx));
  on("#dFile", "change", async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try { await importFile(ctx, f); }
    catch (err) { report([`<b>${esc(f.name)}</b> 匯入失敗：${esc(err.message || err)}`], true); ctx.toast("匯入失敗，清單未變更"); }
  });
  on("#dRestore", "change", async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try { await restore(ctx, f); }
    catch (err) { ctx.toast(`還原失敗：${err.message || err}`); }
  });
  on("#dSample", "click", async () => {
    if (!(await ctx.requireUnlock("改用範例資料會取代目前清單，需主管 PIN"))) return;
    ctx.withUndo("已改用範例資料", () => { ctx.state.items = seedItems(ctx.today()); });
    ctx.audit("data", "改用範例資料");
    ctx.changed();
  });
  on("#dClear", "click", async () => {
    if (!ctx.state.items.length) { ctx.toast("清單已經是空的"); return; }
    if (!(await ctx.requireUnlock(`清空 ${ctx.state.items.length} 筆資料需主管 PIN`))) return;
    const n = ctx.state.items.length;
    ctx.withUndo(`已清空 ${n} 筆`, () => { ctx.state.items = []; });
    ctx.audit("data", `清空清單（${n} 筆）`);
    ctx.changed();
  });
  on("#dV8", "click", (e) => {
    if (e.target.id !== "dV8Export") return;
    const raw = readV8Raw();
    if (raw) downloadBlob(new Blob([raw], { type: "application/json" }), `usedpc_v8原始資料_${stampForFile()}.json`);
  });
}
