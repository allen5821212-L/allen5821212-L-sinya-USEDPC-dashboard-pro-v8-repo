
// v8.5 Pro — calendar-month + purchase-date enhanced

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  items: [],
  filter: { category: "", keyword: "" },
  diagnostics: false,
  globals: {
    roundUnit: 10,
    roundMode: "nearest",
    tailMode: "9",
    defaultMarketAdj: 0.05,
    minMarginFloor: 0.10,
    notBelowMarketPct: -0.05,
    ladder: [ {days:30, adj:-0.05}, {days:60, adj:-0.10}, {days:90, adj:-0.15} ],
    monthlyCoeffs: Array.from({length:18}, ()=>1.00),
    cumulativeMode: false,
    coeffBasis: "purchase" // "purchase" or "recycle"
  }
};

// ---- Helpers ----
function parseLadder(str){
  if(!str) return [];
  return str.split(",").map(s=>s.trim()).filter(Boolean).map(seg=>{
    const [d,p] = seg.split("/").map(x=>x.trim());
    return {days:Number(d), adj:Number(p)};
  }).filter(x=>Number.isFinite(x.days)&&Number.isFinite(x.adj)).sort((a,b)=>a.days-b.days);
}
function roundByMode(value, unit, mode){
  unit = Number(unit)||1;
  if(unit<1) unit=1;
  const q = value/unit;
  if(mode==="nearest") return Math.round(q)*unit;
  if(mode==="ceil") return Math.ceil(q)*unit;
  if(mode==="floor") return Math.floor(q)*unit;
  return Math.round(q)*unit;
}
function applyTail(value, tailMode, constraintFloor){
  if(tailMode==="none") return value;
  const v = Math.max(value, 0);
  let candidate = v;
  if(tailMode==="9"){
    const base = Math.floor(v/10)*10 + 9;
    candidate = base;
    if(candidate < constraintFloor){
      const floor10 = Math.floor(constraintFloor/10)*10 + 9;
      candidate = Math.max(candidate, floor10);
    }
  }else if(tailMode==="99"){
    const base = Math.floor(v/100)*100 + 99;
    candidate = base;
    if(candidate < constraintFloor){
      const floor100 = Math.floor(constraintFloor/100)*100 + 99;
      candidate = Math.max(candidate, floor100);
    }
  }
  return candidate;
}
function parseCoeffRow(str){
  if(!str) return null;
  const parts = String(str).split(/[\s,]+/).filter(Boolean).slice(0,18);
  if(parts.length===0) return null;
  const arr = parts.map(x => Number(x));
  if(arr.some(x => !Number.isFinite(x))) return null;
  while(arr.length<18) arr.push(arr[arr.length-1] ?? 1.00);
  return arr.slice(0,18);
}
// 曆法月演算法
function monthIndexFrom(dateStr, today = new Date()) {
  if (!dateStr) return 1;
  const [y1, m1, d1] = dateStr.split("-").map(Number);
  if(!y1 || !m1 || !d1) return 1;
  const y2 = today.getFullYear();
  const m2 = today.getMonth() + 1;
  const d2 = today.getDate();
  let months = (y2 - y1) * 12 + (m2 - m1);
  if (d2 < d1) months -= 1;
  if (months < 1) months = 1;
  if (months > 18) months = 18;
  return months;
}
function daysBetween(dateStr, today = new Date()){
  if(!dateStr) return 0;
  const d = new Date(dateStr);
  return Math.max(0, Math.floor((today - d)/(1000*60*60*24)));
}

// ---- Core compute ----
function computePrice(item, globals, today = new Date()){
  const steps = {};
  const cost = Number(item.cost)||0;
  const margin = Number(item.margin)||0;
  const market = (item.market===""||item.market===null||item.market===undefined) ? null : Number(item.market);
  const marketAdj = (item.marketAdj===""||item.marketAdj===null||item.marketAdj===undefined)
    ? Number(globals.defaultMarketAdj||0) : Number(item.marketAdj);

  const roundUnit = Number(globals.roundUnit)||1;
  const roundMode = globals.roundMode||"nearest";
  const tailMode  = globals.tailMode||"none";
  const minMarginFloor = Math.max(0, Number(globals.minMarginFloor)||0);
  const notBelowMarketPct = Number(globals.notBelowMarketPct)||0;
  const ladder = Array.isArray(globals.ladder)? globals.ladder : [];

  const recycleDate = item.date || "";           // 入庫
  const purchaseDate = item.purchaseDate || "";  // 原購
  const daysInStock = daysBetween(recycleDate, today);
  steps.daysInStock = daysInStock;

  // 月序（兩種基準皆算，供診斷顯示）
  const monthByPurchase = monthIndexFrom(purchaseDate, today);
  const monthByRecycle  = monthIndexFrom(recycleDate,  today);
  steps.monthByPurchase = monthByPurchase;
  steps.monthByRecycle  = monthByRecycle;

  // 調整後市價
  let adjustedMarket = null;
  if(market!==null) adjustedMarket = market * (1 + marketAdj);
  steps.adjustedMarket = adjustedMarket;

  // 初步毛利
  let price = cost * (1 + margin);
  steps.initialMarginPrice = price;

  // 階梯（取最大門檻）
  let ladderAdj = 0;
  for(const l of ladder){ if(daysInStock >= l.days) ladderAdj = l.adj; }
  if(ladderAdj!==0) price = price * (1 + ladderAdj);
  steps.ladderAdj = ladderAdj;
  steps.afterLadder = price;

  // 月係數
  const coeffMonthIndex = (globals.coeffBasis === "purchase") ? monthByPurchase : monthByRecycle;
  const sourceCoeffs = (Array.isArray(item.monthlyCoeffs) && item.monthlyCoeffs.length)? item.monthlyCoeffs : globals.monthlyCoeffs;
  let coeff = 1;
  if(Array.isArray(sourceCoeffs)){
    if(globals.cumulativeMode){
      const end = Math.min(coeffMonthIndex, sourceCoeffs.length);
      for(let i=0;i<end;i++) coeff *= Number(sourceCoeffs[i]||1);
    }else{
      coeff = Number(sourceCoeffs[coeffMonthIndex-1]||1);
    }
  }
  steps.coeffMonthIndex = coeffMonthIndex;
  steps.coeffApplied = coeff;
  price = price * coeff;
  steps.afterMonthlyCoeff = price;

  // 下限：最低毛利率
  const minPriceByMargin = cost * (1 + minMarginFloor);
  if(price < minPriceByMargin) price = minPriceByMargin;
  steps.afterMinMargin = price;

  // 下限：不得低於市價 X%
  let floorByMarket = -Infinity;
  if(adjustedMarket!==null){
    floorByMarket = adjustedMarket * (1 + notBelowMarketPct);
    if(price < floorByMarket) price = floorByMarket;
  }
  steps.afterMarketFloor = price;
  steps.marketFloor = floorByMarket;

  // 四捨五入
  price = roundByMode(price, roundUnit, roundMode);
  steps.afterRounding = price;

  // 尾數但不破下限
  const floorConstraint = Math.max(minPriceByMargin, floorByMarket);
  price = applyTail(price, tailMode, floorConstraint);
  steps.afterTail = price;

  // 市價上限
  if(adjustedMarket!==null){
    const ceilByMarket = adjustedMarket;
    if(price > ceilByMarket){ price = ceilByMarket; }
    steps.afterMarketCeil = price;
    if(ceilByMarket < floorConstraint){
      steps.marketConflict = `ceil(${Math.round(ceilByMarket)}) < floor(${Math.round(floorConstraint)})`;
    }
  }

  const profit = price - cost;
  return { price: Math.round(price), profit: Math.round(profit), steps };
}

// ---- Render & events ----
function filterItem(item){
  const c = state.filter.category;
  const k = (state.filter.keyword||"").trim().toLowerCase();
  const okCategory = !c || item.category===c;
  const okK = !k || ( (item.name||"").toLowerCase().includes(k) || (item.repairNote||"").toLowerCase().includes(k) );
  return okCategory && okK;
}
function fmt(x){ if(x===null || x===undefined) return "—"; return Math.round(x); }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[m])); }

function render(){
  const tbody = $("#itemsTable tbody");
  tbody.innerHTML = "";
  let sumPrice = 0, sumProfit = 0;
  const filtered = state.items.filter(filterItem);
  filtered.forEach((item, idx) => {
    const r = computePrice(item, state.globals);
    sumPrice += r.price;
    sumProfit += r.profit;
    const tr = document.createElement("tr");
    const diag = state.diagnostics ? `
      <div class="badge mono">市價調整後: ${fmt(r.steps.adjustedMarket)}</div>
      <div class="badge mono">初步: ${fmt(r.steps.initialMarginPrice)}</div>
      <div class="badge mono">階梯(${r.steps.ladderAdj}): ${fmt(r.steps.afterLadder)}</div>
      <div class="badge mono">第N月(購買): ${r.steps.monthByPurchase}</div>
      <div class="badge mono">第N月(回收): ${r.steps.monthByRecycle}</div>
      <div class="badge mono">係數N: ${r.steps.coeffMonthIndex} → ${r.steps.coeffApplied}</div>
      <div class="badge mono">月係數後: ${fmt(r.steps.afterMonthlyCoeff)}</div>
      <div class="badge mono">底線: ${fmt(r.steps.afterMinMargin)}</div>
      <div class="badge mono">市價下限: ${fmt(r.steps.afterMarketFloor)}</div>
      <div class="badge mono">四捨五入: ${fmt(r.steps.afterRounding)}</div>
      <div class="badge mono">尾數: ${fmt(r.steps.afterTail)}</div>
      <div class="badge mono">市價上限: ${fmt(r.steps.afterMarketCeil)}</div>
      ${r.steps.marketConflict? `<div class="badge mono">⚠ 上限/下限衝突: ${r.steps.marketConflict}</div>` : ""}
    ` : "";
    tr.innerHTML = `
      <td>${idx+1}</td>
      <td contenteditable="true" data-field="name">${escapeHtml(item.name||"")}</td>
      <td>
        <select data-field="category">
          ${["NB","DT","MON","DIY","OTH"].map(c=>`<option ${item.category===c?"selected":""}>${c}</option>`).join("")}
        </select>
      </td>
      <td><input type="date" data-field="purchaseDate" value="${item.purchaseDate?item.purchaseDate.split("T")[0]:""}"/></td>
      <td><input type="date" data-field="date" value="${item.date?item.date.split("T")[0]:""}"/></td>
      <td class="mono">${daysBetween(item.date)}</td>
      <td class="mono">${r.steps.monthByPurchase}</td>
      <td class="mono">${r.steps.monthByRecycle}</td>
      <td contenteditable="true" class="mono" data-field="cost">${item.cost??""}</td>
      <td contenteditable="true" class="mono" data-field="margin">${item.margin??""}</td>
      <td contenteditable="true" class="mono" data-field="market">${item.market??""}</td>
      <td contenteditable="true" class="mono" data-field="marketAdj">${item.marketAdj??""}</td>
      <td class="mono">${r.price}</td>
      <td class="mono">${r.profit}</td>
      <td><input type="checkbox" data-field="repair" ${item.repair?"checked":""}/></td>
      <td contenteditable="true" data-field="repairNote">${escapeHtml(item.repairNote||"")}${diag}</td>
      <td contenteditable="true" data-field="monthlyCoeffsStr">${(item.monthlyCoeffs && item.monthlyCoeffs.length)? escapeHtml(item.monthlyCoeffs.join(", ")): ""}</td>
      <td><button class="btn ghost btnDel">刪除</button></td>
    `;
    tbody.appendChild(tr);
  });
  $("#sumPrice").textContent = sumPrice.toLocaleString();
  $("#sumProfit").textContent = sumProfit.toLocaleString();

  tbody.querySelectorAll("[contenteditable='true']").forEach(cell => cell.addEventListener("blur", onCellEdit));
  tbody.querySelectorAll("select[data-field]").forEach(sel => sel.addEventListener("change", onSelectEdit));
  tbody.querySelectorAll("input[type='date'][data-field]").forEach(inp => inp.addEventListener("change", onInputEdit));
  tbody.querySelectorAll("input[type='checkbox'][data-field]").forEach(inp => inp.addEventListener("change", onCheckboxEdit));
  tbody.querySelectorAll(".btnDel").forEach((btn, i) => btn.addEventListener("click", () => {
    const filteredIndices = state.items.map((it, idx) => ({it, idx})).filter(x => filterItem(x.it)).map(x => x.idx);
    const originalIndex = filteredIndices[i];
    state.items.splice(originalIndex,1); render();
  }));
}

function onCellEdit(e){
  const cell = e.target;
  const field = cell.dataset.field;
  const rowIndex = [...cell.parentElement.parentElement.children].indexOf(cell.parentElement);
  const filteredIndices = state.items.map((it, idx) => ({it, idx})).filter(x => filterItem(x.it)).map(x => x.idx);
  const originalIndex = filteredIndices[rowIndex];
  const raw = cell.textContent.trim();
  if(["cost","margin","market","marketAdj"].includes(field)){
    state.items[originalIndex][field] = raw==="" ? "" : Number(raw);
  }else if(field==="monthlyCoeffsStr"){
    const arr = parseCoeffRow(raw);
    state.items[originalIndex].monthlyCoeffs = arr || [];
  }else{
    state.items[originalIndex][field] = raw;
  }
  render();
}
function onSelectEdit(e){
  const sel = e.target;
  const field = sel.dataset.field;
  const rowIndex = [...sel.parentElement.parentElement.children].indexOf(sel.parentElement);
  const filteredIndices = state.items.map((it, idx) => ({it, idx})).filter(x => filterItem(x.it)).map(x => x.idx);
  const originalIndex = filteredIndices[rowIndex];
  state.items[originalIndex][field] = sel.value;
  render();
}
function onInputEdit(e){
  const inp = e.target;
  const field = inp.dataset.field;
  const rowIndex = [...inp.parentElement.parentElement.children].indexOf(inp.parentElement);
  const filteredIndices = state.items.map((it, idx) => ({it, idx})).filter(x => filterItem(x.it)).map(x => x.idx);
  const originalIndex = filteredIndices[rowIndex];
  state.items[originalIndex][field] = inp.value;
  render();
}
function onCheckboxEdit(e){
  const inp = e.target;
  const field = inp.dataset.field;
  const rowIndex = [...inp.parentElement.parentElement.children].indexOf(inp.parentElement);
  const filteredIndices = state.items.map((it, idx) => ({it, idx})).filter(x => filterItem(x.it)).map(x => x.idx);
  const originalIndex = filteredIndices[rowIndex];
  state.items[originalIndex][field] = inp.checked;
  render();
}

// ---- Globals & UI ----
function pullGlobalsFromUI(){
  const ru = Number($("#roundUnit").value);
  $("#roundUnit").value = (!Number.isFinite(ru) || ru < 1) ? 1 : ru;
  state.globals.roundUnit = Number($("#roundUnit").value)||1;
  state.globals.roundMode = $("#roundMode").value;
  state.globals.tailMode  = $("#tailMode").value;
  state.globals.defaultMarketAdj = Number($("#defaultMarketAdj").value)||0;
  state.globals.minMarginFloor   = Math.max(0, Number($("#minMarginFloor").value)||0);
  state.globals.notBelowMarketPct= Number($("#notBelowMarketPct").value)||0;
  state.globals.ladder = parseLadder($("#ladderInput").value);
  state.globals.cumulativeMode = $("#cumulativeMode").checked;
  state.globals.coeffBasis = $("#coeffBasis").value;
}
["#roundUnit","#roundMode","#tailMode","#defaultMarketAdj","#minMarginFloor","#notBelowMarketPct","#ladderInput","#cumulativeMode","#coeffBasis"]
  .forEach(sel => $(sel).addEventListener("input", ()=>{ pullGlobalsFromUI(); render(); }));

$("#btnApplyFilter").addEventListener("click", ()=>{
  state.filter.category = $("#filterCategory").value;
  state.filter.keyword = $("#searchKeyword").value;
  render();
});
$("#btnClearFilter").addEventListener("click", ()=>{
  $("#filterCategory").value = "";
  $("#searchKeyword").value = "";
  state.filter = {category:"", keyword:""};
  render();
});

$("#btnBatchApply").addEventListener("click", ()=>{
  const m = $("#batchMargin").value.trim();
  const a = $("#batchMarketAdj").value.trim();
  const filtered = state.items.map((it, idx) => ({it, idx})).filter(x => filterItem(x.it));
  for(const {idx} of filtered){
    if(m!=="") state.items[idx].margin = Number(m);
    if(a!=="") state.items[idx].marketAdj = Number(a);
  }
  render();
});

function toggleRepairNoteRow(){ $("#repairNoteRow").style.display = $("#newRepair").checked ? "" : "none"; }
$("#newRepair").addEventListener("change", toggleRepairNoteRow);
$("#btnAdd").addEventListener("click", ()=>{
  const it = {
    name: $("#newName").value.trim()||"未命名",
    category: $("#newCategory").value,
    purchaseDate: $("#newPurchaseDate").value||"",                 // 新增
    date: $("#newDate").value||new Date().toISOString().slice(0,10),
    cost: Number($("#newCost").value)||0,
    margin: $("#newMargin").value===""? "" : Number($("#newMargin").value),
    market: $("#newMarket").value===""? "" : Number($("#newMarket").value),
    marketAdj: $("#newMarketAdj").value===""? "" : Number($("#newMarketAdj").value),
    repair: $("#newRepair").checked,
    repairNote: $("#newRepairNote").value.trim()
  };
  state.items.push(it);
  ["#newName","#newPurchaseDate","#newDate","#newCost","#newMargin","#newMarket","#newMarketAdj","#newRepairNote"].forEach(sel => $(sel).value="");
  $("#newRepair").checked=false; toggleRepairNoteRow();
  render();
});

// Exporters (same as before)
$("#btnExportJSON")?.addEventListener("click", ()=>{
  const blob = new Blob([JSON.stringify({globals:state.globals, items:state.items}, null, 2)], {type:"application/json"});
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "usedpc_scenario_v8_5.json"; a.click();
});
$("#btnExportCSV")?.addEventListener("click", ()=>{
  const headers = ["name","category","purchaseDate","date","cost","margin","market","marketAdj","repair","repairNote","monthlyCoeffs"];
  const rows = state.items.map(it => headers.map(h => {
    let v = it[h];
    if(h==="monthlyCoeffs" && Array.isArray(it.monthlyCoeffs)) v = it.monthlyCoeffs.join(",");
    if(v===undefined||v===null) v="";
    return String(v).replace(/"/g,'""');
  }));
  const csv = [headers.join(","), ...rows.map(r => r.map(v => /[",\n]/.test(v)?`"${v}"`:v).join(","))].join("\n");
  const blob = new Blob([csv], {type:"text/csv;charset=utf-8"});
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "usedpc_items_v8_5.csv"; a.click();
});
$("#btnExportXLSX")?.addEventListener("click", ()=>{
  if(typeof XLSX==="undefined"){ alert("XLSX 函式庫尚未載入（需要上傳到 GitHub Pages 後使用）。"); return; }
  const ws = XLSX.utils.json_to_sheet(state.items);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "items");
  const wbout = XLSX.write(wb, {bookType:"xlsx", type:"array"});
  const blob = new Blob([wbout], {type:"application/octet-stream"});
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "usedpc_items_v8_5.xlsx"; a.click();
});

// Paste coeffs
function getPasteCoeffs(){
  const txt = document.getElementById("coeffPaste")?.value || "";
  const arr = parseCoeffRow(txt);
  if(!arr){ alert("無法解析係數，請確認格式"); return null; }
  return arr;
}
document.getElementById("btnCoeffPasteGlobal").addEventListener("click", ()=>{
  const arr = getPasteCoeffs(); if(!arr) return;
  state.globals.monthlyCoeffs = arr; buildCoeffGrid(); render();
  alert("已套用到全域 1–18 月係數");
});
document.getElementById("btnCoeffPasteItems").addEventListener("click", ()=>{
  const arr = getPasteCoeffs(); if(!arr) return;
  const filtered = state.items.map((it, idx) => ({it, idx})).filter(x => filterItem(x.it));
  for(const {idx} of filtered){ state.items[idx].monthlyCoeffs = arr.slice(); }
  render(); alert("已套用到目前篩選的單品（覆寫）");
});
document.getElementById("btnCoeffReset").addEventListener("click", ()=>{
  state.globals.monthlyCoeffs = Array.from({length:18}, ()=>1.00);
  buildCoeffGrid(); render();
});

// Ladder generator
document.getElementById("btnGenLadder").addEventListener("click", ()=>{
  const s = Number(document.getElementById("genStartMonth").value)||1;
  const e = Number(document.getElementById("genEndMonth").value)||12;
  const p = Number(document.getElementById("genPerMonthPct").value)||0;
  if(e < s){ alert("結束月不可小於起始月"); return; }
  const parts = [];
  for(let m=s; m<=e; m++){ const days = m*30; parts.push(`${days}/${p}`); }
  document.getElementById("ladderInput").value = parts.join(",");
  pullGlobalsFromUI(); render(); alert("已按月生成階梯並套用");
});

// Build coeff grid
function buildCoeffGrid(){
  const grid = document.getElementById("coeffGrid");
  grid.innerHTML = "";
  for(let i=1;i<=18;i++){
    const wrap = document.createElement("div");
    wrap.className = "form-row";
    wrap.innerHTML = `
      <label>${i} 月</label>
      <input type="number" step="0.01" data-coeff-index="${i-1}" value="${Number(state.globals.monthlyCoeffs[i-1]).toFixed(2)}"/>
    `;
    grid.appendChild(wrap);
  }
  grid.querySelectorAll("input[data-coeff-index]").forEach(inp => {
    inp.addEventListener("input", e=>{
      const idx = Number(e.target.dataset.coeffIndex);
      const v = Number(e.target.value);
      state.globals.monthlyCoeffs[idx] = Number.isFinite(v) ? v : 1.00;
      render();
    });
  });
}

// Seed
function seed(){
  state.items = [
    { name:"測A", category:"NB",  purchaseDate:"2025-04-15", date:"2025-09-01", cost:10000, margin:0.20, market:"", marketAdj:"", repair:false, repairNote:"" },
    { name:"測B", category:"NB",  purchaseDate:"2024-12-20", date:"2025-09-20", cost:10000, margin:0.05, market:11000, marketAdj:"", repair:false, repairNote:"" },
    { name:"測C", category:"DT",  purchaseDate:"2024-06-10", date:"2025-07-10", cost:20000, margin:0.30, market:26000, marketAdj:0, repair:false, repairNote:"" },
    { name:"你的例子：購買2025/08/04；回收2025/09/01；今天 2025/10/04", category:"OTH", purchaseDate:"2025-08-04", date:"2025-09-01", cost:10000, margin:0.10, market:"", marketAdj:"", repair:false, repairNote:"測試月序" }
  ];
  state.filter = {category:"", keyword:""};
  state.diagnostics = false;
  state.globals.coeffBasis = "purchase";
  pushGlobalsToUI();
  $("#toggleDiagnostics").checked = false;
}

function pushGlobalsToUI(){
  $("#roundUnit").value = state.globals.roundUnit;
  $("#roundMode").value = state.globals.roundMode;
  $("#tailMode").value = state.globals.tailMode;
  $("#defaultMarketAdj").value = state.globals.defaultMarketAdj;
  $("#minMarginFloor").value = state.globals.minMarginFloor;
  $("#notBelowMarketPct").value = state.globals.notBelowMarketPct;
  $("#ladderInput").value = state.globals.ladder.map(x => `${x.days}/${x.adj}`).join(",");
  $("#cumulativeMode").checked = !!state.globals.cumulativeMode;
  $("#coeffBasis").value = state.globals.coeffBasis;
  buildCoeffGrid();
}

document.addEventListener("DOMContentLoaded", ()=>{
  seed();
  render();
  $("#newDate").value = new Date().toISOString().slice(0,10);
  $("#newPurchaseDate").value = "";

  $("#toggleDiagnostics").addEventListener("change", (e)=>{ state.diagnostics = e.target.checked; render(); });
});
