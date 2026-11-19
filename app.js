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
let currentPdfViewerUrl = null;
let deferredInstallPrompt = null;

const defaultCategories = [
  { id: 'c-cash', type: 'Asset', name: 'Cash', subcategories: ['Savings Accounts', 'Cash in Hand'] },
  { id: 'c-investments', type: 'Asset', name: 'Investments', subcategories: ['CPF', 'Group Insurance & Welfare Fund (GI&WF)', 'Other Investment / Co-operation'] },
  { id: 'c-property', type: 'Asset', name: 'Property', subcategories: ['Land & Primary Residence', 'Vehicles', 'Jewelry', 'Other Property'] },
  { id: 'c-retirement', type: 'Asset', name: 'Retirement', subcategories: ['Gratuity'] },
  { id: 'c-other-assets', type: 'Asset', name: 'Other Assets', subcategories: ['Furniture, Electronics & Equipments', 'Accounts Receivable'] },
  { id: 'c-payable', type: 'Liability', name: 'Accounts Payable', subcategories: ['Accounts Payable'] },
  { id: 'c-bank-loan', type: 'Liability', name: 'Bank Loan', subcategories: ['Bank Loan'] },
  { id: 'c-other-liabilities', type: 'Liability', name: 'Other Liabilities', subcategories: ['Other Liabilities'] }
];

// Excel Sheet-Driven Dynamic Field Schemas
// Common fields always rendered: Financial Type, Category, Subcategory, Date, Details / Description, Amount / Balance, Document (PDF)
const SUBCATEGORY_SCHEMAS = {
  'Cash|Cash in Hand': {
    sheet: 'Cash-CIH',
    extraFields: [
      { key: 'particulars', label: 'Cash Asset Name', type: 'text', placeholder: 'e.g. Cash In Hand, Bkash', required: true }
    ]
  },
  'Cash|Savings Accounts': {
    sheet: 'Cash-Savings Accounts',
    extraFields: [
      { key: 'particulars', label: 'Bank Name', type: 'text', placeholder: 'e.g. BASIC Bank Limited', required: true },
      { key: 'accountDetail', label: 'Account Detail', type: 'text', placeholder: 'e.g. 2914010014942' }
    ]
  },
  'Investments|CPF': {
    sheet: 'Investment-CPF',
    extraFields: [
      { key: 'particulars', label: 'Particulars', type: 'text', placeholder: 'e.g. CPF Own, CPF Company', required: true },
      { key: 'referenceDetail', label: 'Detail / Employee ID', type: 'text', placeholder: 'e.g. #1089' },
      { key: 'incomeYear', label: 'Income Year', type: 'incomeYear' }
    ]
  },
  'Investments|Group Insurance & Welfare Fund (GI&WF)': {
    sheet: 'Investment-GI&WF',
    extraFields: [
      { key: 'particulars', label: 'Particulars', type: 'text', placeholder: 'e.g. Group Insurance Premium', required: true },
      { key: 'referenceDetail', label: 'Detail / Reference ID', type: 'text', placeholder: 'e.g. #1089' },
      { key: 'incomeYear', label: 'Income Year', type: 'incomeYear' }
    ]
  },
  'Investments|Other Investment / Co-operation': {
    sheet: 'Investment-Co-oP',
    extraFields: [
      { key: 'particulars', label: 'Particulars', type: 'text', placeholder: 'e.g. 2022-23 Batch Co-op', required: true },
      { key: 'incomeYear', label: 'Income Year', type: 'incomeYear' }
    ]
  },
  'Property|Land & Primary Residence': {
    sheet: 'Property-Land',
    extraFields: [
      { key: 'propertyCategory', label: 'Property Category', type: 'select', options: ['Non-Agricultural', 'Advance Made for Non-Agricultural Property', 'Agricultural'] },
      { key: 'acquisitionType', label: 'Type of Acquisition', type: 'select', options: ['Purchased', 'Gift', 'Inheritance'] },
      { key: 'incomeYear', label: 'Income Year', type: 'incomeYear' },
      { key: 'area', label: 'Area of the Property', type: 'text', placeholder: 'e.g. 5 Decimal / 3 Katha' },
      { key: 'purchaseValue', label: 'Purchase Value', type: 'number', placeholder: '0.00' },
      { key: 'currentMarketValue', label: 'Current Market Value', type: 'number', placeholder: '0.00' }
    ]
  },
  'Property|Vehicles': {
    sheet: 'Property-Vehicles',
    extraFields: [
      { key: 'particulars', label: 'Type and Particulars', type: 'text', placeholder: 'e.g. Motorcycle, Car', required: true },
      { key: 'registrationNo', label: 'Registration No.', type: 'text', placeholder: 'e.g. Jashore Metro-La-12-3456' },
      { key: 'engineCapacity', label: 'Engine Capacity', type: 'text', placeholder: 'e.g. 150 CC' },
      { key: 'incomeYear', label: 'Income Year', type: 'incomeYear' }
    ]
  },
  'Property|Jewelry': {
    sheet: 'Property-Jewelry',
    extraFields: [
      { key: 'particulars', label: 'Particulars', type: 'text', placeholder: 'e.g. Gold Ring, Necklace', required: true },
      { key: 'gramWeight', label: 'Amount (Gram & Karat)', type: 'text', placeholder: 'e.g. 2.75 Gram (21)' },
      { key: 'incomeYear', label: 'Income Year', type: 'incomeYear' }
    ]
  },
  'Property|Other Property': {
    sheet: 'Property-Other Property',
    extraFields: [
      { key: 'particulars', label: 'Particulars', type: 'text', placeholder: 'Property Name', required: true },
      { key: 'incomeYear', label: 'Income Year', type: 'incomeYear' }
    ]
  },
  'Retirement|Gratuity': {
    sheet: 'Retirement-Gratuity',
    extraFields: [
      { key: 'particulars', label: 'Institution', type: 'text', placeholder: 'e.g. PGCL', required: true }
    ]
  },
  'Other Assets|Furniture, Electronics & Equipments': {
    sheet: 'Other Assets-Furniture',
    extraFields: [
      { key: 'particulars', label: 'Particulars', type: 'text', placeholder: 'e.g. Laptop, Box Bed', required: true },
      { key: 'itemCategory', label: 'Item Category', type: 'select', options: ['Furniture', 'Electronics', 'Equipments'] },
      { key: 'acquisitionType', label: 'Type of Acquisition', type: 'select', options: ['Purchased', 'Gift', 'Inheritance'] },
      { key: 'incomeYear', label: 'Income Year', type: 'incomeYear' },
      { key: 'quantity', label: 'Quantity / Units', type: 'text', placeholder: 'e.g. 1' }
    ]
  },
  'Other Assets|Accounts Receivable': {
    sheet: 'Other Assets-Accounts Receivabl',
    extraFields: [
      { key: 'particulars', label: 'Debtor', type: 'text', placeholder: 'Debtor Name', required: true },
      { key: 'incomeYear', label: 'Income Year', type: 'incomeYear' }
    ]
  },
  'Accounts Payable|Accounts Payable': {
    sheet: 'Liabilities-Payable',
    extraFields: [
      { key: 'particulars', label: 'Payee', type: 'text', placeholder: 'Payee Name', required: true },
      { key: 'incomeYear', label: 'Income Year', type: 'incomeYear' }
    ]
  },
  'Bank Loan|Bank Loan': {
    sheet: 'Liabilities-Bank Loan',
    extraFields: [
      { key: 'particulars', label: 'Bank', type: 'text', placeholder: 'Bank Name', required: true },
      { key: 'incomeYear', label: 'Income Year', type: 'incomeYear' }
    ]
  },
  'Other Liabilities|Other Liabilities': {
    sheet: 'Liabilities-Other Liabilities',
    extraFields: [
      { key: 'particulars', label: 'Particulars', type: 'text', placeholder: 'Liability Particulars', required: true },
      { key: 'incomeYear', label: 'Income Year', type: 'incomeYear' }
    ]
  }
};

function getSubcategorySchema(category, subcategory) {
  return SUBCATEGORY_SCHEMAS[`${category}|${subcategory}`] || {
    sheet: 'Custom',
    extraFields: [
      { key: 'particulars', label: 'Particulars / Name', type: 'text', required: true },
      { key: 'incomeYear', label: 'Income Year', type: 'incomeYear' }
    ]
  };
}

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = event => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains('records')) database.createObjectStore('records', { keyPath: 'id' });
      if (!database.objectStoreNames.contains('categories')) database.createObjectStore('categories', { keyPath: 'id' });
      if (!database.objectStoreNames.contains('documents')) database.createObjectStore('documents', { keyPath: 'id' });
      if (!database.objectStoreNames.contains('settings')) database.createObjectStore('settings', { keyPath: 'key' });
      if (!database.objectStoreNames.contains('backupHistory')) database.createObjectStore('backupHistory', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx(store, mode = 'readonly') {
  return db.transaction(store, mode).objectStore(store);
}
function getAll(store) {
  return new Promise((resolve, reject) => {
    const request = tx(store).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}
function put(store, value) {
  return new Promise((resolve, reject) => {
    const request = tx(store, 'readwrite').put(value);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function remove(store, key) {
  return new Promise((resolve, reject) => {
    const request = tx(store, 'readwrite').delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
function clearStore(store) {
  return new Promise((resolve, reject) => {
    const request = tx(store, 'readwrite').clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

const uid = prefix => `${prefix}-${crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2)}`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function registerPWA() {
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstallPrompt = e;
    document.getElementById('installAppTop')?.classList.remove('hidden');
    document.getElementById('installAppSide')?.classList.remove('hidden');
  });
  const triggerInstall = async () => {
    if (!deferredInstallPrompt) {
      toast('Use your browser menu ("Add to Home Screen") to install as a Mobile App.');
      return;
    }
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    if (choice.outcome === 'accepted') {
      toast('AssetBook installed as a Mobile App!');
    }
    deferredInstallPrompt = null;
    document.getElementById('installAppTop')?.classList.add('hidden');
    document.getElementById('installAppSide')?.classList.add('hidden');
  };
  document.getElementById('installAppTop').onclick = triggerInstall;
  document.getElementById('installAppSide').onclick = triggerInstall;
}

async function init() {
  registerPWA();
  db = await openDB();
  let categories = await getAll('categories');
  if (!categories.length) {
    for (const category of defaultCategories) await put('categories', category);
  }
  await loadState();
  const settings = await getAll('settings');
  state.settings = settings.reduce((out, item) => (out[item.key] = item.value, out), {});
  state.settings.currency ||= 'BDT';
  state.settings.locale ||= 'en-BD';
  state.settings.incomeYears ||= ['2026-27', '2025-26', '2024-25', '2023-24', '2022-23'];
  bindNavigation();
  bindGlobalActions();
  renderAll();
}

async function loadState() {
  state.records = await getAll('records');
  state.categories = await getAll('categories');
  state.documents = await getAll('documents');
  state.backupHistory = await getAll('backupHistory');
}

function toast(message, error = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' error' : '');
  el.textContent = message;
  document.getElementById('toastRegion').appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

function confirm(message, title = 'Confirm Action') {
  return new Promise(resolve => {
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmMessage').textContent = message;
    confirmAction = resolve;
    document.getElementById('confirmModal').showModal();
  });
}

function switchPage(pageName) {
  document.querySelectorAll('.nav-item, .m-nav-item').forEach(b => {
    b.classList.toggle('active', b.dataset.page === pageName);
  });
  document.querySelectorAll('[data-page-panel]').forEach(p => {
    p.classList.add('hidden');
    p.classList.remove('page-enter');
  });
  const target = document.getElementById(pageName + 'Page');
  if (target) {
    target.classList.remove('hidden');
    void target.offsetWidth;
    target.classList.add('page-enter');
  }
  const titles = {
    dashboard: ['Dashboard', 'Real-time wealth overview & financial analytics'],
    records: ['Assets & Liabilities', 'Manage categorized financial records'],
    balance: ['Balance Sheet', 'Consolidated financial position'],
    backup: ['Data Backup & Restore', 'Portable encrypted-ready ZIP vault'],
    settings: ['Settings', 'Application preferences & Excel migration']
  };
  if (titles[pageName]) {
    document.getElementById('pageTitle').textContent = titles[pageName][0];
    document.getElementById('pageSubtitle').textContent = titles[pageName][1];
  }
  closeSidebar();
  if (pageName === 'balance') renderBalance();
  if (pageName === 'backup') renderBackupHistory();
  if (pageName === 'settings') renderSettings();
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarBackdrop').classList.remove('show');
}

function bindNavigation() {
  document.querySelectorAll('.nav-item, .m-nav-item').forEach(button => {
    button.onclick = () => switchPage(button.dataset.page);
  });
  document.getElementById('menuToggle').onclick = () => {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('sidebarBackdrop').classList.toggle('show');
  };
  document.getElementById('sidebarBackdrop').onclick = closeSidebar;
}

function bindGlobalActions() {
  document.getElementById('quickAdd').onclick = () => openRecordModal();
  document.getElementById('mobileQuickAdd').onclick = () => openRecordModal();
  document.getElementById('addRecordBtn').onclick = () => openRecordModal();
  document.getElementById('recordSearch').oninput = renderRecordSections;
  document.getElementById('recordTypeFilter').onchange = renderRecordSections;
  document.getElementById('dashboardSearch').oninput = () => { dashboardPage = 1; renderDashboardTable(); };
  document.getElementById('exportFiltered').onclick = exportFilteredExcel;
  document.getElementById('generatePdfReport').onclick = generateFilteredPdfReport;
  document.getElementById('printDashboard').onclick = () => window.print();
  document.getElementById('printBalance').onclick = () => window.print();
  document.getElementById('exportBalanceExcel').onclick = exportBalanceExcel;
  document.getElementById('balanceYear').onchange = renderBalance;
  document.getElementById('balanceMode').onchange = renderBalance;
  document.querySelectorAll('[data-close-modal]').forEach(button => {
    button.onclick = () => {
      const dlg = button.closest('dialog');
      if (dlg.id === 'pdfViewerModal') cleanupPdfViewer();
      dlg.close();
    };
  });
  document.getElementById('confirmCancel').onclick = () => { document.getElementById('confirmModal').close(); if (confirmAction) confirmAction(false); };
  document.getElementById('confirmOk').onclick = () => { document.getElementById('confirmModal').close(); if (confirmAction) confirmAction(true); };
  document.getElementById('recordForm').onsubmit = saveRecord;
  document.getElementById('replaceDocumentFile').onchange = replaceDocumentFile;
  document.getElementById('createBackup').onclick = createBackup;
  document.getElementById('restoreBackup').onclick = () => document.getElementById('restoreFile').click();
  document.getElementById('restoreFile').onchange = e => { restoreFile = e.target.files[0]; if (restoreFile) document.getElementById('restoreModal').showModal(); };
  document.getElementById('confirmRestore').onclick = performRestore;
  document.getElementById('saveSettings').onclick = saveSettings;
  document.getElementById('addYear').onclick = addIncomeYear;
  document.getElementById('manageCategories').onclick = () => openCategoryModal();
  document.getElementById('categoryForm').onsubmit = addCategory;
  document.getElementById('importExcel').onclick = () => document.getElementById('excelImport').click();
  document.getElementById('excelImport').onchange = importExcel;
}

function renderAll() {
  renderDashboardFilters();
  renderDashboard();
  renderRecordSections();
  renderSettings();
  renderBackupHistory();
  renderBalance();
}

function getCurrencySymbol() {
  return { BDT: '৳', USD: '$', EUR: '€', GBP: '£' }[state.settings.currency || 'BDT'] || '৳';
}
function getPdfCurrencyPrefix() {
  // jsPDF standard fonts support ASCII cleanly; use BDT / USD / EUR / GBP for crisp PDF alignment
  return { BDT: 'BDT ', USD: '$', EUR: 'EUR ', GBP: 'GBP ' }[state.settings.currency || 'BDT'] || 'BDT ';
}
function formatMoney(value) {
  const number = Number(value) || 0;
  const locale = state.settings.locale || 'en-BD';
  return `${getCurrencySymbol()}${number.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function formatPdfMoney(value) {
  const number = Number(value) || 0;
  return `${getPdfCurrencyPrefix()}${number.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function recordAmount(record) {
  if (!record) return 0;
  return Number(record.amount ?? record.balance ?? record.currentMarketValue ?? record.outstandingBalance ?? record.purchaseValue ?? 0);
}

const dashFilters = { type: '', category: '', subcategory: '', year: '', from: '', to: '' };

function dashCategoryNames(type) {
  return state.categories
    .filter(c => !type || c.type === type)
    .map(c => c.name)
    .filter((v, i, a) => a.indexOf(v) === i);
}
function dashSubcategoryNames(type, category) {
  return state.categories
    .filter(c => (!type || c.type === type) && (!category || c.name === category))
    .flatMap(c => c.subcategories || [])
    .filter((v, i, a) => a.indexOf(v) === i);
}
function dashYearOptions() {
  return [...new Set([...(state.settings.incomeYears || []), ...state.records.map(r => String(r.incomeYear || '')).filter(Boolean)])]
    .sort((a, b) => String(b).localeCompare(String(a)));
}

// Compute Bangladesh Income Year Date Range (July 1 to June 30)
function computeIncomeYearRange(yearStr) {
  if (!yearStr) return { from: '', to: '' };
  const match = String(yearStr).trim().match(/^(\d{4})(?:\s*[-/]\s*(\d{2,4}))?$/);
  if (!match) return { from: '', to: '' };
  const startYear = parseInt(match[1], 10);
  const endYear = startYear + 1;
  return {
    from: `${startYear}-07-01`,
    to: `${endYear}-06-30`
  };
}

function renderDashboardFilters() {
  const host = document.getElementById('dashboardFilters');
  const categories = dashCategoryNames(dashFilters.type);
  if (!categories.includes(dashFilters.category)) dashFilters.category = '';
  const subcategories = dashSubcategoryNames(dashFilters.type, dashFilters.category);
  if (!subcategories.includes(dashFilters.subcategory)) dashFilters.subcategory = '';
  const years = dashYearOptions();
  if (!years.includes(dashFilters.year)) dashFilters.year = '';
  const option = (value, label, selected, disabled = false) => `<option value="${esc(value)}" ${selected ? 'selected' : ''} ${disabled ? 'disabled' : ''}>${esc(label)}</option>`;

  host.innerHTML = `<div class="filter-row">
    <div class="filter-group">
      <label for="dashType">Financial Type</label>
      <select id="dashType">${option('', 'All Types', !dashFilters.type)}${option('Asset', 'Assets', dashFilters.type === 'Asset')}${option('Liability', 'Liabilities', dashFilters.type === 'Liability')}</select>
    </div>
    <div class="filter-group">
      <label for="dashCategory">Category</label>
      <select id="dashCategory" ${categories.length ? '' : 'disabled'}>${option('', 'All Categories', !dashFilters.category)}${categories.map(c => option(c, c, dashFilters.category === c)).join('')}</select>
    </div>
    <div class="filter-group">
      <label for="dashSubcategory">Subcategory</label>
      <select id="dashSubcategory" ${subcategories.length ? '' : 'disabled'}>${option('', 'All Subcategories', !dashFilters.subcategory)}${subcategories.map(s => option(s, s, dashFilters.subcategory === s)).join('')}</select>
    </div>
    <div class="filter-group">
      <label for="dashYear">Income Year</label>
      <select id="dashYear">${option('', 'All Income Years', !dashFilters.year)}${years.map(y => option(y, y, dashFilters.year === y)).join('')}</select>
    </div>
    <div class="filter-group">
      <label for="dashDateFrom">Start Date</label>
      <input id="dashDateFrom" type="date" value="${esc(dashFilters.from)}">
    </div>
    <div class="filter-group">
      <label for="dashDateTo">End Date</label>
      <input id="dashDateTo" type="date" value="${esc(dashFilters.to)}">
    </div>
  </div>`;

  const rerender = () => { dashboardPage = 1; renderDashboardFilters(); renderDashboard(); };
  const bind = (id, key, followUp) => {
    const el = document.getElementById(id);
    el.onchange = () => {
      dashFilters[key] = el.value;
      if (followUp) {
        followUp();
        rerender();
      } else {
        dashboardPage = 1;
        renderDashboard();
      }
    };
  };
  bind('dashType', 'type', () => { dashFilters.category = ''; dashFilters.subcategory = ''; });
  bind('dashCategory', 'category', () => { dashFilters.subcategory = ''; });
  bind('dashSubcategory', 'subcategory');
  bind('dashYear', 'year', () => {
    const range = computeIncomeYearRange(dashFilters.year);
    dashFilters.from = range.from;
    dashFilters.to = range.to;
  });
  bind('dashDateFrom', 'from');
  bind('dashDateTo', 'to');
}

function getFilteredRecords() {
  let records = [...state.records];
  const { type, category, subcategory, year, from, to } = dashFilters;
  if (type) records = records.filter(r => r.type === type);
  if (category) records = records.filter(r => r.category === category);
  if (subcategory) records = records.filter(r => r.subcategory === subcategory);
  if (year) {
    records = records.filter(r => {
      if (r.incomeYear) return String(r.incomeYear) === year;
      if (r.date && from && to) return r.date >= from && r.date <= to;
      return false;
    });
  }
  if (from) records = records.filter(r => !r.date || r.date >= from);
  if (to) records = records.filter(r => !r.date || r.date <= to);
  return records;
}

function animateCounter(el, targetValue, isMoney = true) {
  if (!el) return;
  const duration = 520;
  const startTime = performance.now();
  const step = now => {
    const progress = Math.min((now - startTime) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const val = targetValue * eased;
    el.textContent = isMoney ? formatMoney(val) : Math.round(val);
    if (progress < 1) requestAnimationFrame(step);
    else el.textContent = isMoney ? formatMoney(targetValue) : targetValue;
  };
  requestAnimationFrame(step);
}

function renderDashboard() {
  const records = getFilteredRecords();
  const assets = records.filter(r => r.type === 'Asset').reduce((sum, r) => sum + recordAmount(r), 0);
  const liabilities = records.filter(r => r.type === 'Liability').reduce((sum, r) => sum + recordAmount(r), 0);
  const assetCategories = new Set(records.filter(r => r.type === 'Asset').map(r => r.category)).size;
  const liabilityCategories = new Set(records.filter(r => r.type === 'Liability').map(r => r.category)).size;
  const documentCount = new Set(records.flatMap(r => r.documentIds || [])).size;

  const cards = [
    ['▰', 'Total Assets', assets, true],
    ['▱', 'Total Liabilities', liabilities, true],
    ['◆', 'Net Worth', assets - liabilities, true],
    ['▦', 'Asset Categories', assetCategories, false],
    ['▦', 'Liability Categories', liabilityCategories, false],
    ['▤', 'Attached PDFs', documentCount, false]
  ];
  const container = document.getElementById('summaryCards');
  container.innerHTML = cards.map((c, idx) => `
    <div class="summary-card">
      <div class="summary-icon">${c[0]}</div>
      <div><p>${c[1]}</p><strong id="kpiVal_${idx}">${c[3] ? formatMoney(c[2]) : c[2]}</strong></div>
    </div>`).join('');

  cards.forEach((c, idx) => animateCounter(document.getElementById(`kpiVal_${idx}`), c[2], c[3]));
  renderCharts(records);
  renderDashboardTable();
}

function destroyChart(id) { if (charts[id]) { charts[id].destroy(); delete charts[id]; } }
function renderCharts(records) {
  const assets = records.filter(r => r.type === 'Asset').reduce((sum, r) => sum + recordAmount(r), 0);
  const liabilities = records.filter(r => r.type === 'Liability').reduce((sum, r) => sum + recordAmount(r), 0);
  destroyChart('comparisonChart'); destroyChart('assetsChart'); destroyChart('liabilitiesChart'); destroyChart('netWorthChart');
  if (!window.Chart) return;
  Chart.defaults.font.family = "'Plus Jakarta Sans', sans-serif";
  charts.comparisonChart = new Chart(document.getElementById('comparisonChart'), {
    type: 'doughnut',
    data: { labels: ['Assets', 'Liabilities'], datasets: [{ data: [assets, liabilities], backgroundColor: ['#10b981', '#f43f5e'], borderWidth: 0 }] },
    options: { maintainAspectRatio: false, cutout: '66%', plugins: { legend: { position: 'bottom' } } }
  });
  const group = type => Object.entries(records.filter(r => r.type === type).reduce((out, r) => { out[r.category] = (out[r.category] || 0) + recordAmount(r); return out; }, {}));
  const assetsGroup = group('Asset'), liabilitiesGroup = group('Liability');
  charts.assetsChart = new Chart(document.getElementById('assetsChart'), {
    type: 'bar',
    data: { labels: assetsGroup.map(x => x[0]), datasets: [{ data: assetsGroup.map(x => x[1]), backgroundColor: '#4f46e5', borderRadius: 8 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } } }
  });
  charts.liabilitiesChart = new Chart(document.getElementById('liabilitiesChart'), {
    type: 'pie',
    data: { labels: liabilitiesGroup.map(x => x[0]), datasets: [{ data: liabilitiesGroup.map(x => x[1]), backgroundColor: ['#f43f5e', '#f59e0b', '#6366f1', '#14b8a6'], borderWidth: 0 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
  });
  const byYear = [...new Set(records.map(r => String(r.incomeYear || '')).filter(Boolean))].sort();
  const trend = byYear.map(year => {
    const yearRecords = records.filter(r => String(r.incomeYear || '') === year);
    const a = yearRecords.filter(r => r.type === 'Asset').reduce((s, r) => s + recordAmount(r), 0);
    const l = yearRecords.filter(r => r.type === 'Liability').reduce((s, r) => s + recordAmount(r), 0);
    return a - l;
  });
  charts.netWorthChart = new Chart(document.getElementById('netWorthChart'), {
    type: 'line',
    data: { labels: byYear, datasets: [{ label: 'Net Worth', data: trend, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,.14)', fill: true, tension: .35, pointRadius: 4 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } } }
  });
}

function renderDocActionChips(docIds = []) {
  const docs = docIds.map(id => state.documents.find(d => d.id === id)).filter(Boolean);
  if (!docs.length) return '<span style="color:var(--muted)">—</span>';
  return docs.map(doc => `
    <span style="display:inline-flex;gap:4px;margin:2px 0;">
      <button type="button" class="doc-chip-btn" onclick="previewDocument('${esc(doc.id)}')" title="Show ${esc(doc.name)}">👁 Show</button>
      <button type="button" class="doc-chip-btn" onclick="downloadDocument('${esc(doc.id)}')" title="Download ${esc(doc.name)}">⬇</button>
    </span>`).join(' ');
}

function renderDashboardTable() {
  let records = getFilteredRecords();
  const search = document.getElementById('dashboardSearch').value.toLowerCase();
  if (search) records = records.filter(r => Object.values(r).some(v => String(v).toLowerCase().includes(search)));
  records.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const pageSize = 10, pages = Math.max(1, Math.ceil(records.length / pageSize));
  dashboardPage = Math.min(dashboardPage, pages);
  const pageRecords = records.slice((dashboardPage - 1) * pageSize, dashboardPage * pageSize);
  document.getElementById('recordCount').textContent = `${records.length} record${records.length === 1 ? '' : 's'} found`;

  document.getElementById('dashboardTable').innerHTML = `<thead>
    <tr>
      <th>Date</th>
      <th>Type</th>
      <th>Category</th>
      <th>Subcategory</th>
      <th>Particulars / Name</th>
      <th>Details / Description</th>
      <th>Documents</th>
      <th style="text-align:right">Amount / Balance</th>
      <th>Action</th>
    </tr>
  </thead>
  <tbody>${pageRecords.map(r => `<tr>
    <td>${esc(r.date || '—')}</td>
    <td><span class="badge ${r.type.toLowerCase()}">${r.type}</span></td>
    <td>${esc(r.category)}</td>
    <td>${esc(r.subcategory)}</td>
    <td><strong>${esc(r.particulars || r.name || '—')}</strong></td>
    <td>${esc(r.details || '—')}</td>
    <td>${renderDocActionChips(r.documentIds)}</td>
    <td style="text-align:right"><strong>${formatMoney(recordAmount(r))}</strong></td>
    <td style="white-space:nowrap">
      <button class="action-link" onclick="viewRecord('${r.id}')">View</button>
      <button class="action-link" onclick="openRecordModal('${r.id}')">Edit</button>
      <button class="action-link danger" onclick="deleteRecord('${r.id}')">Delete</button>
    </td>
  </tr>`).join('') || '<tr><td colspan="9"><div class="empty-state">No financial records match these filters.</div></td></tr>'}</tbody>`;

  document.getElementById('dashboardPagination').innerHTML = Array.from({ length: pages }, (_, i) =>
    `<button class="${i + 1 === dashboardPage ? 'active' : ''}" onclick="dashboardPage=${i + 1};renderDashboardTable()">${i + 1}</button>`
  ).join('');
}

function renderDynamicExtraFields(category, subcategory, record) {
  const schema = getSubcategorySchema(category, subcategory);
  const yearOptions = (state.settings.incomeYears || []).map(y =>
    `<option value="${esc(y)}" ${String(record?.incomeYear || state.settings.incomeYears?.[0] || '') === String(y) ? 'selected' : ''}>${esc(y)}</option>`
  ).join('');

  const fieldsHtml = schema.extraFields.map(field => {
    const currentVal = record?.[field.key] ?? '';
    if (field.type === 'incomeYear') {
      return `<label>${esc(field.label)}<select data-extra-field="${esc(field.key)}">${yearOptions}</select></label>`;
    }
    if (field.type === 'select') {
      return `<label>${esc(field.label)}<select data-extra-field="${esc(field.key)}">${field.options.map(opt =>
        `<option value="${esc(opt)}" ${String(currentVal) === String(opt) ? 'selected' : ''}>${esc(opt)}</option>`
      ).join('')}</select></label>`;
    }
    const inputType = field.type === 'number' ? 'number" step="0.01' : 'text';
    return `<label>${esc(field.label)}
      <input data-extra-field="${esc(field.key)}" type="${inputType}" placeholder="${esc(field.placeholder || '')}" value="${esc(currentVal)}" ${field.required ? 'required' : ''}>
    </label>`;
  }).join('');

  return `<div class="field-section-badge">Sheet Fields (${esc(schema.sheet)})</div>${fieldsHtml}`;
}

function openRecordModal(id = null) {
  editingRecordId = id;
  document.querySelector('#recordForm .modal-foot').innerHTML = '<button type="button" class="btn" data-close-modal>Cancel</button><button type="submit" class="btn btn-primary">Save Record</button>';
  document.querySelectorAll('#recordForm [data-close-modal]').forEach(button => button.onclick = () => document.getElementById('recordModal').close());

  const record = id ? state.records.find(r => r.id === id) : null;
  document.getElementById('recordModalTitle').textContent = record ? 'Edit Financial Record' : 'Add Financial Record';
  document.getElementById('recordModalSubtitle').textContent = record ? `${record.category} → ${record.subcategory}` : 'Fields adapt automatically to Category & Subcategory';

  const existingDocs = (record?.documentIds || [])
    .map(docId => state.documents.find(d => d.id === docId))
    .filter(Boolean);

  const existingDocsHtml = existingDocs.length ? `
    <div class="full document-view-section">
      <label style="margin-bottom:4px">Existing Attached PDFs</label>
      <div class="document-view-list" id="editAttachedDocs">${existingDocs.map(doc => `
        <div class="document-view-item">
          <div class="document-info">
            <strong>${esc(doc.name || 'document.pdf')}</strong>
            <span>${formatFileSize(doc.size)}</span>
          </div>
          <div class="document-actions">
            <button type="button" class="btn btn-sm" onclick="previewDocument('${esc(doc.id)}')">Show PDF</button>
            <button type="button" class="btn btn-sm btn-primary" onclick="downloadDocument('${esc(doc.id)}')">Download</button>
            <button type="button" class="btn btn-sm" onclick="replaceDocument('${esc(doc.id)}')">Replace</button>
            <button type="button" class="btn btn-sm btn-danger" onclick="deleteDocument('${esc(doc.id)}', true)">Remove</button>
          </div>
        </div>`).join('')}
      </div>
    </div>` : '';

  document.getElementById('recordFormFields').innerHTML = `<div class="form-grid">
    <div class="field-section-badge">Common Core Fields</div>
    <label>Financial Type
      <select id="recordType" required>
        <option value="Asset" ${record?.type === 'Asset' ? 'selected' : ''}>Asset</option>
        <option value="Liability" ${record?.type === 'Liability' ? 'selected' : ''}>Liability</option>
      </select>
    </label>
    <label>Category<select id="recordCategory" required></select></label>
    <label>Subcategory<select id="recordSubcategory" required></select></label>
    <label>Date<input id="recordDate" type="date" value="${esc(record?.date || new Date().toISOString().slice(0, 10))}"></label>
    <label class="full">Details / Description<textarea id="recordDetails" rows="2" placeholder="Enter details or description…">${esc(record?.details || record?.description || '')}</textarea></label>
    <label>Amount / Balance<input id="recordAmount" type="number" step="0.01" placeholder="0.00" value="${esc(record ? recordAmount(record) : '')}" required></label>
    <label>Document (PDF)<input id="recordDocument" type="file" accept=".pdf,application/pdf"></label>
    ${existingDocsHtml}
    <div id="dynamicFieldsContainer" class="full" style="display:grid;grid-template-columns:repeat(2,1fr);gap:14px;"></div>
  </div>`;

  const typeSelect = document.getElementById('recordType');
  const categorySelect = document.getElementById('recordCategory');
  const subSelect = document.getElementById('recordSubcategory');
  const dynamicHost = document.getElementById('dynamicFieldsContainer');

  if (record) {
    typeSelect.value = record.type;
  }

  const renderExtra = () => {
    dynamicHost.innerHTML = renderDynamicExtraFields(categorySelect.value, subSelect.value, record);
    document.getElementById('recordModalSubtitle').textContent = `${categorySelect.value} → ${subSelect.value}`;
    // Auto-sync Amount / Balance if Current Market Value or Purchase Value is typed on Land sheet
    const mvInput = dynamicHost.querySelector('[data-extra-field="currentMarketValue"]');
    const pvInput = dynamicHost.querySelector('[data-extra-field="purchaseValue"]');
    const amtInput = document.getElementById('recordAmount');
    if (mvInput && amtInput) {
      mvInput.oninput = () => { if (mvInput.value) amtInput.value = mvInput.value; };
    }
    if (pvInput && amtInput) {
      pvInput.oninput = () => { if (!mvInput?.value && pvInput.value) amtInput.value = pvInput.value; };
    }
  };

  const updateSubcategories = () => {
    const category = state.categories.find(c => c.type === typeSelect.value && c.name === categorySelect.value);
    subSelect.innerHTML = (category?.subcategories || []).map(s => `<option value="${esc(s)}" ${record?.subcategory === s ? 'selected' : ''}>${esc(s)}</option>`).join('');
    renderExtra();
  };

  const updateCategories = () => {
    const filtered = state.categories.filter(c => c.type === typeSelect.value);
    categorySelect.innerHTML = filtered.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
    if (record && filtered.some(c => c.name === record.category)) categorySelect.value = record.category;
    updateSubcategories();
  };

  typeSelect.onchange = updateCategories;
  categorySelect.onchange = updateSubcategories;
  subSelect.onchange = renderExtra;
  updateCategories();
  document.getElementById('recordModal').showModal();
}

async function saveRecord(event) {
  event.preventDefault();
  const existing = editingRecordId ? state.records.find(r => r.id === editingRecordId) : null;
  const amountVal = Number(document.getElementById('recordAmount').value || 0);

  const record = {
    id: editingRecordId || uid('record'),
    type: document.getElementById('recordType').value,
    category: document.getElementById('recordCategory').value,
    subcategory: document.getElementById('recordSubcategory').value,
    date: document.getElementById('recordDate').value,
    details: document.getElementById('recordDetails').value.trim(),
    amount: amountVal,
    balance: amountVal,
    particulars: '',
    incomeYear: '',
    documentIds: existing ? [...(existing.documentIds || [])] : [],
    updatedAt: new Date().toISOString()
  };

  // Capture all dynamic subcategory-specific fields
  document.querySelectorAll('#dynamicFieldsContainer [data-extra-field]').forEach(el => {
    const key = el.dataset.extraField;
    record[key] = el.type === 'number' ? Number(el.value || 0) : el.value.trim();
  });

  if (!record.particulars) {
    record.particulars = record.propertyCategory || record.subcategory;
  }

  const fileInput = document.getElementById('recordDocument');
  if (fileInput && fileInput.files.length > 0) {
    const file = fileInput.files[0];
    const docId = uid('doc');
    await put('documents', {
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
    });
    record.documentIds.push(docId);
  }

  await put('records', record);
  await loadState();
  document.getElementById('recordModal').close();
  editingRecordId = null;
  renderAll();
  toast('Record saved successfully');
}

async function deleteRecord(id) {
  if (await confirm('Delete this financial record and its linked PDF documents?', 'Delete Record')) {
    const record = state.records.find(r => r.id === id);
    for (const documentId of record?.documentIds || []) await remove('documents', documentId);
    await remove('records', id);
    await loadState();
    renderAll();
    toast('Record deleted');
  }
}

function viewRecord(id) {
  const r = state.records.find(x => x.id === id);
  if (!r) return;
  document.getElementById('recordModalTitle').textContent = r.particulars || r.subcategory || 'Financial Record';
  document.getElementById('recordModalSubtitle').textContent = `${r.type} · ${r.category} → ${r.subcategory}`;

  const schema = getSubcategorySchema(r.category, r.subcategory);
  const extraDisplay = schema.extraFields.map(f => {
    let val = r[f.key];
    if (f.type === 'number' && val !== undefined && val !== '') val = formatMoney(val);
    return `<label>${esc(f.label)}<strong style="display:block;margin-top:4px;font-size:14px">${esc(val || '—')}</strong></label>`;
  }).join('');

  const documents = (r.documentIds || [])
    .map(documentId => state.documents.find(doc => doc.id === documentId))
    .filter(Boolean);

  const documentSection = `
    <div class="full document-view-section">
      <label>Attached PDF Documents (${documents.length})</label>
      ${documents.length ? `<div class="document-view-list">${documents.map(doc => `
        <div class="document-view-item">
          <div class="document-info">
            <strong>📄 ${esc(doc.name || doc.title || 'document.pdf')}</strong>
            <span>${formatFileSize(doc.size)}</span>
          </div>
          <div class="document-actions">
            <button type="button" class="btn btn-sm" onclick="previewDocument('${esc(doc.id)}')">👁 Show PDF</button>
            <button type="button" class="btn btn-sm btn-primary" onclick="downloadDocument('${esc(doc.id)}')">⬇ Download</button>
          </div>
        </div>`).join('')}</div>` : '<p style="color:var(--muted);font-size:13px;margin:4px 0">No PDF document uploaded for this record.</p>'}
    </div>`;

  document.getElementById('recordFormFields').innerHTML = `<div class="form-grid">
    <label>Type<strong style="display:block;margin-top:4px">${esc(r.type)}</strong></label>
    <label>Date<strong style="display:block;margin-top:4px">${esc(r.date || '—')}</strong></label>
    <label>Amount / Balance<strong style="display:block;margin-top:4px;color:var(--indigo);font-size:16px">${formatMoney(recordAmount(r))}</strong></label>
    ${extraDisplay}
    <label class="full">Details / Description<strong style="display:block;margin-top:4px">${esc(r.details || r.description || '—')}</strong></label>
    ${documentSection}
  </div>`;

  document.querySelector('#recordForm .modal-foot').innerHTML = `
    <button type="button" class="btn btn-primary" onclick="document.getElementById('recordModal').close();openRecordModal('${esc(r.id)}')">Edit Record</button>
    <button type="button" class="btn" data-close-modal>Close</button>`;
  document.getElementById('recordModal').showModal();
  document.querySelector('#recordModal [data-close-modal]').onclick = () => document.getElementById('recordModal').close();
}

function renderRecordSections() {
  const search = (document.getElementById('recordSearch')?.value || '').toLowerCase();
  const type = document.getElementById('recordTypeFilter')?.value || '';
  let records = state.records.filter(r => !search || Object.values(r).some(v => String(v).toLowerCase().includes(search)));
  if (type) records = records.filter(r => r.type === type);
  const render = items => items.map(r => `<div class="record-item">
    <div>
      <h4>${esc(r.particulars || r.subcategory || 'Unnamed Record')}</h4>
      <p>${esc(r.category)} · ${esc(r.subcategory)} ${r.incomeYear ? '· ' + esc(r.incomeYear) : ''}</p>
    </div>
    <div class="record-amount">
      <strong>${formatMoney(recordAmount(r))}</strong>
      <p>${esc(r.date || '')}</p>
    </div>
    <div class="record-actions">
      <button class="action-link" onclick="viewRecord('${r.id}')">View</button>
      <button class="action-link" onclick="openRecordModal('${r.id}')">Edit</button>
      <button class="action-link danger" onclick="deleteRecord('${r.id}')">Delete</button>
      ${renderDocActionChips(r.documentIds)}
    </div>
  </div>`).join('');
  const assets = records.filter(r => r.type === 'Asset'), liabilities = records.filter(r => r.type === 'Liability');
  document.getElementById('assetRecordCount').textContent = `${assets.length} records`;
  document.getElementById('liabilityRecordCount').textContent = `${liabilities.length} records`;
  document.getElementById('assetList').innerHTML = render(assets) || '<div class="empty-state">No asset records found.</div>';
  document.getElementById('liabilityList').innerHTML = render(liabilities) || '<div class="empty-state">No liability records found.</div>';
}

function renderBalance() {
  const yearSelect = document.getElementById('balanceYear');
  const years = [...new Set([...(state.settings.incomeYears || []), ...state.records.map(r => r.incomeYear).filter(Boolean)])].sort((a, b) => String(b).localeCompare(String(a)));
  const current = yearSelect.value || years[0] || '';
  yearSelect.innerHTML = `<option value="">All Years</option>${years.map(y => `<option ${String(y) == String(current) ? 'selected' : ''}>${esc(y)}</option>`).join('')}`;
  const mode = document.getElementById('balanceMode')?.value || 'current';
  let records = state.records.filter(r => r.type === 'Asset' || r.type === 'Liability');
  if (current && mode === 'historical') records = records.filter(r => String(r.incomeYear || '') === String(current));
  if (current && mode === 'comparative') {
    const idx = years.indexOf(String(current));
    const prevYear = idx !== -1 && idx < years.length - 1 ? years[idx + 1] : '';
    records = records.filter(r => String(r.incomeYear || '') === String(current) || String(r.incomeYear || '') === prevYear);
  }

  const sheetMap = { Asset: {}, Liability: {} };
  for (const record of records) {
    sheetMap[record.type][record.category] = (sheetMap[record.type][record.category] || 0) + recordAmount(record);
  }
  const categoryNames = type => state.categories.filter(c => c.type === type).map(c => c.name).filter((v, i, a) => a.indexOf(v) === i);
  const assetNames = categoryNames('Asset'), liabilityNames = categoryNames('Liability');
  const totalAsset = Object.values(sheetMap.Asset).reduce((s, v) => s + v, 0);
  const totalLiability = Object.values(sheetMap.Liability).reduce((s, v) => s + v, 0);
  const renderSection = (title, names, map) => {
    const rows = names.map(name => `<tr><td>${esc(name)}</td><td>${formatMoney(map[name] || 0)}</td></tr>`).join('');
    return `<table class="balance-table"><tbody><tr class="total"><td>${esc(title)}</td><td></td></tr>${rows}<tr class="total"><td>Total ${esc(title)}</td><td>${formatMoney(names.reduce((s, n) => s + (map[n] || 0), 0))}</td></tr></tbody></table>`;
  };
  document.getElementById('balanceSheet').innerHTML = `<div class="balance-header"><h2>Personal Balance Sheet</h2><p>${current ? esc(current) : 'All Income Years'} · ${esc(mode === 'comparative' ? 'Comparative' : mode === 'historical' ? 'Historical' : 'Current')} Balance Sheet</p></div>
    ${renderSection('ASSETS', assetNames, sheetMap.Asset)}
    ${renderSection('LIABILITIES', liabilityNames, sheetMap.Liability)}
    <table class="balance-table"><tbody><tr class="total"><td>NET WORTH</td><td>${formatMoney(totalAsset - totalLiability)}</td></tr></tbody></table>`;
}

// Document Viewer & Download Functions
function formatFileSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}
function cleanupPdfViewer() {
  if (currentPdfViewerUrl) {
    URL.revokeObjectURL(currentPdfViewerUrl);
    currentPdfViewerUrl = null;
  }
  const frame = document.getElementById('pdfViewerFrame');
  if (frame) frame.src = 'about:blank';
}
function previewDocument(id) {
  const doc = state.documents.find(d => d.id === id);
  if (!doc || !doc.blob) {
    toast('PDF file blob not found.', true);
    return;
  }
  cleanupPdfViewer();
  currentPdfViewerUrl = URL.createObjectURL(doc.blob);
  document.getElementById('pdfViewerTitle').textContent = doc.name || doc.title || 'Document Preview';
  document.getElementById('pdfViewerMeta').textContent = `${doc.category || ''} · ${doc.subcategory || ''} (${formatFileSize(doc.size)})`;
  const dlBtn = document.getElementById('pdfViewerDownload');
  dlBtn.href = currentPdfViewerUrl;
  dlBtn.download = doc.name || `${doc.title || 'document'}.pdf`;
  document.getElementById('pdfViewerNewTab').onclick = () => window.open(currentPdfViewerUrl, '_blank', 'noopener');
  document.getElementById('pdfViewerFrame').src = currentPdfViewerUrl;
  document.getElementById('pdfViewerModal').showModal();
}
function downloadDocument(id) {
  const doc = state.documents.find(d => d.id === id);
  if (!doc || !doc.blob) {
    toast('PDF file blob not found.', true);
    return;
  }
  const url = URL.createObjectURL(doc.blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = doc.name || `${doc.title || 'document'}.pdf`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function replaceDocument(id) {
  replacingDocumentId = id;
  document.getElementById('replaceDocumentFile').click();
}
async function replaceDocumentFile(event) {
  const file = event.target.files[0];
  if (!file || !replacingDocumentId) return;
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    toast('Please select a valid PDF file.', true);
    event.target.value = '';
    return;
  }
  const documentRecord = state.documents.find(d => d.id === replacingDocumentId);
  if (!documentRecord) return;
  documentRecord.blob = file;
  documentRecord.name = file.name;
  documentRecord.title = file.name;
  documentRecord.type = file.type || 'application/pdf';
  documentRecord.size = file.size;
  documentRecord.updatedAt = new Date().toISOString();
  await put('documents', documentRecord);
  replacingDocumentId = null;
  event.target.value = '';
  await loadState();
  renderAll();
  if (editingRecordId) openRecordModal(editingRecordId);
  toast('PDF document replaced');
}
async function deleteDocument(id, reopenEdit = false) {
  if (await confirm('Remove this PDF document from the record?', 'Remove PDF')) {
    const doc = state.documents.find(d => d.id === id);
    const record = state.records.find(r => r.id === doc?.recordId);
    if (record) {
      record.documentIds = (record.documentIds || []).filter(x => x !== id);
      await put('records', record);
    }
    await remove('documents', id);
    await loadState();
    renderAll();
    if (reopenEdit && editingRecordId) openRecordModal(editingRecordId);
    toast('Document removed');
  }
}

// =========================================================================
// MODERN FILTER-WISE PDF REPORT GENERATOR (1 Category/Page, Auto Orientation)
// =========================================================================
function buildCategoryColumnsAndRows(categoryName, records) {
  // Determine dynamic middle columns based on fields populated in this Category's records
  const candidateCols = [
    { key: 'subcategory', header: 'Subcategory' },
    { key: 'particulars', header: 'Particulars / Name' },
    { key: 'details', header: 'Details / Description' },
    { key: 'accountDetail', header: 'Account Detail' },
    { key: 'referenceDetail', header: 'Detail / Ref' },
    { key: 'propertyCategory', header: 'Property Category' },
    { key: 'itemCategory', header: 'Item Category' },
    { key: 'acquisitionType', header: 'Acquisition' },
    { key: 'area', header: 'Area' },
    { key: 'registrationNo', header: 'Reg. No.' },
    { key: 'engineCapacity', header: 'Engine' },
    { key: 'gramWeight', header: 'Weight (Gram)' },
    { key: 'quantity', header: 'Qty' },
    { key: 'incomeYear', header: 'Income Year' },
    { key: 'purchaseValue', header: 'Purchase Value', money: true },
    { key: 'currentMarketValue', header: 'Market Value', money: true }
  ];

  const activeMiddleCols = candidateCols.filter(col =>
    col.key === 'subcategory' ||
    col.key === 'particulars' ||
    col.key === 'details' ||
    records.some(r => {
      const v = r[col.key];
      return v !== undefined && v !== null && String(v).trim() !== '' && !(col.money && Number(v) === 0);
    })
  );

  // Strict Column Rule:
  // First Column: Date
  // Middle Columns: Active Category/Subcategory Fields
  // Last Column: Amount / Balance
  const headers = ['Date', ...activeMiddleCols.map(c => c.header), 'Amount / Balance'];

  const bodyRows = records.map(r => {
    const midCells = activeMiddleCols.map(c => {
      const val = r[c.key];
      if (c.money) return val ? formatPdfMoney(val) : '—';
      return val ? String(val) : '—';
    });
    return [r.date || '—', ...midCells, formatPdfMoney(recordAmount(r))];
  });

  const subtotal = records.reduce((s, r) => s + recordAmount(r), 0);
  const totalRow = [
    { content: `Total — ${categoryName} (${records.length} item${records.length === 1 ? '' : 's'})`, colSpan: headers.length - 1, styles: { fontStyle: 'bold', halign: 'right', fillColor: [238, 242, 255], textColor: [30, 27, 75] } },
    { content: formatPdfMoney(subtotal), styles: { fontStyle: 'bold', halign: 'right', fillColor: [238, 242, 255], textColor: [30, 27, 75] } }
  ];

  return { headers, bodyRows, totalRow, subtotal, colCount: headers.length };
}

function generateFilteredPdfReport() {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    toast('PDF generator library unavailable. Check internet connection.', true);
    return;
  }
  const records = getFilteredRecords();
  if (!records.length) {
    toast('No records available for the selected filter to generate PDF.', true);
    return;
  }

  // Group records by Category (preserving Type -> Category order)
  const groupedMap = new Map();
  for (const r of records) {
    const groupKey = `${r.type}|||${r.category}`;
    if (!groupedMap.has(groupKey)) groupedMap.set(groupKey, []);
    groupedMap.get(groupKey).push(r);
  }

  const groups = Array.from(groupedMap.entries()).map(([key, items]) => {
    const [type, category] = key.split('|||');
    items.sort((a, b) => String(a.subcategory || '').localeCompare(String(b.subcategory || '')) || String(b.date || '').localeCompare(String(a.date || '')));
    const tableSpec = buildCategoryColumnsAndRows(category, items);
    // Automatic Orientation: > 5 columns => Landscape ('l'), <= 5 columns => Portrait ('p')
    const orientation = tableSpec.colCount > 5 ? 'l' : 'p';
    return { type, category, items, orientation, ...tableSpec };
  });

  const { jsPDF } = window.jspdf;
  const firstOrientation = groups[0].orientation;
  const doc = new jsPDF({ orientation: firstOrientation, unit: 'pt', format: 'a4' });

  const filterSummaryParts = [
    dashFilters.type ? `Type: ${dashFilters.type}` : 'Type: All',
    dashFilters.category ? `Category: ${dashFilters.category}` : null,
    dashFilters.subcategory ? `Subcategory: ${dashFilters.subcategory}` : null,
    dashFilters.year ? `Income Year: ${dashFilters.year}` : null,
    (dashFilters.from || dashFilters.to) ? `Period: ${dashFilters.from || '...'} to ${dashFilters.to || '...'}` : null
  ].filter(Boolean).join('  |  ');

  const drawPageHeader = (group, isContinuation = false) => {
    const pageWidth = doc.internal.pageSize.getWidth();
    // Top Brand Banner
    doc.setFillColor(15, 23, 42);
    doc.rect(0, 0, pageWidth, 64, 'F');

    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.text('AssetBook — Personal Financial Statement', 36, 26);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(203, 213, 225);
    doc.text(filterSummaryParts, 36, 44);

    const orientationBadge = group.orientation === 'l' ? 'LANDSCAPE' : 'PORTRAIT';
    doc.setFontSize(8.5);
    doc.text(`Generated: ${new Date().toLocaleDateString('en-GB')}  •  ${orientationBadge}`, pageWidth - 36, 26, { align: 'right' });

    // Category & Subcategory Header Banner
    const subcategories = [...new Set(group.items.map(i => i.subcategory).filter(Boolean))].join(', ');
    doc.setFillColor(241, 245, 249);
    doc.roundedRect(36, 76, pageWidth - 72, 42, 6, 6, 'F');

    doc.setDrawColor(79, 70, 229);
    doc.setLineWidth(3);
    doc.line(36, 76, 36, 118);

    doc.setTextColor(15, 23, 42);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text(`${group.type.toUpperCase()}  ›  ${group.category}${isContinuation ? ' (Continued)' : ''}`, 48, 94);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(71, 85, 105);
    doc.text(`Subcategories: ${subcategories || 'General'}`, 48, 110);
  };

  groups.forEach((group, index) => {
    // Strict 1 Category per Page rule: add new page with that category's automatic orientation
    if (index > 0) {
      doc.addPage('a4', group.orientation);
    }

    drawPageHeader(group, false);

    const lastColIndex = group.headers.length - 1;
    doc.autoTable({
      startY: 128,
      margin: { top: 128, left: 36, right: 36, bottom: 44 },
      head: [group.headers],
      body: [...group.bodyRows, group.totalRow],
      theme: 'grid',
      styles: {
        font: 'helvetica',
        fontSize: 9,
        cellPadding: 6,
        lineColor: [226, 232, 240],
        lineWidth: 0.5,
        textColor: [30, 41, 59],
        overflow: 'linebreak'
      },
      headStyles: {
        fillColor: [79, 70, 229],
        textColor: [255, 255, 255],
        fontStyle: 'bold',
        halign: 'left'
      },
      alternateRowStyles: {
        fillColor: [248, 250, 252]
      },
      columnStyles: {
        0: { cellWidth: 68, halign: 'left' },
        [lastColIndex]: { halign: 'right', fontStyle: 'bold', cellWidth: 95 }
      },
      didDrawPage: data => {
        if (data.pageNumber > 1) {
          drawPageHeader(group, true);
        }
      }
    });
  });

  // Add Grand Summary Footer Box on the final page & Page Numbers across all pages
  const totalAssets = records.filter(r => r.type === 'Asset').reduce((s, r) => s + recordAmount(r), 0);
  const totalLiabilities = records.filter(r => r.type === 'Liability').reduce((s, r) => s + recordAmount(r), 0);
  const finalY = doc.lastAutoTable ? doc.lastAutoTable.finalY + 18 : 150;
  const finalPageHeight = doc.internal.pageSize.getHeight();
  const finalPageWidth = doc.internal.pageSize.getWidth();

  if (finalY + 64 > finalPageHeight - 36) {
    doc.addPage('a4', 'p');
  }
  const boxY = (finalY + 64 > finalPageHeight - 36) ? 48 : finalY;
  const w = doc.internal.pageSize.getWidth();
  doc.setFillColor(15, 23, 42);
  doc.roundedRect(36, boxY, w - 72, 48, 6, 6, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text(`Filtered Total Assets: ${formatPdfMoney(totalAssets)}`, 50, boxY + 28);
  doc.text(`Total Liabilities: ${formatPdfMoney(totalLiabilities)}`, w / 2, boxY + 28, { align: 'center' });
  doc.setTextColor(52, 211, 153);
  doc.text(`Net Worth: ${formatPdfMoney(totalAssets - totalLiabilities)}`, w - 50, boxY + 28, { align: 'right' });

  const totalPages = doc.internal.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    const pw = doc.internal.pageSize.getWidth();
    const ph = doc.internal.pageSize.getHeight();
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(100, 116, 139);
    doc.text(`Page ${p} of ${totalPages}`, pw - 36, ph - 18, { align: 'right' });
    doc.text('Confidential — Personal Financial Report', 36, ph - 18);
  }

  const fileSuffix = dashFilters.year || new Date().toISOString().slice(0, 10);
  doc.save(`AssetBook-Report-${fileSuffix}.pdf`);
  toast(`PDF Report generated (${totalPages} page${totalPages === 1 ? '' : 's'})`);
}

// =========================================================================
// MODERN FILTER-WISE EXCEL REPORT GENERATOR
// =========================================================================
function exportFilteredExcel() {
  if (!window.XLSX) {
    toast('Excel library is unavailable. Check your internet connection.', true);
    return;
  }
  const records = getFilteredRecords();
  if (!records.length) {
    toast('No records match current filters.', true);
    return;
  }
  const workbook = XLSX.utils.book_new();

  // Group by Category with Date first and Amount / Balance last
  const grouped = new Map();
  for (const r of records) {
    if (!grouped.has(r.category)) grouped.set(r.category, []);
    grouped.get(r.category).push(r);
  }

  const summaryRows = [];
  for (const [category, items] of grouped.entries()) {
    const rows = items.map(r => ({
      Date: r.date || '',
      Type: r.type,
      Category: r.category,
      Subcategory: r.subcategory,
      'Particulars / Name': r.particulars || '',
      'Details / Description': r.details || '',
      'Income Year': r.incomeYear || '',
      'Account / Ref / Area': r.accountDetail || r.referenceDetail || r.area || r.registrationNo || r.gramWeight || '',
      'Purchase Value': Number(r.purchaseValue || 0),
      'Current Market Value': Number(r.currentMarketValue || 0),
      'Amount / Balance': recordAmount(r)
    }));
    const catTotal = items.reduce((s, r) => s + recordAmount(r), 0);
    summaryRows.push({ Type: items[0].type, Category: category, Records: items.length, 'Total Amount / Balance': catTotal });
    const safeSheetName = category.replace(/[\/?*[\]]/g, '').slice(0, 31) || 'Category';
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), safeSheetName);
  }

  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(summaryRows), 'Filter Summary');
  XLSX.writeFile(workbook, `AssetBook-Filtered-Report-${dashFilters.year || new Date().toISOString().slice(0, 10)}.xlsx`);
  toast('Filter-wise Excel report exported');
}

function exportBalanceExcel() {
  if (!window.XLSX) { toast('Excel library is unavailable.', true); return; }
  const year = document.getElementById('balanceYear').value;
  let records = state.records.filter(r => !year || String(r.incomeYear || '') === String(year));
  const assetRows = records.filter(r => r.type === 'Asset').map(r => ({ Date: r.date || '', Category: r.category, Subcategory: r.subcategory, Particulars: r.particulars || '', 'Amount / Balance': recordAmount(r) }));
  const liabilityRows = records.filter(r => r.type === 'Liability').map(r => ({ Date: r.date || '', Category: r.category, Subcategory: r.subcategory, Particulars: r.particulars || '', 'Amount / Balance': recordAmount(r) }));
  const assets = assetRows.reduce((s, r) => s + Number(r['Amount / Balance'] || 0), 0);
  const liabilities = liabilityRows.reduce((s, r) => s + Number(r['Amount / Balance'] || 0), 0);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(assetRows), 'Assets');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(liabilityRows), 'Liabilities');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{ Item: 'Total Assets', Amount: assets }, { Item: 'Total Liabilities', Amount: liabilities }, { Item: 'Net Worth', Amount: assets - liabilities }]), 'Summary');
  XLSX.writeFile(workbook, `Balance-Sheet-${year || 'All-Years'}-${new Date().toISOString().slice(0, 10)}.xlsx`);
  toast('Balance Sheet exported');
}

// Category & Settings Management
function openCategoryModal() {
  document.getElementById('categoryModal').showModal();
  renderCategoryTree();
}
function renderCategoryTree() {
  document.getElementById('categoryTree').innerHTML = state.categories.map(c => `<div class="category-group"><strong>${esc(c.type)} · ${esc(c.name)} <button class="action-link" onclick="renameCategory('${c.id}')">Edit</button></strong>${c.subcategories.map(s => `<span>${esc(s)} <button class="action-link" onclick="renameSubcategory('${c.id}','${esc(s)}')">Edit</button> <button class="action-link danger" onclick="deleteSubcategory('${c.id}','${esc(s)}')">×</button></span>`).join('')}<button class="action-link danger" onclick="deleteCategory('${c.id}')">Delete Category</button></div>`).join('');
}
async function addCategory(event) {
  event.preventDefault();
  const type = document.getElementById('categoryType').value;
  const name = document.getElementById('categoryName').value.trim();
  const subcategory = document.getElementById('subcategoryName').value.trim();
  if (!name || !subcategory) return;
  let category = state.categories.find(c => c.type === type && c.name === name);
  if (category) {
    if (!category.subcategories.includes(subcategory)) category.subcategories.push(subcategory);
  } else {
    category = { id: uid('category'), type, name, subcategories: [subcategory] };
  }
  await put('categories', category); await loadState();
  document.getElementById('categoryForm').reset();
  renderCategoryTree(); renderAll(); toast('Category structure updated');
}
async function deleteCategory(id) {
  const category = state.categories.find(c => c.id === id);
  if (state.records.some(r => r.category === category?.name)) { toast('Category has linked records.', true); return; }
  if (await confirm(`Delete category "${category?.name}"?`, 'Delete Category')) {
    await remove('categories', id); await loadState(); renderCategoryTree(); renderAll(); toast('Category deleted');
  }
}
async function renameCategory(id) {
  const category = state.categories.find(c => c.id === id); if (!category) return;
  const name = prompt('Edit category name:', category.name);
  if (!name || name.trim() === category.name) return;
  const newName = name.trim();
  const linked = state.records.filter(r => r.category === category.name);
  category.name = newName;
  await put('categories', category);
  for (const record of linked) { record.category = newName; await put('records', record); }
  await loadState(); renderCategoryTree(); renderAll(); toast('Category renamed');
}
async function renameSubcategory(categoryId, oldName) {
  const category = state.categories.find(c => c.id === categoryId); if (!category) return;
  const name = prompt('Edit subcategory name:', oldName);
  if (!name || name.trim() === oldName) return;
  const newName = name.trim();
  category.subcategories = category.subcategories.map(s => s === oldName ? newName : s);
  await put('categories', category);
  const linked = state.records.filter(r => r.category === category.name && r.subcategory === oldName);
  for (const record of linked) { record.subcategory = newName; await put('records', record); }
  await loadState(); renderCategoryTree(); renderAll(); toast('Subcategory renamed');
}
async function deleteSubcategory(categoryId, name) {
  const category = state.categories.find(c => c.id === categoryId); if (!category) return;
  if (state.records.some(r => r.category === category.name && r.subcategory === name)) { toast('Subcategory has linked records.', true); return; }
  if (await confirm(`Delete subcategory "${name}"?`, 'Delete Subcategory')) {
    category.subcategories = category.subcategories.filter(s => s !== name);
    await put('categories', category); await loadState(); renderCategoryTree(); renderAll(); toast('Subcategory deleted');
  }
}

function renderSettings() {
  document.getElementById('currencySetting').value = state.settings.currency || 'BDT';
  document.getElementById('localeSetting').value = state.settings.locale || 'en-BD';
  renderYearList();
}
function renderYearList() {
  document.getElementById('yearList').innerHTML = (state.settings.incomeYears || []).map(y => `<span class="chip">${esc(y)} <button class="action-link danger" onclick="deleteIncomeYear('${esc(y)}')">×</button></span>`).join('');
}
async function saveSettings() {
  state.settings.currency = document.getElementById('currencySetting').value;
  state.settings.locale = document.getElementById('localeSetting').value;
  await put('settings', { key: 'currency', value: state.settings.currency });
  await put('settings', { key: 'locale', value: state.settings.locale });
  await put('settings', { key: 'incomeYears', value: state.settings.incomeYears || [] });
  renderAll(); toast('Settings saved');
}
async function addIncomeYear() {
  const year = document.getElementById('newYear').value.trim();
  if (!year) return;
  state.settings.incomeYears = [...new Set([...(state.settings.incomeYears || []), year])].sort((a, b) => String(b).localeCompare(String(a)));
  await put('settings', { key: 'incomeYears', value: state.settings.incomeYears });
  document.getElementById('newYear').value = '';
  renderSettings(); renderDashboardFilters(); toast('Income year added');
}
async function deleteIncomeYear(year) {
  if (await confirm(`Delete income year ${year}?`, 'Delete Income Year')) {
    state.settings.incomeYears = (state.settings.incomeYears || []).filter(y => String(y) !== String(year));
    await put('settings', { key: 'incomeYears', value: state.settings.incomeYears });
    renderSettings(); renderDashboardFilters(); toast('Income year deleted');
  }
}

// Backup & Restore
async function createBackup() {
  if (!window.JSZip) { toast('ZIP library unavailable.', true); return; }
  await loadState();
  const settings = await getAll('settings');
  const zip = new JSZip();
  const backup = {
    records: state.records,
    categories: state.categories,
    documents: state.documents.map(({ blob, ...doc }) => doc),
    settings: settings.reduce((out, s) => (out[s.key] = s.value, out), {}),
    backupDate: new Date().toISOString(),
    version: '1.1'
  };
  zip.file('backup.json', JSON.stringify(backup, null, 2));
  const folder = zip.folder('documents');
  for (const document of state.documents) {
    if (document.blob) await folder.file(`${document.financialType === 'Liability' ? 'liabilities' : 'assets'}/${document.id}-${document.name || 'document.pdf'}`, document.blob);
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const fileName = `AssetBook-Backup-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
  await put('backupHistory', { id: uid('backup'), date: backup.backupDate, fileName, size: blob.size, recordCount: state.records.length, documentCount: state.documents.length, blob });
  await loadState();
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = fileName; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  renderBackupHistory(); toast('Full backup created and downloaded');
}
function renderBackupHistory() {
  document.getElementById('backupTable').innerHTML = `<thead><tr><th>Backup Date</th><th>File Name</th><th>Records</th><th>Documents</th><th>File Size</th><th>Action</th></tr></thead><tbody>${state.backupHistory.slice().sort((a, b) => String(b.date).localeCompare(String(a.date))).map(b => `<tr><td>${esc(new Date(b.date).toLocaleString())}</td><td>${esc(b.fileName)}</td><td>${b.recordCount || 0}</td><td>${b.documentCount || 0}</td><td>${formatFileSize(b.size)}</td><td>${b.blob ? `<button class="action-link" onclick="downloadBackup('${b.id}')">Download</button>` : '<span>Unavailable</span>'}</td></tr>`).join('') || '<tr><td colspan="6"><div class="empty-state">No backups created yet.</div></td></tr>'}</tbody>`;
}
function downloadBackup(id) {
  const backup = state.backupHistory.find(b => b.id === id); if (!backup?.blob) return;
  const url = URL.createObjectURL(backup.blob); const link = document.createElement('a'); link.href = url; link.download = backup.fileName; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function performRestore() {
  if (!restoreFile) return;
  const mode = document.querySelector('input[name="restoreMode"]:checked')?.value || 'replace';
  document.getElementById('restoreModal').close();
  try {
    const zip = await JSZip.loadAsync(restoreFile);
    const backupFile = zip.file('backup.json'); if (!backupFile) throw new Error('Missing backup.json');
    const backup = JSON.parse(await backupFile.async('text'));
    const documentFiles = Object.keys(zip.files).filter(p => p.startsWith('documents/') && !zip.files[p].dir);
    const blobs = {};
    for (const path of documentFiles) {
      const entry = backup.documents.find(d => path.includes(d.id));
      if (entry) blobs[entry.id] = await zip.files[path].async('blob');
    }
    if (mode === 'replace') {
      for (const store of ['records', 'categories', 'documents', 'settings']) await clearStore(store);
    }
    for (const category of backup.categories || []) await put('categories', category);
    for (const record of backup.records || []) await put('records', record);
    for (const document of backup.documents || []) {
      const blob = blobs[document.id];
      if (blob) { document.blob = new Blob([blob], { type: document.type || 'application/pdf' }); await put('documents', document); }
    }
    for (const [key, value] of Object.entries(backup.settings || {})) await put('settings', { key, value });
    await loadState();
    state.settings = (await getAll('settings')).reduce((out, s) => (out[s.key] = s.value, out), state.settings || {});
    renderAll();
    toast(`Restored ${backup.records?.length || 0} records successfully`);
  } catch (error) {
    toast(error.message || 'Unable to restore backup.', true);
  } finally {
    restoreFile = null; document.getElementById('restoreFile').value = '';
  }
}

// Accurate Sheet-Aware Excel Importer for Assets & Liabilities.xlsx
async function importExcel(event) {
  const file = event.target.files[0]; if (!file) return;
  if (!window.XLSX) { toast('Excel library unavailable.', true); return; }
  try {
    const data = await file.arrayBuffer();
    const workbook = XLSX.read(data, { type: 'array', cellDates: true });
    let imported = 0;

    const mappings = {
      'Cash-Savings Accounts': ['Asset', 'Cash', 'Savings Accounts'],
      'Cash-CIH': ['Asset', 'Cash', 'Cash in Hand'],
      'Investment-CPF': ['Asset', 'Investments', 'CPF'],
      'Investment-GI&WF': ['Asset', 'Investments', 'Group Insurance & Welfare Fund (GI&WF)'],
      'Investment-Co-oP': ['Asset', 'Investments', 'Other Investment / Co-operation'],
      'Property-Land': ['Asset', 'Property', 'Land & Primary Residence'],
      'Property-Vehicles': ['Asset', 'Property', 'Vehicles'],
      'Property-Jewelry': ['Asset', 'Property', 'Jewelry'],
      'Property-Other Property': ['Asset', 'Property', 'Other Property'],
      'Retirement-Gratuity': ['Asset', 'Retirement', 'Gratuity'],
      'Other Assets-Furniture': ['Asset', 'Other Assets', 'Furniture, Electronics & Equipments'],
      'Other Assets-Accounts Receivabl': ['Asset', 'Other Assets', 'Accounts Receivable'],
      'Liabilities-Payable': ['Liability', 'Accounts Payable', 'Accounts Payable'],
      'Liabilities-Bank Loan': ['Liability', 'Bank Loan', 'Bank Loan'],
      'Liabilities-Other Liabilities': ['Liability', 'Other Liabilities', 'Other Liabilities']
    };

    for (const sheetName of workbook.SheetNames) {
      const mapped = mappings[sheetName];
      if (!mapped) continue;
      const sheet = workbook.Sheets[sheetName];
      const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

      // Locate actual table header row (rows 10..15 in Assets & Liabilities.xlsx)
      let headerIdx = -1;
      for (let r = 0; r < Math.min(20, matrix.length); r++) {
        const joined = matrix[r].map(c => String(c).trim().toLowerCase()).join('|');
        if (joined.includes('balance') || joined.includes('purchase value') || joined.includes('amount')) {
          headerIdx = r;
          break;
        }
      }
      if (headerIdx === -1) continue;

      const rawHeaders = matrix[headerIdx].map(h => String(h).trim());
      // Only take left-hand main data table (stop before blank separator column before summary table)
      let maxCol = rawHeaders.length;
      for (let c = 2; c < rawHeaders.length; c++) {
        if (rawHeaders[c] === '' && c > 4) { maxCol = c; break; }
      }

      for (let r = headerIdx + 1; r < matrix.length; r++) {
        const rowArr = matrix[r].slice(0, maxCol);
        const rowObj = {};
        rawHeaders.slice(0, maxCol).forEach((h, idx) => { if (h) rowObj[h] = rowArr[idx]; });

        const firstTexts = Object.values(rowObj).map(v => String(v).trim());
        if (firstTexts.some(t => /^total$/i.test(t) || /^last updated/i.test(t) || /^days since/i.test(t))) continue;

        const particulars = String(
          rowObj['Cash Asset Name'] || rowObj['Bank Name'] || rowObj['Particulars'] ||
          rowObj['Type and Particulars'] || rowObj['Institution'] || rowObj['Debtor'] ||
          rowObj['Payee'] || rowObj['Bank'] || rowObj['Description and Location'] || ''
        ).trim();

        const amount = parseExcelNumber(
          rowObj['Balance'] ?? rowObj['Current Market Value'] ?? rowObj['Purchase Value'] ?? rowObj['Amount']
        );

        if (!particulars && !amount) continue;

        const record = {
          id: uid('record'),
          type: mapped[0],
          category: mapped[1],
          subcategory: mapped[2],
          date: normalizeExcelDate(rowObj['Date'] || ''),
          particulars: particulars || mapped[2],
          details: String(rowObj['Details'] || rowObj['Description'] || rowObj['Description and Location'] || '').trim(),
          accountDetail: String(rowObj['Account Detail'] || '').trim(),
          referenceDetail: String(rowObj['Detail'] || '').trim(),
          incomeYear: String(rowObj['Income Year'] || '').trim(),
          propertyCategory: String(rowObj['Category'] || '').trim(),
          itemCategory: String(rowObj['Category'] || '').trim(),
          acquisitionType: String(rowObj['Type of Acquisition'] || '').trim(),
          area: String(rowObj['Area of the Property'] || '').trim(),
          purchaseValue: parseExcelNumber(rowObj['Purchase Value']),
          currentMarketValue: parseExcelNumber(rowObj['Current Market Value']),
          registrationNo: String(rowObj['Registration No.'] || '').trim(),
          engineCapacity: String(rowObj['Engine Capacity'] || '').trim(),
          gramWeight: String(rowObj['Amount (Gram)'] || '').trim(),
          quantity: String(rowObj['Amount'] || '').trim(),
          amount: amount,
          balance: amount,
          documentIds: [],
          updatedAt: new Date().toISOString()
        };

        await put('records', record);
        imported++;
      }
    }

    await loadState();
    renderAll();
    toast(`Excel Import Complete: ${imported} records imported.`);
  } catch (error) {
    console.error(error);
    toast(error.message || 'Unable to import Excel file.', true);
  } finally {
    event.target.value = '';
  }
}

function parseExcelNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (!value) return 0;
  const cleaned = String(value).replace(/[,৳$€£]/g, '').trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function normalizeExcelDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === 'number' && value > 20000) {
    const d = new Date(Math.round((value - 25569) * 86400 * 1000));
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  if (typeof value === 'string' && value.trim()) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return '';
}

init().catch(error => {
  console.error(error);
  toast('Unable to initialize local database.', true);
});
