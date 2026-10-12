// 介面共用小工具
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[m]));
}
export function on(target, ev, fn) {
  const el = typeof target === "string" ? $(target) : target;
  if (el) el.addEventListener(ev, fn);
  return el;
}
/** 事件委派 */
export function delegate(root, ev, selector, fn) {
  root.addEventListener(ev, (e) => {
    const t = e.target.closest(selector);
    if (t && root.contains(t)) fn(e, t);
  });
}
/** 百分比輸入：畫面顯示 20 → 內部 0.2；空白回傳 "" */
export function pctIn(v) {
  const s = String(v ?? "").trim().replace(/[%％]/g, "");
  if (s === "") return "";
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 1e6) / 1e8 : NaN;
}
export function pctOut(v, digits = 2) {
  if (v === "" || v === null || v === undefined || !Number.isFinite(Number(v))) return "";
  return String(Math.round(Number(v) * 100 * 10 ** digits) / 10 ** digits);
}
export function numIn(v) {
  const s = String(v ?? "").trim().replace(/[,，\s]/g, "");
  if (s === "") return "";
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}
export function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
export function stampForFile(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
