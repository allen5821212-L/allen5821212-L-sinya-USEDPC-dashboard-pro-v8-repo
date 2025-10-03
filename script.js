
/* SINYA USEDPC Dashboard v8.1 (Fixed)
 * - Calculation order fixed: margin -> ladder -> min margin -> not-below-market -> rounding -> tail
 * - Tail won't break constraints; if it does, it will bump back to nearest valid tail value.
 * - Batch apply affects only filtered items.
 * - Diagnostics mode reveals intermediate steps.
 * - LocalStorage scenarios; JSON/CSV/XLSX import/export.
 */

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
  }
};

function parseLadder(str){
  if(!str) return [];
  return str.split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(seg => {
      const [d,p] = seg.split("/").map(x => x.trim());
      return { days: Number(d), adj: Number(p) };
    })
    .filter(lp => !Number.isNaN(lp.days) && !Number.isNaN(lp.adj))
    .sort((a,b)=>a.days-b.days);
}

function roundByMode(value, unit, mode){
  if(unit<=0) return value;
  const q = value/unit;
  if(mode==="nearest") return Math.round(q)*unit;
  if(mode==="ceil") return Math.ceil(q)*unit;
  if(mode==="floor") return Math.floor(q)*unit;
  return value;
}

function applyTail(value, tailMode, constraintFloor){
  // constraintFloor: minimum allowed price after constraints (may be -Infinity)
  if(tailMode==="none") return value;
  const v = Math.max(value, 0);
  let candidate = v;
  if(tailMode==="9"){
    // change last digit to 9 but don't go below constraint
    const base = Math.floor(v/10)*10 + 9;
    if(base >= constraintFloor) candidate = base;
    else {
      // bump to next valid ending 9 at or above floor
      const floor10 = Math.floor(constraintFloor/10)*10 + 9;
      candidate = Math.max(base, floor10);
    }
  }else if(tailMode==="99"){
    // change last two digits to 99
    const base = Math.floor(v/100)*100 + 99;
    if(base >= constraintFloor) candidate = base;
    else {
      const floor100 = Math.floor(constraintFloor/100)*100 + 99;
      candidate = Math.max(base, floor100);
    }
  }
  return candidate;
}

function computePrice(item, globals, today = new Date()){
  const steps = {}; // diagnostics
  const cost = Number(item.cost)||0;
  const margin = Number(item.margin)||0;
  const market = item.market===""||item.market===null||item.market===undefined ? null : Number(item.market);
  const marketAdj = (item.marketAdj===""||item.marketAdj===null||item.marketAdj===undefined)
    ? Number(globals.defaultMarketAdj||0) : Number(item.marketAdj);

  const roundUnit = Number(globals.roundUnit)||1;
  const roundMode = globals.roundMode||"nearest";
  const tailMode  = globals.tailMode||"none";
  const minMarginFloor = Number(globals.minMarginFloor)||0;
  const notBelowMarketPct = Number(globals.notBelowMarketPct)||0;
  const ladder = Array.isArray(globals.ladder)? globals.ladder : [];

  // 1) days in stock
  const d = item.date ? new Date(item.date) : today;
  const daysInStock = Math.max(0, Math.floor((today - d)/(1000*60*60*24)));
  steps.daysInStock = daysInStock;

  // 2) adjusted market
  let adjustedMarket = null;
  if(market!==null){
    adjustedMarket = market * (1 + marketAdj);
  }
  steps.adjustedMarket = adjustedMarket;

  // 3) initial price by margin
  let price = cost * (1 + margin);
  steps.initialMarginPrice = price;

  // 4) apply ladder by largest threshold <= days
  let ladderAdj = 0;
  for(const l of ladder){
    if(daysInStock >= l.days) ladderAdj = l.adj;
  }
  if(ladderAdj!==0){
    price = price * (1 + ladderAdj);
  }
  steps.afterLadder = price;
  steps.ladderAdj = ladderAdj;

  // 5) monthly recovery coefficient (by month index 1..18)
  const monthIndex = Math.min(18, Math.max(1, Math.floor(daysInStock/30)+1));
  const coeff = Array.isArray(globals.monthlyCoeffs)? Number(globals.monthlyCoeffs[monthIndex-1]||1) : 1;
  price = price * coeff;
  steps.afterMonthlyCoeff = price;

  // 6) enforce minimum margin floor
  const minPriceByMargin = cost * (1 + minMarginFloor);
  if(price < minPriceByMargin){
    price = minPriceByMargin;
  }
  steps.afterMinMargin = price;

  // 6) enforce not-below-market (%)
  // if notBelowMarketPct is -0.05 => price >= adjustedMarket * (1 - 0.05)
  let floorByMarket = -Infinity;
  if(adjustedMarket!==null){
    floorByMarket = adjustedMarket * (1 + notBelowMarketPct);
    if(price < floorByMarket) price = floorByMarket;
  }
  steps.afterMarketFloor = price;
  steps.marketFloor = floorByMarket;

  // 7) rounding
  price = roundByMode(price, roundUnit, roundMode);
  steps.afterRounding = price;

  // 8) tail optimization without breaking floors
  const floorConstraint = Math.max(minPriceByMargin, floorByMarket);
  price = applyTail(price, tailMode, floorConstraint);
  steps.afterTail = price;

  // profit
  const profit = price - cost;

  return { price: Math.round(price), profit: Math.round(profit), steps };
}

function render(){
  const tbody = $("#itemsTable tbody");
  tbody.innerHTML = "";
  let sumPrice = 0, sumProfit = 0;
  const filtered = state.items.filter(filterItem);
  filtered.forEach((item, idx) => {
    const {price, profit, steps} = computePrice(item, state.globals);
    sumPrice += price;
    sumProfit += profit;
    const tr = document.createElement("tr");

    const diag = state.diagnostics ? `
      <div class="badge mono">市價調整後: ${fmt(steps.adjustedMarket)}</div>
      <div class="badge mono">初步: ${fmt(steps.initialMarginPrice)}</div>
      <div class="badge mono">階梯(${steps.ladderAdj}): ${fmt(steps.afterLadder)}</div>
      <div class="badge mono">月係數: ${fmt(steps.afterMonthlyCoeff)}</div>
      <div class="badge mono">底線: ${fmt(steps.afterMinMargin)}</div>
      <div class="badge mono">市價下限: ${fmt(steps.afterMarketFloor)}</div>
      <div class="badge mono">四捨五入: ${fmt(steps.afterRounding)}</div>
      <div class="badge mono">尾數: ${fmt(steps.afterTail)}</div>
    ` : "";

    tr.innerHTML = `
      <td>${idx+1}</td>
      <td contenteditable="true" data-field="name">${escapeHtml(item.name||"")}</td>
      <td>
        <select data-field="category">
          ${["NB","DT","MON","DIY","OTH"].map(c=>`<option ${item.category===c?"selected":""}>${c}</option>`).join("")}
        </select>
      </td>
      <td><input type="date" data-field="date" value="${item.date?item.date.split("T")[0]:""}"/></td>
      <td class="mono">${daysInStock(item.date)}</td>
      <td contenteditable="true" class="mono" data-field="cost">${item.cost??""}</td>
      <td contenteditable="true" class="mono" data-field="margin">${item.margin??""}</td>
      <td contenteditable="true" class="mono" data-field="market">${item.market??""}</td>
      <td contenteditable="true" class="mono" data-field="marketAdj">${item.marketAdj??""}</td>
      <td class="mono">${price}</td>
      <td class="mono">${profit}</td>
      <td>
        <input type="checkbox" data-field="repair" ${item.repair?"checked":""}/>
      </td>
      <td contenteditable="true" data-field="repairNote">${escapeHtml(item.repairNote||"")}${diag}</td>
      <td>
        <button class="btn ghost btnDel">刪除</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  $("#sumPrice").textContent = sumPrice.toLocaleString();
  $("#sumProfit").textContent = sumProfit.toLocaleString();

  // Wire events for editable cells & deletes
  tbody.querySelectorAll("[contenteditable='true']").forEach(cell => {
    cell.addEventListener("blur", onCellEdit);
  });
  tbody.querySelectorAll("select[data-field]").forEach(sel => sel.addEventListener("change", onSelectEdit));
  tbody.querySelectorAll("input[type='date'][data-field]").forEach(inp => inp.addEventListener("change", onInputEdit));
  tbody.querySelectorAll("input[type='checkbox'][data-field]").forEach(inp => inp.addEventListener("change", onCheckboxEdit));
  tbody.querySelectorAll(".btnDel").forEach((btn, i) => btn.addEventListener("click", () => {
    const filteredIndices = state.items.map((it, idx) => ({it, idx})).filter(x => filterItem(x.it)).map(x => x.idx);
    const originalIndex = filteredIndices[i];
    state.items.splice(originalIndex,1);
    render();
  }));
}

function filterItem(item){
  const c = state.filter.category;
  const k = (state.filter.keyword||"").trim().toLowerCase();
  const okCategory = !c || item.category===c;
  const okK = !k || ( (item.name||"").toLowerCase().includes(k) || (item.repairNote||"").toLowerCase().includes(k) );
  return okCategory && okK;
}

function fmt(x){
  if(x===null || x===undefined) return "—";
  return Math.round(x);
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[m]));
}
function daysInStock(dateStr){
  if(!dateStr) return 0;
  const d = new Date(dateStr);
  const today = new Date();
  return Math.max(0, Math.floor((today - d)/(1000*60*60*24)));
}

// Edits
function onCellEdit(e){
  const cell = e.target;
  const field = cell.dataset.field;
  const rowIndex = [...cell.parentElement.parentElement.children].indexOf(cell.parentElement);
  // Row index in filtered view -> map to original index
  const filteredIndices = state.items.map((it, idx) => ({it, idx})).filter(x => filterItem(x.it)).map(x => x.idx);
  const originalIndex = filteredIndices[rowIndex];
  const raw = cell.textContent.trim();
  if(["cost","margin","market","marketAdj"].includes(field)){
    state.items[originalIndex][field] = raw==="" ? "" : Number(raw);
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

// Globals wiring
function pullGlobalsFromUI(){
  state.globals.roundUnit = Number($("#roundUnit").value)||1;
  state.globals.roundMode = $("#roundMode").value;
  state.globals.tailMode  = $("#tailMode").value;
  state.globals.defaultMarketAdj = Number($("#defaultMarketAdj").value)||0;
  state.globals.minMarginFloor   = Number($("#minMarginFloor").value)||0;
  state.globals.notBelowMarketPct= Number($("#notBelowMarketPct").value)||0;
  state.globals.ladder = parseLadder($("#ladderInput").value);
}
["#roundUnit","#roundMode","#tailMode","#defaultMarketAdj","#minMarginFloor","#notBelowMarketPct","#ladderInput"]
  .forEach(sel => $(sel).addEventListener("input", ()=>{ pullGlobalsFromUI(); render(); }));

// Filter wiring
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

// Batch apply
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

// Add item
function toggleRepairNoteRow(){
  $("#repairNoteRow").style.display = $("#newRepair").checked ? "" : "none";
}
$("#newRepair").addEventListener("change", toggleRepairNoteRow);
$("#btnAdd").addEventListener("click", ()=>{
  const it = {
    name: $("#newName").value.trim()||"未命名",
    category: $("#newCategory").value,
    date: $("#newDate").value||new Date().toISOString().slice(0,10),
    cost: Number($("#newCost").value)||0,
    margin: $("#newMargin").value===""? "" : Number($("#newMargin").value),
    market: $("#newMarket").value===""? "" : Number($("#newMarket").value),
    marketAdj: $("#newMarketAdj").value===""? "" : Number($("#newMarketAdj").value),
    repair: $("#newRepair").checked,
    repairNote: $("#newRepairNote").value.trim()
  };
  state.items.push(it);
  // clear inputs
  ["#newName","#newDate","#newCost","#newMargin","#newMarket","#newMarketAdj","#newRepairNote"].forEach(sel => $(sel).value="");
  $("#newRepair").checked=false; toggleRepairNoteRow();
  render();
});

// Import/Export
$("#btnExportJSON").addEventListener("click", ()=>{
  const blob = new Blob([JSON.stringify({globals:state.globals, items:state.items}, null, 2)], {type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "usedpc_scenario_v8_1.json";
  a.click();
});
$("#btnExportCSV").addEventListener("click", ()=>{
  const headers = ["name","category","date","cost","margin","market","marketAdj","repair","repairNote"];
  const rows = state.items.map(it => headers.map(h => (it[h]===undefined||it[h]===null)?"":String(it[h]).replace(/"/g,'""')));
  const csv = [headers.join(","), ...rows.map(r => r.map(v => /[",\n]/.test(v)?`"${v}"`:v).join(","))].join("\n");
  const blob = new Blob([csv], {type:"text/csv;charset=utf-8"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "usedpc_items_v8_1.csv";
  a.click();
});
$("#btnExportXLSX").addEventListener("click", ()=>{
  if(typeof XLSX==="undefined"){
    alert("XLSX 函式庫尚未載入（需要上傳到 GitHub Pages 後使用）。");
    return;
  }
  const ws = XLSX.utils.json_to_sheet(state.items);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "items");
  const wbout = XLSX.write(wb, {bookType:"xlsx", type:"array"});
  const blob = new Blob([wbout], {type:"application/octet-stream"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "usedpc_items_v8_1.xlsx";
  a.click();
});

let importedFile = null;
$("#fileImport").addEventListener("change", (e)=>{
  importedFile = e.target.files[0] || null;
});
$("#btnImport").addEventListener("click", async ()=>{
  if(!importedFile){ alert("請先選擇檔案"); return; }
  const ext = importedFile.name.split(".").pop().toLowerCase();
  if(ext==="json"){
    const txt = await importedFile.text();
    try{
      const data = JSON.parse(txt);
      if(data.globals) Object.assign(state.globals, data.globals);
      if(Array.isArray(data.items)) state.items = data.items;
      pushGlobalsToUI();
      render();
      alert("JSON 匯入完成");
    }catch(err){ alert("JSON 解析失敗：" + err.message); }
  }else if(ext==="csv"){
    const txt = await importedFile.text();
    const rows = txt.split(/\r?\n/).filter(Boolean).map(line => {
      // simple CSV parse (handles quotes)
      const cells = [];
      let cur="", inQ=false;
      for(let i=0;i<line.length;i++){
        const ch=line[i];
        if(ch==='"' ){
          if(inQ && line[i+1]==='"'){ cur+='"'; i++; }
          else inQ=!inQ;
        }else if(ch===',' && !inQ){
          cells.push(cur); cur="";
        }else cur+=ch;
      }
      cells.push(cur);
      return cells;
    });
    const headers = rows.shift();
    const idx = Object.fromEntries(headers.map((h,i)=>[h,i]));
    state.items = rows.map(r => ({
      name: r[idx.name]||"",
      category: r[idx.category]||"NB",
      date: r[idx.date]||new Date().toISOString().slice(0,10),
      cost: num(r[idx.cost]),
      margin: num(r[idx.margin], true),
      market: num(r[idx.market], true),
      marketAdj: num(r[idx.marketAdj], true),
      repair: (r[idx.repair]||"").toLowerCase()==="true",
      repairNote: r[idx.repairNote]||""
    }));
    render();
    alert("CSV 匯入完成");
  }else if(ext==="xlsx"){
    if(typeof XLSX==="undefined"){ alert("XLSX 函式庫尚未載入（需上傳後使用）"); return; }
    const buf = await importedFile.arrayBuffer();
    const wb = XLSX.read(buf, {type:"array"});
    const ws = wb.Sheets[wb.SheetNames[0]];
    const arr = XLSX.utils.sheet_to_json(ws, {defval:""});
    state.items = arr.map(it => ({
      name: it.name||"",
      category: it.category||"NB",
      date: it.date||new Date().toISOString().slice(0,10),
      cost: num(it.cost),
      margin: num(it.margin, true),
      market: num(it.market, true),
      marketAdj: num(it.marketAdj, true),
      repair: Boolean(it.repair),
      repairNote: it.repairNote||""
    }));
    render();
    alert("XLSX 匯入完成");
  }else{
    alert("不支援的副檔名");
  }
});

function num(v, allowEmpty=false){
  if(v==="" && allowEmpty) return "";
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Diagnostics
$("#toggleDiagnostics").addEventListener("change", (e)=>{
  state.diagnostics = e.target.checked;
  render();
});

// Scenarios
function saveScenario(){
  const payload = { globals: state.globals, items: state.items };
  localStorage.setItem("sinya_usedpc_v8_1", JSON.stringify(payload));
  alert("已儲存情境（本機）");
}
function loadScenario(){
  const txt = localStorage.getItem("sinya_usedpc_v8_1");
  if(!txt){ alert("尚無已儲存的情境"); return; }
  try{
    const data = JSON.parse(txt);
    if(data.globals) Object.assign(state.globals, data.globals);
    if(Array.isArray(data.items)) state.items = data.items;
    pushGlobalsToUI();
    render();
    alert("已載入情境");
  }catch(e){ alert("讀取失敗：" + e.message); }
}
$("#btnSaveScenario").addEventListener("click", saveScenario);
$("#btnLoadScenario").addEventListener("click", loadScenario);
$("#btnReset").addEventListener("click", ()=>{
  if(confirm("確定要重置所有內容？")){ seed(); render(); }
});

function pushGlobalsToUI(){
  $("#roundUnit").value = state.globals.roundUnit;
  $("#roundMode").value = state.globals.roundMode;
  $("#tailMode").value = state.globals.tailMode;
  $("#defaultMarketAdj").value = state.globals.defaultMarketAdj;
  $("#minMarginFloor").value = state.globals.minMarginFloor;
  $("#notBelowMarketPct").value = state.globals.notBelowMarketPct;
  $("#ladderInput").value = state.globals.ladder.map(x => `${x.days}/${x.adj}`).join(",");
  buildCoeffGrid();
}
function seed(){
  state.items = [
    { name:"測A", category:"NB",  date:new Date().toISOString().slice(0,10), cost:10000, margin:0.20, market:"", marketAdj:"", repair:false, repairNote:"" },
    { name:"測B", category:"NB",  date:new Date().toISOString().slice(0,10), cost:10000, margin:0.05, market:11000, marketAdj:"", repair:false, repairNote:"" },
    { name:"測C", category:"DT",  date:new Date(Date.now()-90*86400000).toISOString().slice(0,10), cost:20000, margin:0.30, market:26000, marketAdj:0, repair:false, repairNote:"" }
  ];
  state.filter = {category:"", keyword:""};
  state.diagnostics = false;
  state.globals = {
    roundUnit: 10,
    roundMode: "nearest",
    tailMode: "9",
    defaultMarketAdj: 0.05,
    minMarginFloor: 0.10,
    notBelowMarketPct: -0.05,
    ladder: [ {days:30, adj:-0.05}, {days:60, adj:-0.10}, {days:90, adj:-0.15} ],
    monthlyCoeffs: Array.from({length:18}, ()=>1.00),
  };
  pushGlobalsToUI();
  $("#toggleDiagnostics").checked = false;
}


// ---- Monthly Coefficients (1–18 months) UI ----
function buildCoeffGrid(){
  const grid = document.getElementById("coeffGrid");
  if(!grid) return;
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
  const resetBtn = document.getElementById("btnCoeffReset");
  if(resetBtn){
    resetBtn.onclick = ()=>{
      state.globals.monthlyCoeffs = Array.from({length:18}, ()=>1.00);
      buildCoeffGrid();
      render();
    };
  }
}


document.addEventListener("DOMContentLoaded", ()=>{
  seed();
  buildCoeffGrid();
  render();
  $("#newDate").value = new Date().toISOString().slice(0,10);
});
