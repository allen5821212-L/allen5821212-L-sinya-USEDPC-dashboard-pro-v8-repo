// SINYA USEDPC — 介面主程式：狀態、分頁、存檔、復原、提示、主管 PIN
import { todayLocal, CATEGORIES, CATEGORY_LABELS, GRADES, GRADE_LABELS } from "./pricing.js";
import { normalizePolicy, normalizeItem } from "./model.js";
import { loadState, saveState, addAudit, verifyPin } from "./store.js";
import { $, $$, on } from "./dom.js";
import * as List from "./ui-list.js";
import * as Overview from "./ui-overview.js";
import * as Estimate from "./ui-estimate.js";
import * as Policy from "./ui-policy.js";
import * as Data from "./ui-data.js";

const UNLOCK_MS = 10 * 60 * 1000;
const loaded = loadState();

const state = {
  policy: loaded.policy,
  items: loaded.items,
  audit: loaded.audit,
  pin: loaded.pin,
  unlockedUntil: 0,
  tab: "list",
  list: { status: "stock", category: "", keyword: "", minDays: null, view: "", sort: { key: "days", dir: "desc" } },
  periodDays: 90
};

// ============================================================
// 共用操作（傳給各分頁模組）
// ============================================================
let saveTimer = null;
let undoSnap = null;
let toastTimer = null;
let lockTimer = null;

const ctx = {
  state,
  today: () => todayLocal(),
  findItem: (id) => state.items.find((x) => x.id === id),

  save() { clearTimeout(saveTimer); saveTimer = setTimeout(ctx.saveNow, 200); },
  saveNow() {
    clearTimeout(saveTimer); saveTimer = null;
    const r = saveState(state);
    const el = $("#saveStatus");
    if (r.ok) {
      const d = new Date(r.at);
      el.textContent = `已自動儲存 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      el.classList.remove("warn-text");
    } else {
      el.textContent = "無法自動儲存（瀏覽器封鎖儲存空間）— 請到「資料管理」下載備份";
      el.classList.add("warn-text");
    }
  },
  audit(type, text) { addAudit(state, type, text); },

  toast(msg, { undo = false } = {}) {
    $("#toastMsg").textContent = msg;
    $("#toastUndo").hidden = !undo;
    $("#toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $("#toast").hidden = true; }, undo ? 9000 : 3500);
  },
  /** 先存快照再執行；提示列可「復原」 */
  withUndo(message, mutate) {
    const snap = ctx.beginUndo();
    mutate();
    ctx.commitUndo(snap, message);
  },
  beginUndo() { return JSON.parse(JSON.stringify({ policy: state.policy, items: state.items })); },
  commitUndo(snap, message) { undoSnap = snap; ctx.toast(message, { undo: true }); },

  // ---- 主管 PIN ----
  isUnlocked() { return !state.pin || Date.now() < state.unlockedUntil; },
  lock() { state.unlockedUntil = 0; clearTimeout(lockTimer); ctx.refreshLock(); },
  unlockFor(ms = UNLOCK_MS) {
    state.unlockedUntil = Date.now() + ms;
    clearTimeout(lockTimer);
    lockTimer = setTimeout(() => { ctx.lock(); ctx.toast("定價政策已自動鎖定"); }, ms);
    ctx.refreshLock();
  },
  /** 需要主管核准的動作：未設 PIN 直接通過；已解鎖直接通過；否則要求輸入 PIN */
  requireUnlock(reason) {
    if (ctx.isUnlocked()) return Promise.resolve(true);
    return askPin(reason).then((ok) => { if (ok) ctx.unlockFor(); return ok; });
  },
  refreshLock() {
    const b = $("#lockBadge");
    if (!state.pin) { b.textContent = "⚠ 未設主管 PIN"; b.className = "lock-badge warn"; }
    else if (ctx.isUnlocked()) { b.textContent = "🔓 主管已解鎖"; b.className = "lock-badge open"; }
    else { b.textContent = "🔒 政策已鎖定"; b.className = "lock-badge"; }
    if (state.tab === "policy") Policy.render(ctx);
  },

  // ---- 導覽 ----
  switchTab(tab) {
    state.tab = tab;
    for (const btn of $$(".tabs [data-tab]")) btn.setAttribute("aria-selected", String(btn.dataset.tab === tab));
    for (const p of $$(".tab-panel")) p.hidden = p.id !== `tab-${tab}`;
    try { localStorage.setItem("sinya-usedpc-tab", tab); } catch (e) { /* ignore */ }
    if (location.hash !== `#${tab}`) history.replaceState(null, "", `#${tab}`);
    ctx.render();
  },
  render() {
    ({ list: List, overview: Overview, estimate: Estimate, policy: Policy, data: Data })[state.tab].render(ctx);
  },
  /** 資料變更後：重畫目前分頁、存檔 */
  changed() { ctx.render(); List.refreshDrawer(ctx); ctx.save(); },
  openItem(id, opts) { List.openDrawer(ctx, id, opts); },
  prefillAdd(data) { ctx.switchTab("list"); List.prefillAdd(ctx, data); window.scrollTo({ top: 0, behavior: "smooth" }); },
  goList(filter) {
    Object.assign(state.list, { category: "", keyword: "", minDays: null, view: "", status: "stock" }, filter || {});
    List.syncFilterUI(ctx);
    ctx.switchTab("list");
  },
  setPolicy(p) { state.policy = normalizePolicy(p); },
  setItems(items) { state.items = items.map(normalizeItem); },
  options: {
    category: (blank = "") => (blank ? `<option value="">${blank}</option>` : "") + CATEGORIES.map((c) => `<option value="${c}">${CATEGORY_LABELS[c]}</option>`).join(""),
    grade: (blank = "未評") => `<option value="">${blank}</option>` + GRADES.map((g) => `<option value="${g}">${GRADE_LABELS[g]}</option>`).join("")
  }
};

// ============================================================
// PIN 對話框
// ============================================================
function askPin(reason) {
  return new Promise((resolve) => {
    const modal = $("#pinModal"), input = $("#pinInput"), err = $("#pinError");
    $("#pinReason").textContent = reason || "";
    err.hidden = true;
    input.value = "";
    modal.hidden = false;
    setTimeout(() => input.focus(), 0);
    const done = (ok) => {
      modal.hidden = true;
      $("#pinForm").onsubmit = null;
      $("#pinCancel").onclick = null;
      resolve(ok);
    };
    $("#pinForm").onsubmit = async (e) => {
      e.preventDefault();
      if (await verifyPin(state.pin, input.value)) done(true);
      else { err.hidden = false; input.select(); }
    };
    $("#pinCancel").onclick = () => done(false);
  });
}

// ============================================================
// 啟動
// ============================================================
function init() {
  on("#toastUndo", "click", () => {
    if (!undoSnap) return;
    state.policy = normalizePolicy(undoSnap.policy);
    state.items = undoSnap.items.map(normalizeItem);
    undoSnap = null;
    ctx.audit("system", "復原上一個動作");
    ctx.changed();
    ctx.toast("已復原");
  });
  for (const btn of $$(".tabs [data-tab]")) on(btn, "click", () => ctx.switchTab(btn.dataset.tab));
  on("#lockBadge", "click", () => ctx.switchTab("policy"));
  on(document, "keydown", (e) => { if (e.key === "Escape") List.closeDrawer(ctx); });
  window.addEventListener("beforeunload", () => { if (saveTimer) ctx.saveNow(); });
  window.addEventListener("storage", (e) => {
    if (e.key === "sinya-usedpc-v9") {
      const el = $("#saveStatus");
      el.textContent = "另一個分頁已修改資料 — 請重新整理以免覆蓋";
      el.classList.add("warn-text");
    }
  });

  List.init(ctx);
  Overview.init(ctx);
  Estimate.init(ctx);
  Policy.init(ctx);
  Data.init(ctx);

  if (loaded.origin === "v8") {
    ctx.saveNow();
    ctx.toast(`已升級 ${state.items.length} 筆舊版資料：毛利率已換算為財會口徑（舊資料保留未刪）`);
  } else if (loaded.origin === "seed") {
    $("#saveStatus").textContent = "目前為範例資料（變更會自動儲存）";
  } else if (loaded.savedAt) {
    const d = new Date(loaded.savedAt);
    $("#saveStatus").textContent = `已載入存檔（${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}）`;
  }
  ctx.refreshLock();

  let tab = (location.hash || "").slice(1);
  if (!["list", "overview", "estimate", "policy", "data"].includes(tab)) {
    try { tab = localStorage.getItem("sinya-usedpc-tab") || "list"; } catch (e) { tab = "list"; }
  }
  ctx.switchTab(["list", "overview", "estimate", "policy", "data"].includes(tab) ? tab : "list");
  window.addEventListener("hashchange", () => {
    const t = location.hash.slice(1);
    if (t && t !== state.tab && ["list", "overview", "estimate", "policy", "data"].includes(t)) ctx.switchTab(t);
  });
}

init();
