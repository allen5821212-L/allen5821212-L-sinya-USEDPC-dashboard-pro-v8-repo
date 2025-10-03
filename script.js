
// v8.5 Pro core script

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

function computePrice(item, globals, today = new Date()){
  const steps = {};
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

  const d = item.date ? new Date(item.date) : today;
  const daysInStock = Math.max(0, Math.floor((today - d)/(1000*60*60*24)));
  steps.daysInStock = daysInStock;

  // adjusted market
  let adjustedMarket = null;
  if(market!==null){
    adjustedMarket = market * (1 + marketAdj);
  }
  steps.adjustedMarket = adjustedMarket;

  // initial margin price
  let price = cost * (1 + margin);
  steps.initialMarginPrice = price;

  // ladder (max threshold)
  let ladderAdj = 0;
  for(const l of ladder){
    if(daysInStock >= l.days) ladderAdj = l.adj;
  }
  if(ladderAdj!==0){
    price = price * (1 + ladderAdj);
  }
  steps.afterLadder = price;
  steps.ladderAdj = ladderAdj;

  // monthly coeff
  const monthIndex = Math.min(18, Math.max(1, Math.floor(daysInStock/30)+1));
  const sourceCoeffs = (Array.isArray(item.monthlyCoeffs) && item.monthlyCoeffs.length)? item.monthlyCoeffs : globals.monthlyCoeffs;
  let coeff = 1;
  if(Array.isArray(sourceCoeffs)){
    if(globals.cumulativeMode){
      const end = Math.min(monthIndex, sourceCoeffs.length);
      for(let i=0;i<end;i++) coeff *= Number(sourceCoeffs[i]||1);
    }else{
      coeff = Number(sourceCoeffs[monthIndex-1]||1);
    }
  }
  price = price * coeff;
  steps.afterMonthlyCoeff = price;

  // lower-bound constraints
  const minPriceByMargin = cost * (1 + minMarginFloor);
  if(price < minPriceByMargin){
    price = minPriceByMargin;
  }
  steps.afterMinMargin = price;

  let floorByMarket = -Infinity;
  if(adjustedMarket!==null){
    floorByMarket = adjustedMarket * (1 + notBelowMarketPct);
    if(price < floorByMarket) price = floorByMarket;
  }
  steps.afterMarketFloor = price;
  steps.marketFloor = floorByMarket;

  // rounding
  price = roundByMode(price, roundUnit, roundMode);
  steps.afterRounding = price;

  // tail without breaking floor
  const floorConstraint = Math.max(minPriceByMargin, floorByMarket);
  price = applyTail(price, tailMode, floorConstraint);
  steps.afterTail = price;

  // NEW: market ceiling
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

function filterItem(item){
  const c = state.filter.category;
  const k = (state.filter.keyword||"").trim().toLowerCase();
  const okCategory = !c || item.category===c;
  const okK = !k || ( (item.name||"").toLowerCase().includes(k) || (item.repairNote||"").toLowerCase().includes(k) );
  return okCategory && okK;
}

function fmt(x){ if(x===null || x===undefined) return "—"; return Math.round(x); }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[m])); }
function daysInStock(dateStr){ if(!dateStr) return 0; const d = new Date(dateStr); const today = new Date(); return Math.max(0, Math.floor((today - d)/(1000*60*60*24))); }

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
      <div class="badge mono">市價上限: ${fmt(steps.afterMarketCeil)}</div>
      ${steps.marketConflict? `<div class="badge mono">⚠ 上限/下限衝突: ${steps.marketConflict}</div>` : ""}
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
      <td><input type="checkbox" data-field="repair" ${item.repair?"checked":""}/></td>
      <td contenteditable="true" data-field="repairNote">${escapeHtml(item.repairNote||"")}${diag}</td>
      <td contenteditable="true" data-field="monthlyCoeffsStr">${(item.monthlyCoeffs && item.monthlyCoeffs.length)? escapeHtml(item.monthlyCoeffs.join(", ")): ""}</td>
      <td><button class="btn ghost btnDel">刪除</button></td>
    `;
    tbody.appendChild(tr);
  });

  $("#sumPrice").textContent = sumPrice.toLocaleString();
  $("#sumProfit").textContent = sumProfit.toLocaleString();

  tbody.querySelectorAll("[contenteditable='true']").forEach(cell => { cell.addEventListener("blur", onCellEdit); });
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

function pullGlobalsFromUI(){
  state.globals.roundUnit = Number($("#roundUnit").value)||1;
  state.globals.roundMode = $("#roundMode").value;
  state.globals.tailMode  = $("#tailMode").value;
  state.globals.defaultMarketAdj = Number($("#defaultMarketAdj").value)||0;
  state.globals.minMarginFloor   = Number($("#minMarginFloor").value)||0;
  state.globals.notBelowMarketPct= Number($("#notBelowMarketPct").value)||0;
  state.globals.ladder = parseLadder($("#ladderInput").value);
  state.globals.cumulativeMode = $("#cumulativeMode").checked;
}
["#roundUnit","#roundMode","#tailMode","#defaultMarketAdj","#minMarginFloor","#notBelowMarketPct","#ladderInput","#cumulativeMode"]
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
  ["#newName","#newDate","#newCost","#newMargin","#newMarket","#newMarketAdj","#newRepairNote"].forEach(sel => $(sel).value="");
  $("#newRepair").checked=false; toggleRepairNoteRow();
  render();
});

$("#btnExportJSON").addEventListener("click", ()=>{
  const blob = new Blob([JSON.stringify({globals:state.globals, items:state.items}, null, 2)], {type:"application/json"});
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "usedpc_scenario_v8_5.json"; a.click();
});
$("#btnExportCSV").addEventListener("click", ()=>{
  const headers = ["name","category","date","cost","margin","market","marketAdj","repair","repairNote","monthlyCoeffs"];
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
$("#btnExportXLSX").addEventListener("click", ()=>{
  if(typeof XLSX==="undefined"){ alert("XLSX 函式庫尚未載入（需要上傳到 GitHub Pages 後使用）。"); return; }
  const ws = XLSX.utils.json_to_sheet(state.items);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "items");
  const wbout = XLSX.write(wb, {bookType:"xlsx", type:"array"});
  const blob = new Blob([wbout], {type:"application/octet-stream"});
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "usedpc_items_v8_5.xlsx"; a.click();
});

let importedFile = null;
$("#fileImport").addEventListener("change", (e)=>{ importedFile = e.target.files[0] || null; });
$("#btnImport").addEventListener("click", async ()=>{
  if(!importedFile){ alert("請先選擇檔案"); return; }
  const ext = importedFile.name.split(".").pop().toLowerCase();
  if(ext==="json"){
    const txt = await importedFile.text();
    try{
      const data = JSON.parse(txt);
      if(data.globals) Object.assign(state.globals, data.globals);
      if(Array.isArray(data.items)) state.items = data.items;
      pushGlobalsToUI(); render(); alert("JSON 匯入完成");
    }catch(err){ alert("JSON 解析失敗：" + err.message); }
  }else if(ext==="csv"){
    const txt = await importedFile.text();
    const rows = txt.split(/\r?\n/).filter(Boolean).map(line => {
      const cells = []; let cur="", inQ=false;
      for(let i=0;i<line.length;i++){
        const ch=line[i];
        if(ch=='"'){ if(inQ && line[i+1]=='"'){ cur+='"'; i++; } else inQ=!inQ; }
        else if(ch===',' && !inQ){ cells.push(cur); cur=""; }
        else cur+=ch;
      }
      cells.push(cur); return cells;
    });
    const headers = rows.shift();
    const idx = Object.fromEntries(headers.map((h,i)=>[h,i]));
    state.items = rows.map(r => ({
      name: r[idx.name]||"",
      category: r[idx.category]||"NB",
      date: r[idx.date]||new Date().toISOString().slice(0,10),
      cost: Number(r[idx.cost]||0),
      margin: r[idx.margin]===""? "" : Number(r[idx.margin]),
      market: r[idx.market]===""? "" : Number(r[idx.market]),
      marketAdj: r[idx.marketAdj]===""? "" : Number(r[idx.marketAdj]),
      repair: (r[idx.repair]||"").toLowerCase()==="true",
      repairNote: r[idx.repairNote]||"",
      monthlyCoeffs: parseCoeffRow(idx.monthlyCoeffs!==undefined ? r[idx.monthlyCoeffs] : "") || []
    }));
    render(); alert("CSV 匯入完成");
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
      cost: Number(it.cost||0),
      margin: it.margin===""? "" : Number(it.margin),
      market: it.market===""? "" : Number(it.market),
      marketAdj: it.marketAdj===""? "" : Number(it.marketAdj),
      repair: Boolean(it.repair),
      repairNote: it.repairNote||"",
      monthlyCoeffs: parseCoeffRow(it.monthlyCoeffs) || []
    }));
    render(); alert("XLSX 匯入完成");
  }else{
    alert("不支援的副檔名");
  }
});

function pushGlobalsToUI(){
  $("#roundUnit").value = state.globals.roundUnit;
  $("#roundMode").value = state.globals.roundMode;
  $("#tailMode").value = state.globals.tailMode;
  $("#defaultMarketAdj").value = state.globals.defaultMarketAdj;
  $("#minMarginFloor").value = state.globals.minMarginFloor;
  $("#notBelowMarketPct").value = state.globals.notBelowMarketPct;
  $("#ladderInput").value = state.globals.ladder.map(x => `${x.days}/${x.adj}`).join(",");
  $("#cumulativeMode").checked = !!state.globals.cumulativeMode;
  buildCoeffGrid();
}

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
      buildCoeffGrid(); render();
    };
  }
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
    cumulativeMode: false,
  };
  pushGlobalsToUI();
  $("#toggleDiagnostics").checked = false;
}

document.addEventListener("DOMContentLoaded", ()=>{
  seed();
  render();
  $("#newDate").value = new Date().toISOString().slice(0,10);

  // paste & generator
  function getPasteCoeffs(){
    const txt = document.getElementById("coeffPaste")?.value || "";
    const arr = parseCoeffRow(txt);
    if(!arr){ alert("無法解析係數，請確認格式"); return null; }
    return arr;
  }
  const btnPasteGlobal = document.getElementById("btnCoeffPasteGlobal");
  if(btnPasteGlobal){
    btnPasteGlobal.onclick = ()=>{
      const arr = getPasteCoeffs(); if(!arr) return;
      state.globals.monthlyCoeffs = arr; buildCoeffGrid(); render();
      alert("已套用到全域 1–18 月係數");
    };
  }
  const btnPasteItems = document.getElementById("btnCoeffPasteItems");
  if(btnPasteItems){
    btnPasteItems.onclick = ()=>{
      const arr = getPasteCoeffs(); if(!arr) return;
      const filtered = state.items.map((it, idx) => ({it, idx})).filter(x => filterItem(x.it));
      for(const {idx} of filtered){ state.items[idx].monthlyCoeffs = arr.slice(); }
      render(); alert("已套用到目前篩選的單品（覆寫）");
    };
  }

  const btnGen = document.getElementById("btnGenLadder");
  if(btnGen){
    btnGen.onclick = ()=>{
      const s = Number(document.getElementById("genStartMonth").value)||1;
      const e = Number(document.getElementById("genEndMonth").value)||12;
      const p = Number(document.getElementById("genPerMonthPct").value)||0;
      if(e < s){ alert("結束月不可小於起始月"); return; }
      const parts = [];
      for(let m=s; m<=e; m++){ const days = m*30; parts.push(`${days}/${p}`); }
      document.getElementById("ladderInput").value = parts.join(",");
      pullGlobalsFromUI(); render(); alert("已按月生成階梯並套用");
    };
  }

  // Template Manager
  const TPL_KEY = "sinya_usedpc_templates_v8_5";
  function loadTemplates(){ try{ return JSON.parse(localStorage.getItem(TPL_KEY) || "[]"); }catch(_){ return []; } }
  function saveTemplates(list){ localStorage.setItem(TPL_KEY, JSON.stringify(list)); }
  function refreshTplList(){
    const sel = document.getElementById("tplList"); if(!sel) return;
    const list = loadTemplates(); sel.innerHTML = list.map((t,i)=>`<option value="${i}">${escapeHtml(t.name)}</option>`).join("");
  }
  function getTplName(){ return (document.getElementById("tplName")?.value || "").trim(); }
  function getCurrentTplData(){
    return {
      name: getTplName() || `模板-${new Date().toISOString().slice(0,19).replace("T"," ")}`,
      coeffs: Array.isArray(state.globals.monthlyCoeffs)? state.globals.monthlyCoeffs.slice(0,18) : Array.from({length:18}, ()=>1),
      cumulative: !!state.globals.cumulativeMode,
      ladderStr: document.getElementById("ladderInput").value || ""
    };
  }
  const btnTplSave = document.getElementById("btnTplSave");
  if(btnTplSave){
    btnTplSave.onclick = ()=>{
      const t = getCurrentTplData();
      const list = loadTemplates();
      const idx = list.findIndex(x => x.name === t.name);
      if(idx>=0) list[idx] = t; else list.push(t);
      saveTemplates(list); refreshTplList(); alert("模板已儲存");
    };
  }
  const btnTplDelete = document.getElementById("btnTplDelete");
  if(btnTplDelete){
    btnTplDelete.onclick = ()=>{
      const sel = document.getElementById("tplList");
      if(!sel || sel.selectedIndex<0){ alert("請先選擇模板"); return; }
      const list = loadTemplates(); list.splice(sel.selectedIndex,1);
      saveTemplates(list); refreshTplList(); alert("模板已刪除");
    };
  }
  const btnTplApplyGlobal = document.getElementById("btnTplApplyGlobal");
  if(btnTplApplyGlobal){
    btnTplApplyGlobal.onclick = ()=>{
      const sel = document.getElementById("tplList");
      if(!sel || sel.selectedIndex<0){ alert("請先選擇模板"); return; }
      const t = loadTemplates()[sel.selectedIndex];
      state.globals.monthlyCoeffs = (t.coeffs||[]).slice(0,18);
      state.globals.cumulativeMode = !!t.cumulative;
      document.getElementById("ladderInput").value = t.ladderStr || document.getElementById("ladderInput").value;
      pullGlobalsFromUI(); buildCoeffGrid(); render();
      alert("已套用模板的係數（全域）與累積模式設定");
    };
  }
  const btnTplApplyItems = document.getElementById("btnTplApplyItems");
  if(btnTplApplyItems){
    btnTplApplyItems.onclick = ()=>{
      const sel = document.getElementById("tplList");
      if(!sel || sel.selectedIndex<0){ alert("請先選擇模板"); return; }
      const t = loadTemplates()[sel.selectedIndex];
      const arr = (t.coeffs||[]).slice(0,18);
      const filtered = state.items.map((it, idx) => ({it, idx})).filter(x => filterItem(x.it));
      for(const {idx} of filtered) state.items[idx].monthlyCoeffs = arr.slice();
      render(); alert("已將模板係數覆寫到目前篩選的單品");
    };
  }
  const btnTplApplyLadder = document.getElementById("btnTplApplyLadder");
  if(btnTplApplyLadder){
    btnTplApplyLadder.onclick = ()=>{
      const sel = document.getElementById("tplList");
      if(!sel || sel.selectedIndex<0){ alert("請先選擇模板"); return; }
      const t = loadTemplates()[sel.selectedIndex];
      document.getElementById("ladderInput").value = t.ladderStr || "";
      pullGlobalsFromUI(); render(); alert("已套用模板的逾期階梯");
    };
  }
  const btnTplExport = document.getElementById("btnTplExport");
  if(btnTplExport){
    btnTplExport.onclick = ()=>{
      const list = loadTemplates();
      const blob = new Blob([JSON.stringify(list, null, 2)], {type:"application/json"});
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download="usedpc_templates_v8_5.json"; a.click();
    };
  }
  let tplImportedFile = null;
  const tplFileInput = document.getElementById("tplFileImport");
  if(tplFileInput){
    tplFileInput.addEventListener("change", e=>{ tplImportedFile = e.target.files[0] || null; });
  }
  const btnTplFileImport = document.getElementById("btnTplFileImport");
  if(btnTplFileImport){
    btnTplFileImport.onclick = async ()=>{
      if(!tplImportedFile){ alert("請先選擇模板 JSON 檔"); return; }
      try{
        const txt = await tplImportedFile.text();
        const arr = JSON.parse(txt);
        if(!Array.isArray(arr)) throw new Error("格式錯誤：非陣列");
        localStorage.setItem("sinya_usedpc_templates_v8_5", JSON.stringify(arr));
        refreshTplList(); alert("模板 JSON 已匯入");
      }catch(e){ alert("匯入失敗：" + e.message); }
    };
  }
  function initTemplateManager(){ refreshTplList(); }
  initTemplateManager();
});

