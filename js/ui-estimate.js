// 回收估價：收多少？（殘值係數只用在這裡）
import { estimateBuyback, fmtN, fmtPct, fmtFactor, toISODate } from "./pricing.js";
import { $, esc, on, pctIn, pctOut, numIn } from "./dom.js";

let last = null;
let lastSig = "";

function readForm(ctx) {
  const f = $("#estForm").elements;
  const tm = pctIn(f.targetMargin.value);
  return {
    refType: f.refType.value,
    refPrice: numIn(f.refPrice.value),
    purchaseDate: f.purchaseDate.value,
    category: f.category.value,
    grade: f.grade.value,
    battery: numIn(f.battery.value),
    refurbCost: numIn(f.refurbCost.value),
    targetMargin: tm === "" ? ctx.state.policy.defaultTargetMargin : tm,
    accessoriesComplete: f.accessoriesComplete.checked,
    repair: f.repair.checked
  };
}

export function render(ctx) {
  const f = $("#estForm").elements;
  if (!f.targetMargin.value) f.targetMargin.placeholder = `預設 ${pctOut(ctx.state.policy.defaultTargetMargin)}`;
  if (!f.refurbCost.value) f.refurbCost.placeholder = `預設 ${ctx.state.policy.estimatorRefurbCost}`;
  const input = readForm(ctx);
  // 輸入沒變就不重畫（blur 觸發的 change 若重畫，會吃掉正在按的按鈕）
  const sig = JSON.stringify([input, ctx.state.policy]);
  if (sig === lastSig && $("#estResult").childElementCount) return;
  lastSig = sig;
  const box = $("#estResult");
  if (Number.isNaN(input.refPrice) || Number.isNaN(input.battery) || Number.isNaN(input.refurbCost) || Number.isNaN(input.targetMargin)) {
    box.innerHTML = `<p class="warn-text">請輸入數字</p>`; last = null; return;
  }
  if (input.refPrice === "") { box.innerHTML = `<p class="muted">輸入參考價格後顯示估價</p>`; last = null; return; }
  const e = estimateBuyback(input, ctx.state.policy, ctx.today());
  if (e.error) { box.innerHTML = `<p class="warn-text">${esc(e.error)}</p>`; last = null; return; }
  last = { input, e };
  const q = e.quality.parts.length ? e.quality.parts.map((p) => `${p.label} ${fmtFactor(p.factor)}`).join("、") : "無扣減";
  box.innerHTML = `
    ${e.notes.map((n) => `<p class="callout warn">${esc(n)}</p>`).join("")}
    <div class="est-grid">
      <div class="est-main"><span class="k">建議收購價</span><span class="v">${fmtN(e.suggested)}</span>
        <span class="sub">第 0 天售價 ${fmtN(e.price0)} × (1 − 目標毛利率 ${fmtPct(e.targetMargin)}) − 整新 ${fmtN(e.refurb)}，取整到百元</span></div>
      <div class="est-main"><span class="k">最高收購價（放到 180 天出清仍不虧）</span><span class="v">${fmtN(e.maxBuy)}</span>
        <span class="sub">超過這個價格，滯銷時會賠錢</span></div>
    </div>
    <dl class="est-steps">
      ${input.refType === "new" ? `<dt>殘值</dt><dd>新品價 ${fmtN(input.refPrice)} × 第 ${e.coeffMonth} 月係數 ${fmtFactor(e.coeff)} = 二手行情 ${fmtN(e.usedMarket)}</dd>` : `<dt>二手行情</dt><dd>${fmtN(e.usedMarket)}</dd>`}
      <dt>品況</dt><dd>${esc(q)} → 品況市價 ${fmtN(e.marketValue)}</dd>
    </dl>
    <h4>以建議收購價 ${fmtN(e.suggested)} 收進來，之後的售價與毛利</h4>
    <table class="mini"><thead><tr><th>庫齡</th><th class="num">售價</th><th class="num">毛利</th><th class="num">毛利率</th></tr></thead>
      <tbody>${e.scenarios.map((s) => `<tr><td>${s.days} 天</td><td class="num">${fmtN(s.price)}</td><td class="num ${s.profit < 0 ? "neg" : ""}">${fmtN(s.profit)}</td><td class="num">${fmtPct(s.margin)}</td></tr>`).join("")}</tbody></table>
    <div class="btn-row"><button id="estToItem" class="btn success" type="button">以建議收購價建立回收品</button></div>`;
}

export function init(ctx) {
  const f = $("#estForm").elements;
  f.category.innerHTML = ctx.options.category();
  f.grade.innerHTML = ctx.options.grade();
  on("#estForm", "input", () => render(ctx));
  on("#estForm", "change", () => render(ctx));
  on("#estForm", "submit", (e) => e.preventDefault());
  on("#estResult", "click", (e) => {
    if (e.target.id !== "estToItem" || !last) return;
    const { input, e: est } = last;
    ctx.prefillAdd({
      category: input.category, grade: input.grade, battery: input.battery, accessoriesComplete: input.accessoriesComplete,
      repair: input.repair, purchaseDate: input.purchaseDate, cost: est.suggested + (input.refurbCost || 0),
      market: est.usedMarket, marketDate: toISODate(ctx.today()), marketSource: input.refType === "new" ? "新品價 × 殘值係數推算" : "",
      newPrice: input.refType === "new" ? input.refPrice : ""
    });
    ctx.toast("已帶入新增表單，請補上名稱並確認實際收購成本");
  });
}
