// 定價政策：主管 PIN、政策編輯（先預覽影響再套用）、修改紀錄
import { computePrice, fmtN, COEFF_MONTHS } from "./pricing.js";
import { POLICY_FIELDS, defaultPolicy, normalizePolicy, policyDiff, getPath, setPath, validatePolicyValue } from "./model.js";
import { makePin, verifyPin } from "./store.js";
import { aoaToCSV } from "./io.js";
import { $, $$, esc, on, delegate, pctOut, downloadBlob, stampForFile } from "./dom.js";

let draft = null;
let draftBase = null;
let countdown = null;
const AUDIT_LABEL = { policy: "定價政策", approve: "主管核准", item: "商品", price: "標價／售出", data: "匯入／備份", system: "系統" };

const clone = (x) => JSON.parse(JSON.stringify(x));
function ensureDraft(ctx) {
  if (!draft || draftBase !== ctx.state.policy) { draft = clone(ctx.state.policy); draftBase = ctx.state.policy; }
}

// ============================================================
// 鎖定卡片
// ============================================================
function lockCardHtml(ctx) {
  const note = `<p class="muted small">PIN 只防止誤改，不是資安防護：資料存在這台電腦的瀏覽器，懂技術的人仍可繞過。多人共用與帳號權限請見<a href="docs/INTEGRATION_SPEC.md">整合規格</a>。</p>`;
  if (!ctx.state.pin) {
    return `<h2>主管 PIN</h2>
      <p class="callout warn">尚未設定主管 PIN：任何人都能修改定價政策、刪除資料、核准低於成本的標價與售出。</p>
      <form id="pinSetForm" class="pin-row" autocomplete="off">
        <input name="p1" type="password" inputmode="numeric" placeholder="設定 PIN（至少 4 碼）" autocomplete="new-password"/>
        <input name="p2" type="password" inputmode="numeric" placeholder="再輸入一次" autocomplete="new-password"/>
        <button class="btn primary" type="submit">設定 PIN</button>
      </form>${note}`;
  }
  if (!ctx.isUnlocked()) {
    return `<h2>🔒 定價政策已鎖定</h2>
      <form id="pinUnlockForm" class="pin-row" autocomplete="off">
        <input name="p" type="password" inputmode="numeric" placeholder="主管 PIN" autocomplete="off"/>
        <button class="btn primary" type="submit">解鎖</button>
      </form>
      <p class="muted small">解鎖後 10 分鐘自動鎖定。PIN 設定於 ${esc(ctx.state.pin.setAt || "")}。</p>${note}`;
  }
  return `<h2>🔓 主管已解鎖 <span id="lockCountdown" class="muted small"></span></h2>
    <div class="btn-row"><button id="pinLockNow" class="btn" type="button">立即鎖定</button></div>
    <details class="more"><summary>變更或移除 PIN</summary>
      <form id="pinChangeForm" class="pin-row" autocomplete="off">
        <input name="p1" type="password" inputmode="numeric" placeholder="新 PIN（至少 4 碼）" autocomplete="new-password"/>
        <input name="p2" type="password" inputmode="numeric" placeholder="再輸入一次" autocomplete="new-password"/>
        <button class="btn primary" type="submit">變更 PIN</button>
        <button id="pinRemove" class="btn danger" type="button">移除 PIN</button>
      </form>
    </details>${note}`;
}
function tickCountdown(ctx) {
  clearInterval(countdown);
  const el = $("#lockCountdown");
  if (!el) return;
  const upd = () => {
    const ms = ctx.state.unlockedUntil - Date.now();
    if (ms <= 0) { clearInterval(countdown); return; }
    el.textContent = `（${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")} 後自動鎖定）`;
  };
  upd();
  countdown = setInterval(upd, 1000);
}

// ============================================================
// 政策表單
// ============================================================
function ladderEditor(key, ladder, nullable) {
  const on = Array.isArray(ladder) && ladder.length > 0;
  const rows = (on ? ladder : []).map((l, i) => `<div class="ladder-row">
      <label>庫齡 ≥<input type="number" min="0" step="1" data-ladder="${key}" data-i="${i}" data-part="days" value="${l.days}"/> 天</label>
      <label>降價<input type="number" step="0.5" data-ladder="${key}" data-i="${i}" data-part="adj" value="${pctOut(l.adj)}"/> %</label>
      <button type="button" class="btn ghost small" data-ladder-del="${key}" data-i="${i}" aria-label="刪除這一階">✕</button>
    </div>`).join("");
  return `${nullable ? `<label class="check"><input type="checkbox" data-ladder-own="${key}" ${on ? "checked" : ""}/> 使用專用階梯</label>` : ""}
    ${on || !nullable ? `<div class="ladder">${rows}<button type="button" class="btn small" data-ladder-add="${key}">＋ 新增一階</button></div>` : ""}`;
}
function fieldInput(f, v) {
  const k = f.key;
  switch (f.type) {
    case "bool": return `<label class="check"><input type="checkbox" data-pk="${k}" ${v ? "checked" : ""}/> ${f.label}</label>`;
    case "enum": return `<label class="field">${f.label}<select data-pk="${k}">${f.options.map(([val, l]) => `<option value="${val}" ${String(v) === val ? "selected" : ""}>${l}</option>`).join("")}</select></label>`;
    case "pct": case "costpct":
      return `<label class="field">${f.label}<span class="suffix"><input type="number" step="0.5" data-pk="${k}" value="${esc(pctOut(v))}" ${f.nullable ? `placeholder="不設"` : ""}/><em>%</em></span><span class="field-err" data-err="${k}"></span></label>`;
    case "factor": return `<label class="field">${f.label}<span class="suffix"><em>×</em><input type="number" step="0.01" data-pk="${k}" value="${esc(v)}"/></span><span class="field-err" data-err="${k}"></span></label>`;
    case "int": return `<label class="field">${f.label}<input type="number" step="1" data-pk="${k}" value="${esc(v ?? "")}" ${f.nullable ? `placeholder="不設"` : ""}/><span class="field-err" data-err="${k}"></span></label>`;
    case "ladder": return `<div class="field ladder-field"><span>${f.label}</span>${ladderEditor(k, v, f.nullable)}</div>`;
    case "coeffs": return `<div class="field span-4"><span>${f.label}</span><div class="coeff-grid">${Array.from({ length: COEFF_MONTHS }, (_, i) =>
      `<label>${i + 1} 月<input type="number" step="0.01" min="0" data-coeff="${i}" value="${esc(v[i])}"/></label>`).join("")}</div></div>`;
    default: return "";
  }
}
function renderForm(ctx) {
  ensureDraft(ctx);
  const locked = !ctx.isUnlocked();
  const groups = [...new Set(POLICY_FIELDS.map((f) => f.group))];
  $("#policyForm").innerHTML = (locked ? `<p class="callout">🔒 已鎖定：可檢視，需主管 PIN 解鎖才能修改。</p>` : "") +
    groups.map((g) => `<fieldset ${locked ? "disabled" : ""}><legend>${g}</legend><div class="grid four">${
      POLICY_FIELDS.filter((f) => f.group === g).map((f) => fieldInput(f, getPath(draft, f.key))).join("")}</div>${groupHelp(g)}</fieldset>`).join("");
}
function groupHelp(g) {
  const t = {
    "錨定與市價": "有參考市價：售價 = 市價 × 品況係數 × (1 + 門市加成)。沒有市價時用成本 ÷ (1 − 目標毛利率) 暫代。",
    "成本底線": "底線只決定最低能降到哪。市價錨定時若底線高於錨定價（收購成本偏高），改依市價定價並標示。",
    "降價階梯": "依回收日起算的庫齡，取符合的最大門檻（不累加）。分類勾選「使用專用階梯」後優先於預設。",
    "品況係數": "只在有參考市價時影響售價。電池健康度低於門檻才扣。",
    "取整與標價": "取整與尾數都不會跌破底線。",
    "回收估價": "殘值係數只用在「回收估價」，不影響售價。"
  }[g];
  return t ? `<p class="muted small">${t}</p>` : "";
}
function impact(ctx, next) {
  const today = ctx.today();
  let changed = 0, oldSum = 0, newSum = 0, oldBelow = 0, newBelow = 0;
  for (const it of ctx.state.items) {
    if (it.status === "sold") continue;
    const a = computePrice(it, ctx.state.policy, today), b = computePrice(it, next, today);
    oldSum += a.price; newSum += b.price;
    if (a.price !== b.price) changed++;
    if (a.warnings.some((w) => w.code === "below_cost")) oldBelow++;
    if (b.warnings.some((w) => w.code === "below_cost")) newBelow++;
  }
  return { changed, oldSum, newSum, oldBelow, newBelow };
}
function renderDiff(ctx) {
  const box = $("#policyDiff");
  const next = normalizePolicy(draft);
  const diff = policyDiff(ctx.state.policy, next);
  if (!diff.length) { box.hidden = true; box.innerHTML = ""; return; }
  const im = impact(ctx, next);
  box.hidden = false;
  box.innerHTML = `<h3>尚未套用的變更（${diff.length} 項）</h3>
    <ul>${diff.map((d) => `<li><b>${esc(d.label)}</b>：${esc(d.from)} → ${esc(d.to)}</li>`).join("")}</ul>
    <p>影響預覽：在庫 <b>${im.changed}</b> 件售價會改變；建議售價合計 ${fmtN(im.oldSum)} → <b>${fmtN(im.newSum)}</b>（${im.newSum - im.oldSum >= 0 ? "+" : ""}${fmtN(im.newSum - im.oldSum)}）；低於成本 ${im.oldBelow} → <b>${im.newBelow}</b> 件。</p>
    <div class="btn-row"><button id="polApply" class="btn success" type="button">套用變更</button><button id="polDiscard" class="btn ghost" type="button">放棄</button></div>`;
}
function onFieldInput(ctx, el) {
  const f = POLICY_FIELDS.find((x) => x.key === el.dataset.pk);
  if (!f) return;
  let v;
  if (f.type === "bool") v = el.checked;
  else if (f.type === "enum") v = el.value;
  else {
    const s = el.value.trim();
    if (s === "") v = f.nullable ? null : "";
    else { const n = Number(s); v = f.type === "pct" || f.type === "costpct" ? Math.round(n * 1e4) / 1e6 : n; }
  }
  const err = validatePolicyValue(f, v);
  const errEl = $(`[data-err="${f.key}"]`);
  if (errEl) errEl.textContent = err || "";
  el.classList.toggle("invalid", !!err);
  if (err) return;
  // 值沒變就不重畫（blur 觸發的 change 若重畫預覽區，會吃掉正在按的「套用」按鈕）
  if (JSON.stringify(getPath(draft, f.key) ?? null) === JSON.stringify(v ?? null)) return;
  setPath(draft, f.key, v);
  renderDiff(ctx);
}
function readLadder(key) {
  return $$(`[data-ladder="${key}"][data-part="days"]`).map((d) => {
    const a = $(`[data-ladder="${key}"][data-part="adj"][data-i="${d.dataset.i}"]`);
    return { days: Number(d.value), adj: Math.round(Number(a.value) * 1e4) / 1e6 };
  });
}
function onLadderInput(ctx, el) {
  const key = el.dataset.ladder;
  const l = readLadder(key);
  const bad = l.some((x) => !Number.isFinite(x.days) || x.days < 0 || !Number.isFinite(x.adj) || x.adj <= -1 || x.adj >= 1);
  el.classList.toggle("invalid", bad);
  if (bad) return;
  const next = l.slice().sort((a, b) => a.days - b.days);
  if (JSON.stringify(getPath(draft, key) ?? null) === JSON.stringify(next)) return;
  setPath(draft, key, next);
  renderDiff(ctx);
}

// ============================================================
// 修改紀錄
// ============================================================
function renderAudit(ctx) {
  const type = $("#auditFilter").value;
  const rows = ctx.state.audit.filter((a) => !type || a.type === type).slice(-300).reverse();
  $("#auditBody").innerHTML = rows.length
    ? rows.map((a) => `<tr><td class="mono nowrap">${esc(a.at)}</td><td class="nowrap">${esc(AUDIT_LABEL[a.type] || a.type)}</td><td>${esc(a.text)}</td></tr>`).join("")
    : `<tr><td colspan="3" class="muted">尚無紀錄</td></tr>`;
}

export function render(ctx) {
  $("#lockCard").innerHTML = lockCardHtml(ctx);
  tickCountdown(ctx);
  renderForm(ctx);
  renderDiff(ctx);
  renderAudit(ctx);
}

export function init(ctx) {
  const form = $("#policyForm");
  delegate(form, "input", "[data-pk]", (e, el) => onFieldInput(ctx, el));
  delegate(form, "change", "[data-pk]", (e, el) => onFieldInput(ctx, el));
  delegate(form, "input", "[data-ladder]", (e, el) => onLadderInput(ctx, el));
  delegate(form, "input", "[data-coeff]", (e, el) => {
    const n = Number(el.value);
    const bad = el.value.trim() === "" || !Number.isFinite(n) || n <= 0;
    el.classList.toggle("invalid", bad);
    if (bad) return;
    const arr = draft.residualCoeffs.slice(); arr[Number(el.dataset.coeff)] = n;
    draft.residualCoeffs = arr;
    renderDiff(ctx);
  });
  delegate(form, "click", "[data-ladder-add]", (e, b) => {
    const key = b.dataset.ladderAdd;
    const l = (getPath(draft, key) || []).slice();
    const last = l[l.length - 1];
    l.push({ days: last ? last.days + 30 : 30, adj: last ? Math.max(-0.9, Math.round((last.adj - 0.05) * 100) / 100) : -0.05 });
    setPath(draft, key, l);
    renderForm(ctx); renderDiff(ctx);
  });
  delegate(form, "click", "[data-ladder-del]", (e, b) => {
    const key = b.dataset.ladderDel;
    const l = (getPath(draft, key) || []).slice();
    l.splice(Number(b.dataset.i), 1);
    setPath(draft, key, l.length ? l : (key === "ladders.default" ? [] : null));
    renderForm(ctx); renderDiff(ctx);
  });
  delegate(form, "change", "[data-ladder-own]", (e, el) => {
    const key = el.dataset.ladderOwn;
    setPath(draft, key, el.checked ? clone(draft.ladders.default) : null);
    renderForm(ctx); renderDiff(ctx);
  });
  on("#polReset", "click", async () => {
    if (!(await ctx.requireUnlock("還原預設定價政策需主管 PIN"))) return;
    draft = defaultPolicy(); draftBase = ctx.state.policy;
    renderForm(ctx); renderDiff(ctx);
    ctx.toast("已載入預設值，確認影響預覽後按「套用變更」");
  });
  delegate($("#policyDiff"), "click", "button", async (e, b) => {
    if (b.id === "polDiscard") { draft = null; render(ctx); return; }
    if (b.id !== "polApply") return;
    if (!(await ctx.requireUnlock("套用定價政策需主管 PIN"))) return;
    const next = normalizePolicy(draft);
    const diff = policyDiff(ctx.state.policy, next);
    const im = impact(ctx, next);
    ctx.withUndo(`已套用定價政策（${diff.length} 項）`, () => { ctx.setPolicy(next); });
    for (const d of diff) ctx.audit("policy", `${d.label}：${d.from} → ${d.to}`);
    ctx.audit("policy", `套用 ${diff.length} 項變更，在庫 ${im.changed} 件售價改變，建議售價合計 ${fmtN(im.oldSum)} → ${fmtN(im.newSum)}`);
    draft = null;
    ctx.changed();
  });

  // PIN
  delegate($("#lockCard"), "submit", "form", async (e, f) => {
    e.preventDefault();
    if (f.id === "pinUnlockForm") {
      if (await verifyPin(ctx.state.pin, f.elements.p.value)) { ctx.unlockFor(); ctx.toast("已解鎖 10 分鐘"); }
      else { ctx.toast("PIN 不正確"); f.elements.p.select(); }
      return;
    }
    const p1 = f.elements.p1.value, p2 = f.elements.p2.value;
    if (p1.length < 4) { ctx.toast("PIN 至少 4 碼"); return; }
    if (p1 !== p2) { ctx.toast("兩次輸入的 PIN 不一致"); return; }
    const had = !!ctx.state.pin;
    ctx.state.pin = await makePin(p1);
    ctx.audit("system", had ? "變更主管 PIN" : "設定主管 PIN");
    ctx.saveNow();
    ctx.unlockFor();
    ctx.toast(had ? "已變更 PIN" : "已設定 PIN，目前為解鎖狀態（10 分鐘後自動鎖定）");
  });
  delegate($("#lockCard"), "click", "button", async (e, b) => {
    if (b.id === "pinLockNow") { ctx.lock(); ctx.toast("已鎖定"); }
    if (b.id === "pinRemove") {
      ctx.state.pin = null;
      ctx.audit("system", "移除主管 PIN");
      ctx.saveNow();
      ctx.refreshLock();
      ctx.toast("已移除 PIN");
    }
  });

  on("#auditFilter", "change", () => renderAudit(ctx));
  on("#auditExport", "click", () => {
    const aoa = [["時間", "類別", "內容"], ...ctx.state.audit.map((a) => [a.at, AUDIT_LABEL[a.type] || a.type, a.text])];
    downloadBlob(new Blob([aoaToCSV(aoa)], { type: "text/csv;charset=utf-8" }), `usedpc_修改紀錄_${stampForFile()}.csv`);
  });
}
