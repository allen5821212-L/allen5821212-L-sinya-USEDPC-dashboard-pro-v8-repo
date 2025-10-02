// ============ Utilities ============
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const fmt = (n) => isFinite(n) ? n.toLocaleString('zh-TW', {maximumFractionDigits:0}) : '-';
const todayStr = () => new Date().toISOString().slice(0,10);
const parseNum = (v, def=0) => {
  if (v === null || v === undefined || v === '') return def;
  const n = Number(v);
  return isFinite(n) ? n : def;
};

// LocalStorage Keys
const LS_SETTINGS = 'sinya_usedpc_settings_v80';
const LS_LIST = 'sinya_usedpc_list_v80';
const LS_SCENARIOS = 'sinya_usedpc_scenarios_v80';

// ============ Global Elements ============
const roundUnitEl = $('#roundUnit');
const roundModeEl = $('#roundMode');
const tailModeEl  = $('#tailMode');
const defaultMarketAdjEl = $('#defaultMarketAdj');
const minMarginFloorEl = $('#minMarginFloor');
const marketFloorPctEl = $('#marketFloorPct');

const saveSettingsBtn = $('#saveSettings');
const loadSettingsBtn = $('#loadSettings');
const resetSettingsBtn = $('#resetSettings');

// Tiers
const tiersBody = $('#tiersBody');
const tierDaysEl = $('#tierDays');
const tierAdjEl = $('#tierAdj');
const addTierBtn = $('#addTier');
const resetTiersBtn = $('#resetTiers');

// Scenarios
const scenarioListEl = $('#scenarioList');
const scenarioNameEl = $('#scenarioName');
const scenarioSaveBtn = $('#scenarioSave');
const scenarioDeleteBtn = $('#scenarioDelete');
const scenarioCompareBtn = $('#scenarioCompare');
const compareArea = $('#compareArea');

const nameEl   = $('#itemName');
const catEl    = $('#itemCat');
const costEl   = $('#itemCost');
const marginEl = $('#itemMargin');
const marketEl = $('#itemMarket');
const marketAdjEl = $('#itemMarketAdj');
const recycleDateEl = $('#itemRecycleDate');
const noteEl   = $('#itemNote');
const hasRepairEl = $('#hasRepair');
const repairNoteEl = $('#repairNote');
const addItemBtn = $('#addItem');
const autoBestEl = $('#autoBest');
const runBestBtn = $('#runBest');

const searchEl = $('#search');
const saveListBtn = $('#saveList');
const loadListBtn = $('#loadList');
const clearListBtn = $('#clearList');
const exportCSVBtn = $('#exportCSV');
const exportXLSBtn = $('#exportXLS');
const exportXLSXBtn = $('#exportXLSX');
const importJSONEl = $('#importJSON');
const exportJSONBtn = $('#exportJSON');

const totalPriceEl = $('#totalPrice');
const totalGPEl = $('#totalGP');
const totalCountEl = $('#totalCount');

const listBody = $('#listBody');
const listTable = $('#listTable');

// Batch
const selectAllEl = $('#selectAll');
const hdrSelectEl = $('#hdrSelect');
const batchMarginEl = $('#batchMargin');
const applyBatchMarginBtn = $('#applyBatchMargin');
const batchMarketAdjEl = $('#batchMarketAdj');
const applyBatchMarketAdjBtn = $('#applyBatchMarketAdj');
const batchCatEl = $('#batchCat');
const batchOnlyFilteredEl = $('#batchOnlyFiltered');

// ============ State ============
let items = []; // array of item objects
let sortKey = 'name';
let sortAsc = true;

// ============ Settings ============
function defaultSettings(){
  return {
    roundUnit: 100,
    roundMode: 'round', // 'round' | 'ceil' | 'floor'
    tailMode: 'none',   // 'none' | '9' | '99'
    defaultMarketAdj: 0.00,
    minMarginFloor: 0.00,
    marketFloorPct: -0.10,
    tiers: [
      {days:30, adj:-0.05},
      {days:60, adj:-0.10},
      {days:90, adj:-0.15},
    ],
  };
}

function getSettingsUI(){
  // collect tiers from table
  const tiers = Array.from(tiersBody.querySelectorAll('tr')).map(tr => {
    const days = parseNum(tr.querySelector('.tierDays').value, 0);
    const adj  = parseNum(tr.querySelector('.tierAdj').value, 0);
    return {days, adj};
  }).sort((a,b)=> a.days - b.days);
  return {
    roundUnit: parseNum(roundUnitEl.value, 1),
    roundMode: roundModeEl.value,
    tailMode: tailModeEl.value,
    defaultMarketAdj: parseNum(defaultMarketAdjEl.value, 0),
    minMarginFloor: parseNum(minMarginFloorEl.value, 0),
    marketFloorPct: parseNum(marketFloorPctEl.value, -0.10),
    tiers,
  };
}

function setSettingsUI(s){
  roundUnitEl.value = String(s.roundUnit);
  roundModeEl.value = s.roundMode;
  tailModeEl.value = s.tailMode;
  defaultMarketAdjEl.value = s.defaultMarketAdj;
  minMarginFloorEl.value = s.minMarginFloor ?? 0;
  marketFloorPctEl.value = s.marketFloorPct ?? -0.10;
  // tiers render
  renderTiers(s.tiers || []);
}

function renderTiers(tiers){
  tiersBody.innerHTML = '';
  tiers.forEach((t, idx)=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input class="tierDays" type="number" step="1" value="${t.days}"/></td>
      <td><input class="tierAdj" type="number" step="0.01" value="${t.adj}"/></td>
      <td><button class="delTier" data-i="${idx}">刪除</button></td>`;
    tiersBody.appendChild(tr);
  });
  $$('.delTier').forEach(btn => btn.addEventListener('click', ()=>{
    const i = Number(btn.dataset.i);
    const cur = getSettingsUI().tiers;
    cur.splice(i,1);
    renderTiers(cur);
  }));
}

function saveSettings(){
  const s = getSettingsUI();
  localStorage.setItem(LS_SETTINGS, JSON.stringify(s));
  toast('設定已保存');
}

function loadSettings(){
  const raw = localStorage.getItem(LS_SETTINGS);
  const s = raw ? JSON.parse(raw) : defaultSettings();
  setSettingsUI(s);
  toast('設定已載入');
}

function resetSettings(){
  const s = defaultSettings();
  setSettingsUI(s);
  toast('已套用預設值（尚未保存）');
}

addTierBtn.addEventListener('click', ()=>{
  const d = parseNum(tierDaysEl.value, null);
  const a = parseNum(tierAdjEl.value, null);
  if (d===null || a===null){ alert('請輸入門檻天數與調整％'); return; }
  const cur = getSettingsUI().tiers;
  cur.push({days:d, adj:a});
  renderTiers(cur.sort((x,y)=>x.days-y.days));
  tierDaysEl.value = ''; tierAdjEl.value = '';
});
resetTiersBtn.addEventListener('click', ()=> renderTiers(defaultSettings().tiers));

// ============ Scenarios ============
function loadScenarioMap(){
  const raw = localStorage.getItem(LS_SCENARIOS);
  return raw ? JSON.parse(raw) : {};
}
function saveScenarioMap(m){
  localStorage.setItem(LS_SCENARIOS, JSON.stringify(m));
}
function refreshScenarioList(){
  const m = loadScenarioMap();
  scenarioListEl.innerHTML = '';
  Object.keys(m).forEach(k=>{
    const opt = document.createElement('option');
    opt.value = k; opt.textContent = k;
    scenarioListEl.appendChild(opt);
  });
}
function saveScenario(){
  const name = (scenarioNameEl.value || '').trim();
  if(!name){ alert('請輸入情境名稱'); return; }
  const s = getSettingsUI();
  const m = loadScenarioMap();
  m[name] = s;
  saveScenarioMap(m);
  refreshScenarioList();
  selectOption(scenarioListEl, name);
  toast('情境已儲存/更新');
}
function deleteScenario(){
  const sel = scenarioListEl.value;
  if (!sel){ alert('請先選擇情境'); return; }
  const m = loadScenarioMap();
  delete m[sel];
  saveScenarioMap(m);
  refreshScenarioList();
  toast('情境已刪除');
}
function applyScenario(){
  const sel = scenarioListEl.value;
  const m = loadScenarioMap();
  if (sel && m[sel]){
    setSettingsUI(m[sel]);
    toast('已套用情境：' + sel);
    render();
  }
}
function compareScenarios(){
  const m = loadScenarioMap();
  const names = Object.keys(m);
  if (names.length < 2){ alert('至少需要兩個情境'); return; }
  const rows = [];
  for (const n of names){
    const s = m[n];
    let totPrice = 0, totGP = 0;
    for (const it of items){
      const calc = finalPriceFor(it, s);
      totPrice += calc.final;
      totGP += (calc.final - it.cost);
    }
    rows.push({ name:n, total: totPrice, gp: totGP });
  }
  rows.sort((a,b)=> b.total - a.total);
  let html = '<div class="tableWrap"><table><thead><tr><th>情境</th><th>二手總價</th><th>毛利總額</th></tr></thead><tbody>';
  for (const r of rows){
    html += `<tr><td>${escapeHTML(r.name)}</td><td>${fmt(r.total)}</td><td>${fmt(r.gp)}</td></tr>`;
  }
  html += '</tbody></table></div>';
  compareArea.innerHTML = html;
}

function selectOption(sel, val){
  Array.from(sel.options).forEach(o=> o.selected = (o.value === val));
}

// ============ Item Logic ============
function addItem(autoBest=true){
  const name = (nameEl.value || '').trim();
  const cat  = (catEl.value || '').trim();
  const cost = parseNum(costEl.value, 0);
  const margin = parseNum(marginEl.value, 0.10);
  const market = (marketEl.value === '' ? null : parseNum(marketEl.value, null));
  const marketAdj = (marketAdjEl.value === '' ? null : parseNum(marketAdjEl.value, null));
  const recycled = recycleDateEl.value || todayStr();
  const note = (noteEl.value || '').trim();
  const hasRepair = !!hasRepairEl.checked;
  const repairNote = (repairNoteEl.value || '').trim();

  if(!name){ alert('請輸入品名'); return; }
  if(cost < 0){ alert('成本不可為負'); return; }

  const id = 'i' + Math.random().toString(36).slice(2,9);
  const item = { id, name, cat, cost, margin, market, marketAdj, recycled, note, hasRepair, repairNote, selected:false };
  items.push(item);
  clearAddForm();
  render();
  toast('已新增 1 筆');
}

function clearAddForm(){
  nameEl.value = '';
  catEl.value = '';
  costEl.value = '';
  marginEl.value = '0.10';
  marketEl.value = '';
  marketAdjEl.value = '';
  recycleDateEl.value = '';
  noteEl.value = '';
  hasRepairEl.checked = false;
  repairNoteEl.value = '';
}

function removeItem(id){
  items = items.filter(x => x.id !== id);
  render();
}

function editMargin(id, newMargin){
  const x = items.find(x => x.id === id);
  if (!x) return;
  x.margin = parseNum(newMargin, x.margin);
  render();
}

function editMarketAdj(id, newAdj){
  const x = items.find(x => x.id === id);
  if (!x) return;
  x.marketAdj = (newAdj === '' ? null : parseNum(newAdj, x.marketAdj));
  render();
}

function daysBetween(d1, d2){
  const t1 = new Date(d1).setHours(0,0,0,0);
  const t2 = new Date(d2).setHours(0,0,0,0);
  return Math.max(0, Math.round((t2 - t1) / 86400000));
}

function applyRounding(v, unit, mode){
  if(unit <= 1) {
    if (mode === 'ceil') return Math.ceil(v);
    if (mode === 'floor') return Math.floor(v);
    return Math.round(v);
  }
  const div = v / unit;
  let r;
  if (mode === 'ceil') r = Math.ceil(div);
  else if (mode === 'floor') r = Math.floor(div);
  else r = Math.round(div);
  return r * unit;
}

function applyTail(v, tailMode){
  if (tailMode === 'none') return v;
  const s = Math.floor(v).toString();
  if (tailMode === '9'){
    return Number(s.slice(0, -1) + '9');
  }
  if (tailMode === '99'){
    if (s.length <= 2) return 99;
    return Number(s.slice(0, -2) + '99');
  }
  return v;
}

// Apply tiers: find greatest threshold <= invDays, sum adj (or just latest). We'll use latest (like ladder override).
function tierFactor(invDays, tiers){
  let adj = 0;
  for (const t of tiers){
    if (invDays >= t.days) adj = t.adj;
    else break;
  }
  return 1 + adj;
}

function finalPriceFor(item, settings){
  const cost = item.cost;
  const marginPrice = cost * (1 + item.margin);
  const adj = (item.marketAdj === null || item.marketAdj === undefined) ? settings.defaultMarketAdj : item.marketAdj;
  const marketCandidate = (item.market != null) ? (item.market * (1 + adj)) : null;
  let base = (marketCandidate != null) ? marketCandidate : marginPrice;

  // Rounding & tail
  base = applyRounding(base, settings.roundUnit, settings.roundMode);
  base = applyTail(base, settings.tailMode);

  // Overdue tiers by inventory days
  const invDays = daysBetween(item.recycled, todayStr());
  const fact = tierFactor(invDays, settings.tiers || []);
  let final = Math.max(0, Math.round(base * fact));

  // Guards: minimum margin floor & market floor %
  const minMarginFloor = settings.minMarginFloor || 0;
  const marketFloorPct = settings.marketFloorPct ?? -0.10;

  const minByMargin = Math.round(cost * (1 + minMarginFloor));
  if (final < minByMargin) final = minByMargin;

  if (item.market != null){
    const minByMarket = Math.round(item.market * (1 + marketFloorPct));
    if (final < minByMarket) final = minByMarket;
  }

  return { final, invDays, marginPrice, marketCandidate };
}

// ============ Render & Totals ============
function render(){
  const settings = getSettingsUI();
  const q = (searchEl.value || '').trim().toLowerCase();

  // sort
  items.sort((a,b)=>{
    let va, vb;
    if (sortKey === 'name'){ va = a.name || ''; vb = b.name || ''; }
    else if (sortKey === 'cat'){ va = a.cat || ''; vb = b.cat || ''; }
    else if (sortKey === 'cost'){ va = a.cost || 0; vb = b.cost || 0; }
    else if (sortKey === 'margin'){ va = a.margin || 0; vb = b.margin || 0; }
    else if (sortKey === 'recycled'){ va = a.recycled || ''; vb = b.recycled || ''; }
    else if (sortKey === 'final'){
      va = finalPriceFor(a, settings).final;
      vb = finalPriceFor(b, settings).final;
    } else { va = 0; vb = 0; }
    if (typeof va === 'string'){ va = va.toLowerCase(); vb = (vb||'').toLowerCase(); }
    return sortAsc ? (va > vb ? 1 : va < vb ? -1 : 0) : (va < vb ? 1 : va > vb ? -1 : 0);
  });

  let html = '';
  let totPrice = 0;
  let totGP = 0;
  let cnt = 0;

  for (const it of items){
    // filter
    const blob = [it.name, it.cat, it.note, it.repairNote].join(' ').toLowerCase();
    if (q && !blob.includes(q)) continue;

    const calc = finalPriceFor(it, settings);
    const gp = calc.final - it.cost;
    totPrice += calc.final;
    totGP += gp;
    cnt++;

    html += `<tr>
      <td><input type="checkbox" class="rowSel" data-id="${it.id}" ${it.selected?'checked':''}></td>
      <td>${escapeHTML(it.name)}</td>
      <td>${escapeHTML(it.cat||'')}</td>
      <td>${fmt(it.cost)}</td>
      <td><input type="number" step="0.01" value="${it.margin}" data-id="${it.id}" class="editMargin" style="width:90px" /></td>
      <td>${it.market != null ? fmt(it.market) : '-'}</td>
      <td><input type="number" step="0.01" value="${it.marketAdj ?? ''}" data-id="${it.id}" class="editMarketAdj" style="width:110px" placeholder="（預設）" /></td>
      <td>${it.recycled}</td>
      <td>${calc.invDays}</td>
      <td>${fmt(calc.final)}</td>
      <td>${fmt(gp)}</td>
      <td><div class="row-actions"><button data-id="${it.id}" class="delBtn">刪除</button></div></td>
    </tr>`;
  }

  listBody.innerHTML = html;
  totalPriceEl.textContent = fmt(totPrice);
  totalGPEl.textContent = fmt(totGP);
  totalCountEl.textContent = fmt(cnt);

  // bind events after render
  $$('.delBtn').forEach(btn=> btn.addEventListener('click', e=> removeItem(btn.dataset.id)));
  $$('.editMargin').forEach(inp=> inp.addEventListener('change', e=> editMargin(inp.dataset.id, Number(inp.value))));
  $$('.editMarketAdj').forEach(inp=> inp.addEventListener('change', e=> editMarketAdj(inp.dataset.id, inp.value)));
  $$('.rowSel').forEach(chk=> chk.addEventListener('change', e=> {
    const it = items.find(x => x.id === chk.dataset.id);
    if (it){ it.selected = chk.checked; }
  }));
}

// ============ CSV / Excel (.xls XML 2003) / Excel (.xlsx OOXML ZIP) / JSON ============
function exportCSV(){
  const rows = exportRows();
  const csv = rows.map(r => r.map(v => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')){
      return '"' + s.replace(/"/g,'""') + '"';
    }
    return s;
  }).join(',')).join('\n');
  downloadBlob(csv, 'text/csv;charset=utf-8;', 'sinya_usedpc_list.csv');
}

function exportXLS(){
  const rows = exportRows();
  let xmlRows = '';
  for (const r of rows){
    xmlRows += '<Row>' + r.map(v => {
      const isNum = typeof v === 'number';
      return `<Cell><Data ss:Type="${isNum?'Number':'String'}">${escapeXML(String(v))}</Data></Cell>`;
    }).join('') + '</Row>';
  }
  const xml = `<?xml version="1.0"?>
  <?mso-application progid="Excel.Sheet"?>
  <Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
    xmlns:o="urn:schemas-microsoft-com:office:office"
    xmlns:x="urn:schemas-microsoft-com:office:excel"
    xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
    <Worksheet ss:Name="UsedPC">
      <Table>${xmlRows}</Table>
    </Worksheet>
  </Workbook>`;
  downloadBlob(xml, 'application/vnd.ms-excel', 'sinya_usedpc_list.xls');
}

function exportXLSX(){
  const rows = exportRows();

  // Build OOXML parts
  const sheetXml = buildSheetXML(rows);
  const files = [
    {name:'[Content_Types].xml', data:buildContentTypes()},
    {name:'_rels/.rels', data:buildRelsRoot()},
    {name:'xl/workbook.xml', data:buildWorkbook()},
    {name:'xl/_rels/workbook.xml.rels', data:buildWorkbookRels()},
    {name:'xl/worksheets/sheet1.xml', data:sheetXml},
  ];

  const zipBytes = makeZip(files);
  const blob = new Blob([zipBytes], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  downloadURL(URL.createObjectURL(blob), 'sinya_usedpc_list.xlsx');
}

function exportRows(){
  const settings = getSettingsUI();
  const header = ['品名','分類','成本','毛利率','市場價','市價調整％','回收日','庫存天數','最終售價','毛利額','備註','有維修','維修備註'];
  const rows = [header];
  for (const it of items){
    const calc = finalPriceFor(it, settings);
    const gp = calc.final - it.cost;
    rows.push([
      it.name, it.cat||'', it.cost, it.margin, (it.market!=null?it.market:''),
      (it.marketAdj!=null?it.marketAdj:''), it.recycled, calc.invDays, calc.final, gp,
      it.note||'', it.hasRepair ? 'Y' : '', it.repairNote||''
    ]);
  }
  return rows;
}

// OOXML helpers
function buildContentTypes(){
  return `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;
}
function buildRelsRoot(){
  return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
}
function buildWorkbook(){
  return `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="UsedPC" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;
}
function buildWorkbookRels(){
  return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;
}
function colLetter(n){
  let s = ''; n++;
  while(n>0){ const m = (n-1)%26; s = String.fromCharCode(65+m)+s; n = Math.floor((n-1)/26); }
  return s;
}
function buildSheetXML(rows){
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
  <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
    <sheetData>`;
  for (let r=0; r<rows.length; r++){
    xml += `<row r="${r+1}">`;
    const row = rows[r];
    for (let c=0; c<row.length; c++){
      const v = row[c];
      const cellRef = colLetter(c) + (r+1);
      if (typeof v === 'number'){
        xml += `<c r="${cellRef}"><v>${v}</v></c>`;
      } else {
        xml += `<c r="${cellRef}" t="inlineStr"><is><t>${escapeXML(String(v))}</t></is></c>`;
      }
    }
    xml += `</row>`;
  }
  xml += `</sheetData></worksheet>`;
  return xml;
}

// Minimal ZIP (STORED, no compression)
function makeZip(files){
  function crc32(buf){
    let c = ~0;
    for (let i=0; i<buf.length; i++){
      c ^= buf[i];
      for (let k=0; k<8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    return ~c >>> 0;
  }
  function encUTF8(str){
    return new TextEncoder().encode(str);
  }
  function writeUint32LE(arr, v){
    arr.push(v & 0xFF, (v>>>8)&0xFF, (v>>>16)&0xFF, (v>>>24)&0xFF);
  }
  function writeUint16LE(arr, v){
    arr.push(v & 0xFF, (v>>>8)&0xFF);
  }

  let localParts = [];
  let centralParts = [];
  let offset = 0;

  files.forEach(f=>{
    const nameBytes = encUTF8(f.name);
    const dataBytes = encUTF8(f.data);
    const crc = crc32(dataBytes);
    const compSize = dataBytes.length;
    const uncompSize = dataBytes.length;

    // Local file header
    let lh = [];
    writeUint32LE(lh, 0x04034b50);
    writeUint16LE(lh, 20); // version needed
    writeUint16LE(lh, 0);  // flags
    writeUint16LE(lh, 0);  // method 0 STORED
    writeUint16LE(lh, 0);  // mod time
    writeUint16LE(lh, 0);  // mod date
    writeUint32LE(lh, crc);
    writeUint32LE(lh, compSize);
    writeUint32LE(lh, uncompSize);
    writeUint16LE(lh, nameBytes.length);
    writeUint16LE(lh, 0);  // extra length

    localParts.push(new Uint8Array(lh));
    localParts.push(nameBytes);
    localParts.push(dataBytes);

    // Central directory header
    let ch = [];
    writeUint32LE(ch, 0x02014b50);
    writeUint16LE(ch, 20); // version made by
    writeUint16LE(ch, 20); // version needed
    writeUint16LE(ch, 0);  // flags
    writeUint16LE(ch, 0);  // method
    writeUint16LE(ch, 0);  // mod time
    writeUint16LE(ch, 0);  // mod date
    writeUint32LE(ch, crc);
    writeUint32LE(ch, compSize);
    writeUint32LE(ch, uncompSize);
    writeUint16LE(ch, nameBytes.length);
    writeUint16LE(ch, 0);  // extra
    writeUint16LE(ch, 0);  // comment
    writeUint16LE(ch, 0);  // disk start
    writeUint16LE(ch, 0);  // internal attrs
    writeUint32LE(ch, 0);  // external attrs
    writeUint32LE(ch, offset);
    centralParts.push(new Uint8Array(ch));
    centralParts.push(nameBytes);

    // update offset
    offset += lh.length + nameBytes.length + dataBytes.length;
  });

  // End of central directory
  let centralSize = centralParts.reduce((s,u)=>s+u.length,0);
  let localSize = localParts.reduce((s,u)=>s+u.length,0);
  let eocd = [];
  writeUint32LE(eocd, 0x06054b50);
  writeUint16LE(eocd, 0); // disk
  writeUint16LE(eocd, 0); // start disk
  writeUint16LE(eocd, files.length);
  writeUint16LE(eocd, files.length);
  writeUint32LE(eocd, centralSize);
  writeUint32LE(eocd, localSize);
  writeUint16LE(eocd, 0); // comment

  const parts = [...localParts, ...centralParts, new Uint8Array(eocd)];
  let total = parts.reduce((s,u)=>s+u.length,0);
  let out = new Uint8Array(total);
  let pos = 0;
  parts.forEach(u=> { out.set(u, pos); pos += u.length; });
  return out;
}

// ============ JSON / LocalStorage ============
function importJSON(file){
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const obj = JSON.parse(fr.result);
      if (Array.isArray(obj)){
        items = obj;
        render();
        toast('JSON 已匯入');
      } else {
        alert('JSON 格式不正確：應為陣列');
      }
    } catch(e){
      alert('解析 JSON 失敗：' + e.message);
    }
  };
  fr.readAsText(file);
}
function exportJSON(){
  const blob = new Blob([JSON.stringify(items, null, 2)], {type:'application/json'});
  downloadURL(URL.createObjectURL(blob), 'sinya_usedpc_list.json');
}
function saveList(){
  localStorage.setItem(LS_LIST, JSON.stringify(items));
  toast('清單已保存');
}
function loadList(){
  const raw = localStorage.getItem(LS_LIST);
  if (!raw){ toast('尚無保存清單'); return; }
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)){
      items = arr;
      render();
      toast('清單已載入');
    } else {
      alert('保存內容已損壞');
    }
  } catch(e){
    alert('讀取清單錯誤：' + e.message);
  }
}
function clearList(){
  if (!confirm('確定清空清單？')) return;
  items = [];
  render();
}

// ============ Sorting & Search ============
function headerClick(e){
  const key = e.target.getAttribute('data-sort');
  if (!key) return;
  if (sortKey === key) sortAsc = !sortAsc;
  else { sortKey = key; sortAsc = true; }
  render();
}

// ============ Batch / Best Price ============
function getFilteredIds(){
  const q = (searchEl.value || '').trim().toLowerCase();
  return items.filter(it => {
    const blob = [it.name, it.cat, it.note, it.repairNote].join(' ').toLowerCase();
    return !q || blob.includes(q);
  }).map(x => x.id);
}
function getSelectedIds(){
  return items.filter(x => x.selected).map(x => x.id);
}
function pickTarget(){
  // Priority: if any selected, use selected; else if batchOnlyFiltered, use filtered; else if batchCat given, filter by category; else all.
  let target = items;
  const filteredIds = getFilteredIds();
  const selectedIds = getSelectedIds();
  const cat = (batchCatEl.value || '').trim().toLowerCase();

  if (selectedIds.length){
    target = items.filter(x => selectedIds.includes(x.id));
  } else if (batchOnlyFilteredEl.checked){
    target = items.filter(x => filteredIds.includes(x.id));
  }

  if (cat){
    target = target.filter(x => (x.cat||'').toLowerCase() === cat);
  }
  return target;
}
function applyBatchMargin(){
  const v = batchMarginEl.value;
  if (v === ''){ alert('請輸入毛利率'); return; }
  const m = parseNum(v, null);
  if (m === null){ alert('毛利率格式錯誤'); return; }
  const target = pickTarget();
  target.forEach(x => x.margin = m);
  render();
  toast(`已套用毛利率至 ${target.length} 筆`);
}
function applyBatchMarketAdj(){
  const v = batchMarketAdjEl.value;
  if (v === ''){ alert('請輸入市價調整％'); return; }
  const adj = parseNum(v, null);
  if (adj === null){ alert('格式錯誤'); return; }
  const target = pickTarget();
  target.forEach(x => x.marketAdj = adj);
  render();
  toast(`已套用市價調整％至 ${target.length} 筆`);
}
function runBestAll(){
  render();
  toast('已套用最佳價流程（目前規則已全部生效）');
}

// ============ Helpers ============
function escapeHTML(s){
  return (s||'').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
function escapeXML(s){
  return (s||'').replace(/[<>&'"]/g, c => ({
    '<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'
  }[c]));
}
function toast(msg){
  let t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  Object.assign(t.style, {
    position:'fixed', left:'50%', bottom:'24px', transform:'translateX(-50%)',
    background:'#111', color:'#fff', padding:'8px 12px', borderRadius:'999px',
    fontSize:'13px', opacity:'0', transition:'opacity .2s ease', zIndex:9999
  });
  document.body.appendChild(t);
  requestAnimationFrame(()=> t.style.opacity = '1');
  setTimeout(()=>{
    t.style.opacity = '0';
    setTimeout(()=> t.remove(), 250);
  }, 1200);
}

function downloadBlob(content, mime, filename){
  const blob = new Blob([content], {type: mime});
  downloadURL(URL.createObjectURL(blob), filename);
}
function downloadURL(url, filename){
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=> URL.revokeObjectURL(url), 1000);
}

// ============ Bindings ============
saveSettingsBtn.addEventListener('click', saveSettings);
loadSettingsBtn.addEventListener('click', loadSettings);
resetSettingsBtn.addEventListener('click', resetSettings);

scenarioSaveBtn.addEventListener('click', saveScenario);
scenarioDeleteBtn.addEventListener('click', deleteScenario);
scenarioListEl.addEventListener('change', applyScenario);
scenarioCompareBtn.addEventListener('click', compareScenarios);

addItemBtn.addEventListener('click', ()=> addItem(autoBestEl.checked));
runBestBtn.addEventListener('click', runBestAll);

saveListBtn.addEventListener('click', saveList);
loadListBtn.addEventListener('click', loadList);
clearListBtn.addEventListener('click', clearList);

exportCSVBtn.addEventListener('click', exportCSV);
exportXLSBtn.addEventListener('click', exportXLS);
exportXLSXBtn.addEventListener('click', exportXLSX);
exportJSONBtn.addEventListener('click', exportJSON);
importJSONEl.addEventListener('change', e => {
  if (e.target.files && e.target.files[0]) importJSON(e.target.files[0]);
});

searchEl.addEventListener('input', render);
listTable.querySelector('thead').addEventListener('click', headerClick);

hdrSelectEl.addEventListener('change', ()=> {
  const checked = hdrSelectEl.checked;
  items.forEach(x => x.selected = checked);
  render();
});
selectAllEl.addEventListener('change', ()=> {
  const checked = selectAllEl.checked;
  items.forEach(x => x.selected = checked);
  render();
});
applyBatchMarginBtn.addEventListener('click', applyBatchMargin);
applyBatchMarketAdjBtn.addEventListener('click', applyBatchMarketAdj);

// init
(function init(){
  const raw = localStorage.getItem(LS_SETTINGS);
  const s = raw ? JSON.parse(raw) : defaultSettings();
  setSettingsUI(s);
  refreshScenarioList();

  const rawList = localStorage.getItem(LS_LIST);
  if (rawList){
    try { items = JSON.parse(rawList) || []; } catch {}
  }
  if (!items.length){
    const d = todayStr();
    items = [
      {id:'demo1', name:'ASUS TUF A15', cat:'筆電', cost:22000, margin:0.12, market:25900, marketAdj:null, recycled:d, note:'RTX 4060', hasRepair:false, repairNote:'', selected:false},
      {id:'demo2', name:'MSI MPG A650GF', cat:'電源供應器', cost:1200, margin:0.20, market:null, marketAdj:null, recycled:d, note:'80+ Gold', hasRepair:false, repairNote:'', selected:false},
    ];
  }
  render();
})();
