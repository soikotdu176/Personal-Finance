const DB_NAME = 'AssetBookDB';
const DB_VERSION = 1;
let db;
let state = { records: [], categories: [], documents: [], settings: {}, backupHistory: [] };
let charts = {};
let editingRecordId = null;
let confirmAction = null;
let restoreFile = null;
let dashboardPage = 1;
let replacingDocumentId = null;

const defaultCategories = [
  {id:'c-cash',type:'Asset',name:'Cash',subcategories:['Savings Accounts','Cash in Hand']},
  {id:'c-investments',type:'Asset',name:'Investments',subcategories:['CPF','Group Insurance & Welfare Fund (GI&WF)','Other Investment / Co-operation']},
  {id:'c-property',type:'Asset',name:'Property',subcategories:['Land & Primary Residence','Vehicles','Jewelry','Other Property']},
  {id:'c-retirement',type:'Asset',name:'Retirement',subcategories:['Gratuity']},
  {id:'c-other-assets',type:'Asset',name:'Other Assets',subcategories:['Furniture, Electronics & Equipments','Accounts Receivable']},
  {id:'c-payable',type:'Liability',name:'Accounts Payable',subcategories:['Accounts Payable']},
  {id:'c-bank-loan',type:'Liability',name:'Bank Loan',subcategories:['Bank Loan']},
  {id:'c-other-liabilities',type:'Liability',name:'Other Liabilities',subcategories:['Other Liabilities']}
];

function openDB() {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(DB_NAME,DB_VERSION);
    request.onupgradeneeded=event=>{
      const database=event.target.result;
      if(!database.objectStoreNames.contains('records')) database.createObjectStore('records',{keyPath:'id'});
      if(!database.objectStoreNames.contains('categories')) database.createObjectStore('categories',{keyPath:'id'});
      if(!database.objectStoreNames.contains('documents')) database.createObjectStore('documents',{keyPath:'id'});
      if(!database.objectStoreNames.contains('settings')) database.createObjectStore('settings',{keyPath:'key'});
      if(!database.objectStoreNames.contains('backupHistory')) database.createObjectStore('backupHistory',{keyPath:'id'});
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}

function tx(store,mode='readonly'){
  return db.transaction(store,mode).objectStore(store);
}
function getAll(store){
  return new Promise((resolve,reject)=>{
    const request=tx(store).getAll();
    request.onsuccess=()=>resolve(request.result||[]);
    request.onerror=()=>reject(request.error);
  });
}
function put(store,value){
  return new Promise((resolve,reject)=>{
    const request=tx(store,'readwrite').put(value);
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}
function remove(store,key){
  return new Promise((resolve,reject)=>{
    const request=tx(store,'readwrite').delete(key);
    request.onsuccess=()=>resolve();
    request.onerror=()=>reject(request.error);
  });
}
function clearStore(store){
  return new Promise((resolve,reject)=>{
    const request=tx(store,'readwrite').clear();
    request.onsuccess=()=>resolve();
    request.onerror=()=>reject(request.error);
  });
}
const uid=prefix=>`${prefix}-${crypto.randomUUID ? crypto.randomUUID() : Date.now()+'-'+Math.random().toString(16).slice(2)}`;
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function init(){
  db=await openDB();
  let categories=await getAll('categories');
  if(!categories.length){
    for(const category of defaultCategories) await put('categories',category);
  }
  await loadState();
  const settings=await getAll('settings');
  state.settings=settings.reduce((out,item)=>(out[item.key]=item.value,out),{});
  state.settings.currency ||= 'BDT';
  state.settings.locale ||= 'en-BD';
  state.settings.incomeYears ||= ['2026-27','2025-26','2024-25','2023-24','2022-23'];
  bindNavigation();
  bindGlobalActions();
  renderAll();
}

async function loadState(){
  state.records=await getAll('records');
  state.categories=await getAll('categories');
  state.documents=await getAll('documents');
  state.backupHistory=await getAll('backupHistory');
}

function toast(message,error=false){
  const el=document.createElement('div');
  el.className='toast'+(error?' error':'');
  el.textContent=message;
  document.getElementById('toastRegion').appendChild(el);
  setTimeout(()=>el.remove(),3500);
}
function confirm(message,title='Confirm Action'){
  return new Promise(resolve=>{
    document.getElementById('confirmTitle').textContent=title;
    document.getElementById('confirmMessage').textContent=message;
    confirmAction=resolve;
    document.getElementById('confirmModal').showModal();
  });
}

function bindNavigation(){
  document.querySelectorAll('.nav-item').forEach(button=>{
    button.onclick=()=>{
      document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active'));
      button.classList.add('active');
      document.querySelectorAll('[data-page-panel]').forEach(p=>p.classList.add('hidden'));
      document.getElementById(button.dataset.page+'Page').classList.remove('hidden');
      const titles={dashboard:['Dashboard','Financial overview'],records:['Assets & Liabilities','Manage financial records'],balance:['Balance Sheet','Consolidated financial position'],backup:['Data Backup & Restore','Portable data management'],settings:['Settings','Application preferences']};
      document.getElementById('pageTitle').textContent=titles[button.dataset.page][0];
      document.getElementById('pageSubtitle').textContent=titles[button.dataset.page][1];
      document.getElementById('sidebar').classList.remove('open');
      if(button.dataset.page==='balance') renderBalance();
      if(button.dataset.page==='backup') renderBackupHistory();
      if(button.dataset.page==='settings') renderSettings();
    };
  });
  document.getElementById('menuToggle').onclick=()=>document.getElementById('sidebar').classList.toggle('open');
}

function bindGlobalActions(){
  document.getElementById('quickAdd').onclick=()=>openRecordModal();
  document.getElementById('addRecordBtn').onclick=()=>openRecordModal();
  document.getElementById('recordSearch').oninput=renderRecordSections;
  document.getElementById('recordTypeFilter').onchange=renderRecordSections;
  document.getElementById('dashboardSearch').oninput=()=>{dashboardPage=1;renderDashboardTable()};
  document.getElementById('exportFiltered').onclick=exportFilteredExcel;
  document.getElementById('printDashboard').onclick=()=>window.print();
  document.getElementById('printBalance').onclick=()=>window.print();
  document.getElementById('exportBalanceExcel').onclick=exportBalanceExcel;
  document.getElementById('balanceYear').onchange=renderBalance;
  document.getElementById('balanceMode').onchange=renderBalance;
  document.querySelectorAll('[data-close-modal]').forEach(button=>{
    button.onclick=()=>button.closest('dialog').close();
  });
  document.getElementById('confirmCancel').onclick=()=>{document.getElementById('confirmModal').close();if(confirmAction)confirmAction(false)};
  document.getElementById('confirmOk').onclick=()=>{document.getElementById('confirmModal').close();if(confirmAction)confirmAction(true)};
  document.getElementById('recordForm').onsubmit=saveRecord;
  document.getElementById('replaceDocumentFile').onchange=replaceDocumentFile;
  document.getElementById('createBackup').onclick=createBackup;
  document.getElementById('restoreBackup').onclick=()=>document.getElementById('restoreFile').click();
  document.getElementById('restoreFile').onchange=e=>{restoreFile=e.target.files[0];if(restoreFile)document.getElementById('restoreModal').showModal()};
  document.getElementById('confirmRestore').onclick=performRestore;
  document.getElementById('saveSettings').onclick=saveSettings;
  document.getElementById('addYear').onclick=addIncomeYear;
  document.getElementById('manageCategories').onclick=()=>openCategoryModal();
  document.getElementById('categoryForm').onsubmit=addCategory;
  document.getElementById('importExcel').onclick=()=>document.getElementById('excelImport').click();
  document.getElementById('excelImport').onchange=importExcel;
}

function renderAll(){
  renderDashboardFilters();
  renderDashboard();
  renderRecordSections();
  renderSettings();
  renderBackupHistory();
  renderBalance();
}

function getCurrencySymbol(){
  return {BDT:'৳',USD:'$',EUR:'€',GBP:'£'}[state.settings.currency||'BDT']||'৳';
}
function formatMoney(value){
  const number=Number(value)||0;
  const locale=state.settings.locale||'en-BD';
  return `${getCurrencySymbol()}${number.toLocaleString(locale,{minimumFractionDigits:2,maximumFractionDigits:2})}`;
}
function recordAmount(record){
  if(!record)return 0;
  return Number(record.amount ?? record.balance ?? record.currentMarketValue ?? record.outstandingBalance ?? record.purchaseValue ?? 0);
}

const dashFilters={type:'',category:'',subcategory:'',year:'',from:'',to:''};

function dashCategoryNames(type){
  return state.categories
    .filter(c=>!type||c.type===type)
    .map(c=>c.name)
    .filter((v,i,a)=>a.indexOf(v)===i);
}
function dashSubcategoryNames(type,category){
  return state.categories
    .filter(c=>(!type||c.type===type)&&(!category||c.name===category))
    .flatMap(c=>c.subcategories||[])
    .filter((v,i,a)=>a.indexOf(v)===i);
}
function dashYearOptions(){
  return [...new Set([...(state.settings.incomeYears||[]),...state.records.map(r=>String(r.incomeYear||'')).filter(Boolean)])]
    .sort((a,b)=>String(b).localeCompare(String(a)));
}

function renderDashboardFilters(){
  const host=document.getElementById('dashboardFilters');
  const categories=dashCategoryNames(dashFilters.type);
  if(!categories.includes(dashFilters.category)) dashFilters.category='';
  const subcategories=dashSubcategoryNames(dashFilters.type,dashFilters.category);
  if(!subcategories.includes(dashFilters.subcategory)) dashFilters.subcategory='';
  const years=dashYearOptions();
  if(!years.includes(dashFilters.year)) dashFilters.year='';
  const option=(value,label,selected,disabled=false)=>`<option value="${esc(value)}" ${selected?'selected':''} ${disabled?'disabled':''}>${esc(label)}</option>`;

  host.innerHTML=`<div class="filter-row">
    <select id="dashType">${option('','All Financial Types',!dashFilters.type)}${option('Asset','Assets',dashFilters.type==='Asset')}${option('Liability','Liabilities',dashFilters.type==='Liability')}</select>
    <select id="dashCategory" ${categories.length?'':'disabled'}>${option('',dashFilters.type?'All '+dashFilters.type+' Categories':'All Categories',!dashFilters.category)}${categories.map(c=>option(c,c,dashFilters.category===c)).join('')}</select>
    <select id="dashSubcategory" ${subcategories.length?'':'disabled'}>${option('','All Subcategories',!dashFilters.subcategory)}${subcategories.map(s=>option(s,s,dashFilters.subcategory===s)).join('')}</select>
    <select id="dashYear">${option('','All Income Years',!dashFilters.year)}${years.map(y=>option(y,y,dashFilters.year===y)).join('')}</select>
    <input id="dashDateFrom" type="date" aria-label="Date from" value="${esc(dashFilters.from)}">
    <input id="dashDateTo" type="date" aria-label="Date to" value="${esc(dashFilters.to)}">
  </div>`;

  const rerender=()=>{dashboardPage=1;renderDashboardFilters();renderDashboard()};
  const bind=(id,key,followUp)=>{
    const el=document.getElementById(id);
    el.onchange=()=>{dashFilters[key]=el.value;if(followUp){followUp();rerender()}else{dashboardPage=1;renderDashboard()}};
  };
  bind('dashType','type',()=>{dashFilters.category='';dashFilters.subcategory=''});
  bind('dashCategory','category',()=>{dashFilters.subcategory=''});
  bind('dashSubcategory','subcategory');
  bind('dashYear','year');
  bind('dashDateFrom','from');
  bind('dashDateTo','to');
}

function getFilteredRecords(){
  let records=[...state.records];
  const type=dashFilters.type;
  const category=dashFilters.category;
  const subcategory=dashFilters.subcategory;
  const year=dashFilters.year;
  const from=dashFilters.from;
  const to=dashFilters.to;
  if(type) records=records.filter(r=>r.type===type);
  if(category) records=records.filter(r=>r.category===category);
  if(subcategory) records=records.filter(r=>r.subcategory===subcategory);
  if(year) records=records.filter(r=>String(r.incomeYear||'')===year);
  if(from) records=records.filter(r=>r.date>=from);
  if(to) records=records.filter(r=>r.date<=to);
  return records;
}

function renderDashboard(){
  const records=getFilteredRecords();
  const assets=records.filter(r=>r.type==='Asset').reduce((sum,r)=>sum+recordAmount(r),0);
  const liabilities=records.filter(r=>r.type==='Liability').reduce((sum,r)=>sum+recordAmount(r),0);
  const assetCategories=new Set(records.filter(r=>r.type==='Asset').map(r=>r.category)).size;
  const liabilityCategories=new Set(records.filter(r=>r.type==='Liability').map(r=>r.category)).size;
  const documentCount=new Set(records.flatMap(r=>r.documentIds||[])).size;
  const cards=[
    ['▰','Total Assets',assets],['▱','Total Liabilities',liabilities],['◆','Net Worth',assets-liabilities],
    ['▦','Asset Categories',assetCategories],['▦','Liability Categories',liabilityCategories],['▤','PDF Documents',documentCount]
  ];
  document.getElementById('summaryCards').innerHTML=cards.map((c,i)=>`<div class="summary-card"><div class="summary-icon">${c[0]}</div><div><p>${c[1]}</p><strong>${i>=3?c[2]:formatMoney(c[2])}</strong></div></div>`).join('');
  renderCharts(records);
  renderDashboardTable();
}

function destroyChart(id){if(charts[id]){charts[id].destroy();delete charts[id]}}
function renderCharts(records){
  const assets=records.filter(r=>r.type==='Asset').reduce((sum,r)=>sum+recordAmount(r),0);
  const liabilities=records.filter(r=>r.type==='Liability').reduce((sum,r)=>sum+recordAmount(r),0);
  destroyChart('comparisonChart');destroyChart('assetsChart');destroyChart('liabilitiesChart');destroyChart('netWorthChart');
  if(!window.Chart)return;
  charts.comparisonChart=new Chart(document.getElementById('comparisonChart'),{type:'doughnut',data:{labels:['Assets','Liabilities'],datasets:[{data:[assets,liabilities],backgroundColor:['#24a77a','#e66a47']}]},options:{maintainAspectRatio:false,plugins:{legend:{position:'bottom'}}}});
  const group=(type)=>Object.entries(records.filter(r=>r.type===type).reduce((out,r)=>{out[r.category]=(out[r.category]||0)+recordAmount(r);return out},{}));
  const assetsGroup=group('Asset'),liabilitiesGroup=group('Liability');
  charts.assetsChart=new Chart(document.getElementById('assetsChart'),{type:'bar',data:{labels:assetsGroup.map(x=>x[0]),datasets:[{data:assetsGroup.map(x=>x[1]),backgroundColor:'#2f6fed'}]},options:{maintainAspectRatio:false,plugins:{legend:{display:false}}}});
  charts.liabilitiesChart=new Chart(document.getElementById('liabilitiesChart'),{type:'pie',data:{labels:liabilitiesGroup.map(x=>x[0]),datasets:[{data:liabilitiesGroup.map(x=>x[1]),backgroundColor:['#e66a47','#f3b562','#7d8da6','#4b8fbd']}]},options:{maintainAspectRatio:false,plugins:{legend:{position:'bottom'}}}});
  const byYear=[...new Set(records.map(r=>String(r.incomeYear||'')).filter(Boolean))].sort();
  const trend=byYear.map(year=>{const yearRecords=records.filter(r=>String(r.incomeYear||'')===year);const a=yearRecords.filter(r=>r.type==='Asset').reduce((s,r)=>s+recordAmount(r),0);const l=yearRecords.filter(r=>r.type==='Liability').reduce((s,r)=>s+recordAmount(r),0);return a-l});
  charts.netWorthChart=new Chart(document.getElementById('netWorthChart'),{type:'line',data:{labels:byYear,datasets:[{label:'Net Worth',data:trend,borderColor:'#24a77a',backgroundColor:'rgba(36,167,122,.12)',fill:true,tension:.3}]},options:{maintainAspectRatio:false,plugins:{legend:{display:false}}}});
}

function renderDashboardTable(){
  let records=getFilteredRecords();
  const search=document.getElementById('dashboardSearch').value.toLowerCase();
  if(search) records=records.filter(r=>Object.values(r).some(v=>String(v).toLowerCase().includes(search)));
  const sortField='date';
  records.sort((a,b)=>String(b[sortField]||'').localeCompare(String(a[sortField]||'')));
  const pageSize=10, pages=Math.max(1,Math.ceil(records.length/pageSize));
  dashboardPage=Math.min(dashboardPage,pages);
  const pageRecords=records.slice((dashboardPage-1)*pageSize,dashboardPage*pageSize);
  document.getElementById('recordCount').textContent=`${records.length} record${records.length===1?'':'s'} found`;
  document.getElementById('dashboardTable').innerHTML=`<thead><tr><th>Type</th><th>Category</th><th>Subcategory</th><th>Particulars</th><th>Details</th><th>Income Year</th><th>Balance / Amount</th><th>Documents</th><th>Action</th></tr></thead><tbody>${pageRecords.map(r=>`<tr><td><span class="badge ${r.type.toLowerCase()}">${r.type}</span></td><td>${esc(r.category)}</td><td>${esc(r.subcategory)}</td><td>${esc(r.particulars||r.name||'—')}</td><td>${esc(r.details||'—')}</td><td>${esc(r.incomeYear||'—')}</td><td><strong>${formatMoney(recordAmount(r))}</strong></td><td>${(r.documentIds||[]).length}</td><td><button class="action-link" onclick="viewRecord('${r.id}')">View</button><button class="action-link" onclick="openRecordModal('${r.id}')">Edit</button><button class="action-link danger" onclick="deleteRecord('${r.id}')">Delete</button></td></tr>`).join('')||'<tr><td colspan="9"><div class="empty-state">No financial records match these filters.</div></td></tr>'}</tbody>`;
  document.getElementById('dashboardPagination').innerHTML=Array.from({length:pages},(_,i)=>`<button class="${i+1===dashboardPage?'active':''}" onclick="dashboardPage=${i+1};renderDashboardTable()">${i+1}</button>`).join('');
}

function openRecordModal(id=null){
  editingRecordId=id;
  document.querySelector('#recordForm .modal-foot').innerHTML='<button type="button" class="btn" data-close-modal>Cancel</button><button type="submit" class="btn btn-primary">Save Record</button>';
  document.querySelectorAll('#recordForm [data-close-modal]').forEach(button=>button.onclick=()=>document.getElementById('recordModal').close());
  const record=id?state.records.find(r=>r.id===id):null;
  document.getElementById('recordModalTitle').textContent=record?'Edit Financial Record':'Add Financial Record';
  document.getElementById('recordModalSubtitle').textContent=record?`${record.category} / ${record.subcategory}`:'Enter the financial record details';
  const categoryOptions=state.categories.map(c=>`<option value="${esc(c.name)}" data-type="${esc(c.type)}">${esc(c.name)}</option>`).join('');
  document.getElementById('recordFormFields').innerHTML=`<div class="form-grid">
    <label>Financial Type<select id="recordType" required><option value="Asset" ${record?.type==='Asset'?'selected':''}>Asset</option><option value="Liability" ${record?.type==='Liability'?'selected':''}>Liability</option></select></label>
    <label>Category<select id="recordCategory" required>${categoryOptions}</select></label>
    <label>Subcategory<select id="recordSubcategory" required></select></label>
    <label>Date<input id="recordDate" type="date" value="${esc(record?.date||new Date().toISOString().slice(0,10))}"></label>
    <label>Particulars / Name<input id="recordParticulars" value="${esc(record?.particulars||record?.name||'')}" required></label>
    <label>Income Year<select id="recordIncomeYear">${(state.settings.incomeYears||[]).map(y=>`<option ${String(record?.incomeYear||new Date().getFullYear())===String(y)?'selected':''}>${esc(y)}</option>`).join('')}</select></label>
    <label class="full">Details / Description<textarea id="recordDetails" rows="3">${esc(record?.details||record?.description||'')}</textarea></label>
    <label>Amount / Balance<input id="recordAmount" type="number" step="0.01" value="${esc(recordAmount(record)||'')}"></label>
    <label>Purchase Value<input id="recordPurchaseValue" type="number" step="0.01" value="${esc(record?.purchaseValue||'')}"></label>
    <label>Current Market Value<input id="recordMarketValue" type="number" step="0.01" value="${esc(record?.currentMarketValue||'')}"></label>
    <label>Quantity / Area<input id="recordQuantity" value="${esc(record?.quantity||record?.area||'')}"></label>
    <label>Remarks / Other Details<textarea id="recordRemarks" rows="2">${esc(record?.remarks||'')}</textarea></label>
    <label>Document (PDF)<input id="recordDocument" type="file" accept=".pdf,application/pdf"></label>
  </div>`;
  const typeSelect=document.getElementById('recordType'),categorySelect=document.getElementById('recordCategory'),subSelect=document.getElementById('recordSubcategory');
  if(record){typeSelect.value=record.type;categorySelect.value=record.category}
  const updateCategories=()=>{
    const filtered=state.categories.filter(c=>c.type===typeSelect.value);
    categorySelect.innerHTML=filtered.map(c=>`<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
    if(record&&filtered.some(c=>c.name===record.category))categorySelect.value=record.category;
    updateSubcategories();
  };
  const updateSubcategories=()=>{
    const category=state.categories.find(c=>c.type===typeSelect.value&&c.name===categorySelect.value);
    subSelect.innerHTML=(category?.subcategories||[]).map(s=>`<option ${record?.subcategory===s?'selected':''}>${esc(s)}</option>`).join('');
  };
  typeSelect.onchange=updateCategories;categorySelect.onchange=updateSubcategories;
  updateCategories();
  document.getElementById('recordModal').showModal();
}

async function saveRecord(event){
  event.preventDefault();
  const record={
    id:editingRecordId||uid('record'),
    type:document.getElementById('recordType').value,
    category:document.getElementById('recordCategory').value,
    subcategory:document.getElementById('recordSubcategory').value,
    date:document.getElementById('recordDate').value,
    particulars:document.getElementById('recordParticulars').value.trim(),
    incomeYear:document.getElementById('recordIncomeYear').value,
    details:document.getElementById('recordDetails').value.trim(),
    amount:Number(document.getElementById('recordAmount').value||0),
    balance:Number(document.getElementById('recordAmount').value||0),
    purchaseValue:Number(document.getElementById('recordPurchaseValue').value||0),
    currentMarketValue:Number(document.getElementById('recordMarketValue').value||0),
    quantity:document.getElementById('recordQuantity').value.trim(),
    remarks:document.getElementById('recordRemarks').value.trim(),
    documentIds:editingRecordId?(state.records.find(r=>r.id===editingRecordId)?.documentIds||[]):[],
    updatedAt:new Date().toISOString()
  };
  const fileInput = document.getElementById('recordDocument');
  if (fileInput.files.length > 0) {
      const file = fileInput.files[0];
      const docId = uid('doc');
      const documentRecord = {
          id: docId,
          recordId: record.id,
          title: file.name,
          name: file.name,
          type: file.type || 'application/pdf',
          size: file.size,
          blob: file,
          category: record.category,
          subcategory: record.subcategory,
          financialType: record.type,
          incomeYear: record.incomeYear,
          createdAt: new Date().toISOString()
      };
      await put('documents', documentRecord);
      record.documentIds.push(docId);
  }

  await put('records',record);
  await loadState();
  document.getElementById('recordModal').close();
  editingRecordId=null;
  renderAll();
  toast(record.id?'Record saved successfully':'Record created successfully');
}

async function deleteRecord(id){
  if(await confirm('Delete this financial record? Any linked document relationships will also be removed.','Delete Record')){
    const record=state.records.find(r=>r.id===id);
    for(const documentId of record?.documentIds||[]) await remove('documents',documentId);
    await remove('records',id);
    await loadState();renderAll();toast('Record deleted');
  }
}
function viewRecord(id){
  const r=state.records.find(x=>x.id===id);if(!r)return;
  document.getElementById('recordModalTitle').textContent=r.particulars||r.name||'Financial Record';
  document.getElementById('recordModalSubtitle').textContent=`${r.category} / ${r.subcategory}`;
  const documents=(r.documentIds||[])
    .map(documentId=>state.documents.find(doc=>doc.id===documentId))
    .filter(Boolean);
  const documentSection=documents.length?`
    <label class="full document-view-section">Attached PDF Documents
      <div class="document-view-list">${documents.map(doc=>`
        <div class="document-view-item">
          <div class="document-info">
            <strong>${esc(doc.name||doc.title||'document.pdf')}</strong>
            <span>${formatFileSize(doc.size)}</span>
          </div>
          <div class="document-actions">
            <button type="button" class="btn" onclick="previewDocument('${esc(doc.id)}')">View PDF</button>
            <button type="button" class="btn btn-primary" onclick="downloadDocument('${esc(doc.id)}')">Download</button>
          </div>
        </div>`).join('')}
      </div>
    </label>`:'';
  document.getElementById('recordFormFields').innerHTML=`<div class="form-grid">
    <label>Type<strong>${esc(r.type)}</strong></label><label>Date<strong>${esc(r.date||'—')}</strong></label>
    <label>Income Year<strong>${esc(r.incomeYear||'—')}</strong></label><label>Amount / Balance<strong>${formatMoney(recordAmount(r))}</strong></label>
    <label class="full">Details<strong>${esc(r.details||r.description||'—')}</strong></label>
    <label>Purchase Value<strong>${r.purchaseValue?formatMoney(r.purchaseValue):'—'}</strong></label><label>Current Market Value<strong>${r.currentMarketValue?formatMoney(r.currentMarketValue):'—'}</strong></label>
    <label class="full">Remarks<strong>${esc(r.remarks||'—')}</strong></label>
    ${documentSection}
  </div>`;
  document.querySelector('#recordForm .modal-foot').innerHTML='<button type="button" class="btn" data-close-modal>Close</button>';
  document.getElementById('recordModal').showModal();
  document.querySelector('#recordModal [data-close-modal]').onclick=()=>document.getElementById('recordModal').close();
}

function renderRecordSections(){
  const search=(document.getElementById('recordSearch')?.value||'').toLowerCase();
  const type=document.getElementById('recordTypeFilter')?.value||'';
  let records=state.records.filter(r=>!search||Object.values(r).some(v=>String(v).toLowerCase().includes(search)));
  if(type)records=records.filter(r=>r.type===type);
  const render=(items)=>items.map(r=>`<div class="record-item"><div><h4>${esc(r.particulars||r.name||'Unnamed Record')}</h4><p>${esc(r.category)} · ${esc(r.subcategory)} · ${esc(r.incomeYear||'')}</p></div><div class="record-amount"><strong>${formatMoney(recordAmount(r))}</strong><p>${esc(r.date||'')}</p></div><div class="record-actions"><button class="action-link" onclick="viewRecord('${r.id}')">View</button><button class="action-link" onclick="openRecordModal('${r.id}')">Edit</button><button class="action-link danger" onclick="deleteRecord('${r.id}')">Delete</button></div></div>`).join('');
  const assets=records.filter(r=>r.type==='Asset'),liabilities=records.filter(r=>r.type==='Liability');
  document.getElementById('assetRecordCount').textContent=`${assets.length} records`;
  document.getElementById('liabilityRecordCount').textContent=`${liabilities.length} records`;
  document.getElementById('assetList').innerHTML=render(assets)||'<div class="empty-state">No asset records.</div>';
  document.getElementById('liabilityList').innerHTML=render(liabilities)||'<div class="empty-state">No liability records.</div>';
}

function renderBalance(){
  const yearSelect=document.getElementById('balanceYear');
  const years=[...new Set([...(state.settings.incomeYears||[]),...state.records.map(r=>r.incomeYear).filter(Boolean)])].sort((a,b)=>String(b).localeCompare(String(a)));
  const current=yearSelect.value||years[0]||String(new Date().getFullYear());
  yearSelect.innerHTML=`<option value="">All Years</option>${years.map(y=>`<option ${String(y)==String(current)?'selected':''}>${esc(y)}</option>`).join('')}`;
  const mode=document.getElementById('balanceMode')?.value||'current';
  let records=state.records.filter(r=>r.type==='Asset'||r.type==='Liability');
  if(current&&mode==='historical')records=records.filter(r=>String(r.incomeYear||'')===String(current));
  if(current&&mode==='comparative') {
    const years = state.settings.incomeYears || [];
    const currentIndex = years.indexOf(String(current));
    const previousYear = currentIndex !== -1 && currentIndex < years.length - 1 ? years[currentIndex + 1] : '';
    records=records.filter(r=>String(r.incomeYear||'')===String(current)||String(r.incomeYear||'')===previousYear);
  }

  const sheetMap={Asset:{},Liability:{}};
  for(const record of records){
    sheetMap[record.type][record.category]=(sheetMap[record.type][record.category]||0)+recordAmount(record);
  }
  const assetCategories=['Cash','Investments','Property','Retirement','Other Assets'];
  const liabilityCategories=['Accounts Payable','Bank Loan','Other Liabilities'];
  const categoryNames=(type)=>state.categories.filter(c=>c.type===type).map(c=>c.name).filter((v,i,a)=>a.indexOf(v)===i);
  const assetNames=categoryNames('Asset'),liabilityNames=categoryNames('Liability');
  const totalAsset=Object.entries(sheetMap.Asset).reduce((s,[,v])=>s+v,0);
  const totalLiability=Object.entries(sheetMap.Liability).reduce((s,[,v])=>s+v,0);
  const renderSection=(title,names,map)=>{
    const rows=names.map(name=>`<tr><td>${esc(name)}</td><td>${formatMoney(map[name]||0)}</td></tr>`).join('');
    return `<table class="balance-table"><tbody><tr class="total"><td>${esc(title)}</td><td></td></tr>${rows}<tr class="total"><td>Total ${esc(title)}</td><td>${formatMoney(names.reduce((s,n)=>s+(map[n]||0),0))}</td></tr></tbody></table>`;
  };
  document.getElementById('balanceSheet').innerHTML=`<div class="balance-header"><h2>Personal Balance Sheet</h2><p>${current?esc(current):'All Income Years'} · ${esc(mode==='comparative'?'Comparative':mode==='historical'?'Historical':'Current')} Balance Sheet</p></div>
    ${renderSection('ASSETS',assetNames.length?assetNames:assetCategories,sheetMap.Asset)}
    ${renderSection('LIABILITIES',liabilityNames.length?liabilityNames:liabilityCategories,sheetMap.Liability)}
    <table class="balance-table"><tbody><tr class="total"><td>NET WORTH</td><td>${formatMoney(totalAsset-totalLiability)}</td></tr></tbody></table>`;
}

function openDocumentModal(){
  document.getElementById('documentRecord').innerHTML=state.records.map(r=>`<option value="${esc(r.id)}">${esc(r.particulars||r.name||'Unnamed')} · ${esc(r.category)} · ${esc(r.subcategory)}</option>`).join('');
  document.getElementById('documentDate').value=new Date().toISOString().slice(0,10);
  document.getElementById('documentModal').showModal();
}

function formatFileSize(bytes){
  if(!bytes)return '0 B';
  const units=['B','KB','MB','GB'];const i=Math.min(Math.floor(Math.log(bytes)/Math.log(1024)),units.length-1);
  return `${(bytes/Math.pow(1024,i)).toFixed(i?1:0)} ${units[i]}`;
}
function previewDocument(id){
  const doc=state.documents.find(d=>d.id===id);if(!doc)return;
  const url=URL.createObjectURL(doc.blob);
  window.open(url,'_blank','noopener');
  setTimeout(()=>URL.revokeObjectURL(url),60000);
}
function downloadDocument(id){
  const doc=state.documents.find(d=>d.id===id);if(!doc)return;
  const url=URL.createObjectURL(doc.blob);
  const link=document.createElement('a');link.href=url;link.download=doc.name||`${doc.title||'document'}.pdf`;link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function replaceDocument(id){
  replacingDocumentId=id;
  document.getElementById('replaceDocumentFile').click();
}
async function replaceDocumentFile(event){
  const file=event.target.files[0];if(!file||!replacingDocumentId)return;
  if(file.type!=='application/pdf'&&!file.name.toLowerCase().endsWith('.pdf')){
    toast('Please select a PDF file.',true);event.target.value='';return;
  }
  const documentRecord=state.documents.find(d=>d.id===replacingDocumentId);
  if(!documentRecord)return;
  documentRecord.blob=file;
  documentRecord.name=file.name;
  documentRecord.type=file.type||'application/pdf';
  documentRecord.size=file.size;
  documentRecord.updatedAt=new Date().toISOString();
  await put('documents',documentRecord);
  replacingDocumentId=null;
  event.target.value='';
  await loadState();renderAll();toast('PDF document replaced');
}
async function deleteDocument(id){
  if(await confirm('Delete this PDF document and remove it from the linked record?','Delete PDF')){
    const doc=state.documents.find(d=>d.id===id);
    const record=state.records.find(r=>r.id===doc?.recordId);
    if(record){record.documentIds=(record.documentIds||[]).filter(x=>x!==id);await put('records',record)}
    await remove('documents',id);await loadState();renderAll();toast('Document deleted');
  }
}

function openCategoryModal(){
  document.getElementById('categoryModal').showModal();
  renderCategoryTree();
}
function renderCategoryTree(){
  document.getElementById('categoryTree').innerHTML=state.categories.map(c=>`<div class="category-group"><strong>${esc(c.type)} · ${esc(c.name)} <button class="action-link" onclick="renameCategory('${c.id}')">Edit</button></strong>${c.subcategories.map(s=>`<span>${esc(s)} <button class="action-link" onclick="renameSubcategory('${c.id}','${esc(s)}')">Edit</button> <button class="action-link danger" onclick="deleteSubcategory('${c.id}','${esc(s)}')">×</button></span>`).join('')}<button class="action-link danger" onclick="deleteCategory('${c.id}')">Delete Category</button></div>`).join('');
}
async function addCategory(event){
  event.preventDefault();
  const type=document.getElementById('categoryType').value;
  const name=document.getElementById('categoryName').value.trim();
  const subcategory=document.getElementById('subcategoryName').value.trim();
  if(!name||!subcategory)return;
  let category=state.categories.find(c=>c.type===type&&c.name===name);
  if(category){
    if(!category.subcategories.includes(subcategory))category.subcategories.push(subcategory);
  }else{
    category={id:uid('category'),type,name,subcategories:[subcategory]};
  }
  await put('categories',category);await loadState();
  document.getElementById('categoryForm').reset();
  renderCategoryTree();renderDashboardFilters();renderAll();toast('Category structure updated');
}
async function deleteCategory(id){
  const category=state.categories.find(c=>c.id===id);
  const linked=state.records.some(r=>r.category===category?.name);
  if(linked){toast('This category has linked records and cannot be deleted.',true);return}
  if(await confirm(`Delete category "${category?.name}" and all of its subcategories?`,`Delete Category`)){
    await remove('categories',id);await loadState();renderCategoryTree();renderAll();toast('Category deleted');
  }
}

async function renameCategory(id){
  const category=state.categories.find(c=>c.id===id);if(!category)return;
  const name=prompt('Edit category name:',category.name);
  if(!name||name.trim()===category.name)return;
  const newName=name.trim();
  const linked=state.records.filter(r=>r.category===category.name);
  category.name=newName;
  await put('categories',category);
  for(const record of linked){record.category=newName;await put('records',record)}
  await loadState();renderCategoryTree();renderAll();toast('Category renamed');
}
async function renameSubcategory(categoryId,oldName){
  const category=state.categories.find(c=>c.id===categoryId);if(!category)return;
  const name=prompt('Edit subcategory name:',oldName);
  if(!name||name.trim()===oldName)return;
  const newName=name.trim();
  category.subcategories=category.subcategories.map(s=>s===oldName?newName:s);
  await put('categories',category);
  const linked=state.records.filter(r=>r.category===category.name&&r.subcategory===oldName);
  for(const record of linked){record.subcategory=newName;await put('records',record)}
  await loadState();renderCategoryTree();renderAll();toast('Subcategory renamed');
}
async function deleteSubcategory(categoryId,name){
  const category=state.categories.find(c=>c.id===categoryId);if(!category)return;
  const linked=state.records.some(r=>r.category===category.name&&r.subcategory===name);
  if(linked){toast('This subcategory has linked records and cannot be deleted.',true);return}
  if(await confirm(`Delete subcategory "${name}"?`,`Delete Subcategory`)){
    category.subcategories=category.subcategories.filter(s=>s!==name);
    await put('categories',category);await loadState();renderCategoryTree();renderAll();toast('Subcategory deleted');
  }
}

function renderSettings(){
  document.getElementById('currencySetting').value=state.settings.currency||'BDT';
  document.getElementById('localeSetting').value=state.settings.locale||'en-BD';
  renderYearList();
}
function renderYearList(){
  document.getElementById('yearList').innerHTML=(state.settings.incomeYears||[]).map(y=>`<span class="chip">${esc(y)} <button class="action-link danger" onclick="deleteIncomeYear('${esc(y)}')">×</button></span>`).join('');
}
async function saveSettings(){
  state.settings.currency=document.getElementById('currencySetting').value;
  state.settings.locale=document.getElementById('localeSetting').value;
  await put('settings',{key:'currency',value:state.settings.currency});
  await put('settings',{key:'locale',value:state.settings.locale});
  await put('settings',{key:'incomeYears',value:state.settings.incomeYears||[]});
  renderAll();toast('Settings saved');
}
async function addIncomeYear(){
  const year=document.getElementById('newYear').value.trim();
  if(!year)return;
  state.settings.incomeYears=[...new Set([...(state.settings.incomeYears||[]),year])].sort((a,b)=>String(b).localeCompare(String(a)));
  await put('settings',{key:'incomeYears',value:state.settings.incomeYears});
  document.getElementById('newYear').value='';
  renderSettings();renderDashboardFilters();toast('Income year added');
}
async function deleteIncomeYear(year){
  if(await confirm(`Delete income year ${year}?`,'Delete Income Year')){
    state.settings.incomeYears=(state.settings.incomeYears||[]).filter(y=>String(y)!==String(year));
    await put('settings',{key:'incomeYears',value:state.settings.incomeYears});
    renderSettings();renderDashboardFilters();toast('Income year deleted');
  }
}

async function createBackup(){
  if(!window.JSZip){toast('ZIP library is unavailable. Check your internet connection.',true);return}
  await loadState();
  const settings=await getAll('settings');
  const zip=new JSZip();
  const backup={
    records:state.records,
    categories:state.categories,
    documents:state.documents.map(({blob,...doc})=>doc),
    settings:settings.reduce((out,s)=>(out[s.key]=s.value,out),{}),
    backupDate:new Date().toISOString(),
    version:'1.0'
  };
  zip.file('backup.json',JSON.stringify(backup,null,2));
  zip.file('metadata.json',JSON.stringify({name:'Personal Assets & Liabilities Management System',version:'1.0',database:DB_NAME,createdAt:backup.backupDate,records:state.records.length,documents:state.documents.length},null,2));
  const folder=zip.folder('documents');
  for(const document of state.documents){
    if(document.blob)await folder.file(`${document.financialType==='Liability'?'liabilities':'assets'}/${document.id}-${document.name||'document.pdf'}`,document.blob);
  }
  const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE'});
  const timestamp=new Date().toISOString().replace(/[:.]/g,'-');
  const fileName=`AssetBook-Backup-${timestamp}.zip`;
  const history={id:uid('backup'),date:backup.backupDate,fileName,size:blob.size,recordCount:state.records.length,documentCount:state.documents.length,blob};
  await put('backupHistory',history);
  await loadState();
  const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=fileName;link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  renderBackupHistory();
  toast('Full backup created and downloaded');
}
function renderBackupHistory(){
  document.getElementById('backupTable').innerHTML=`<thead><tr><th>Backup Date</th><th>File Name</th><th>Records</th><th>Documents</th><th>File Size</th><th>Action</th></tr></thead><tbody>${state.backupHistory.slice().sort((a,b)=>String(b.date).localeCompare(String(a.date))).map(b=>`<tr><td>${esc(new Date(b.date).toLocaleString())}</td><td>${esc(b.fileName)}</td><td>${b.recordCount||0}</td><td>${b.documentCount||0}</td><td>${formatFileSize(b.size)}</td><td>${b.blob?`<button class="action-link" onclick="downloadBackup('${b.id}')">Download</button>`:'<span>File unavailable</span>'}</td></tr>`).join('')||'<tr><td colspan="6"><div class="empty-state">No backups created in this browser yet.</div></td></tr>'}</tbody>`;
}
function downloadBackup(id){
  const backup=state.backupHistory.find(b=>b.id===id);if(!backup?.blob)return;
  const url=URL.createObjectURL(backup.blob);const link=document.createElement('a');link.href=url;link.download=backup.fileName;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function performRestore(){
  if(!restoreFile)return;
  const mode=document.querySelector('input[name="restoreMode"]:checked')?.value||'replace';
  document.getElementById('restoreModal').close();
  if(!window.JSZip){toast('ZIP library is unavailable.',true);return}
  try{
    const zip=await JSZip.loadAsync(restoreFile);
    const backupFile=zip.file('backup.json');if(!backupFile)throw new Error('Missing backup.json');
    const backup=JSON.parse(await backupFile.async('text'));
    if(!backup.records||!backup.categories||backup.version!==undefined&&Number.parseFloat(backup.version)<1)throw new Error('Unsupported or invalid backup format');
    const documentFiles=Object.keys(zip.files).filter(p=>p.startsWith('documents/')&&!zip.files[p].dir);
    const blobs={};
    for(const path of documentFiles){
      const fileName=path.split('/').pop();
      const id=fileName.split('-')[0];
      const actualId=`doc-${fileName.split('-').slice(1).join('-')}`.includes('-')?null:null;
      const entry=backup.documents.find(d=>path.includes(d.id));
      if(entry)blobs[entry.id]=await zip.files[path].async('blob');
    }

    if(mode==='replace'){
      for(const store of ['records','categories','documents','settings'])await clearStore(store);
    }
    for(const category of backup.categories||[]){
      if(mode==='merge'){
        const existing=await tx('categories').get(category.id);
        await new Promise(resolve=>{existing.onsuccess=async()=>{if(!existing.result)await put('categories',category);resolve()};existing.onerror=()=>resolve()});
      }else await put('categories',category);
    }
    for(const record of backup.records||[]){
      if(mode==='merge'){
        const request=tx('records').get(record.id);
        await new Promise(resolve=>{request.onsuccess=()=>{if(!request.result)put('records',record).then(resolve);else resolve()};request.onerror=()=>resolve()});
      }else await put('records',record);
    }
    for(const document of backup.documents||[]){
      const blob=blobs[document.id];
      if(blob)document.blob=new Blob([blob],{type:document.type||'application/pdf'});
      if(mode==='merge'){
        const request=tx('documents').get(document.id);
        await new Promise(resolve=>{request.onsuccess=()=>{if(!request.result&&blob)put('documents',document).then(resolve);else resolve()};request.onerror=()=>resolve()});
      }else if(blob)await put('documents',document);
    }
    for(const [key,value] of Object.entries(backup.settings||{}))await put('settings',{key,value});
    await loadState();
    state.settings=(await getAll('settings')).reduce((out,s)=>(out[s.key]=s.value,out),state.settings||{});
    renderAll();
    toast(`Backup restored successfully: ${backup.records?.length||0} records and ${backup.documents?.length||0} documents`);
  }catch(error){
    console.error(error);toast(error.message||'Unable to restore backup.',true);
  }finally{
    restoreFile=null;document.getElementById('restoreFile').value='';
  }
}

function exportFilteredExcel(){
  if(!window.XLSX){toast('Excel library is unavailable. Check your internet connection.',true);return}
  const records=getFilteredRecords();
  const rows=records.map(r=>({
    Type:r.type,Category:r.category,Subcategory:r.subcategory,Date:r.date||'',Particulars:r.particulars||r.name||'',
    Details:r.details||r.description||'', 'Income Year':r.incomeYear||'',
    'Purchase Value':Number(r.purchaseValue||0),'Current Market Value':Number(r.currentMarketValue||0),
    'Amount / Balance':recordAmount(r),Remarks:r.remarks||'',Documents:(r.documentIds||[]).length
  }));
  const workbook=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook,XLSX.utils.json_to_sheet(rows),'Filtered Records');
  XLSX.writeFile(workbook,`Financial-Records-${new Date().toISOString().slice(0,10)}.xlsx`);
  toast('Excel report exported');
}
function exportBalanceExcel(){
  if(!window.XLSX){toast('Excel library is unavailable.',true);return}
  const year=document.getElementById('balanceYear').value;
  let records=state.records.filter(r=>!year||String(r.incomeYear||'')===String(year));
  const assetRows=records.filter(r=>r.type==='Asset').map(r=>({Category:r.category,Subcategory:r.subcategory,Particulars:r.particulars||r.name||'',Balance:recordAmount(r)}));
  const liabilityRows=records.filter(r=>r.type==='Liability').map(r=>({Category:r.category,Subcategory:r.subcategory,Particulars:r.particulars||r.name||'',Balance:recordAmount(r)}));
  const assets=assetRows.reduce((s,r)=>s+Number(r.Balance||0),0),liabilities=liabilityRows.reduce((s,r)=>s+Number(r.Balance||0),0);
  const workbook=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook,XLSX.utils.json_to_sheet(assetRows),'Assets');
  XLSX.utils.book_append_sheet(workbook,XLSX.utils.json_to_sheet(liabilityRows),'Liabilities');
  XLSX.utils.book_append_sheet(workbook,XLSX.utils.json_to_sheet([{Item:'Total Assets',Amount:assets},{Item:'Total Liabilities',Amount:liabilities},{Item:'Net Worth',Amount:assets-liabilities}]),'Summary');
  XLSX.writeFile(workbook,`Balance-Sheet-${year||'All-Years'}-${new Date().toISOString().slice(0,10)}.xlsx`);
  toast('Balance Sheet exported');
}

async function importExcel(event){
  const file=event.target.files[0];if(!file)return;
  if(!window.XLSX){toast('Excel library is unavailable.',true);return}
  try{
    const data=await file.arrayBuffer();
    const workbook=XLSX.read(data,{type:'array',cellDates:true});
    let imported=0,skipped=0,manual=0;
    const mappings={
      'Cash-Savings Accounts':['Cash','Savings Accounts'],'Cash-CIH':['Cash','Cash in Hand'],
      'Investment-CPF':['Investments','CPF'],'Investment-GI&WF':['Investments','Group Insurance & Welfare Fund (GI&WF)'],'Investment-Co-oP':['Investments','Other Investment / Co-operation'],
      'Property-Land':['Property','Land & Primary Residence'],'Property-Vehicles':['Property','Vehicles'],'Property-Jewelry':['Property','Jewelry'],'Property-Other Property':['Property','Other Property'],
      'Retirement-Gratuity':['Retirement','Gratuity'],'Other Assets-Furniture':['Other Assets','Furniture, Electronics & Equipments'],'Other Assets-Accounts Receivabl':['Other Assets','Accounts Receivable'],
      'Liabilities-Payable':['Accounts Payable','Accounts Payable'],'Liabilities-Bank Loan':['Bank Loan','Bank Loan'],'Liabilities-Other Liabilities':['Other Liabilities','Other Liabilities']
    };
    const liabilitySheets=new Set(['Liabilities-Payable','Liabilities-Bank Loan','Liabilities-Other Liabilities']);
    for(const sheetName of workbook.SheetNames){
      if(/Balance Sheet/i.test(sheetName)||!/Assets|Liabilities|Cash|Investment|Property|Retirement|Other/i.test(sheetName))continue;
      const mapped=mappings[sheetName];
      if(!mapped){manual++;continue}
      const rows=XLSX.utils.sheet_to_json(workbook.Sheets[sheetName],{defval:''});
      for(const [index,row] of rows.entries()){
        const hasValue=Object.values(row).some(v=>String(v).trim()!==''&&!/^total$/i.test(String(v).trim()));
        if(!hasValue){skipped++;continue}
        const record={
          id:uid('record'),type:liabilitySheets.has(sheetName)?'Liability':'Asset',category:mapped[0],subcategory:mapped[1],
          date:normalizeExcelDate(row.Date||row.date||row['Transaction Date']||row['Income Year']||''),
          particulars:String(row.Particulars||row['Particulars / Name']||row.Name||row['Description']||row.Description||'').trim(),
          details:String(row.Details||row['Description']||row.Location||row['Particular Details']||'').trim(),
          incomeYear:String(row['Income Year']||row['Income year']||row.Year||row.year||'').trim(),
          amount:parseExcelNumber(row.Balance??row.Amount??row['Outstanding Balance']??row['Current Market Value']??row['Purchase Value']),
          balance:parseExcelNumber(row.Balance??row.Amount??row['Outstanding Balance']),
          purchaseValue:parseExcelNumber(row['Purchase Value']),
          currentMarketValue:parseExcelNumber(row['Current Market Value']),
          remarks:String(row.Remarks||row.Notes||'').trim(),quantity:String(row.Quantity||row.Area||row['Area of Property']||''),documentIds:[],
          sourceSheet:sheetName,sourceRow:index+2,updatedAt:new Date().toISOString()
        };
        if(!record.particulars&&!record.details&&!record.amount&&record.purchaseValue===0&&record.currentMarketValue===0){skipped++;continue}
        await put('records',record);imported++;
      }
    }
    await loadState();renderAll();
    const message=`Import complete: ${imported} imported, ${skipped} skipped, ${manual} sheet(s) requiring manual review.`;
    toast(message,manual>0);
  }catch(error){
    console.error(error);toast(error.message||'Unable to import workbook.',true);
  }finally{
    event.target.value='';
  }
}
function parseExcelNumber(value){
  if(typeof value==='number')return value;
  if(!value)return 0;
  const cleaned=String(value).replace(/[,৳$€£]/g,'').trim();
  const number=Number(cleaned);
  return Number.isFinite(number)?number:0;
}
function normalizeExcelDate(value){
  if(value instanceof Date&&!Number.isNaN(value.getTime()))return value.toISOString().slice(0,10);
  if(typeof value==='number'){const date=new Date(Math.round((value-25569)*86400*1000));if(!Number.isNaN(date.getTime()))return date.toISOString().slice(0,10)}
  if(typeof value==='string'){
    const date=new Date(value);if(!Number.isNaN(date.getTime()))return date.toISOString().slice(0,10);
  }
  return '';
}

async function importExcel(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async function(e) {
    const data = new Uint8Array(e.target.result);
    const workbook = XLSX.read(data, { type: 'array' });

    for (const sheetName of workbook.SheetNames) {
      if (sheetName === 'Balance Sheet') continue;
      const worksheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(worksheet);
      
      let type = 'Asset';
      if (sheetName.startsWith('Liabilities')) type = 'Liability';
      
      let [category, subcategory] = sheetName.split('-');
      if (category === 'Liabilities') {
        category = 'Other'; 
        subcategory = subcategory || sheetName;
      }
      
      for (const row of rows) {
        const record = {
          id: crypto.randomUUID(),
          type: type,
          category: category,
          subcategory: subcategory,
          particulars: row['Particulars'] || row['Name'] || 'Imported Record',
          incomeYear: String(row['Income Year'] || row['Income year'] || row['Year'] || '2026-27'),
          amount: parseFloat(row['Amount'] || row['Balance'] || 0) || 0,
          date: new Date().toISOString().slice(0,10)
        };
        state.records.push(record);
      }
    }
    await put('records', state.records);
    await loadState();
    renderDashboardTable();
    toast('Import complete!');
  };
  reader.readAsArrayBuffer(file);
}

init().catch(error=>{
  console.error(error);
  toast('Unable to initialize local database.',true);
});

