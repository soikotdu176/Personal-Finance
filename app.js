/* ==========================================================================
   Personal Finance - Personal Assets & Liabilities Management System
   Vanilla JS · IndexedDB (AssetBookDB) · Chart.js · JSZip · SheetJS · jsPDF
   Data safety rules enforced here:
     - a new release never deletes local data (see checkDataVersion)
     - PDF blobs live in their own store, so start-up never loads megabytes of PDFs
   ========================================================================== */

const DB_NAME = 'AssetBookDB';
const DB_VERSION = 2;                       // v2: PDF blobs split out of the documents store
const APP_VERSION = '2026-11-19-v4';
const DATA_VERSION_KEY = 'assetbook-data-version';
let db;
let state = { records: [], categories: [], documents: [], settings: {}, backupHistory: [] };
let charts = {};
let editingRecordId = null;
let savingRecord = false;
let confirmAction = null;
let restoreFile = null;
let dashboardPage = 1;
let replacingDocumentId = null;
let currentPage = 'dashboard';
let deferredInstallPrompt = null;

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

/* ---------- IndexedDB helpers ---------- */
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
      // v2: PDF bytes get their own store, so loading document metadata stays cheap.
      if(!database.objectStoreNames.contains('documentBlobs')) database.createObjectStore('documentBlobs',{keyPath:'id'});
      if(event.oldVersion<2&&event.target.transaction) migrateDocumentBlobs(event.target.transaction);
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
    request.onblocked=()=>console.warn('Database upgrade is waiting for other tabs to close');
  });
}
/**
 * v1 -> v2 migration: copy documents[i].blob into "documentBlobs", then strip it from the metadata
 * record. The blob is only removed after the copy succeeded, so a failed copy keeps the original.
 */
function migrateDocumentBlobs(transaction){
  const documents=transaction.objectStore('documents');
  const blobs=transaction.objectStore('documentBlobs');
  const cursorRequest=documents.openCursor();
  cursorRequest.onsuccess=()=>{
    const cursor=cursorRequest.result;
    if(!cursor)return;
    const record=cursor.value;
    const next=()=>cursor.continue();
    if(!record||!record.blob){next();return}
    const copy=blobs.put({id:record.id,blob:record.blob});
    copy.onsuccess=()=>{
      const metadata=Object.assign({},record);
      delete metadata.blob;
      const strip=documents.put(metadata);
      strip.onsuccess=next;
      strip.onerror=next;
    };
    copy.onerror=next;                                  // keep the original blob for a later retry
  };
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
function putMany(store,items){
  return new Promise((resolve,reject)=>{
    const transaction=db.transaction(store,'readwrite');
    const objectStore=transaction.objectStore(store);
    items.forEach(item=>objectStore.put(item));
    transaction.oncomplete=()=>resolve();
    transaction.onerror=()=>reject(transaction.error);
    transaction.onabort=()=>reject(transaction.error);
  });
}
function remove(store,key){
  return new Promise((resolve,reject)=>{
    const request=tx(store,'readwrite').delete(key);
    request.onsuccess=()=>resolve();
    request.onerror=()=>reject(request.error);
  });
}
function getOne(store,key){
  return new Promise((resolve,reject)=>{
    const request=tx(store).get(key);
    request.onsuccess=()=>resolve(request.result||null);
    request.onerror=()=>reject(request.error);
  });
}
/** Clears a store and writes the new contents in ONE transaction, so a failure never leaves it half empty. */
function replaceStore(store,items){
  return new Promise((resolve,reject)=>{
    const transaction=db.transaction(store,'readwrite');
    const objectStore=transaction.objectStore(store);
    objectStore.clear();
    (items||[]).forEach(item=>objectStore.put(item));
    transaction.oncomplete=()=>resolve();
    transaction.onerror=()=>reject(transaction.error||new Error('Could not write to the database.'));
    transaction.onabort=()=>reject(transaction.error||new Error('The database rejected the write (is the disk full?).'));
  });
}
/** PDF bytes are loaded on demand only - they are never part of the in-memory state. */
async function getDocBlob(id){
  const stored=await getOne('documentBlobs',id).catch(()=>null);
  if(stored&&stored.blob)return stored.blob;
  // Fallback for a document whose v1 -> v2 copy failed: the bytes are still in "documents".
  const legacy=await getOne('documents',id).catch(()=>null);
  return legacy&&legacy.blob?legacy.blob:null;
}
/** Missing elements (e.g. a stale cached index.html) must never abort start-up. */
const $el=id=>document.getElementById(id)||document.createElement('div');
const uid=prefix=>`${prefix}-${crypto.randomUUID ? crypto.randomUUID() : Date.now()+'-'+Math.random().toString(16).slice(2)}`;
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon=name=>`<svg class="ic" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const pad2=n=>String(n).padStart(2,'0');
const reducedMotion=()=>window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
function todayISO(){const d=new Date();return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`}
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtDate(iso){
  const m=String(iso||'').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m?`${m[3]} ${MONTHS[+m[2]-1]} ${m[1]}`:'';
}

/* ==========================================================================
   Bangladesh fiscal year helpers (Income Year: 1 July -> 30 June)
   ========================================================================== */
function parseIncomeYear(value){
  const s=String(value??'').trim();
  if(!s)return null;
  let m=s.match(/^(\d{4})\s*[-\u2013\u2014\/]\s*(\d{4}|\d{2})$/);
  if(m)return {start:+m[1],plain:false};
  m=s.match(/^(\d{4})$/);
  if(m)return {start:+m[1],plain:true};
  return null;
}
/** '2025-26' | '2025-2026' -> { from:'2025-07-01', to:'2026-06-30' } */
function fiscalRange(value){
  const p=parseIncomeYear(value);
  if(!p)return null;
  return {from:`${p.start}-07-01`,to:`${p.start+1}-06-30`};
}
/** Canonical label so '2025-2026' and '2025-26' compare equal. */
function normIncomeYear(value){
  const p=parseIncomeYear(value);
  if(!p||p.plain)return String(value??'').trim();
  return `${p.start}-${pad2((p.start+1)%100)}`;
}
function fiscalYearFromDate(iso){
  const m=String(iso||'').match(/^(\d{4})-(\d{2})/);
  if(!m)return '';
  const start=+m[2]>=7?+m[1]:+m[1]-1;
  return `${start}-${pad2((start+1)%100)}`;
}

/* ==========================================================================
   Record schemas - strictly mapped to the sheets of "Assets & Liabilities.xlsx"
   Common fields on every form: Type, Category, Subcategory, Date, Details,
   Amount / Balance, Document (PDF).  Everything else comes from the schema.
   ========================================================================== */
const ACQUISITIONS=['Purchased','Gift','Inheritance'];
const LAND_CATEGORIES=['Non-Agricultural','Advance Made for Non-Agricultural Property','Agricultural'];
const ITEM_CATEGORIES=['Furniture','Electronics','Equipments'];
const choice=rules=>value=>{
  const s=String(value??'').trim();
  for(const [re,out] of rules) if(re.test(s)) return out;
  return s;
};
const normLand=choice([[/advance/i,LAND_CATEGORIES[1]],[/non/i,LAND_CATEGORIES[0]],[/agri/i,LAND_CATEGORIES[2]]]);
const normAcquisition=choice([[/purch/i,'Purchased'],[/gift/i,'Gift'],[/inherit/i,'Inheritance']]);
const normItemCategory=choice([[/furn/i,'Furniture'],[/elec/i,'Electronics'],[/equip/i,'Equipments']]);

function field(key,label,type,excel,extra={}){
  return Object.assign({key,label,type,excel,required:false},extra);
}
const F_INCOME_YEAR=()=>field('incomeYear','Income Year','year',['income year'],{required:true});

function makeSchema(category,subcategory,sheet,fields,opts={}){
  return {
    category,subcategory,sheet,fields,
    type:opts.type||'Asset',
    hasDate:!!opts.hasDate,                       // Excel sheet has its own Date column
    detailsLabel:opts.detailsLabel||'Details / Description',
    detailsExcel:opts.detailsExcel||null,         // Excel header aliases for details
    detailsHint:opts.detailsHint||'',
    detailsAfter:opts.detailsAfter??fields.length,// position among report columns
    detailsRequired:!!opts.detailsRequired,
    amountExcel:opts.amountExcel||[],
    amountHint:opts.amountHint||'',
    amountSync:opts.amountSync||null              // 'market' | 'purchase'
  };
}

const SCHEMAS=[
  makeSchema('Cash','Cash in Hand','Cash-CIH',[
    field('particulars','Cash Asset Name','text',['cash asset name'],{required:true,placeholder:'e.g. Cash In Hand, Bkash'})
  ],{amountExcel:['balance'],amountHint:'Excel: Balance',detailsHint:'Optional note (not a separate column in this sheet)'}),

  makeSchema('Cash','Savings Accounts','Cash-Savings Accounts',[
    field('particulars','Bank Name','text',['bank name'],{required:true,placeholder:'e.g. BASIC Bank Limited'}),
    field('accountDetail','Account Detail','text',['account detail'],{placeholder:'Account number / branch'})
  ],{amountExcel:['balance'],amountHint:'Excel: Balance',detailsHint:'Optional note (not a separate column in this sheet)'}),

  makeSchema('Investments','CPF','Investment-CPF',[
    field('particulars','Particulars','text',['particulars'],{required:true,placeholder:'e.g. CPF Own, CPF Company'}),
    field('detailRef','Detail','text',['detail'],{placeholder:'e.g. Employee / PF ID #1089'}),
    F_INCOME_YEAR()
  ],{hasDate:true,amountExcel:['balance'],amountHint:'Excel: Balance',detailsHint:'Optional extra notes'}),

  makeSchema('Investments','Group Insurance & Welfare Fund (GI&WF)','Investment-GI&WF',[
    field('particulars','Particulars','text',['particulars'],{required:true,placeholder:'e.g. Group Insurance Premium'}),
    field('detailRef','Detail','text',['detail'],{placeholder:'e.g. #1089'}),
    F_INCOME_YEAR()
  ],{hasDate:true,amountExcel:['balance'],amountHint:'Excel: Balance',detailsHint:'Optional extra notes'}),

  makeSchema('Investments','Other Investment / Co-operation','Investment-Co-oP',[
    field('particulars','Particulars','text',['particulars'],{required:true,placeholder:'e.g. 2022-23 Batch Co-op'}),
    F_INCOME_YEAR()
  ],{amountExcel:['balance'],amountHint:'Excel: Balance',detailsExcel:['details'],detailsHint:'Excel: Details',detailsAfter:1}),

  makeSchema('Property','Land & Primary Residence','Property-Land',[
    field('propertyCategory','Property Category','select',['category'],{required:true,options:LAND_CATEGORIES,normalize:normLand}),
    field('acquisition','Type of Acquisition','select',['type of acquisition'],{required:true,options:ACQUISITIONS,normalize:normAcquisition}),
    F_INCOME_YEAR(),
    field('area','Area of the Property','text',['area of the property'],{placeholder:'e.g. 5 Decimal / 3 Katha'}),
    field('purchaseValue','Purchase Value','money',['purchase value']),
    field('currentMarketValue','Current Market Value','money',['current market value'])
  ],{hasDate:true,detailsExcel:['description and location'],detailsLabel:'Details / Description',detailsHint:'Excel: Description and Location',detailsRequired:true,detailsAfter:0,
     amountHint:'Syncs with Current Market Value (or Purchase Value) - editable',amountSync:'market'}),

  makeSchema('Property','Vehicles','Property-Vehicles',[
    field('registrationNo','Registration No.','text',['registration no.','registration no']),
    field('particulars','Type and Particulars','text',['type and particulars'],{required:true,placeholder:'e.g. Motorcycle, Car',list:['Motorcycle','Car','Any other']}),
    field('engineCapacity','Engine Capacity (CC)','text',['engine capacity'],{placeholder:'e.g. 150'}),
    F_INCOME_YEAR()
  ],{hasDate:true,amountExcel:['amount'],amountHint:'Excel: Amount',detailsHint:'Optional extra notes'}),

  makeSchema('Property','Jewelry','Property-Jewelry',[
    field('particulars','Particulars','text',['particulars'],{required:true,placeholder:'e.g. Gold Ring, Chain'}),
    field('quantity','Amount (Gram & Karat)','text',['amount (gram)','amount (gram & karat)'],{placeholder:'e.g. 2.75 Gram (21)'}),
    F_INCOME_YEAR()
  ],{amountExcel:['purchase value'],amountHint:'Excel: Purchase Value',amountSync:'purchase',detailsHint:'Optional extra notes'}),

  makeSchema('Property','Other Property','Property-Other Property',[
    field('particulars','Particulars','text',['particulars'],{required:true}),
    F_INCOME_YEAR()
  ],{amountExcel:['purchase value'],amountHint:'Excel: Purchase Value',amountSync:'purchase',detailsExcel:['description'],detailsHint:'Excel: Description',detailsAfter:1}),

  makeSchema('Retirement','Gratuity','Retirement-Gratuity',[
    field('particulars','Institution','text',['institution'],{required:true,placeholder:'e.g. PGCL'})
  ],{amountExcel:['balance'],amountHint:'Excel: Balance',detailsExcel:['detail'],detailsHint:'Excel: Detail',detailsAfter:1}),

  makeSchema('Other Assets','Furniture, Electronics & Equipments','Other Assets-Furniture',[
    field('particulars','Particulars','text',['particulars'],{required:true,placeholder:'e.g. Laptop, Box Bed'}),
    field('itemCategory','Item Category','select',['category'],{required:true,options:ITEM_CATEGORIES,normalize:normItemCategory}),
    field('acquisition','Type of Acquisition','select',['type of acquisition'],{required:true,options:ACQUISITIONS,normalize:normAcquisition}),
    F_INCOME_YEAR(),
    field('quantity','Quantity (Amount/Units)','text',['amount'],{placeholder:'e.g. 1'})
  ],{hasDate:true,amountExcel:['balance'],amountHint:'Excel: Balance',detailsHint:'Optional extra notes'}),

  makeSchema('Other Assets','Accounts Receivable','Other Assets-Accounts Receivable',[
    field('particulars','Debtor','text',['debtor'],{required:true,placeholder:'Person / organization'}),
    F_INCOME_YEAR()
  ],{amountExcel:['balance'],amountHint:'Excel: Balance',detailsExcel:['detail'],detailsHint:'Excel: Detail',detailsAfter:1}),

  makeSchema('Accounts Payable','Accounts Payable','Liabilities-Payable',[
    field('particulars','Payee','text',['payee'],{required:true,placeholder:'Person / organization'}),
    F_INCOME_YEAR()
  ],{type:'Liability',amountExcel:['balance'],amountHint:'Excel: Balance',detailsExcel:['detail'],detailsHint:'Excel: Detail',detailsAfter:1}),

  makeSchema('Bank Loan','Bank Loan','Liabilities-Bank Loan',[
    field('particulars','Bank','text',['bank'],{required:true,placeholder:'Bank name'}),
    F_INCOME_YEAR()
  ],{type:'Liability',amountExcel:['balance'],amountHint:'Excel: Balance',detailsExcel:['detail'],detailsHint:'Excel: Detail',detailsAfter:1}),

  makeSchema('Other Liabilities','Other Liabilities','Liabilities-Other Liabilities',[
    field('particulars','Particulars','text',['particulars'],{required:true}),
    F_INCOME_YEAR()
  ],{type:'Liability',amountExcel:['balance'],amountHint:'Excel: Balance',detailsExcel:['detail'],detailsHint:'Excel: Detail',detailsAfter:1})
];

/** Used for custom categories created in "Manage Categories". */
const GENERIC_SCHEMA=makeSchema('','','',[
  field('particulars','Particulars / Name','text',['particulars']),
  F_INCOME_YEAR()
],{amountHint:'',detailsHint:''});
GENERIC_SCHEMA.fields[0].required=true;

/** Every key that a schema may manage - cleared on save so stale values never survive a subcategory change. */
const MANAGED_KEYS=['particulars','accountDetail','detailRef','propertyCategory','acquisition','itemCategory','area','purchaseValue','currentMarketValue','registrationNo','engineCapacity','quantity','incomeYear'];

function getSchema(category,subcategory){
  return SCHEMAS.find(s=>s.category===category&&s.subcategory===subcategory)||GENERIC_SCHEMA;
}
function schemaForRecord(r){return getSchema(r.category,r.subcategory)}
function recordTitle(r){
  return String(r.particulars||r.name||r.details||r.description||r.registrationNo||r.area||'').trim()||'Unnamed Record';
}
/** Compact secondary line built from schema-specific values. */
function recordMeta(r){
  const parts=[];
  if(r.accountDetail)parts.push(r.accountDetail);
  if(r.detailRef)parts.push(r.detailRef);
  if(r.registrationNo)parts.push('Reg: '+r.registrationNo);
  if(r.engineCapacity)parts.push(r.engineCapacity+' CC');
  if(r.propertyCategory)parts.push(r.propertyCategory);
  if(r.itemCategory)parts.push(r.itemCategory);
  if(r.acquisition)parts.push(r.acquisition);
  if(r.area)parts.push(r.area);
  if(r.quantity)parts.push('Qty/Wt: '+r.quantity);
  return parts.join(' · ');
}

/* ==========================================================================
   Init, theme, toast, confirm
   ========================================================================== */
/**
 * A release must never destroy local data. An older build wiped the database whenever its
 * reset token changed, which silently deleted every record on update. Now the stored data
 * version is only compared, and the user is told to take a backup - nothing is deleted.
 */
async function checkDataVersion(){
  let stored=null;
  try{stored=localStorage.getItem(DATA_VERSION_KEY)}catch(e){}
  if(stored===APP_VERSION)return;
  let hasData=false;
  try{hasData=(await getAll('records')).length>0||(await getAll('documents')).length>0}catch(e){}
  try{localStorage.setItem(DATA_VERSION_KEY,APP_VERSION)}catch(e){}
  if(!hasData)return;
  toast('App updated. All saved records were kept - create a backup from Data Backup & Restore.');
}

function deleteDatabase(){
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('The database is in use by another tab or window. Close every other Personal Finance tab and try again.')),10000);
    const request=indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess=()=>{clearTimeout(timer);resolve()};
    request.onerror=()=>{clearTimeout(timer);reject(request.error)};
    request.onblocked=()=>console.warn('Database delete is waiting for other tabs to close');
  });
}
async function clearAppCaches(){
  try{
    if('serviceWorker' in navigator){(await navigator.serviceWorker.getRegistrations()).forEach(r=>r.unregister())}
    if(window.caches){(await caches.keys()).forEach(k=>caches.delete(k))}
  }catch(e){console.warn(e)}
}
/** Explicit, user-triggered data deletion (Settings page). Never runs automatically. */
async function deleteAllLocalData(){
  const ok=await confirm('Delete every record, category and PDF stored in this browser? This cannot be undone. Create a backup first.','Delete All Local Data');
  if(!ok)return;
  try{
    db=null;
    await deleteDatabase();
    try{localStorage.removeItem(DATA_VERSION_KEY);localStorage.removeItem('assetbook-data-token')}catch(e){}
    await clearAppCaches();
    location.reload();
  }catch(error){toast(error.message||'Unable to delete the local database.',true)}
}
/** Ask the browser to keep this data out of automatic eviction. */
async function requestPersistentStorage(){
  try{
    if(!navigator.storage||!navigator.storage.persist)return;
    if(await navigator.storage.persisted())return;
    await navigator.storage.persist();
  }catch(e){console.warn('Persistent storage request failed',e)}
}
/** Full-screen recovery panel shown when start-up fails. */
function showFatal(error){
  console.error(error);
  document.getElementById('fatalScreen')?.remove();
  const box=document.createElement('div');
  box.id='fatalScreen';box.className='fatal';
  box.innerHTML=`<div class="fatal-card"><h2>Unable to start Personal Finance</h2><p>The local database or the cached app files could not be loaded.</p><pre>${esc(error&&error.message||String(error))}</pre>
    <div class="fatal-actions"><button class="btn btn-primary" id="fatalRetry">Retry</button><button class="btn" id="fatalCache">Clear app cache &amp; reload</button><button class="btn btn-danger" id="fatalReset">Delete local database &amp; reload</button></div>
    <p class="fatal-note">Deleting the local database removes all data stored in this browser. Restore it afterwards from your backup ZIP.</p></div>`;
  document.body.appendChild(box);
  document.getElementById('fatalRetry').onclick=()=>location.reload();
  document.getElementById('fatalCache').onclick=async()=>{await clearAppCaches();location.reload()};
  document.getElementById('fatalReset').onclick=async()=>{
    try{await deleteDatabase();await clearAppCaches();location.reload()}catch(e){alert(e.message)}
  };
}

async function init(){
  initTheme();
  // Self-heal: an old cached index.html without the new elements -> drop caches once and reload.
  if(!document.getElementById('generatePdfReport')||!document.getElementById('pdfViewerModal')){
    if(!sessionStorage.getItem('assetbook-healed')){
      sessionStorage.setItem('assetbook-healed','1');
      await clearAppCaches();location.reload();return;
    }
  }
  renderTableSkeleton();
  setupPWA();
  db=await openDB();
  await checkDataVersion();
  const existingCategories=await getAll('categories');
  if(!existingCategories.length){
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
  bindDelegatedActions();
  renderAll();
  playEnter(document.getElementById('dashboardPage'));
  placePills(true);
  if(document.fonts&&document.fonts.ready)document.fonts.ready.then(()=>placePills(true));
  if(new URLSearchParams(location.search).get('action')==='add')openRecordModal();
  requestPersistentStorage();
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
  setTimeout(()=>{el.style.transition='opacity .3s,transform .3s';el.style.opacity='0';el.style.transform='translateY(8px)';setTimeout(()=>el.remove(),320)},3500);
}
function confirm(message,title='Confirm Action'){
  return new Promise(resolve=>{
    // Never leave an earlier confirmation hanging: resolve it as "cancel".
    if(confirmAction){const previous=confirmAction;confirmAction=null;previous(false)}
    document.getElementById('confirmTitle').textContent=title;
    document.getElementById('confirmMessage').textContent=message;
    confirmAction=resolve;
    const modal=document.getElementById('confirmModal');
    if(!modal.open)modal.showModal();
  });
}

function initTheme(){
  const btn=$el('themeToggle');
  btn.onclick=()=>{
    const next=document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark';
    document.documentElement.setAttribute('data-theme',next);
    try{localStorage.setItem('assetbook-theme',next)}catch(e){}
    const meta=document.getElementById('metaThemeColor');
    if(meta)meta.setAttribute('content',next==='dark'?'#0b1020':'#4f46e5');
    if(db&&currentPage==='dashboard')renderCharts(getFilteredRecords());
  };
}

/* ==========================================================================
   Navigation (sidebar + mobile bottom bar) with animated active pill
   ========================================================================== */
const PAGE_TITLES={dashboard:['Dashboard','Financial overview'],records:['Assets & Liabilities','Manage financial records'],balance:['Balance Sheet','Consolidated financial position'],backup:['Data Backup & Restore','Portable data management'],settings:['Settings','Application preferences']};

function playEnter(panel){
  if(!panel)return;
  [...panel.children].forEach((c,i)=>c.style.setProperty('--i',i));
  panel.classList.remove('enter');
  void panel.offsetWidth;
  panel.classList.add('enter');
}
function restartAnimation(el){
  if(!el||reducedMotion())return;
  el.style.animation='none';
  void el.offsetWidth;
  el.style.animation='';
}
function placePill(nav,instant){
  const pill=nav&&nav.querySelector('.nav-pill'),active=nav&&nav.querySelector('.active');
  if(!pill||!active||!active.offsetWidth)return;
  if(instant){pill.style.transition='none'}
  pill.style.width=active.offsetWidth+'px';
  pill.style.height=active.offsetHeight+'px';
  pill.style.transform=`translate(${active.offsetLeft}px,${active.offsetTop}px)`;
  if(instant){void pill.offsetWidth;pill.style.transition=''}
  pill.classList.add('ready');
}
function placePills(instant=false){
  placePill(document.getElementById('sideNav'),instant);
  placePill(document.getElementById('bottomNav'),instant);
}
function closeDrawer(){
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('scrim').classList.remove('show');
}
function showPage(page){
  if(!PAGE_TITLES[page])return;
  currentPage=page;
  document.querySelectorAll('[data-page]').forEach(b=>{
    const active=b.dataset.page===page;
    b.classList.toggle('active',active);
    if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');
  });
  document.querySelectorAll('[data-page-panel]').forEach(p=>p.classList.add('hidden'));
  const panel=document.getElementById(page+'Page');
  panel.classList.remove('hidden');
  document.getElementById('pageTitle').textContent=PAGE_TITLES[page][0];
  document.getElementById('pageSubtitle').textContent=PAGE_TITLES[page][1];
  closeDrawer();
  if(page==='dashboard'){kpiPrev.length=0;renderDashboard()}
  if(page==='records')renderRecordSections();
  if(page==='balance')renderBalance();
  if(page==='backup')renderBackupHistory();
  if(page==='settings')renderSettings();
  playEnter(panel);
  placePills();
  window.scrollTo({top:0,behavior:reducedMotion()?'auto':'smooth'});
}
function bindNavigation(){
  document.querySelectorAll('[data-page]').forEach(button=>{
    button.onclick=()=>showPage(button.dataset.page);
  });
  const toggle=()=>{
    const sidebar=$el('sidebar');
    const open=!sidebar.classList.contains('open');
    sidebar.classList.toggle('open',open);
    $el('scrim').classList.toggle('show',open);
  };
  $el('menuToggle').onclick=toggle;
  $el('scrim').onclick=closeDrawer;
  window.addEventListener('resize',()=>placePills(true));
}

function bindGlobalActions(){
  const debounce=(fn,wait=180)=>{let timer=null;return (...args)=>{clearTimeout(timer);timer=setTimeout(()=>fn(...args),wait)}};
  $el('quickAdd').onclick=()=>openRecordModal();
  $el('addRecordBtn').onclick=()=>openRecordModal();
  $el('recordSearch').oninput=debounce(renderRecordSections);
  $el('recordTypeFilter').onchange=renderRecordSections;
  $el('dashboardSearch').oninput=debounce(()=>{dashboardPage=1;renderDashboardTable()});
  $el('exportFiltered').onclick=exportFilteredExcel;
  $el('printDashboard').onclick=()=>window.print();
  $el('generatePdfReport').onclick=e=>runWithLoading(e.currentTarget,generatePdfReport);
  $el('generateExcelReport').onclick=e=>runWithLoading(e.currentTarget,generateExcelReport);
  $el('printBalance').onclick=()=>window.print();
  $el('exportBalanceExcel').onclick=exportBalanceExcel;
  $el('balanceYear').onchange=e=>{balanceYear=e.target.value;balanceYearChosen=true;renderBalance()};
  document.querySelectorAll('[data-close-modal]').forEach(button=>{
    button.onclick=()=>button.closest('dialog').close();
  });
  $el('confirmCancel').onclick=()=>{$el('confirmModal').close();if(confirmAction){const resolve=confirmAction;confirmAction=null;resolve(false)}};
  $el('confirmOk').onclick=()=>{$el('confirmModal').close();if(confirmAction){const resolve=confirmAction;confirmAction=null;resolve(true)}};
  $el('confirmModal').addEventListener('cancel',()=>{if(confirmAction){const resolve=confirmAction;confirmAction=null;resolve(false)}});
  $el('recordForm').onsubmit=saveRecord;
  $el('replaceDocumentFile').onchange=replaceDocumentFile;
  $el('createBackup').onclick=createBackup;
  $el('restoreBackup').onclick=()=>$el('restoreFile').click();
  $el('restoreFile').onchange=e=>{restoreFile=e.target.files[0];if(restoreFile)$el('restoreModal').showModal()};
  $el('confirmRestore').onclick=performRestore;
  $el('saveSettings').onclick=saveSettings;
  $el('addYear').onclick=addIncomeYear;
  $el('manageCategories').onclick=()=>openCategoryModal();
  $el('categoryForm').onsubmit=addCategory;
  $el('importExcel').onclick=()=>$el('excelImport').click();
  $el('excelImport').onchange=importExcel;
  const wipe=$el('deleteAllData');
  if(wipe)wipe.onclick=deleteAllLocalData;
  bindPdfViewer();
}

/**
 * One delegated listener for every generated action, instead of inline onclick attributes.
 * Inline handlers had to embed user text inside a JavaScript string, which let a crafted
 * category / income-year name break out of the string and run code. Data attributes keep the
 * value in plain HTML-attribute position, where esc() is sufficient.
 */
function bindDelegatedActions(){
  document.addEventListener('click',async event=>{
    const trigger=event.target.closest('[data-cmd]');
    if(!trigger)return;
    const command=trigger.dataset.cmd,id=trigger.dataset.id||'',name=trigger.dataset.name||'';
    switch(command){
      case 'view-record': viewRecord(id); break;
      case 'edit-record': openRecordModal(id); break;
      case 'delete-record': await deleteRecord(id); break;
      case 'open-pdf': await openPdfViewer(id); break;
      case 'download-pdf': await downloadDocument(id); break;
      case 'rename-category': await renameCategory(id); break;
      case 'rename-subcategory': await renameSubcategory(id,name); break;
      case 'delete-subcategory': await deleteSubcategory(id,name); break;
      case 'delete-category': await deleteCategory(id); break;
      case 'delete-year': await deleteIncomeYear(id); break;
      case 'page': dashboardPage=Number(id)||1; renderDashboardTable(); break;
    }
  });
}

async function runWithLoading(button,task){
  if(button.classList.contains('loading'))return;
  button.classList.add('loading');
  await new Promise(r=>setTimeout(r,60)); // let the shimmer paint before heavy work
  try{await task()}catch(error){console.error(error);toast(error.message||'Unable to generate the report.',true)}
  finally{button.classList.remove('loading')}
}

function renderAll(){
  renderDashboardFilters();
  renderDashboard();
  renderRecordSections();
  renderSettings();
  renderBackupHistory();
  renderBalance();
}

/* ==========================================================================
   Formatting / amounts
   ========================================================================== */
function getCurrencySymbol(){
  return {BDT:'৳',USD:'$',EUR:'€',GBP:'£'}[state.settings.currency||'BDT']||'৳';
}
function formatMoney(value){
  const number=Number(value)||0;
  const locale=state.settings.locale||'en-BD';
  return `${getCurrencySymbol()}${number.toLocaleString(locale,{minimumFractionDigits:2,maximumFractionDigits:2})}`;
}
/**
 * Resolves the primary value of any record.
 * An explicit `amount` always wins - even when it is 0 - so a deliberately zeroed record can no
 * longer resurrect an old Purchase / Market value. The legacy chain only runs when `amount` is
 * missing entirely (records created before the amount field existed, or imported rows).
 */
function recordAmount(record){
  if(!record)return 0;
  if(record.amount!==undefined&&record.amount!==null&&record.amount!==''){
    const explicit=Number(record.amount);
    return Number.isFinite(explicit)?explicit:0;
  }
  const candidates=[record.balance,record.currentMarketValue,record.outstandingBalance,record.purchaseValue];
  for(const c of candidates){
    const n=Number(c);
    if(c!==undefined&&c!==null&&c!==''&&Number.isFinite(n)&&n!==0)return n;
  }
  return 0;
}

/* ==========================================================================
   Dashboard filters (with automatic Bangladesh fiscal-year dates)
   ========================================================================== */
const dashFilters={type:'',category:'',subcategory:'',year:'',from:'',to:'',datesAuto:false};

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
  if(dashFilters.year&&!years.includes(dashFilters.year)) {dashFilters.year='';if(dashFilters.datesAuto){dashFilters.from='';dashFilters.to='';dashFilters.datesAuto=false}}
  const option=(value,label,selected,disabled=false)=>`<option value="${esc(value)}" ${selected?'selected':''} ${disabled?'disabled':''}>${esc(label)}</option>`;
  const range=dashFilters.year?fiscalRange(dashFilters.year):null;
  const hint=range&&dashFilters.datesAuto?`<span class="fy-hint">Fiscal year ${esc(dashFilters.year)} · ${esc(fmtDate(range.from))} to ${esc(fmtDate(range.to))}</span>`:'';
  const anyFilter=dashFilters.type||dashFilters.category||dashFilters.subcategory||dashFilters.year||dashFilters.from||dashFilters.to;

  host.innerHTML=`<div class="filter-row">
    <select id="dashType" aria-label="Financial type">${option('','All Financial Types',!dashFilters.type)}${option('Asset','Assets',dashFilters.type==='Asset')}${option('Liability','Liabilities',dashFilters.type==='Liability')}</select>
    <select id="dashCategory" aria-label="Category" ${categories.length?'':'disabled'}>${option('',dashFilters.type?'All '+dashFilters.type+' Categories':'All Categories',!dashFilters.category)}${categories.map(c=>option(c,c,dashFilters.category===c)).join('')}</select>
    <select id="dashSubcategory" aria-label="Subcategory" ${subcategories.length?'':'disabled'}>${option('','All Subcategories',!dashFilters.subcategory)}${subcategories.map(s=>option(s,s,dashFilters.subcategory===s)).join('')}</select>
    <select id="dashYear" aria-label="Income year">${option('','All Income Years',!dashFilters.year)}${years.map(y=>option(y,y,dashFilters.year===y)).join('')}</select>
    <label class="date-field">Start Date<input id="dashDateFrom" type="date" value="${esc(dashFilters.from)}"></label>
    <label class="date-field">End Date<input id="dashDateTo" type="date" value="${esc(dashFilters.to)}"></label>
    ${anyFilter?'<button type="button" class="btn filter-reset" id="dashReset">Reset filters</button>':''}
    ${hint}
  </div>`;

  const rerender=()=>{dashboardPage=1;renderDashboardFilters();renderDashboard()};
  const bind=(id,key,followUp)=>{
    const el=document.getElementById(id);
    el.onchange=()=>{dashFilters[key]=el.value;if(followUp)followUp();rerender()};
  };
  bind('dashType','type',()=>{dashFilters.category='';dashFilters.subcategory=''});
  bind('dashCategory','category',()=>{dashFilters.subcategory=''});
  bind('dashSubcategory','subcategory');
  bind('dashYear','year',()=>{
    const range=dashFilters.year?fiscalRange(dashFilters.year):null;
    if(range){dashFilters.from=range.from;dashFilters.to=range.to;dashFilters.datesAuto=true}
    else{dashFilters.from='';dashFilters.to='';dashFilters.datesAuto=false}
  });
  bind('dashDateFrom','from',()=>{dashFilters.datesAuto=false});
  bind('dashDateTo','to',()=>{dashFilters.datesAuto=false});
  const reset=document.getElementById('dashReset');
  if(reset)reset.onclick=()=>{Object.assign(dashFilters,{type:'',category:'',subcategory:'',year:'',from:'',to:'',datesAuto:false});rerender()};
}

const inRange=(date,from,to)=>(!from||date>=from)&&(!to||date<=to);

/**
 * Filtering rules
 *  - Income Year: matches the record's incomeYear ('2025-26' == '2025-2026'). Records that have no
 *    incomeYear but a date inside the fiscal year also match.
 *  - Date range: while the dates are the ones auto-filled from the Income Year, the Income Year is the
 *    source of truth, so dateless records (and records whose date sits slightly outside the window) stay in.
 *    As soon as the user edits a date manually, the range is enforced as well (dateless records drop out).
 */
function getFilteredRecords(){
  const {type,category,subcategory,year,from,to,datesAuto}=dashFilters;
  const yearNorm=year?normIncomeYear(year):'';
  const fy=year?fiscalRange(year):null;
  return state.records.filter(r=>{
    if(type&&r.type!==type)return false;
    if(category&&r.category!==category)return false;
    if(subcategory&&r.subcategory!==subcategory)return false;
    if(year){
      const ry=r.incomeYear?normIncomeYear(r.incomeYear):'';
      const match=ry?ry===yearNorm:!!(r.date&&fy&&inRange(r.date,fy.from,fy.to));
      if(!match)return false;
      if(datesAuto)return true;
    }
    if(from||to){
      if(!r.date)return false;
      if(!inRange(r.date,from,to))return false;
    }
    return true;
  });
}

/* ==========================================================================
   Dashboard rendering
   ========================================================================== */
const kpiPrev=[];
function renderDashboard(){
  const records=getFilteredRecords();
  const assets=records.filter(r=>r.type==='Asset').reduce((sum,r)=>sum+recordAmount(r),0);
  const liabilities=records.filter(r=>r.type==='Liability').reduce((sum,r)=>sum+recordAmount(r),0);
  const assetCategories=new Set(records.filter(r=>r.type==='Asset').map(r=>r.category)).size;
  const liabilityCategories=new Set(records.filter(r=>r.type==='Liability').map(r=>r.category)).size;
  const documentCount=new Set(records.flatMap(r=>r.documentIds||[])).size;
  const cards=[
    ['up','Total Assets',assets,'money'],['down','Total Liabilities',liabilities,'money'],['scale','Net Worth',assets-liabilities,'money'],
    ['layers','Asset Categories',assetCategories,'int'],['layers','Liability Categories',liabilityCategories,'int'],['file','PDF Documents',documentCount,'int']
  ];
  document.getElementById('summaryCards').innerHTML=cards.map((c,i)=>`<div class="summary-card" style="--i:${i}"><div class="summary-icon">${icon(c[0])}</div><div><p>${c[1]}</p><strong class="kpi-value" data-kind="${c[3]}" data-to="${c[2]}">${c[3]==='money'?formatMoney(c[2]):c[2]}</strong></div></div>`).join('');
  animateKpis();
  document.querySelectorAll('.chart-card').forEach((el,i)=>{el.style.setProperty('--i',i);restartAnimation(el)});
  renderCharts(records);
  renderDashboardTable();
}

function animateKpis(){
  document.querySelectorAll('#summaryCards .kpi-value').forEach((el,i)=>{
    const to=Number(el.dataset.to)||0,kind=el.dataset.kind;
    const from=kpiPrev[i]??0;
    kpiPrev[i]=to;
    const fmt=v=>kind==='money'?formatMoney(v):String(Math.round(v));
    if(reducedMotion()||from===to){el.textContent=fmt(to);return}
    const duration=900,start=performance.now();
    const step=now=>{
      const t=Math.min(1,(now-start)/duration);
      const eased=1-Math.pow(1-t,4);
      el.textContent=fmt(from+(to-from)*eased);
      if(t<1)requestAnimationFrame(step);else el.textContent=fmt(to);
    };
    el.textContent=fmt(from);
    requestAnimationFrame(step);
  });
}

function renderTableSkeleton(){
  const rows=Array.from({length:5},()=>`<tr class="sk-row"><td colspan="9"><div class="sk"></div></td></tr>`).join('');
  document.getElementById('dashboardTable').innerHTML=`<tbody>${rows}</tbody>`;
}

function destroyChart(id){if(charts[id]){charts[id].destroy();delete charts[id]}}
function chartTheme(){
  const dark=document.documentElement.getAttribute('data-theme')==='dark';
  return {text:dark?'#a8b3d1':'#64748b',grid:dark?'rgba(148,163,184,.14)':'rgba(15,23,42,.07)'};
}
const CHART_COLORS=['#6366f1','#10b981','#f59e0b','#0ea5e9','#ec4899','#8b5cf6','#14b8a6','#f97316'];
const LIABILITY_COLORS=['#f43f5e','#fb923c','#a78bfa','#38bdf8','#facc15'];

function renderCharts(records){
  const assets=records.filter(r=>r.type==='Asset').reduce((sum,r)=>sum+recordAmount(r),0);
  const liabilities=records.filter(r=>r.type==='Liability').reduce((sum,r)=>sum+recordAmount(r),0);
  destroyChart('comparisonChart');destroyChart('assetsChart');destroyChart('liabilitiesChart');destroyChart('netWorthChart');
  if(!window.Chart)return;
  const theme=chartTheme();
  Chart.defaults.color=theme.text;
  Chart.defaults.borderColor=theme.grid;
  Chart.defaults.font.family="'Plus Jakarta Sans','Inter',system-ui,sans-serif";
  const anim={duration:reducedMotion()?0:900,easing:'easeOutQuart'};
  const legend={position:'bottom',labels:{usePointStyle:true,boxWidth:8,color:theme.text}};
  const scales={x:{grid:{display:false},ticks:{color:theme.text}},y:{grid:{color:theme.grid},ticks:{color:theme.text}}};
  charts.comparisonChart=new Chart(document.getElementById('comparisonChart'),{type:'doughnut',data:{labels:['Assets','Liabilities'],datasets:[{data:[assets,liabilities],backgroundColor:['#10b981','#f43f5e'],borderWidth:0,hoverOffset:6}]},options:{maintainAspectRatio:false,cutout:'66%',animation:anim,plugins:{legend}}});
  const group=(type)=>Object.entries(records.filter(r=>r.type===type).reduce((out,r)=>{out[r.category]=(out[r.category]||0)+recordAmount(r);return out},{}));
  const assetsGroup=group('Asset'),liabilitiesGroup=group('Liability');
  charts.assetsChart=new Chart(document.getElementById('assetsChart'),{type:'bar',data:{labels:assetsGroup.map(x=>x[0]),datasets:[{data:assetsGroup.map(x=>x[1]),backgroundColor:assetsGroup.map((x,i)=>CHART_COLORS[i%CHART_COLORS.length]),borderRadius:8,maxBarThickness:42}]},options:{maintainAspectRatio:false,animation:anim,scales,plugins:{legend:{display:false}}}});
  charts.liabilitiesChart=new Chart(document.getElementById('liabilitiesChart'),{type:'pie',data:{labels:liabilitiesGroup.map(x=>x[0]),datasets:[{data:liabilitiesGroup.map(x=>x[1]),backgroundColor:LIABILITY_COLORS,borderWidth:0}]},options:{maintainAspectRatio:false,animation:anim,plugins:{legend}}});
  const byYear=[...new Set(records.map(r=>normIncomeYear(r.incomeYear||'')).filter(Boolean))].sort();
  const trend=byYear.map(year=>{const yearRecords=records.filter(r=>normIncomeYear(r.incomeYear||'')===year);const a=yearRecords.filter(r=>r.type==='Asset').reduce((s,r)=>s+recordAmount(r),0);const l=yearRecords.filter(r=>r.type==='Liability').reduce((s,r)=>s+recordAmount(r),0);return a-l});
  charts.netWorthChart=new Chart(document.getElementById('netWorthChart'),{type:'line',data:{labels:byYear,datasets:[{label:'Net Worth',data:trend,borderColor:'#6366f1',backgroundColor:'rgba(99,102,241,.16)',fill:true,tension:.38,pointRadius:4,pointBackgroundColor:'#6366f1',borderWidth:2.5}]},options:{maintainAspectRatio:false,animation:anim,scales,plugins:{legend:{display:false}}}});
}

function docsOf(record){
  return (record.documentIds||[]).map(id=>state.documents.find(d=>d.id===id)).filter(Boolean);
}
function shortName(name,max=16){
  const base=String(name||'document.pdf');
  return base.length>max?base.slice(0,max-4)+'…pdf':base;
}
/** Clickable PDF badges shown on table rows / record cards. */
function docChips(record,max=2){
  const docs=docsOf(record);
  if(!docs.length)return '';
  const shown=docs.slice(0,max).map(d=>`<button type="button" class="doc-chip" data-cmd="open-pdf" data-id="${esc(d.id)}" title="View ${esc(d.name||d.title||'PDF')}">${icon('file')}<span>${esc(shortName(d.name||d.title))}</span></button>`).join('');
  const more=docs.length>max?`<button type="button" class="doc-chip more" data-cmd="view-record" data-id="${esc(record.id)}" title="Show all documents">+${docs.length-max} more</button>`:'';
  return shown+more;
}

function renderDashboardTable(){
  let records=getFilteredRecords();
  const search=document.getElementById('dashboardSearch').value.toLowerCase();
  if(search) records=records.filter(r=>Object.values(r).some(v=>String(v).toLowerCase().includes(search)));
  records.sort((a,b)=>String(b.date||'').localeCompare(String(a.date||''))||recordTitle(a).localeCompare(recordTitle(b)));
  const pageSize=10, pages=Math.max(1,Math.ceil(records.length/pageSize));
  dashboardPage=Math.min(dashboardPage,pages);
  const pageRecords=records.slice((dashboardPage-1)*pageSize,dashboardPage*pageSize);
  document.getElementById('recordCount').textContent=`${records.length} record${records.length===1?'':'s'} found`;
  document.getElementById('dashboardTable').innerHTML=`<thead><tr><th scope="col">Type</th><th scope="col">Date</th><th scope="col">Category</th><th scope="col">Subcategory</th><th scope="col">Particulars</th><th scope="col">Details</th><th scope="col">Income Year</th><th scope="col" class="num">Balance / Amount</th><th scope="col">Documents</th><th scope="col">Action</th></tr></thead><tbody>${pageRecords.map((r,i)=>{
    const meta=recordMeta(r);
    const id=esc(r.id);
    return `<tr style="--i:${i}"><td><span class="badge ${r.type.toLowerCase()}">${esc(r.type)}</span></td><td>${esc(fmtDate(r.date)||'—')}</td><td>${esc(r.category)}</td><td>${esc(r.subcategory)}</td><td><strong>${esc(recordTitle(r))}</strong>${meta?`<span class="muted-sub">${esc(meta)}</span>`:''}</td><td>${esc(r.details||'—')}</td><td>${esc(r.incomeYear||'—')}</td><td class="num"><strong>${formatMoney(recordAmount(r))}</strong></td><td><div class="doc-cell">${docChips(r)||'<span class="doc-none">—</span>'}</div></td><td class="actions-cell"><button type="button" class="action-link" data-cmd="view-record" data-id="${id}">View</button><button type="button" class="action-link" data-cmd="edit-record" data-id="${id}">Edit</button><button type="button" class="action-link danger" data-cmd="delete-record" data-id="${id}">Delete</button></td></tr>`;
  }).join('')||'<tr><td colspan="10"><div class="empty-state">No financial records match these filters.</div></td></tr>'}</tbody>`;
  document.getElementById('dashboardPagination').innerHTML=pages>1?Array.from({length:pages},(_,i)=>`<button type="button" class="${i+1===dashboardPage?'active':''}" data-cmd="page" data-id="${i+1}" aria-label="Page ${i+1}">${i+1}</button>`).join(''):'';
}

/* ==========================================================================
   PDF documents: viewer modal, download, staged edit operations
   ========================================================================== */
let viewerUrl=null;
let viewerDoc=null;
let viewerTimer=null;

const isPdfFile=file=>!!file&&(file.type==='application/pdf'||/\.pdf$/i.test(file.name||''));
/**
 * Resolves a document id (or an already-loaded {blob,name,size}) into {blob,name,size}.
 * PDF bytes are read from IndexedDB only here, on demand - they never sit in the app state.
 */
async function resolveDocSource(source){
  if(typeof source!=='string')return source||null;
  const meta=state.documents.find(d=>d.id===source);
  if(!meta)return null;
  const blob=await getDocBlob(source);
  if(!blob)return null;
  return {blob,name:meta.name||meta.title||'document.pdf',size:meta.size||blob.size};
}
function asPdfBlob(blob){
  return blob&&blob.type==='application/pdf'?blob:new Blob([blob],{type:'application/pdf'});
}
function downloadBlob(blob,fileName){
  const url=URL.createObjectURL(blob);
  const link=document.createElement('a');
  link.href=url;link.download=fileName;link.rel='noopener';link.style.display='none';
  document.body.appendChild(link);link.click();
  setTimeout(()=>{link.remove();URL.revokeObjectURL(url)},60000);   // keep the URL alive long enough for large files
}
/** Saves a file: native share sheet on iOS home-screen apps (anchor downloads are blocked there), normal download elsewhere. */
async function saveFile(blob,fileName){
  const ios=/iphone|ipad|ipod/i.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  const standalone=window.matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
  if(ios&&standalone&&navigator.canShare){
    try{
      const file=new File([blob],fileName,{type:blob.type||'application/octet-stream'});
      if(navigator.canShare({files:[file]})){await navigator.share({files:[file],title:fileName});return}
    }catch(e){if(e&&e.name==='AbortError')return}
  }
  downloadBlob(blob,fileName);
}
function releaseViewerUrl(){
  clearTimeout(viewerTimer);
  if(viewerUrl){URL.revokeObjectURL(viewerUrl);viewerUrl=null}
  const frame=document.getElementById('pdfFrame');
  if(frame){frame.onload=null;frame.removeAttribute('src')}
}
function bindPdfViewer(){
  const modal=$el('pdfViewerModal');
  modal.addEventListener('close',()=>{releaseViewerUrl();viewerDoc=null});
  modal.addEventListener('click',e=>{if(e.target===modal)modal.close()});
  const download=()=>{if(viewerDoc)downloadBlob(asPdfBlob(viewerDoc.blob),viewerDoc.name)};
  const tab=async()=>{if(viewerDoc)await openDocumentInTab(viewerDoc)};
  $el('pdfDownloadBtn').onclick=download;
  $el('pdfFallbackDownload').onclick=download;
  $el('pdfNewTabBtn').onclick=tab;
  $el('pdfFallbackTab').onclick=tab;
}
/** Embedded viewer. `source` is a document id or { blob, name, size }. */
async function openPdfViewer(source){
  const doc=await resolveDocSource(source);
  if(!doc||!doc.blob){toast('This document file is not available on this device.',true);return}
  releaseViewerUrl();
  viewerDoc=doc;
  const modal=document.getElementById('pdfViewerModal');
  const stage=document.getElementById('pdfStage');
  const frame=document.getElementById('pdfFrame');
  const fallback=document.getElementById('pdfFallback');
  document.getElementById('pdfViewerTitle').textContent=doc.name||'Document';
  document.getElementById('pdfViewerMeta').textContent=doc.size?formatFileSize(doc.size):'PDF document';
  stage.classList.remove('loaded');
  fallback.classList.add('hidden');
  if(navigator.pdfViewerEnabled===false){
    fallback.classList.remove('hidden');
    stage.classList.add('loaded');
  }else{
    viewerUrl=URL.createObjectURL(asPdfBlob(doc.blob));
    frame.onload=()=>stage.classList.add('loaded');
    frame.src=viewerUrl+'#toolbar=1&navpanes=0';
    viewerTimer=setTimeout(()=>stage.classList.add('loaded'),4000);
  }
  if(!modal.open)modal.showModal();
}
/** Opens in a new tab with its own Blob URL (revoked after 5 minutes). */
async function openDocumentInTab(source){
  const doc=await resolveDocSource(source);
  if(!doc||!doc.blob){toast('This document file is not available on this device.',true);return}
  const url=URL.createObjectURL(asPdfBlob(doc.blob));
  const win=window.open(url,'_blank','noopener');
  if(!win)toast('Pop-up blocked. Allow pop-ups or use Download.',true);
  setTimeout(()=>URL.revokeObjectURL(url),5*60*1000);
}
async function downloadDocument(source){
  const doc=await resolveDocSource(source);
  if(!doc||!doc.blob){toast('This document file is not available on this device.',true);return}
  downloadBlob(asPdfBlob(doc.blob),doc.name);
}
function formatFileSize(bytes){
  if(!bytes)return '0 B';
  const units=['B','KB','MB','GB'];const i=Math.min(Math.floor(Math.log(bytes)/Math.log(1024)),units.length-1);
  return `${(bytes/Math.pow(1024,i)).toFixed(i?1:0)} ${units[i]}`;
}

/* Staged document operations for the Add / Edit modal (committed on Save, discarded on Cancel). */
let docDraft={existing:[],removed:new Set(),replaced:new Map(),added:[]};
function resetDocDraft(record){
  docDraft={existing:record?docsOf(record):[],removed:new Set(),replaced:new Map(),added:[]};
}
function renderDocManager(){
  const host=document.getElementById('docManagerList');
  if(!host)return;
  const rows=[];
  docDraft.existing.forEach(d=>{
    const removed=docDraft.removed.has(d.id),replacement=docDraft.replaced.get(d.id);
    const name=replacement?replacement.name:(d.name||d.title||'document.pdf');
    const size=replacement?replacement.size:d.size;
    const tag=removed?'<span class="tag warn">Will be removed</span>':replacement?`<span class="tag">Will replace "${esc(shortName(d.name||d.title,24))}"</span>`:'';
    rows.push(`<div class="doc-row ${removed?'removed':''}"><div class="doc-info"><strong>${esc(name)}</strong><span>${formatFileSize(size)}</span>${tag}</div><div class="doc-actions">
      ${removed?'':`<button type="button" class="action-link" data-act="view" data-id="${esc(d.id)}">View</button><button type="button" class="action-link" data-act="download" data-id="${esc(d.id)}">Download</button><button type="button" class="action-link" data-act="replace" data-id="${esc(d.id)}">Replace</button>`}
      <button type="button" class="action-link ${removed?'':'danger'}" data-act="${removed?'undo':'remove'}" data-id="${esc(d.id)}">${removed?'Undo remove':'Remove'}</button></div></div>`);
  });
  docDraft.added.forEach((file,i)=>{
    rows.push(`<div class="doc-row"><div class="doc-info"><strong>${esc(file.name)}</strong><span>${formatFileSize(file.size)}</span><span class="tag new">New · saved with record</span></div><div class="doc-actions"><button type="button" class="action-link" data-act="view-new" data-idx="${i}">View</button><button type="button" class="action-link danger" data-act="remove-new" data-idx="${i}">Remove</button></div></div>`);
  });
  host.innerHTML=rows.join('')||'<div class="doc-empty">No PDF attached yet.</div>';
}
async function docDraftSource(id){
  const meta=docDraft.existing.find(x=>x.id===id);if(!meta)return null;
  const replacement=docDraft.replaced.get(id);
  if(replacement)return {blob:replacement,name:replacement.name,size:replacement.size};
  const blob=await getDocBlob(id);
  if(!blob)return null;
  return {blob,name:meta.name||meta.title||'document.pdf',size:meta.size||blob.size};
}
function bindDocManager(){
  const host=document.getElementById('docManager');
  host.onclick=async event=>{
    const btn=event.target.closest('[data-act]');if(!btn)return;
    const {act,id,idx}=btn.dataset;
    if(act==='view')await openPdfViewer(await docDraftSource(id));
    else if(act==='download'){const source=await docDraftSource(id);if(source)downloadBlob(asPdfBlob(source.blob),source.name)}
    else if(act==='replace')replaceDocument(id);
    else if(act==='remove'){docDraft.removed.add(id);docDraft.replaced.delete(id);renderDocManager()}
    else if(act==='undo'){docDraft.removed.delete(id);renderDocManager()}
    else if(act==='view-new'){const f=docDraft.added[+idx];if(f)await openPdfViewer({blob:f,name:f.name,size:f.size})}
    else if(act==='remove-new'){docDraft.added.splice(+idx,1);renderDocManager()}
  };
  document.getElementById('recordDocument').onchange=event=>{
    const files=[...event.target.files];
    const bad=files.filter(f=>!isPdfFile(f));
    docDraft.added.push(...files.filter(isPdfFile));
    if(bad.length)toast('Only PDF files can be attached.',true);
    event.target.value='';
    renderDocManager();
  };
}
function replaceDocument(id){
  replacingDocumentId=id;
  document.getElementById('replaceDocumentFile').click();
}
async function replaceDocumentFile(event){
  const file=event.target.files[0];
  const targetId=replacingDocumentId;
  event.target.value='';
  if(!file||!targetId)return;
  if(!isPdfFile(file)){toast('Please select a PDF file.',true);return}
  replacingDocumentId=null;
  if(document.getElementById('recordModal').open&&docDraft.existing.some(d=>d.id===targetId)){
    docDraft.replaced.set(targetId,file);
    docDraft.removed.delete(targetId);
    renderDocManager();
    return;
  }
  const documentRecord=state.documents.find(d=>d.id===targetId);
  if(!documentRecord)return;
  await put('documentBlobs',{id:targetId,blob:file});
  Object.assign(documentRecord,{name:file.name,title:file.name,type:file.type||'application/pdf',size:file.size,updatedAt:new Date().toISOString()});
  await put('documents',documentRecord);
  await loadState();renderAll();toast('PDF document replaced');
}

/* ==========================================================================
   Add / Edit record modal - fields adapt to Type > Category > Subcategory
   ========================================================================== */
let formState={draft:{},schema:GENERIC_SCHEMA,amountTouched:false,yearTouched:false};

function yearOptionsFor(current){
  const list=[...(state.settings.incomeYears||[])];
  if(current&&!list.includes(current))list.push(current);
  return list.sort((a,b)=>String(b).localeCompare(String(a)));
}
function fieldHtml(f){
  const value=formState.draft[f.key]??'';
  const req=f.required?'required':'';
  const star=f.required?' *':'';
  const base=`id="f_${f.key}" data-key="${f.key}" ${req}`;
  if(f.type==='select'){
    const options=[...f.options];
    if(value&&!options.includes(value))options.push(value);
    const selected=value||options[0];
    formState.draft[f.key]=selected;
    return `<label>${esc(f.label)}${star}<select ${base}>${options.map(o=>`<option value="${esc(o)}" ${o===selected?'selected':''}>${esc(o)}</option>`).join('')}</select></label>`;
  }
  if(f.type==='year'){
    const dateValue=document.getElementById('recordDate')?.value||'';
    const selected=value||fiscalYearFromDate(dateValue)||state.settings.incomeYears?.[0]||'';
    formState.draft[f.key]=selected;
    return `<label>${esc(f.label)}${star}<select ${base}>${yearOptionsFor(selected).map(y=>`<option value="${esc(y)}" ${String(y)===String(selected)?'selected':''}>${esc(y)}</option>`).join('')}</select></label>`;
  }
  if(f.type==='money'){
    return `<label>${esc(f.label)}${star}<input ${base} type="number" step="0.01" min="0" inputmode="decimal" value="${esc(value===0?'0':value)}" placeholder="0.00"></label>`;
  }
  const listAttr=f.list?`list="dl_${f.key}"`:'';
  const dataList=f.list?`<datalist id="dl_${f.key}">${f.list.map(o=>`<option value="${esc(o)}"></option>`).join('')}</datalist>`:'';
  return `<label>${esc(f.label)}${star}<input ${base} ${listAttr} value="${esc(value)}" placeholder="${esc(f.placeholder||'')}" autocomplete="off">${dataList}</label>`;
}

function renderSubFields(){
  const category=document.getElementById('recordCategory').value;
  const subcategory=document.getElementById('recordSubcategory').value;
  const schema=getSchema(category,subcategory);
  formState.schema=schema;
  const host=document.getElementById('subFields');
  host.innerHTML=schema.fields.map(fieldHtml).join('');
  const details=document.getElementById('recordDetails');
  details.required=schema.detailsRequired;
  document.getElementById('detailsLabelText').textContent=schema.detailsRequired?'Details / Description *':'Details / Description';
  document.getElementById('detailsHint').textContent=schema.detailsHint||'';
  document.getElementById('amountHint').textContent=schema.amountHint||'';
  document.getElementById('subSectionTitle').textContent=schema.fields.length?`${subcategory||'Subcategory'} details`:'Details';
  host.oninput=event=>{
    const key=event.target.dataset.key;if(!key)return;
    formState.draft[key]=event.target.value;
    if(key==='incomeYear')formState.yearTouched=true;
    if(schema.amountSync==='market'&&(key==='currentMarketValue'||key==='purchaseValue'))syncAmountFromValues();
  };
  if(schema.amountSync==='market')syncAmountFromValues();
}
/** Land: Amount / Balance follows Current Market Value (fallback Purchase Value) until edited by hand. */
function syncAmountFromValues(){
  if(formState.amountTouched)return;
  const market=Number(formState.draft.currentMarketValue)||0,purchase=Number(formState.draft.purchaseValue)||0;
  const value=market||purchase;
  document.getElementById('recordAmount').value=value?String(value):'';
}

function openRecordModal(id=null){
  editingRecordId=id;
  const record=id?state.records.find(r=>r.id===id):null;
  resetDocDraft(record);
  formState={draft:{},schema:GENERIC_SCHEMA,amountTouched:false,yearTouched:!!record?.incomeYear};
  if(record)MANAGED_KEYS.forEach(k=>{if(record[k]!==undefined)formState.draft[k]=record[k]});
  document.querySelector('#recordForm .modal-foot').innerHTML='<button type="button" class="btn" data-close-modal>Cancel</button><button type="submit" class="btn btn-primary">Save Record</button>';
  document.querySelectorAll('#recordForm [data-close-modal]').forEach(button=>button.onclick=()=>document.getElementById('recordModal').close());
  document.getElementById('recordModalTitle').textContent=record?'Edit Financial Record':'Add Financial Record';
  document.getElementById('recordModalSubtitle').textContent=record?`${record.category} / ${record.subcategory}`:'Fields adapt to the selected category and subcategory';
  const startType=record?.type||'Asset';
  const amountValue=record?recordAmount(record):'';
  document.getElementById('recordFormFields').innerHTML=`<div class="form-grid">
    <label>Financial Type *<select id="recordType" required><option value="Asset" ${startType==='Asset'?'selected':''}>Asset</option><option value="Liability" ${startType==='Liability'?'selected':''}>Liability</option></select></label>
    <label>Category *<select id="recordCategory" required></select></label>
    <label>Subcategory *<select id="recordSubcategory" required></select></label>
    <label>Date<input id="recordDate" type="date" value="${esc(record?record.date||'':todayISO())}"></label>
    <div class="form-section" id="subSectionTitle">Details</div>
    <div class="sub-fields" id="subFields"></div>
    <label class="full"><span id="detailsLabelText">Details / Description</span><textarea id="recordDetails" rows="3">${esc(record?.details||record?.description||'')}</textarea><span class="hint" id="detailsHint"></span></label>
    <label>Amount / Balance *<input id="recordAmount" type="number" step="0.01" inputmode="decimal" required value="${esc(amountValue===0?'0':amountValue)}" placeholder="0.00"><span class="hint" id="amountHint"></span></label>
    <label>Document (PDF)<input id="recordDocument" type="file" accept=".pdf,application/pdf" multiple><span class="hint">You can attach more than one PDF.</span></label>
    <div class="doc-manager" id="docManager"><h4>Attached documents</h4><div class="doc-list" id="docManagerList"></div></div>
  </div>`;

  const typeSelect=document.getElementById('recordType'),categorySelect=document.getElementById('recordCategory'),subSelect=document.getElementById('recordSubcategory');
  const dateInput=document.getElementById('recordDate'),amountInput=document.getElementById('recordAmount');

  const updateCategories=(keepCategory)=>{
    const filtered=state.categories.filter(c=>c.type===typeSelect.value);
    const wanted=keepCategory||categorySelect.value;
    categorySelect.innerHTML=filtered.map(c=>`<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
    if(filtered.some(c=>c.name===wanted))categorySelect.value=wanted;
    updateSubcategories(keepCategory===record?.category?record?.subcategory:undefined);
  };
  const updateSubcategories=(keepSub)=>{
    const category=state.categories.find(c=>c.type===typeSelect.value&&c.name===categorySelect.value);
    // A category without subcategories must not make the form impossible to submit:
    // fall back to the category name so the record can still be saved.
    const subs=(category?.subcategories||[]).length?category.subcategories:[categorySelect.value].filter(Boolean);
    subSelect.innerHTML=subs.map(s=>`<option value="${esc(s)}">${esc(s)}</option>`).join('');
    if(keepSub&&subs.includes(keepSub))subSelect.value=keepSub;
    renderSubFields();
  };
  typeSelect.onchange=()=>updateCategories();
  categorySelect.onchange=()=>updateSubcategories();
  subSelect.onchange=renderSubFields;
  dateInput.onchange=()=>{
    if(formState.yearTouched||!formState.schema.fields.some(f=>f.key==='incomeYear'))return;
    const derived=fiscalYearFromDate(dateInput.value);
    const select=document.getElementById('f_incomeYear');
    if(!derived||!select)return;
    if(![...select.options].some(o=>o.value===derived))select.add(new Option(derived,derived));
    select.value=derived;formState.draft.incomeYear=derived;
  };
  amountInput.oninput=()=>{formState.amountTouched=true};
  if(record&&schemaForRecord(record).amountSync==='market'){
    // An amount that differs from Market/Purchase Value was typed by hand: don't auto-overwrite it.
    const linked=Number(record.currentMarketValue)||Number(record.purchaseValue)||0;
    formState.amountTouched=Number(record.amount)!==0&&Number(record.amount)!==linked;
  }
  updateCategories(record?.category);
  bindDocManager();
  renderDocManager();
  document.getElementById('recordModal').showModal();
}

async function saveRecord(event){
  event.preventDefault();
  if(savingRecord)return;                       // a double click must not create two records
  const form=event.target;
  if(form.querySelector('select:invalid,input:invalid,textarea:invalid')){form.reportValidity();return}
  savingRecord=true;
  try{
  const type=document.getElementById('recordType').value;
  const category=document.getElementById('recordCategory').value;
  const subcategory=document.getElementById('recordSubcategory').value;
  const schema=getSchema(category,subcategory);
  const old=editingRecordId?state.records.find(r=>r.id===editingRecordId):null;
  const isNew=!old;
  const record=Object.assign({},old||{});
  MANAGED_KEYS.forEach(k=>delete record[k]);        // stale schema values never survive a subcategory change
  const amount=Number(document.getElementById('recordAmount').value||0);
  Object.assign(record,{
    id:old?old.id:uid('record'),type,category,subcategory,
    date:document.getElementById('recordDate').value,
    details:document.getElementById('recordDetails').value.trim(),
    amount,balance:amount
  });
  for(const f of schema.fields){
    const el=document.getElementById('f_'+f.key);
    const value=el?el.value:'';
    record[f.key]=f.type==='money'?Number(value||0):String(value).trim();
  }
  if(schema.amountSync==='purchase')record.purchaseValue=amount;      // Jewelry / Other Property: Amount = Purchase Value
  if(schema.amountSync==='market'&&!record.currentMarketValue&&!record.purchaseValue){record.currentMarketValue=amount}
  if(!record.incomeYear){const derived=fiscalYearFromDate(record.date);if(derived)record.incomeYear=derived}
  record.updatedAt=new Date().toISOString();

  // Commit staged document operations
  let documentIds=[...(old?.documentIds||[])];
  for(const docId of docDraft.removed){
    await remove('documents',docId);
    await remove('documentBlobs',docId);
    documentIds=documentIds.filter(x=>x!==docId);
  }
  for(const [docId,file] of docDraft.replaced){
    const existing=state.documents.find(d=>d.id===docId);
    if(!existing||docDraft.removed.has(docId))continue;
    await put('documentBlobs',{id:docId,blob:file});
    Object.assign(existing,{name:file.name,title:file.name,type:file.type||'application/pdf',size:file.size,updatedAt:new Date().toISOString()});
    await put('documents',existing);
  }
  for(const file of docDraft.added){
    const docId=uid('doc');
    await put('documentBlobs',{id:docId,blob:file});
    await put('documents',{id:docId,recordId:record.id,title:file.name,name:file.name,type:file.type||'application/pdf',size:file.size,category,subcategory,financialType:type,incomeYear:record.incomeYear||'',createdAt:new Date().toISOString()});
    documentIds.push(docId);
  }
  record.documentIds=documentIds;
  for(const d of state.documents.filter(x=>x.recordId===record.id&&documentIds.includes(x.id)&&!docDraft.replaced.has(x.id))){
    if(d.category!==category||d.subcategory!==subcategory||d.financialType!==type||d.incomeYear!==(record.incomeYear||'')){
      await put('documents',Object.assign(d,{category,subcategory,financialType:type,incomeYear:record.incomeYear||''}));
    }
  }
  await put('records',record);
  await loadState();
  document.getElementById('recordModal').close();
  editingRecordId=null;
  renderAll();
  toast(isNew?'Record created successfully':'Record saved successfully');
  }finally{
    savingRecord=false;
  }
}

async function deleteRecord(id){
  if(await confirm('Delete this financial record? Any linked document relationships will also be removed.','Delete Record')){
    const record=state.records.find(r=>r.id===id);
    const linked=new Set([...(record?.documentIds||[]),...state.documents.filter(d=>d.recordId===id).map(d=>d.id)]);
    for(const documentId of linked){
      await remove('documents',documentId);
      await remove('documentBlobs',documentId);
    }
    await remove('records',id);
    await loadState();renderAll();toast('Record deleted');
  }
}

function viewRecord(id){
  const r=state.records.find(x=>x.id===id);if(!r)return;
  editingRecordId=null;
  const schema=schemaForRecord(r);
  document.getElementById('recordModalTitle').textContent=recordTitle(r);
  document.getElementById('recordModalSubtitle').textContent=`${r.category} / ${r.subcategory}`;
  const documents=docsOf(r);
  const documentSection=documents.length?`
    <label class="full document-view-section">Attached PDF Documents
      <div class="document-view-list">${documents.map(doc=>`
        <div class="document-view-item">
          <div class="document-info">
            <strong>${esc(doc.name||doc.title||'document.pdf')}</strong>
            <span>${formatFileSize(doc.size)}</span>
          </div>
          <div class="document-actions">
            <button type="button" class="btn" data-cmd="open-pdf" data-id="${esc(doc.id)}">View PDF</button>
            <button type="button" class="btn btn-primary" data-cmd="download-pdf" data-id="${esc(doc.id)}">Download PDF</button>
          </div>
        </div>`).join('')}
      </div>
    </label>`:'';
  const show=(label,value,full=false)=>`<label${full?' class="full"':''}><span class="k">${esc(label)}</span><strong class="view-field">${value===''||value===undefined||value===null?'—':esc(value)}</strong></label>`;
  const rows=[show('Type',r.type),show('Category',r.category),show('Subcategory',r.subcategory),show('Date',fmtDate(r.date))];
  schema.fields.forEach(f=>rows.push(show(f.label,f.type==='money'?(r[f.key]?formatMoney(r[f.key]):''):r[f.key])));
  const shown=new Set(schema.fields.map(f=>f.key));
  ['purchaseValue','currentMarketValue'].forEach(k=>{if(!shown.has(k)&&r[k])rows.push(show(k==='purchaseValue'?'Purchase Value':'Current Market Value',formatMoney(r[k])))});
  rows.push(show('Amount / Balance',formatMoney(recordAmount(r))));
  rows.push(show('Details / Description',r.details||r.description||'',true));
  if(r.remarks)rows.push(show('Remarks',r.remarks,true));
  document.getElementById('recordFormFields').innerHTML=`<div class="form-grid">${rows.join('')}${documentSection}</div>`;
  document.querySelector('#recordForm .modal-foot').innerHTML='<button type="button" class="btn" data-close-modal>Close</button>';
  document.querySelectorAll('#recordForm [data-close-modal]').forEach(button=>button.onclick=()=>document.getElementById('recordModal').close());
  document.getElementById('recordModal').showModal();
}

/* ==========================================================================
   Records page & balance sheet
   ========================================================================== */
function renderRecordSections(){
  const search=(document.getElementById('recordSearch')?.value||'').toLowerCase();
  const type=document.getElementById('recordTypeFilter')?.value||'';
  let records=state.records.filter(r=>!search||Object.values(r).some(v=>String(v).toLowerCase().includes(search)));
  if(type)records=records.filter(r=>r.type===type);
  records.sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
  const render=(items)=>items.map((r,i)=>{
    const meta=recordMeta(r);
    const id=esc(r.id);
    return `<div class="record-item" style="--i:${Math.min(i,14)}"><div><h4>${esc(recordTitle(r))}</h4><p>${esc(r.category)} · ${esc(r.subcategory)}${r.incomeYear?' · '+esc(r.incomeYear):''}</p>${meta?`<p>${esc(meta)}</p>`:''}</div><div class="record-amount"><strong>${formatMoney(recordAmount(r))}</strong><p>${esc(fmtDate(r.date))}</p></div>${docsOf(r).length?`<div class="record-docs">${docChips(r,3)}</div>`:''}<div class="record-actions"><button type="button" class="action-link" data-cmd="view-record" data-id="${id}">View</button><button type="button" class="action-link" data-cmd="edit-record" data-id="${id}">Edit</button><button type="button" class="action-link danger" data-cmd="delete-record" data-id="${id}">Delete</button></div></div>`;
  }).join('');
  const assets=records.filter(r=>r.type==='Asset'),liabilities=records.filter(r=>r.type==='Liability');
  document.getElementById('assetRecordCount').textContent=`${assets.length} records`;
  document.getElementById('liabilityRecordCount').textContent=`${liabilities.length} records`;
  document.getElementById('assetList').innerHTML=render(assets)||'<div class="empty-state">No asset records.</div>';
  document.getElementById('liabilityList').innerHTML=render(liabilities)||'<div class="empty-state">No liability records.</div>';
}

/** Income Year match used by the Balance Sheet: incomeYear equality ('2025-26' == '2025-2026'),
 *  or - for records without an Income Year - a date inside that fiscal year. */
function recordMatchesYear(r,year){
  if(!year)return true;
  if(r.incomeYear)return normIncomeYear(r.incomeYear)===normIncomeYear(year);
  const fy=fiscalRange(year);
  return !!(r.date&&fy&&inRange(r.date,fy.from,fy.to));
}
let balanceYear='';          // '' = All Income Years
let balanceYearChosen=false; // until the user picks a year, default to the newest year that has data

function orderedCategories(type){
  // Only live categories count: a category the user deleted must not reappear on the balance sheet.
  // Defaults are used solely as a fallback before the classification tree has been created.
  const source=state.categories.length?state.categories.filter(c=>c.type===type):defaultCategories.filter(c=>c.type===type);
  const names=[...new Set(source.map(c=>c.name))];
  return names.map(name=>{
    const found=source.find(c=>c.name===name);
    return {name,subcategories:[...(found?.subcategories||[])]};
  });
}
/** Category -> Subcategory structure of the balance sheet for one Income Year. */
function buildBalanceData(year){
  const records=state.records.filter(r=>(r.type==='Asset'||r.type==='Liability')&&recordMatchesYear(r,year));
  const section=type=>{
    const cats=orderedCategories(type).map(c=>{
      const recs=records.filter(r=>r.type===type&&r.category===c.name);
      const subNames=[...c.subcategories];
      recs.forEach(r=>{if(!subNames.includes(r.subcategory))subNames.push(r.subcategory)});
      const subs=subNames.map(n=>{
        const list=recs.filter(r=>r.subcategory===n);
        return {name:n,count:list.length,total:list.reduce((s,r)=>s+recordAmount(r),0)};
      });
      return {name:c.name,subs,count:recs.length,total:subs.reduce((s,x)=>s+x.total,0)};
    });
    return {cats,total:cats.reduce((s,c)=>s+c.total,0)};
  };
  const assets=section('Asset'),liabilities=section('Liability');
  return {assets,liabilities,net:assets.total-liabilities.total,count:records.length};
}

function renderBalance(){
  const yearSelect=document.getElementById('balanceYear');
  const years=dashYearOptions();
  if(!balanceYearChosen){
    balanceYear=years.find(y=>state.records.some(r=>recordMatchesYear(r,y)))||'';
  }
  if(balanceYear&&!years.includes(balanceYear))balanceYear='';
  yearSelect.innerHTML=`<option value="">All Income Years</option>${years.map(y=>`<option value="${esc(y)}" ${y===balanceYear?'selected':''}>${esc(y)}</option>`).join('')}`;
  yearSelect.value=balanceYear;
  const data=buildBalanceData(balanceYear);
  const range=balanceYear?fiscalRange(balanceYear):null;
  const section=(title,sec)=>{
    const rows=sec.cats.map(c=>`<tr class="cat-row"><td>${esc(c.name)}</td><td>${formatMoney(c.total)}</td></tr>`+
      c.subs.map(sub=>`<tr class="sub-row"><td>${esc(sub.name)}</td><td>${formatMoney(sub.total)}</td></tr>`).join('')).join('');
    return `<table class="balance-table"><tbody><tr class="total section-title"><td>${title}</td><td></td></tr>${rows}<tr class="total"><td>Total ${title}</td><td>${formatMoney(sec.total)}</td></tr></tbody></table>`;
  };
  document.getElementById('balanceSheet').innerHTML=`<div class="balance-header"><h2>Personal Balance Sheet</h2><p>${balanceYear?`Income Year ${esc(balanceYear)}${range?` · ${esc(fmtDate(range.from))} to ${esc(fmtDate(range.to))}`:''}`:'All Income Years'}</p></div>
    ${section('ASSETS',data.assets)}
    ${section('LIABILITIES',data.liabilities)}
    <table class="balance-table"><tbody><tr class="total net-worth-row"><td>NET WORTH</td><td>${formatMoney(data.net)}</td></tr></tbody></table>`;
}

function openCategoryModal(){
  document.getElementById('categoryModal').showModal();
  renderCategoryTree();
}
function renderCategoryTree(){
  const tree=state.categories.map(c=>{
    const id=esc(c.id);
    const subs=c.subcategories.map(s=>`<span>${esc(s)} <button type="button" class="action-link" data-cmd="rename-subcategory" data-id="${id}" data-name="${esc(s)}">Edit</button> <button type="button" class="action-link danger" data-cmd="delete-subcategory" data-id="${id}" data-name="${esc(s)}" aria-label="Delete subcategory ${esc(s)}">×</button></span>`).join('');
    return `<div class="category-group"><strong>${esc(c.type)} · ${esc(c.name)} <button type="button" class="action-link" data-cmd="rename-category" data-id="${id}">Edit</button></strong>${subs}<button type="button" class="action-link danger" data-cmd="delete-category" data-id="${id}">Delete Category</button></div>`;
  }).join('');
  document.getElementById('categoryTree').innerHTML=tree;
}
async function addCategory(event){
  event.preventDefault();
  const type=document.getElementById('categoryType').value;
  const name=document.getElementById('categoryName').value.trim();
  const subcategory=document.getElementById('subcategoryName').value.trim();
  if(!name||!subcategory){toast('Enter both a category and a subcategory name.',true);return}
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
  if(!category)return;
  const linked=state.records.some(r=>r.type===category.type&&r.category===category.name);
  if(linked){toast('This category has linked records and cannot be deleted.',true);return}
  if(await confirm(`Delete category "${category.name}" and all of its subcategories?`,`Delete Category`)){
    await remove('categories',id);await loadState();renderCategoryTree();renderAll();toast('Category deleted');
  }
}

async function renameCategory(id){
  const category=state.categories.find(c=>c.id===id);if(!category)return;
  const name=prompt('Edit category name:',category.name);
  if(!name||name.trim()===category.name)return;
  const newName=name.trim(),oldName=category.name;
  category.name=newName;
  await put('categories',category);
  for(const record of state.records.filter(r=>r.type===category.type&&r.category===oldName)){record.category=newName;await put('records',record)}
  // keep the PDF metadata in step, or a backup would file the document under the old category
  for(const doc of state.documents.filter(d=>d.financialType===category.type&&d.category===oldName)){doc.category=newName;await put('documents',doc)}
  await loadState();renderCategoryTree();renderAll();toast('Category renamed');
}
async function renameSubcategory(categoryId,oldName){
  const category=state.categories.find(c=>c.id===categoryId);if(!category||!oldName)return;
  const name=prompt('Edit subcategory name:',oldName);
  if(!name||name.trim()===oldName)return;
  const newName=name.trim();
  category.subcategories=category.subcategories.map(s=>s===oldName?newName:s);
  await put('categories',category);
  for(const record of state.records.filter(r=>r.type===category.type&&r.category===category.name&&r.subcategory===oldName)){record.subcategory=newName;await put('records',record)}
  for(const doc of state.documents.filter(d=>d.financialType===category.type&&d.category===category.name&&d.subcategory===oldName)){doc.subcategory=newName;await put('documents',doc)}
  await loadState();renderCategoryTree();renderAll();toast('Subcategory renamed');
}
async function deleteSubcategory(categoryId,name){
  const category=state.categories.find(c=>c.id===categoryId);if(!category||!name)return;
  if(category.subcategories.length<=1){toast('A category needs at least one subcategory. Add another one first.',true);return}
  const linked=state.records.some(r=>r.type===category.type&&r.category===category.name&&r.subcategory===name);
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
  renderStorageInfo();
}
function renderYearList(){
  document.getElementById('yearList').innerHTML=(state.settings.incomeYears||[]).map(y=>`<span class="chip">${esc(y)} <button type="button" class="action-link danger" data-cmd="delete-year" data-id="${esc(y)}" aria-label="Delete income year ${esc(y)}">×</button></span>`).join('');
}
/** Storage pressure is the main long-term risk for an offline-first app; show it honestly. */
async function renderStorageInfo(){
  const label=document.getElementById('storageInfo'),bar=document.getElementById('storageBar');
  if(!label)return;
  const counts=`${state.records.length} record${state.records.length===1?'':'s'} · ${state.documents.length} PDF${state.documents.length===1?'':'s'}`;
  if(!navigator.storage||!navigator.storage.estimate){label.textContent=counts;return}
  try{
    const {usage=0,quota=0}=await navigator.storage.estimate();
    label.textContent=`${formatFileSize(usage)} of ${formatFileSize(quota)} used · ${counts}`;
    if(bar)bar.style.width=`${quota?Math.min(100,(usage/quota)*100):0}%`;
  }catch(e){label.textContent=counts}
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
  try{
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
    for(const doc of state.documents){
      const bytes=await getDocBlob(doc.id);                 // read each PDF only while it is being written
      if(bytes)folder.file(`${doc.financialType==='Liability'?'liabilities':'assets'}/${doc.id}-${doc.name||'document.pdf'}`,bytes);
    }
    const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE'});
    const fileName=`Personal-Finance-Backup-${new Date().toISOString().replace(/[:.]/g,'-')}.zip`;
    await saveFile(blob,fileName);                         // deliver the file first - history is secondary
    try{                                                   // metadata only: storing every ZIP again would exhaust browser storage
      await put('backupHistory',{id:uid('backup'),date:backup.backupDate,fileName,size:blob.size,recordCount:state.records.length,documentCount:state.documents.length});
      await loadState();renderBackupHistory();
    }catch(historyError){console.warn('Backup history not saved',historyError)}
    toast('Full backup created and downloaded');
  }catch(error){
    console.error(error);toast(`Backup failed: ${error.message||error}`,true);
  }
}
function renderBackupHistory(){
  const history=state.backupHistory.slice().sort((a,b)=>String(b.date).localeCompare(String(a.date)));
  document.getElementById('backupTable').innerHTML=`<thead><tr><th scope="col">Backup Date</th><th scope="col">File Name</th><th scope="col">Records</th><th scope="col">Documents</th><th scope="col">File Size</th></tr></thead><tbody>${history.map(b=>`<tr><td>${esc(new Date(b.date).toLocaleString())}</td><td>${esc(b.fileName)}</td><td>${b.recordCount||0}</td><td>${b.documentCount||0}</td><td>${formatFileSize(b.size)}</td></tr>`).join('')||'<tr><td colspan="5"><div class="empty-state">No backups created in this browser yet.</div></td></tr>'}</tbody>`;
}
const MAX_RESTORE_BYTES=250*1024*1024;
async function performRestore(){
  if(!restoreFile)return;
  const mode=document.querySelector('input[name="restoreMode"]:checked')?.value||'replace';
  document.getElementById('restoreModal').close();
  if(!window.JSZip){toast('ZIP library is unavailable.',true);return}
  if(restoreFile.size>MAX_RESTORE_BYTES){toast('That backup file is too large to restore safely.',true);restoreFile=null;document.getElementById('restoreFile').value='';return}
  try{
    const zip=await JSZip.loadAsync(restoreFile);
    const backupFile=zip.file('backup.json');if(!backupFile)throw new Error('Missing backup.json');
    const backup=JSON.parse(await backupFile.async('text'));
    if(!backup.records||!backup.categories||backup.version!==undefined&&Number.parseFloat(backup.version)<1)throw new Error('Unsupported or invalid backup format');
    const documents=(backup.documents||[]).map(doc=>{const clean=Object.assign({},doc);delete clean.blob;return clean});
    // Read every PDF into memory BEFORE touching the database, so a broken archive cannot
    // destroy good local data.
    const blobs=[];
    const paths=Object.keys(zip.files).filter(p=>p.startsWith('documents/')&&!zip.files[p].dir);
    for(const path of paths){
      const entry=documents.find(d=>path.includes(d.id));
      if(!entry)continue;
      const bytes=await zip.files[path].async('blob');
      blobs.push({id:entry.id,blob:new Blob([bytes],{type:'application/pdf'})});
    }

    if(mode==='replace'){
      // One transaction per store: a quota failure leaves that store untouched instead of half written.
      await replaceStore('categories',backup.categories||[]);
      await replaceStore('records',backup.records||[]);
      await replaceStore('documents',documents);
      await replaceStore('documentBlobs',blobs);
    }else{
      for(const category of backup.categories||[]){if(!await getOne('categories',category.id))await put('categories',category)}
      for(const record of backup.records||[]){if(!await getOne('records',record.id))await put('records',record)}
      for(const document of documents){if(!await getOne('documents',document.id))await put('documents',document)}
      for(const blob of blobs){if(!await getOne('documentBlobs',blob.id))await put('documentBlobs',blob)}
    }
    for(const [key,value] of Object.entries(backup.settings||{}))await put('settings',{key,value});
    await loadState();
    state.settings=(await getAll('settings')).reduce((out,s)=>(out[s.key]=s.value,out),state.settings||{});
    renderAll();
    toast(`Backup restored: ${backup.records?.length||0} record(s) and ${blobs.length} document(s)`);
  }catch(error){
    console.error(error);toast(error.message||'Unable to restore backup.',true);
  }finally{
    restoreFile=null;document.getElementById('restoreFile').value='';
  }
}


function exportBalanceExcel(){
  if(!window.XLSX){toast('Excel library is unavailable.',true);return}
  const year=balanceYear||'';
  const data=buildBalanceData(year);
  const rows=[['Personal Balance Sheet'],[year?`Income Year: ${year}`:'All Income Years'],[`Generated ${generatedStamp()}`],[],['Particulars','Amount / Balance']];
  const bold=[];
  const block=(title,sec)=>{
    rows.push([title,'']);
    sec.cats.forEach(c=>{
      rows.push([c.name,c.total]);
      c.subs.forEach(sub=>rows.push([`      ${sub.name}`,sub.total]));
    });
    rows.push([`Total ${title}`,sec.total]);
    const idx=rows.length-1;rows.push([]);return idx;
  };
  const aRow=block('ASSETS',data.assets),lRow=block('LIABILITIES',data.liabilities);
  rows.push(['NET WORTH',data.net]);
  const ws=XLSX.utils.aoa_to_sheet(rows);
  rows.forEach((r,i)=>{if(typeof r[1]==='number'){const addr=XLSX.utils.encode_cell({r:i,c:1});ws[addr].z='#,##0.00'}});
  const netAddr=XLSX.utils.encode_cell({r:rows.length-1,c:1});
  ws[netAddr]={t:'n',v:data.net,f:`B${aRow+1}-B${lRow+1}`,z:'#,##0.00'};
  ws['!cols']=[{wch:48},{wch:22}];
  const workbook=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook,ws,'Balance Sheet');
  XLSX.writeFile(workbook,`Balance-Sheet-${year||'All-Years'}-${todayISO()}.xlsx`);
  toast('Balance Sheet exported');
}

/* ==========================================================================
   Excel: flat export + schema-driven import (header rows detected per sheet)
   ========================================================================== */
function exportFilteredExcel(){
  if(!window.XLSX){toast('Excel library is unavailable. Check your internet connection.',true);return}
  const records=getFilteredRecords();
  const rows=records.map(r=>({
    Type:r.type,Category:r.category,Subcategory:r.subcategory,Date:r.date||'',Particulars:r.particulars||r.name||'',
    Details:r.details||r.description||'','Detail / Account':r.detailRef||r.accountDetail||'','Income Year':r.incomeYear||'',
    'Property Category':r.propertyCategory||'','Item Category':r.itemCategory||'','Type of Acquisition':r.acquisition||'',
    'Area':r.area||'','Registration No.':r.registrationNo||'','Engine Capacity':r.engineCapacity||'','Quantity / Weight':r.quantity||'',
    'Purchase Value':Number(r.purchaseValue||0),'Current Market Value':Number(r.currentMarketValue||0),
    'Amount / Balance':recordAmount(r),Remarks:r.remarks||'',Documents:(r.documentIds||[]).length
  }));
  const workbook=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook,XLSX.utils.json_to_sheet(rows),'Filtered Records');
  XLSX.writeFile(workbook,`Financial-Records-${todayISO()}.xlsx`);
  toast('Excel data exported');
}

const nrm=s=>String(s??'').replace(/\s+/g,' ').trim().toLowerCase();

function parseExcelNumber(value){
  if(typeof value==='number')return Number.isFinite(value)?value:0;
  if(!value)return 0;
  const cleaned=String(value).replace(/[,৳$€£\s]/g,'').trim();
  const number=Number(cleaned);
  return Number.isFinite(number)?number:0;
}
function normalizeExcelDate(value){
  if(value===''||value===null||value===undefined)return '';
  if(value instanceof Date&&!Number.isNaN(value.getTime()))return `${value.getFullYear()}-${pad2(value.getMonth()+1)}-${pad2(value.getDate())}`;
  if(typeof value==='number'){
    if(value<=0)return '';
    // Excel's date part is the integer portion of the serial; rounding a timestamp would shift the day.
    const serial=Math.floor(value);
    const date=new Date(Math.round((serial-25569)*86400*1000));
    return Number.isNaN(date.getTime())?'':date.toISOString().slice(0,10);
  }
  const s=String(value).trim();
  let m=s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(m)return `${m[1]}-${m[2]}-${m[3]}`;
  // 3-part loose dates: d/m/yyyy is the local convention, but a value above 12 can only be
  // the day, so m/d/yyyy files are detected instead of silently swapping day and month.
  m=s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if(m){
    let day=+m[1],month=+m[2];
    if(month>12&&day<=12){const swap=day;day=month;month=swap}
    if(day<1||day>31||month<1||month>12)return '';
    return `${m[3]}-${pad2(month)}-${pad2(day)}`;
  }
  const date=new Date(s);
  return Number.isNaN(date.getTime())?'':`${date.getFullYear()}-${pad2(date.getMonth()+1)}-${pad2(date.getDate())}`;
}

function findSchemaBySheet(sheetName){
  const n=nrm(sheetName);
  return SCHEMAS.find(s=>{const target=nrm(s.sheet);return target===n||(n.length>=28&&target.startsWith(n))});
}
function schemaImportColumns(schema){
  const cols=[];
  if(schema.hasDate)cols.push({key:'date',aliases:['date']});
  schema.fields.forEach(f=>cols.push({key:f.key,aliases:f.excel||[],type:f.type,norm:f.normalize}));
  if(schema.detailsExcel)cols.push({key:'details',aliases:schema.detailsExcel});
  if(schema.amountExcel.length)cols.push({key:'amount',aliases:schema.amountExcel,type:'money'});
  return cols;
}
function findLastUpdated(aoa){
  for(const row of aoa){
    for(let c=0;c<(row||[]).length;c++){
      if(nrm(row[c])==='last updated'){
        for(let k=c+1;k<row.length;k++){const d=normalizeExcelDate(row[k]);if(d)return d}
      }
    }
  }
  return '';
}

/**
 * Pure mapping of one worksheet (array-of-arrays) to records.
 * The header row is located by matching the schema's column names (rows 11-14 depending on the sheet);
 * only the leftmost occurrence of each header is used, so helper tables on the right are ignored,
 * and reading stops at the "Total" row.
 */
function mapSheetToRecords(schema,aoa){
  const cols=schemaImportColumns(schema);
  let headerRow=-1,map=null;
  for(let i=0;i<Math.min(aoa.length,40);i++){
    const cells=(aoa[i]||[]).map(nrm),found={};let hits=0;
    cols.forEach(c=>{const idx=cells.findIndex(x=>c.aliases.includes(x));if(idx>=0){found[c.key]=idx;hits++}});
    if(hits>=2){headerRow=i;map=found;break}
  }
  if(headerRow<0)return {records:[],headerRow:-1};
  const idxs=Object.values(map),minC=Math.min(...idxs),maxC=Math.max(...idxs);
  const lastUpdated=findLastUpdated(aoa);
  const records=[];
  for(let r=headerRow+1;r<aoa.length;r++){
    const row=aoa[r]||[];
    let isTotal=false;
    for(let c=Math.max(0,minC-1);c<=maxC;c++){if(nrm(row[c])==='total'){isTotal=true;break}}
    if(isTotal)break;
    const raw={};let meaningful=false;
    for(const c of cols){
      if(!(c.key in map))continue;
      const value=row[map[c.key]];
      if(c.key==='date'){raw.date=normalizeExcelDate(value)}
      else if(c.type==='money'){const n=parseExcelNumber(value);raw[c.key]=n;if(n!==0)meaningful=true}
      else{
        let s=String(value??'').trim();
        if(/^#(VALUE|REF|N\/A|NAME|DIV)/i.test(s))s='';
        if(c.norm)s=c.norm(s);
        raw[c.key]=s;
        if(s&&c.key!=='incomeYear')meaningful=true;
      }
    }
    if(!meaningful)continue;
    const date=schema.hasDate?(raw.date||''):lastUpdated;
    const record={
      type:schema.type,category:schema.category,subcategory:schema.subcategory,date,
      details:raw.details||'',documentIds:[],sourceSheet:schema.sheet,sourceRow:r+1
    };
    for(const f of schema.fields){
      if(f.type==='money')record[f.key]=raw[f.key]||0;
      else if(raw[f.key]!==undefined)record[f.key]=raw[f.key];
    }
    let amount=raw.amount||0;
    if(schema.amountSync==='market')amount=record.currentMarketValue||record.purchaseValue||0;
    if(schema.amountSync==='purchase')record.purchaseValue=amount;
    record.amount=amount;record.balance=amount;
    if(!record.incomeYear){const fy=fiscalYearFromDate(date);if(fy)record.incomeYear=fy}
    records.push(record);
  }
  return {records,headerRow};
}

const MAX_IMPORT_BYTES=30*1024*1024;      // bounds the work an untrusted workbook can cause
const MAX_IMPORT_ROWS=20000;
async function importExcel(event){
  const file=event.target.files[0];if(!file)return;
  if(!window.XLSX){toast('Excel library is unavailable.',true);event.target.value='';return}
  if(file.size>MAX_IMPORT_BYTES){toast('That workbook is larger than 30 MB. Split it and import the parts.',true);event.target.value='';return}
  try{
    const workbook=XLSX.read(await file.arrayBuffer(),{type:'array'});
    const seen=new Set(state.records.filter(r=>r.sourceSheet).map(r=>`${r.sourceSheet}|${r.sourceRow}`));
    const toSave=[],years=new Set();
    let skippedDuplicates=0,manual=0,truncated=0;
    const summary=[];
    for(const sheetName of workbook.SheetNames){
      if(/balance sheet/i.test(sheetName))continue;
      const schema=findSchemaBySheet(sheetName);
      if(!schema){manual++;continue}
      const aoa=XLSX.utils.sheet_to_json(workbook.Sheets[sheetName],{header:1,defval:'',raw:true});
      if(aoa.length>MAX_IMPORT_ROWS){aoa.length=MAX_IMPORT_ROWS;truncated++}
      const {records,headerRow}=mapSheetToRecords(schema,aoa);
      if(headerRow<0){manual++;continue}
      let count=0;
      for(const record of records){
        const key=`${record.sourceSheet}|${record.sourceRow}`;
        if(seen.has(key)){skippedDuplicates++;continue}
        seen.add(key);
        record.id=uid('record');record.updatedAt=new Date().toISOString();
        if(record.incomeYear)years.add(record.incomeYear);
        toSave.push(record);count++;
      }
      summary.push(`${schema.subcategory}: ${count}`);
    }
    // make sure every imported category exists in the classification tree
    const newCategories=[];
    for(const r of toSave){
      let category=state.categories.find(c=>c.type===r.type&&c.name===r.category)||newCategories.find(c=>c.type===r.type&&c.name===r.category);
      if(!category){category={id:uid('category'),type:r.type,name:r.category,subcategories:[]};newCategories.push(category)}
      if(!category.subcategories.includes(r.subcategory)){category.subcategories.push(r.subcategory);if(!newCategories.includes(category))newCategories.push(category)}
    }
    if(newCategories.length)await putMany('categories',newCategories);
    if(toSave.length)await putMany('records',toSave);
    const knownYears=new Set(state.settings.incomeYears||[]);
    if([...years].some(y=>!knownYears.has(y))){
      state.settings.incomeYears=[...new Set([...knownYears,...years])].sort((a,b)=>String(b).localeCompare(String(a)));
      await put('settings',{key:'incomeYears',value:state.settings.incomeYears});
    }
    await loadState();renderAll();
    const truncatedNote=truncated?` ${truncated} sheet(s) were read up to ${MAX_IMPORT_ROWS} rows.`:'';
    toast(`Import complete: ${toSave.length} imported, ${skippedDuplicates} duplicate(s) skipped, ${manual} sheet(s) need manual review.${truncatedNote}`,manual>0&&!toSave.length);
    console.info('Excel import summary',summary);
  }catch(error){
    console.error(error);toast(error.message||'Unable to import workbook.',true);
  }finally{
    event.target.value='';
  }
}

/* ==========================================================================
   Filter-wise reports (PDF via jsPDF + AutoTable, Excel via SheetJS)
   ========================================================================== */
function describeFilters(){
  const f=dashFilters;
  const range=(f.from||f.to)?`${fmtDate(f.from)||'Any'} to ${fmtDate(f.to)||'Any'}`:'All dates';
  return [
    ['Type',f.type||'All'],['Category',f.category||'All'],['Subcategory',f.subcategory||'All'],
    ['Income Year',f.year||'All'],['Date Range',range]
  ];
}
const filterText=()=>describeFilters().map(([k,v])=>`${k}: ${v}`).join('   |   ');
function generatedStamp(){
  const d=new Date();
  return `${pad2(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function reportDetailsLabel(schema){
  return /^Excel:/.test(schema.detailsHint||'')?schema.detailsHint.replace(/^Excel:\s*/,''):'Details / Description';
}

/** Records -> [{type,category,tables:[{name,records,cols}],total,count,orient}] (Assets first, then Liabilities). */
function groupRecordsForReport(records){
  const order=[...defaultCategories,...state.categories].map(c=>`${c.type}|${c.name}`);
  const map=new Map();
  records.forEach(r=>{
    const key=`${r.type}|${r.category}`;
    if(!map.has(key))map.set(key,{type:r.type,category:r.category,records:[]});
    map.get(key).records.push(r);
  });
  const rank=g=>{const i=order.indexOf(`${g.type}|${g.category}`);return i<0?999:i};
  const groups=[...map.values()].sort((a,b)=>(a.type===b.type?0:a.type==='Asset'?-1:1)||rank(a)-rank(b)||a.category.localeCompare(b.category));
  groups.forEach(g=>{
    const catDef=state.categories.find(c=>c.type===g.type&&c.name===g.category);
    const subOrder=catDef?.subcategories||[];
    const subs=new Map();
    g.records.forEach(r=>{if(!subs.has(r.subcategory))subs.set(r.subcategory,[]);subs.get(r.subcategory).push(r)});
    g.tables=[...subs.entries()]
      .sort((a,b)=>{const ia=subOrder.indexOf(a[0]),ib=subOrder.indexOf(b[0]);return (ia<0?999:ia)-(ib<0?999:ib)||a[0].localeCompare(b[0])})
      .map(([name,recs])=>{
        recs.sort((a,b)=>String(a.date||'').localeCompare(String(b.date||''))||recordTitle(a).localeCompare(recordTitle(b)));
        return {name,records:recs,schema:getSchema(g.category,name),cols:reportColumns(getSchema(g.category,name),recs),total:recs.reduce((s,r)=>s+recordAmount(r),0)};
      });
    g.total=g.tables.reduce((s,t)=>s+t.total,0);
    g.count=g.records.length;
    g.orient=Math.max(...g.tables.map(t=>t.cols.length))>5?'l':'p';
  });
  return groups;
}
/** Date first · schema columns (only those with data) in the middle · Amount / Balance last. */
function reportColumns(schema,recs){
  const mids=schema.fields.map(f=>({key:f.key,label:f.label,kind:f.type==='money'?'money':'text',required:f.required}));
  mids.splice(Math.min(schema.detailsAfter,mids.length),0,{key:'details',label:reportDetailsLabel(schema),kind:'text',required:schema.detailsRequired});
  const keep=mids.filter(c=>c.required||recs.some(r=>c.kind==='money'?Number(r[c.key])>0:String(r[c.key]??'').trim()!==''));
  return [{key:'date',label:'Date',kind:'date'},...keep,{key:'amount',label:'Amount / Balance',kind:'amount'}];
}
function pdfMoney(value){
  const prefix={BDT:'BDT ',USD:'$',EUR:'EUR ',GBP:'GBP '}[state.settings.currency||'BDT']||'BDT ';  // built-in PDF fonts cannot draw the taka sign
  return prefix+(Number(value)||0).toLocaleString(state.settings.locale||'en-BD',{minimumFractionDigits:2,maximumFractionDigits:2});
}
function reportCell(r,col){
  if(col.key==='date')return fmtDate(r.date)||'-';
  if(col.key==='amount')return pdfMoney(recordAmount(r));
  if(col.kind==='money')return Number(r[col.key])?pdfMoney(r[col.key]):'-';
  const v=String(r[col.key]??'').trim();
  return v||'-';
}

async function generatePdfReport(){
  const records=getFilteredRecords();
  if(!records.length){toast('No records match the current filters.',true);return}
  const JsPDF=window.jspdf&&window.jspdf.jsPDF;
  if(!JsPDF){toast('PDF library is unavailable. Check your internet connection.',true);return}
  const groups=groupRecordsForReport(records);
  const doc=new JsPDF({orientation:groups[0].orient,unit:'pt',format:'a4',compress:true});
  if(typeof doc.autoTable!=='function'){toast('PDF table plugin is unavailable. Check your internet connection.',true);return}
  doc.setProperties({title:'Personal Finance - Financial Report',subject:filterText(),creator:'SOIKOT RAIHAN'});

  const M=36,HEAD_H=132,FOOT_H=34;
  let orient=groups[0].orient;
  const nativeAddPage=doc.addPage.bind(doc);
  doc.addPage=(format,o)=>nativeAddPage(format||'a4',o||orient);   // AutoTable's own page breaks keep this category's orientation
  const drawn=new Set();
  const pageNo=()=>doc.internal.getCurrentPageInfo().pageNumber;
  const size=()=>({W:doc.internal.pageSize.getWidth(),H:doc.internal.pageSize.getHeight()});
  const stamp=generatedStamp();
  const palette={
    Asset:{fill:[236,253,245],accent:[16,185,129],ink:[6,95,70]},
    Liability:{fill:[255,241,242],accent:[244,63,94],ink:[159,18,57]},
    Summary:{fill:[238,242,255],accent:[79,70,229],ink:[49,46,129]}
  };

  function drawHeader(banner){
    const {W}=size();
    doc.setFillColor(79,70,229);doc.rect(0,0,W,42,'F');
    doc.setFillColor(16,185,129);doc.rect(0,42,W,3,'F');
    doc.setTextColor(255,255,255);doc.setFont('helvetica','bold');doc.setFontSize(14);
    doc.setDrawColor(255,255,255);doc.setLineWidth(1.3);doc.circle(M+14,22,14,'S');   // SR monogram
    doc.setFont('times','bold');doc.setFontSize(12);doc.text('SR',M+14,26.5,{align:'center'});
    doc.setFont('helvetica','bold');doc.setFontSize(14);
    doc.text('Personal Finance  |  Financial Report',M+38,27);
    doc.setFont('helvetica','normal');doc.setFontSize(8.5);
    doc.text(`Generated ${stamp}`,W-M,27,{align:'right'});
    doc.setTextColor(100,116,139);doc.setFontSize(8);
    doc.text(doc.splitTextToSize(filterText(),W-2*M).slice(0,2),M,62);
    const p=palette[banner.kind];
    doc.setFillColor(...p.fill);doc.roundedRect(M,80,W-2*M,40,6,6,'F');
    doc.setFillColor(...p.accent);doc.roundedRect(M,80,5,40,2,2,'F');
    doc.setTextColor(...p.ink);doc.setFont('helvetica','bold');doc.setFontSize(13);
    doc.text(banner.title,M+16,98);
    doc.setFont('helvetica','normal');doc.setFontSize(8.5);doc.setTextColor(71,85,105);
    doc.text(doc.splitTextToSize(banner.sub||'',W-2*M-170)[0]||'',M+16,112);
    doc.setFont('helvetica','bold');doc.setFontSize(9);doc.setTextColor(...p.ink);
    doc.text(banner.tag||'',W-M-12,98,{align:'right'});
    drawn.add(pageNo());
  }
  const bannerFor=(g,continued)=>({
    kind:g.type,title:`${g.type.toUpperCase()}  >  ${g.category}`,
    sub:g.tables.map(t=>`${t.name} (${t.records.length})`).join('  |  '),
    tag:continued?'(continued)':`${g.count} record${g.count===1?'':'s'}`
  });
  const baseStyles={font:'helvetica',fontSize:8.5,cellPadding:{top:5,bottom:5,left:6,right:6},lineColor:[226,232,240],lineWidth:.5,textColor:[30,41,59],valign:'middle',overflow:'linebreak'};
  const margin={top:HEAD_H,left:M,right:M,bottom:FOOT_H};

  groups.forEach((g,gi)=>{
    orient=g.orient;
    if(gi>0)doc.addPage('a4',g.orient);
    drawHeader(bannerFor(g,false));
    let y=HEAD_H;
    const onPage=()=>{if(!drawn.has(pageNo()))drawHeader(bannerFor(g,true))};
    g.tables.forEach(t=>{
      if(y>size().H-FOOT_H-120){doc.addPage();drawHeader(bannerFor(g,true));y=HEAD_H}
      const n=t.cols.length,single=g.tables.length===1;
      const numeric=c=>c.kind==='amount'||c.kind==='money';
      const columnStyles={};
      t.cols.forEach((c,i)=>{
        if(c.kind==='date')columnStyles[i]={cellWidth:62};
        if(c.kind==='amount')columnStyles[i]={halign:'right',fontStyle:'bold',cellWidth:96};
        if(c.kind==='money')columnStyles[i]={halign:'right',cellWidth:86};
      });
      doc.autoTable({
        startY:y,theme:'grid',margin,styles:baseStyles,columnStyles,
        head:[
          [{content:`${t.name}   -   ${t.records.length} record${t.records.length===1?'':'s'}`,colSpan:n,styles:{halign:'left',fillColor:[238,242,255],textColor:[49,46,129],fontStyle:'bold',fontSize:9,cellPadding:{top:6,bottom:6,left:8,right:6}}}],
          t.cols.map(c=>({content:c.label,styles:{halign:numeric(c)?'right':'left'}}))
        ],
        body:t.records.map(r=>t.cols.map(c=>reportCell(r,c))),
        foot:[[{content:single?`Category Subtotal - ${g.category}`:`Subtotal - ${t.name}`,colSpan:n-1,styles:{halign:'right'}},{content:pdfMoney(t.total),styles:{halign:'right'}}]],
        headStyles:{fillColor:[15,23,42],textColor:[255,255,255],fontStyle:'bold',fontSize:8.5},
        footStyles:{fillColor:[241,245,249],textColor:[15,23,42],fontStyle:'bold',lineColor:[99,102,241],lineWidth:.8},
        alternateRowStyles:{fillColor:[248,250,252]},
        showHead:'everyPage',showFoot:'lastPage',rowPageBreak:'avoid',
        didDrawPage:onPage
      });
      y=doc.lastAutoTable.finalY+14;
    });
    if(g.tables.length>1){
      if(y>size().H-FOOT_H-60){doc.addPage();drawHeader(bannerFor(g,true));y=HEAD_H}
      const {W}=size();
      doc.autoTable({
        startY:y,theme:'grid',margin,tableWidth:W-2*M,didDrawPage:onPage,
        body:[[{content:`Category Subtotal - ${g.category}`,styles:{halign:'right'}},{content:pdfMoney(g.total),styles:{halign:'right'}}]],
        columnStyles:{1:{cellWidth:140}},
        styles:{...baseStyles,fontStyle:'bold',fontSize:10,fillColor:[238,242,255],textColor:[49,46,129],lineColor:[99,102,241],lineWidth:1}
      });
    }
  });

  // Grand summary (always portrait, last page)
  orient='p';
  doc.addPage('a4','p');
  const assetTotal=groups.filter(g=>g.type==='Asset').reduce((s,g)=>s+g.total,0);
  const liabTotal=groups.filter(g=>g.type==='Liability').reduce((s,g)=>s+g.total,0);
  const hasA=groups.some(g=>g.type==='Asset'),hasL=groups.some(g=>g.type==='Liability');
  drawHeader({kind:'Summary',title:'GRAND SUMMARY',sub:`${groups.length} categor${groups.length===1?'y':'ies'} · ${records.length} record${records.length===1?'':'s'}`,tag:pdfMoney(hasA&&hasL?assetTotal-liabTotal:hasA?assetTotal:liabTotal)});
  const totalRow=(label,value,fill,ink)=>[{content:label,colSpan:3,styles:{halign:'right',fontStyle:'bold',fillColor:fill,textColor:ink}},{content:pdfMoney(value),styles:{halign:'right',fontStyle:'bold',fillColor:fill,textColor:ink}}];
  const body=[];
  ['Asset','Liability'].forEach(type=>{
    const list=groups.filter(g=>g.type===type);
    list.forEach(g=>body.push([type,g.category,String(g.count),{content:pdfMoney(g.total),styles:{halign:'right'}}]));
    if(list.length)body.push(totalRow(type==='Asset'?'Total Assets':'Total Liabilities',type==='Asset'?assetTotal:liabTotal,type==='Asset'?[209,250,229]:[255,228,230],type==='Asset'?[6,95,70]:[159,18,57]));
  });
  if(hasA&&hasL)body.push(totalRow('NET WORTH',assetTotal-liabTotal,[49,46,129],[255,255,255]));
  doc.autoTable({
    startY:HEAD_H,theme:'grid',margin,styles:{...baseStyles,fontSize:9.5,cellPadding:7},
    head:[['Type','Category','Records',{content:'Amount / Balance',styles:{halign:'right'}}]],
    body,headStyles:{fillColor:[15,23,42],textColor:[255,255,255],fontStyle:'bold'},
    alternateRowStyles:{fillColor:[248,250,252]},
    columnStyles:{2:{halign:'center',cellWidth:60},3:{cellWidth:130}},
    didDrawPage:()=>{if(!drawn.has(pageNo()))drawHeader({kind:'Summary',title:'GRAND SUMMARY',sub:'(continued)',tag:''})}
  });

  // Footers: "Page X of Y"
  const total=doc.getNumberOfPages();
  for(let i=1;i<=total;i++){
    doc.setPage(i);
    const {W,H}=size();
    doc.setDrawColor(226,232,240);doc.setLineWidth(.6);doc.line(M,H-26,W-M,H-26);
    doc.setFont('helvetica','normal');doc.setFontSize(8);doc.setTextColor(100,116,139);
    doc.text('Personal Finance  ·  SOIKOT RAIHAN',M,H-13);
    doc.text(`Page ${i} of ${total}`,W-M,H-13,{align:'right'});
  }
  doc.save(`Personal-Finance-Report-${dashFilters.year||'All-Years'}-${todayISO()}.pdf`);
  toast(`PDF report generated (${total} page${total===1?'':'s'})`);
}

const excelSerial=iso=>{
  const m=String(iso||'').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m?Math.round((Date.UTC(+m[1],+m[2]-1,+m[3])-Date.UTC(1899,11,30))/86400000):null;
};
function safeSheetName(name,used){
  const base=String(name).replace(/[\\\/\?\*\[\]:]/g,' ').replace(/\s+/g,' ').trim().slice(0,27)||'Sheet';
  let candidate=base,i=2;
  while(used.has(candidate.toLowerCase()))candidate=`${base.slice(0,24)} ${i++}`;
  used.add(candidate.toLowerCase());
  return candidate;
}
const MONEY_FMT='#,##0.00';
/** Builds a worksheet from a plain array-of-arrays, then applies number formats / formulas / merges. */
function makeSheet(rows,{widths=[],merges=[],money=[],dates=[],formulas=[]}={}){
  const ws=XLSX.utils.aoa_to_sheet(rows);
  const addr=(r,c)=>XLSX.utils.encode_cell({r,c});
  money.forEach(([r,c])=>{const a=addr(r,c);if(ws[a]){ws[a].t='n';ws[a].z=MONEY_FMT}});
  dates.forEach(([r,c])=>{const a=addr(r,c);if(ws[a]){ws[a].t='n';ws[a].z='dd-mmm-yyyy'}});
  formulas.forEach(([r,c,f,v])=>{ws[addr(r,c)]={t:'n',v,f,z:MONEY_FMT}});
  ws['!cols']=widths.map(w=>({wch:w}));
  if(merges.length)ws['!merges']=merges.map(([r1,c1,r2,c2])=>({s:{r:r1,c:c1},e:{r:r2,c:c2}}));
  return ws;
}
const plainMoney=v=>Number(v)||0;
const reportCellValue=(r,c)=>{
  if(c.key==='date')return excelSerial(r.date)||'';
  if(c.key==='amount')return recordAmount(r);
  if(c.kind==='money')return Number(r[c.key])||'';
  return String(r[c.key]??'').trim();
};

/**
 * Excel report - same structure as the PDF report:
 *  Summary sheet + one sheet per Category. Each sheet: subcategory banner -> column header row
 *  (Date first, specific columns in the middle, Amount / Balance last) -> data rows -> SUM subtotal,
 *  then a Category Subtotal.
 */
function generateExcelReport(){
  const records=getFilteredRecords();
  if(!records.length){toast('No records match the current filters.',true);return}
  if(!window.XLSX){toast('Excel library is unavailable. Check your internet connection.',true);return}
  const groups=groupRecordsForReport(records);
  const used=new Set(['summary']);
  const stamp=generatedStamp();
  const q=name=>`'${name.replace(/'/g,"''")}'`;
  const colName=XLSX.utils.encode_col;
  const sheets=[];                 // [{name, ws}] category sheets
  const refs=[];                   // cell references for the Summary sheet

  groups.forEach(g=>{
    const maxCols=Math.max(...g.tables.map(t=>t.cols.length));
    const rows=[
      ['Personal Finance - Financial Report'],
      [`${g.type} > ${g.category}`],
      [filterText()],
      [`Generated ${stamp}`],
      []
    ];
    const opts={widths:new Array(maxCols).fill(12),merges:[],money:[],dates:[],formulas:[]};
    const subtotalRefs=[],subRefs=[];
    const single=g.tables.length===1;
    const sheetName=safeSheetName(g.category,used);

    g.tables.forEach(t=>{
      const n=t.cols.length,amountIdx=n-1,letter=colName(amountIdx);
      // banner row
      const bannerRow=rows.length;
      rows.push([`${t.name}  -  ${t.records.length} record${t.records.length===1?'':'s'}`]);
      opts.merges.push([bannerRow,0,bannerRow,Math.max(n-1,1)]);
      // header row
      rows.push(t.cols.map(c=>c.label));
      const firstData=rows.length;           // 0-based index of the first data row
      t.records.forEach(r=>{
        const rowIndex=rows.length;
        rows.push(t.cols.map((c,ci)=>{
          const v=reportCellValue(r,c);
          if(c.key==='date'&&v!=='')opts.dates.push([rowIndex,ci]);
          if((c.kind==='money'||c.kind==='amount')&&v!=='')opts.money.push([rowIndex,ci]);
          return v;
        }));
      });
      const lastData=rows.length-1;
      // subtotal row (formula + cached value)
      const subRow=new Array(n).fill('');
      subRow[n-2>=0?n-2:0]=single?`Category Subtotal - ${g.category}`:`Subtotal - ${t.name}`;
      const subIndex=rows.length;
      rows.push(subRow);
      opts.formulas.push([subIndex,amountIdx,`SUM(${letter}${firstData+1}:${letter}${lastData+1})`,plainMoney(t.total)]);
      subtotalRefs.push(`${letter}${subIndex+1}`);
      subRefs.push({name:t.name,count:t.records.length,cell:`${letter}${subIndex+1}`});
      rows.push([]);
      // column widths: widest content per column index across all tables of this sheet
      t.cols.forEach((c,ci)=>{
        const longest=Math.max(c.label.length,...t.records.map(r=>{const v=reportCellValue(r,c);return c.key==='date'?11:String(v).length}));
        const cap=c.kind==='amount'||c.kind==='money'?22:48;
        opts.widths[ci]=Math.max(opts.widths[ci],Math.min(cap,longest+3));
      });
    });

    let totalCellRef;
    if(single){
      totalCellRef=subtotalRefs[0];
    }else{
      const lastCol=maxCols-1;
      const totalRow=new Array(maxCols).fill('');
      totalRow[Math.max(lastCol-1,0)]=`Category Subtotal - ${g.category}`;
      const idx=rows.length;
      rows.push(totalRow);
      // amount column of the category total = last column of the widest table; subtotals sit in each table's own last column
      opts.formulas.push([idx,lastCol,subtotalRefs.join('+'),plainMoney(g.total)]);
      totalCellRef=`${colName(lastCol)}${idx+1}`;
    }
    sheets.push({name:sheetName,ws:makeSheet(rows,opts)});
    refs.push({g,sheet:sheetName,total:totalCellRef,subs:subRefs.map(s=>({...s,sheet:sheetName}))});
  });

  // ---- Summary sheet ----
  const rows=[['Personal Finance - Financial Report'],['Applied filters'],...describeFilters().map(([k,v])=>[k,v]),[`Generated ${stamp}`],[],
    ['Type','Category','Subcategory','Records','Amount / Balance']];
  const opts={widths:[12,26,46,10,22],money:[],formulas:[]};
  const catRowIndex=[];
  refs.forEach(({g,sheet,total,subs})=>{
    const idx=rows.length;
    rows.push([g.type,g.category,'All subcategories',g.count,'']);
    opts.formulas.push([idx,4,`${q(sheet)}!${total}`,plainMoney(g.total)]);
    catRowIndex.push({type:g.type,idx});
    subs.forEach(s=>{
      const si=rows.length;
      rows.push(['','','   '+s.name,s.count,'']);
      opts.formulas.push([si,4,`${q(sheet)}!${s.cell}`,plainMoney(g.tables.find(t=>t.name===s.name).total)]);
    });
  });
  const assetTotal=groups.filter(g=>g.type==='Asset').reduce((s,g)=>s+g.total,0);
  const liabTotal=groups.filter(g=>g.type==='Liability').reduce((s,g)=>s+g.total,0);
  const hasA=groups.some(g=>g.type==='Asset'),hasL=groups.some(g=>g.type==='Liability');
  const sumOf=type=>catRowIndex.filter(c=>c.type===type).map(c=>`E${c.idx+1}`).join('+');
  rows.push([]);
  let assetIdx=-1,liabIdx=-1;
  if(hasA){assetIdx=rows.length;rows.push(['','','Total Assets','','']);opts.formulas.push([assetIdx,4,sumOf('Asset'),plainMoney(assetTotal)])}
  if(hasL){liabIdx=rows.length;rows.push(['','','Total Liabilities','','']);opts.formulas.push([liabIdx,4,sumOf('Liability'),plainMoney(liabTotal)])}
  if(hasA&&hasL){const i=rows.length;rows.push(['','','NET WORTH','','']);opts.formulas.push([i,4,`E${assetIdx+1}-E${liabIdx+1}`,plainMoney(assetTotal-liabTotal)])}

  const workbook=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook,makeSheet(rows,opts),'Summary');
  sheets.forEach(s=>XLSX.utils.book_append_sheet(workbook,s.ws,s.name));
  XLSX.writeFile(workbook,`Personal-Finance-Report-${dashFilters.year||'All-Years'}-${todayISO()}.xlsx`);
  toast(`Excel report generated (${sheets.length+1} sheets)`);
}

/* ==========================================================================
   PWA: service worker + install prompt
   ========================================================================== */
/** Persistent "new version" bar: a toast disappears before the user can act on it. */
function showUpdateBanner(worker){
  let banner=document.getElementById('updateBanner');
  if(!banner){
    banner=document.createElement('div');
    banner.id='updateBanner';
    banner.className='update-banner';
    banner.setAttribute('role','status');
    const text=document.createElement('span');
    text.textContent='A new version is available.';
    const reload=document.createElement('button');
    reload.type='button';reload.className='btn btn-primary';reload.textContent='Reload';
    reload.onclick=()=>{try{worker.postMessage('SKIP_WAITING')}catch(e){}setTimeout(()=>location.reload(),150)};
    const dismiss=document.createElement('button');
    dismiss.type='button';dismiss.className='update-dismiss';dismiss.setAttribute('aria-label','Dismiss update notice');dismiss.textContent='×';
    dismiss.onclick=()=>banner.remove();
    banner.append(text,reload,dismiss);
    document.body.appendChild(banner);
  }
}
function setupPWA(){
  if('serviceWorker' in navigator&&/^https?:$/.test(location.protocol)){
    navigator.serviceWorker.register('sw.js').then(reg=>{
      reg.addEventListener('updatefound',()=>{
        const worker=reg.installing;
        if(worker)worker.addEventListener('statechange',()=>{
          if(worker.state==='installed'&&navigator.serviceWorker.controller)showUpdateBanner(worker);
        });
      });
    }).catch(error=>console.warn('Service worker registration failed',error));
  }
  const buttons=[$el('installBtn'),$el('installBtnSettings')];
  const setVisible=v=>buttons.forEach(b=>b.classList.toggle('hidden',!v));
  const standalone=window.matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
  const ios=/iphone|ipad|ipod/i.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  window.addEventListener('beforeinstallprompt',event=>{
    event.preventDefault();deferredInstallPrompt=event;setVisible(true);
  });
  window.addEventListener('appinstalled',()=>{deferredInstallPrompt=null;setVisible(false);toast('Personal Finance installed')});
  const install=async()=>{
    if(deferredInstallPrompt){
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice.catch(()=>null);
      deferredInstallPrompt=null;setVisible(false);
    }else if(ios){
      toast('On iPhone/iPad: tap Share, then "Add to Home Screen".');
    }
  };
  buttons.forEach(b=>b.onclick=install);
  if(standalone){
    $el('installHint').textContent='Personal Finance is running as an installed app.';
  }else if(ios){
    setVisible(true);
    $el('installHint').textContent='On iPhone/iPad: tap the Share button in Safari, then choose "Add to Home Screen".';
  }
}

init().catch(showFatal);
