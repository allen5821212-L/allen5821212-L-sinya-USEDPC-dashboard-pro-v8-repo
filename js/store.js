// SINYA USEDPC — 本機儲存、修改紀錄、主管 PIN
// 注意：資料存在這台電腦的瀏覽器（localStorage）。PIN 只能防止誤改，不是資安防護；
// 多人共用、帳號權限與不可竄改的稽核紀錄需併入二手平台後台（見 docs/INTEGRATION_SPEC.md）。
import { normalizePolicy, normalizeItem, ensureSkus, migrateFromV8, defaultPolicy, seedItems, APP_VERSION } from "./model.js";
import { todayLocal, pad2 } from "./pricing.js";

export const STORAGE_KEY = "sinya-usedpc-v9";
export const V8_KEY = "sinya-usedpc-dashboard";
const AUDIT_CAP = 3000;

function readJSON(key) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
export function nowStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 載入：v9 存檔 → 舊版 v8 存檔（升級）→ 範例資料 */
export function loadState() {
  const today = todayLocal();
  const v9 = readJSON(STORAGE_KEY);
  if (v9 && Array.isArray(v9.items)) {
    return {
      policy: normalizePolicy(v9.policy),
      items: ensureSkus(v9.items.map(normalizeItem), today),
      audit: Array.isArray(v9.audit) ? v9.audit.slice(-AUDIT_CAP) : [],
      pin: v9.pin && v9.pin.hash ? v9.pin : null,
      savedAt: v9.savedAt || null,
      origin: "v9", notes: []
    };
  }
  const v8 = readJSON(V8_KEY);
  if (v8 && Array.isArray(v8.items)) {
    const m = migrateFromV8(v8, today);
    return {
      policy: m.policy, items: m.items,
      audit: [{ at: nowStamp(), type: "system", text: m.notes.join("；") }],
      pin: null, savedAt: null, origin: "v8", notes: m.notes
    };
  }
  return { policy: defaultPolicy(), items: seedItems(today), audit: [], pin: null, savedAt: null, origin: "seed", notes: [] };
}

export function saveState(s) {
  const at = new Date().toISOString();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      app: "SINYA USEDPC Dashboard", version: APP_VERSION, savedAt: at,
      policy: s.policy, items: s.items, audit: s.audit.slice(-AUDIT_CAP), pin: s.pin
    }));
    return { ok: true, at };
  } catch (e) {
    return { ok: false, error: e };
  }
}
export function hasV8Data() { return !!readJSON(V8_KEY); }
export function readV8Raw() { try { return localStorage.getItem(V8_KEY); } catch (e) { return null; } }

export function addAudit(s, type, text) {
  s.audit.push({ at: nowStamp(), type, text });
  if (s.audit.length > AUDIT_CAP) s.audit.splice(0, s.audit.length - AUDIT_CAP);
}

// ============================================================
// 主管 PIN（SHA-256 + 隨機鹽；無 WebCrypto 時退回簡易雜湊）
// ============================================================
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return "fnv-" + h.toString(16);
}
export async function hashPin(pin, salt) {
  const data = `${salt}:${pin}`;
  try {
    if (globalThis.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
      return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
    }
  } catch (e) { /* fall through */ }
  return fnv1a(data);
}
export function randomSalt() {
  try {
    const a = new Uint8Array(12);
    crypto.getRandomValues(a);
    return Array.from(a).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch (e) { return Math.random().toString(36).slice(2); }
}
export async function makePin(pin) {
  const salt = randomSalt();
  return { salt, hash: await hashPin(pin, salt), setAt: nowStamp() };
}
export async function verifyPin(pinObj, pin) {
  if (!pinObj) return true;
  return (await hashPin(pin, pinObj.salt)) === pinObj.hash;
}
