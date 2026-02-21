const DEFAULT_HOST = 'https://update.x-plane.org';
const INIBUILDS_DEFAULT_HOST = 'https://manager.inibuilds.com';
const PROVIDER_DEFAULT_HOSTS = Object.freeze({
  xupdater: DEFAULT_HOST,
  inibuilds: INIBUILDS_DEFAULT_HOST
});
const LANGUAGE_STORAGE_KEY = 'aerosync.language';
const ACTION_TABLE_MAX_ROWS = 600;
const ACTION_TABLE_PAGE_SIZES = [50, 100, 200, 300, 600];
const UPDATE_PROVIDERS = new Set(['xupdater', 'inibuilds']);

const MENU_ACTIONS = Object.freeze({
  PROFILE_NEW: 'profile:new',
  PROFILE_SAVE: 'profile:save',
  PROFILE_DELETE: 'profile:delete',
  PROFILE_IMPORT: 'profile:import',
  PROFILE_EXPORT: 'profile:export',
  PROFILE_OPEN_DIR: 'profile:open-dir',
  UPDATES_CHECK: 'updates:check',
  UPDATES_INSTALL: 'updates:install',
  UPDATES_PAUSE_RESUME: 'updates:pause-resume',
  UPDATES_CANCEL: 'updates:cancel',
  APP_EXPORT_DIAGNOSTICS: 'app:export-diagnostics',
  APP_CHECK_UPDATE: 'app:check-update',
  LOG_CLEAR: 'log:clear'
});

let lastMenuStateSnapshot = '';
let lastProviderHostMismatchKey = '';

const state = {
  profiles: [],
  selectedProfileId: null,
  currentPlan: null,
  inibuildsProducts: [],
  optionalPackageSelection: {},
  actionTable: {
    query: '',
    action: 'all',
    page: 1,
    pageSize: 100
  },
  checkRunning: false,
  installRunning: false,
  rollbackRunning: false,
  rollbackAvailable: false,
  installPaused: false,
  appUpdateRunning: false,
  i18n: {
    locale: 'en',
    localeTag: 'en-US',
    name: 'English',
    messages: {},
    languages: [],
    directory: ''
  }
};

const el = {
  profileList: document.getElementById('profileList'),
  selectedProfileName: document.getElementById('selectedProfileName'),
  languageSelect: document.getElementById('languageSelect'),
  appVersionChip: document.getElementById('appVersionChip'),

  profileName: document.getElementById('profileName'),
  host: document.getElementById('host'),
  productDir: document.getElementById('productDir'),
  login: document.getElementById('login'),
  licenseKey: document.getElementById('licenseKey'),
  password: document.getElementById('password'),
  fieldLoginWrap: document.getElementById('fieldLoginWrap'),
  fieldLicenseKeyWrap: document.getElementById('fieldLicenseKeyWrap'),
  fieldPasswordWrap: document.getElementById('fieldPasswordWrap'),
  fieldIniBuildsProductWrap: document.getElementById('fieldIniBuildsProductWrap'),
  fieldSinceWrap: document.getElementById('fieldSinceWrap'),
  fieldIniBuildsActivationKeyWrap: document.getElementById('fieldIniBuildsActivationKeyWrap'),
  inibuildsProductId: document.getElementById('inibuildsProductId'),
  inibuildsActivationKey: document.getElementById('inibuildsActivationKey'),
  btnCopyIniBuildsActivationKey: document.getElementById('btnCopyIniBuildsActivationKey'),
  ignoreList: document.getElementById('ignoreList'),
  packageVersion: document.getElementById('packageVersion'),
  rememberAuth: document.getElementById('rememberAuth'),
  channel: document.getElementById('channel'),
  provider: document.getElementById('provider'),

  optFresh: document.getElementById('optFresh'),
  optRepair: document.getElementById('optRepair'),

  btnNewProfile: document.getElementById('btnNewProfile'),
  btnDeleteProfile: document.getElementById('btnDeleteProfile'),
  btnCheckAppUpdate: document.getElementById('btnCheckAppUpdate'),
  btnSaveProfile: document.getElementById('btnSaveProfile'),
  btnPickDir: document.getElementById('btnPickDir'),
  btnCheck: document.getElementById('btnCheck'),
  btnInstall: document.getElementById('btnInstall'),
  btnRollback: document.getElementById('btnRollback'),
  btnPause: document.getElementById('btnPause'),
  btnCancel: document.getElementById('btnCancel'),
  btnClearLog: document.getElementById('btnClearLog'),

  runStatus: document.getElementById('runStatus'),
  summaryGrid: document.getElementById('summaryGrid'),
  sumSnapshotCard: document.getElementById('sumSnapshotCard'),
  sumSnapshot: document.getElementById('sumSnapshot'),
  sumFiles: document.getElementById('sumFiles'),
  sumDownload: document.getElementById('sumDownload'),
  sumDisk: document.getElementById('sumDisk'),
  sumWarnings: document.getElementById('sumWarnings'),
  optionalPackagesPanel: document.getElementById('optionalPackagesPanel'),
  optionalPackageCount: document.getElementById('optionalPackageCount'),
  optionalPackagesEmpty: document.getElementById('optionalPackagesEmpty'),
  optionalPackagesList: document.getElementById('optionalPackagesList'),
  actionCount: document.getElementById('actionCount'),
  planSearch: document.getElementById('planSearch'),
  planActionFilter: document.getElementById('planActionFilter'),
  planPageSize: document.getElementById('planPageSize'),
  btnPlanPrev: document.getElementById('btnPlanPrev'),
  btnPlanNext: document.getElementById('btnPlanNext'),
  planPageInfo: document.getElementById('planPageInfo'),
  progressLabel: document.getElementById('progressLabel'),
  progressPercent: document.getElementById('progressPercent'),
  progressMeta: document.getElementById('progressMeta'),
  progressFile: document.getElementById('progressFile'),
  progressFill: document.getElementById('progressFill'),

  actionsTableBody: document.getElementById('actionsTableBody'),
  logBox: document.getElementById('logBox')
};

function t(key, vars = {}) {
  const template = state.i18n.messages[key];
  const raw = typeof template === 'string' ? template : key;

  return Object.entries(vars).reduce((acc, [name, value]) => {
    return acc.replaceAll(`{${name}}`, String(value));
  }, raw);
}

function formatVersionLabel(version) {
  const raw = String(version || '').trim();
  if (!raw) {
    return 'v?';
  }

  return /^v/i.test(raw) ? raw : `v${raw}`;
}

function formatBytes(bytes) {
  const size = Number(bytes || 0);
  if (!Number.isFinite(size) || size <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = size;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = unitIndex === 0 ? 0 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function formatDownload(summary) {
  const known = Number(summary.downloadSizeKnown || 0);
  const estimatedMax = Number((summary.downloadSizeEstimatedMax ?? summary.downloadSize) || 0);
  const unknownCount = Number(summary.downloadSizeUnknownCount || 0);

  if (unknownCount > 0) {
    if (known > 0 && estimatedMax > known) {
      return `${formatBytes(known)} ${t('common.to')} ${formatBytes(estimatedMax)}`;
    }

    return `${t('common.to')} ${formatBytes(estimatedMax)}`;
  }

  return formatBytes(estimatedMax);
}

function parseIgnoreListInput(input) {
  return String(input || '')
    .split(/\r?\n/g)
    .map((line) => line.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/'))
    .filter((line, index, all) => line && !line.startsWith('#') && all.indexOf(line) === index);
}

function formatIgnoreListOutput(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return '';
  }

  return entries.join('\n');
}

function normalizeOptionalPackageAction(value, fallback = 'ignore') {
  const action = String(value || '').trim().toLowerCase();
  if (action === 'install' || action === 'ignore') {
    return action;
  }

  return fallback;
}

function normalizeActionTableFilter(value, fallback = 'all') {
  const action = String(value || '').trim().toLowerCase();
  if (action === 'all' || action === 'update' || action === 'delete') {
    return action;
  }

  return fallback;
}

function normalizeActionTablePageSize(value, fallback = 100) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  if (!ACTION_TABLE_PAGE_SIZES.includes(parsed)) {
    return fallback;
  }

  return Math.min(parsed, ACTION_TABLE_MAX_ROWS);
}

function normalizeProvider(value, fallback = 'xupdater') {
  const provider = String(value || '').trim().toLowerCase();
  if (UPDATE_PROVIDERS.has(provider)) {
    return provider;
  }

  return fallback;
}

function getFilteredActions(actions) {
  const list = Array.isArray(actions) ? actions : [];
  const query = String(state.actionTable.query || '').trim().toLowerCase();
  const actionFilter = normalizeActionTableFilter(state.actionTable.action, 'all');

  return list.filter((item) => {
    const type = String(item && item.type ? item.type : '').toLowerCase();
    if (actionFilter !== 'all' && type !== actionFilter) {
      return false;
    }

    if (!query) {
      return true;
    }

    const packageName = String(item && item.packageName ? item.packageName : '').toLowerCase();
    const relativePath = String(item && item.relativePath ? item.relativePath : '').toLowerCase();
    return packageName.includes(query) || relativePath.includes(query);
  });
}

function syncActionTableControls(totalCount, filteredCount, totalPages) {
  const hasActions = totalCount > 0;
  const hasFilteredActions = filteredCount > 0;
  const page = Number(state.actionTable.page || 1);

  if (el.planSearch.value !== state.actionTable.query) {
    el.planSearch.value = state.actionTable.query;
  }

  if (el.planActionFilter.value !== state.actionTable.action) {
    el.planActionFilter.value = state.actionTable.action;
  }

  if (el.planPageSize.value !== String(state.actionTable.pageSize)) {
    el.planPageSize.value = String(state.actionTable.pageSize);
  }

  el.planSearch.disabled = !hasActions;
  el.planActionFilter.disabled = !hasActions;
  el.planPageSize.disabled = !hasActions;
  el.btnPlanPrev.disabled = !hasFilteredActions || page <= 1;
  el.btnPlanNext.disabled = !hasFilteredActions || page >= totalPages;

  if (!hasActions) {
    el.planPageInfo.textContent = t('table.pageInfoEmpty');
    return;
  }

  if (!hasFilteredActions) {
    el.planPageInfo.textContent = t('table.pageInfoNoMatch', { total: totalCount });
    return;
  }

  el.planPageInfo.textContent = t('table.pageInfo', {
    page,
    totalPages,
    count: filteredCount
  });
}

function syncOptionalSelectionFromPlan(optionalPackages) {
  const out = {};

  if (Array.isArray(optionalPackages)) {
    for (const item of optionalPackages) {
      const id = String(item && item.id ? item.id : '').trim();
      if (!id) {
        continue;
      }

      out[id] = normalizeOptionalPackageAction(item.selectedAction, 'ignore');
    }
  }

  state.optionalPackageSelection = out;
}

function resetOptionalPackages() {
  state.optionalPackageSelection = {};
  renderOptionalPackages([]);
}

function escapeHtml(input) {
  return String(input ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function applyI18nToDom() {
  document.title = t('app.windowTitle');
  document.documentElement.lang = state.i18n.localeTag || state.i18n.locale || 'en';

  document.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.getAttribute('data-i18n'));
  });

  document.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
    node.setAttribute('placeholder', t(node.getAttribute('data-i18n-placeholder')));
  });

  document.querySelectorAll('[data-i18n-title]').forEach((node) => {
    node.setAttribute('title', t(node.getAttribute('data-i18n-title')));
  });

  document.querySelectorAll('[data-i18n-aria-label]').forEach((node) => {
    node.setAttribute('aria-label', t(node.getAttribute('data-i18n-aria-label')));
  });
}

function safeGetStoredLanguage() {
  try {
    return window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function safeSetStoredLanguage(code) {
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, code);
  } catch {
    // Ignore blocked local storage.
  }
}

function pickPreferredLanguageCode() {
  const available = state.i18n.languages.map((item) => String(item.code || '').toLowerCase());
  if (available.length === 0) {
    return 'en';
  }

  const saved = String(safeGetStoredLanguage() || '').toLowerCase();
  if (saved && available.includes(saved)) {
    return saved;
  }

  if (available.includes('en')) {
    return 'en';
  }

  const navRaw = String(window.navigator.language || '').toLowerCase();
  if (navRaw && available.includes(navRaw)) {
    return navRaw;
  }

  const navBase = navRaw.split('-')[0];
  if (navBase && available.includes(navBase)) {
    return navBase;
  }

  if (available.includes('de')) {
    return 'de';
  }

  return available[0];
}

function renderLanguageOptions() {
  el.languageSelect.innerHTML = '';

  for (const language of state.i18n.languages) {
    const option = document.createElement('option');
    option.value = language.code;
    option.textContent = `${language.name} (${language.code})`;
    el.languageSelect.append(option);
  }

  el.languageSelect.disabled = state.i18n.languages.length === 0;
}

async function loadAndApplyLanguage(code, options = {}) {
  const loaded = await window.aeroApi.loadLanguage({ code });
  state.i18n.locale = String(loaded.code || 'en').toLowerCase();
  state.i18n.localeTag = String(loaded.locale || state.i18n.locale || 'en-US');
  state.i18n.name = String(loaded.name || loaded.code || state.i18n.locale);
  state.i18n.messages = loaded.messages || {};

  if (el.languageSelect.value !== state.i18n.locale) {
    el.languageSelect.value = state.i18n.locale;
  }

  safeSetStoredLanguage(state.i18n.locale);

  applyI18nToDom();
  syncFreshModeUi();
  syncActionButtons();
  renderProfiles();
  renderActions(state.currentPlan?.actions || []);
  renderOptionalPackages(state.currentPlan?.optionalPackages || []);

  if (state.currentPlan) {
    applyPlanToUi({
      summary: state.currentPlan.summary,
      actions: state.currentPlan.actions,
      warnings: [],
      optionalPackages: state.currentPlan.optionalPackages || []
    });
  } else {
    resetSummary();
  }

  if (!state.installRunning) {
    resetProgressUi();
  }

  if (!options.silentLog) {
    log(t('log.languageLoaded', { name: state.i18n.name, code: state.i18n.locale }));
  }
}

async function initI18n() {
  const result = await window.aeroApi.listLanguages();
  state.i18n.languages = Array.isArray(result.languages) ? result.languages : [];
  state.i18n.directory = String(result.directory || '');
  renderLanguageOptions();

  const preferred = pickPreferredLanguageCode();
  await loadAndApplyLanguage(preferred, { silentLog: true });
}

function timeStamp() {
  const locale = state.i18n.localeTag || state.i18n.locale || undefined;
  return new Date().toLocaleTimeString(locale);
}

function log(message) {
  el.logBox.textContent += `[${timeStamp()}] ${message}\n`;
  el.logBox.scrollTop = el.logBox.scrollHeight;
}

function setStatus(text) {
  el.runStatus.textContent = text;
}

function setAppVersion(version) {
  el.appVersionChip.textContent = formatVersionLabel(version);
}

function resetProgressUi() {
  el.progressLabel.textContent = t('progress.ready');
  el.progressPercent.textContent = '0%';
  el.progressMeta.textContent = t('progress.meta', { index: 0, total: 0 });
  el.progressFile.textContent = '-';
  el.progressFill.style.width = '0%';
}

function updateProgressUi(progress) {
  const total = Number(progress.total || 0);
  const index = Number(progress.index || 0);
  const bytesTotal = Number(progress.bytesTotal || 0);
  const bytesDownloaded = Number(progress.bytesDownloaded || 0);
  const hasByteProgress = bytesTotal > 0 && bytesDownloaded >= 0;
  const percent = hasByteProgress
    ? Math.max(0, Math.min(100, Math.round((bytesDownloaded / bytesTotal) * 100)))
    : total > 0
      ? Math.max(0, Math.min(100, Math.round((index / total) * 100)))
      : 0;
  const message = String(progress.message || '').trim();

  el.progressFill.style.width = `${percent}%`;
  el.progressPercent.textContent = `${percent}%`;
  el.progressMeta.textContent = hasByteProgress
    ? t('progress.metaBytes', { downloaded: formatBytes(bytesDownloaded), total: formatBytes(bytesTotal) })
    : t('progress.meta', { index, total });
  if (/^DOWNLOAD\b/i.test(message)) {
    el.progressLabel.textContent = t('progress.downloadingPackage');
  } else if (/^VERIFY\b/i.test(message)) {
    el.progressLabel.textContent = t('progress.verifyingPackage');
  } else {
    el.progressLabel.textContent = progress.type === 'delete'
      ? t('progress.deletingFiles')
      : t('progress.installingFiles');
  }
  el.progressFile.textContent = progress.path || message || '-';
}

function syncNativeMenuState() {
  const snapshot = {
    hasProfile: Boolean(getSelectedProfile()),
    hasPlan: Boolean(state.currentPlan && Array.isArray(state.currentPlan.actions) && state.currentPlan.actions.length > 0),
    checkRunning: state.checkRunning,
    installRunning: state.installRunning,
    rollbackRunning: state.rollbackRunning,
    installPaused: state.installPaused,
    appUpdateRunning: state.appUpdateRunning
  };

  const key = JSON.stringify(snapshot);
  if (key === lastMenuStateSnapshot) {
    return;
  }

  lastMenuStateSnapshot = key;
  window.aeroApi.updateMenuState(snapshot).catch(() => {
    // Ignore menu sync errors if menu is unavailable in this environment.
  });
}

function syncActionButtons() {
  const lockProfileUi = state.installRunning || state.checkRunning || state.rollbackRunning;
  const hasPlanActions = Boolean(state.currentPlan && state.currentPlan.actions && state.currentPlan.actions.length > 0);
  const hasSelectedProfile = Boolean(getSelectedProfile());
  el.btnCheck.disabled = state.checkRunning || state.installRunning || state.rollbackRunning;
  el.btnInstall.disabled = state.checkRunning || state.installRunning || state.rollbackRunning || !hasPlanActions;
  if (el.btnRollback) {
    el.btnRollback.disabled = state.checkRunning || state.installRunning || state.rollbackRunning || !hasSelectedProfile || !state.rollbackAvailable;
  }
  el.btnPause.disabled = !state.installRunning;
  el.btnCancel.disabled = !state.installRunning;
  el.btnCheckAppUpdate.disabled = state.installRunning || state.checkRunning || state.rollbackRunning || state.appUpdateRunning;
  el.btnNewProfile.disabled = lockProfileUi;
  el.btnSaveProfile.disabled = lockProfileUi;
  el.btnDeleteProfile.disabled = lockProfileUi;
  el.btnPickDir.disabled = lockProfileUi;
  el.provider.disabled = lockProfileUi;
  el.languageSelect.disabled = lockProfileUi || state.i18n.languages.length === 0;
  el.btnPause.textContent = state.installPaused ? t('btn.resume') : t('btn.pause');
  el.profileList.classList.toggle('blocked', lockProfileUi);
  el.optionalPackagesList
    .querySelectorAll('select[data-optional-package-id]')
    .forEach((node) => {
      node.disabled = lockProfileUi;
    });

  syncNativeMenuState();
}

async function refreshRollbackInfo(profileId = '') {
  const id = String(profileId || state.selectedProfileId || '').trim();
  if (!id) {
    state.rollbackAvailable = false;
    syncActionButtons();
    return;
  }

  try {
    const info = await window.aeroApi.getRollbackInfo({ profileId: id });
    state.rollbackAvailable = Boolean(info && info.available);
  } catch {
    state.rollbackAvailable = false;
  }

  syncActionButtons();
}

function syncFreshModeUi() {
  const provider = normalizeProvider(el.provider.value, 'xupdater');
  const isIniBuilds = provider === 'inibuilds';
  const isFresh = Boolean(el.optFresh.checked);
  const isRepair = Boolean(el.optRepair.checked);
  const ignoreSince = isFresh || isRepair;

  el.packageVersion.disabled = isIniBuilds || ignoreSince;
  el.packageVersion.title = isFresh
    ? t('tooltip.freshSince')
    : isRepair
      ? t('tooltip.repairSince')
      : '';
}

function onToggleFreshMode() {
  if (el.optFresh.checked) {
    el.optRepair.checked = false;
  }

  syncFreshModeUi();
}

function onToggleRepairMode() {
  if (el.optRepair.checked) {
    el.optFresh.checked = false;
  }

  syncFreshModeUi();
}

function getSelectedProfile() {
  if (!state.selectedProfileId) {
    return null;
  }

  return state.profiles.find((item) => item.id === state.selectedProfileId) || null;
}

function getDefaultHostForProvider(provider) {
  const normalized = normalizeProvider(provider, 'xupdater');
  return PROVIDER_DEFAULT_HOSTS[normalized] || DEFAULT_HOST;
}

function isKnownProviderDefaultHost(host) {
  const value = String(host || '').trim();
  return Object.values(PROVIDER_DEFAULT_HOSTS).includes(value);
}

function guessProviderFromHost(host) {
  const value = String(host || '').trim().toLowerCase();
  if (/(^|\.)inibuilds\.com(?=$|\/)|manager\.inibuilds\.com/.test(value)) {
    return 'inibuilds';
  }
  return 'xupdater';
}

function maybeWarnProviderHostMismatch() {
  const provider = normalizeProvider(el.provider.value, 'xupdater');
  const host = String(el.host.value || '').trim();
  if (!host) {
    return;
  }

  const guessed = guessProviderFromHost(host);
  if (!guessed || guessed === provider) {
    lastProviderHostMismatchKey = '';
    return;
  }

  const key = `${provider}::${guessed}::${host}`;
  if (key === lastProviderHostMismatchKey) {
    return;
  }
  lastProviderHostMismatchKey = key;

  const expectedLabel = guessed === 'inibuilds'
    ? t('provider.inibuilds')
    : t('provider.xupdater');

  log(t('log.hintPrefix', {
    message: t('hint.providerHostMismatch', { expected: expectedLabel })
  }));
}

function setWrapVisible(wrap, visible) {
  if (!wrap) {
    return;
  }

  wrap.hidden = !visible;
  wrap.style.display = visible ? '' : 'none';
}

function truncateText(text, maxLen) {
  const raw = String(text || '');
  const max = Number.isFinite(Number(maxLen)) ? Math.max(10, Math.trunc(Number(maxLen))) : 60;
  if (raw.length <= max) {
    return raw;
  }
  return `${raw.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function buildIniBuildsOptionLabel(name, id) {
  const safeId = String(id || '').trim();
  const safeName = String(name || '').trim();
  const suffix = safeId ? ` (#${safeId})` : '';

  if (!safeName) {
    return suffix ? suffix.trim() : '';
  }

  const maxLen = 60;
  const available = Math.max(10, maxLen - suffix.length);
  const trimmedName = truncateText(safeName, available);
  return `${trimmedName}${suffix}`;
}

function setSelectOptions(select, items, selectedValue, selectedName = '') {
  if (!select) {
    return;
  }

  const selected = String(selectedValue || '0');
  const savedName = String(selectedName || '').trim();
  const safeItems = Array.isArray(items) ? items : [];
  const options = [];

  options.push(`<option value="0">${escapeHtml(t('placeholder.inibuildsProduct'))}</option>`);

  const hasSelectedInItems = selected !== '0' && safeItems.some((item) => String(item && item.id ? item.id : '').trim() === selected);
  if (selected !== '0' && !hasSelectedInItems) {
    const savedLabel = savedName
      ? t('placeholder.inibuildsProductSavedNamed', { id: selected, name: savedName })
      : t('placeholder.inibuildsProductSaved', { id: selected });
    options.push(
      `<option value="${escapeHtml(selected)}" selected>${escapeHtml(truncateText(savedLabel, 60))}</option>`
    );
  }

  for (const item of safeItems) {
    const id = String(item && item.id ? item.id : '').trim();
    const name = String(item && item.name ? item.name : '').trim();
    if (!id || id === '0') {
      continue;
    }

    const label = name ? buildIniBuildsOptionLabel(name, id) : `#${id}`;
    const isSelected = id === selected ? ' selected' : '';
    options.push(`<option value="${escapeHtml(id)}"${isSelected}>${escapeHtml(label)}</option>`);
  }

  select.innerHTML = options.join('');
  select.value = selected;
}

function isXPlaneIniBuildsProduct(item) {
  const name = String(item && item.name ? item.name : '').toLowerCase();
  return name.includes('xplane');
}

function filterIniBuildsProductsForUi(items) {
  const safeItems = Array.isArray(items) ? items : [];
  const provider = normalizeProvider(el.provider && el.provider.value ? el.provider.value : '', 'xupdater');
  if (provider !== 'inibuilds') {
    return safeItems;
  }

  return safeItems.filter(isXPlaneIniBuildsProduct);
}

function applyIniBuildsProductsFromPlan(planResult) {
  const products = Array.isArray(planResult && planResult.inibuildsProducts)
    ? planResult.inibuildsProducts
    : [];

  state.inibuildsProducts = filterIniBuildsProductsForUi(products);

  const selectedProfile = getSelectedProfile();
  const selectedId = Number(selectedProfile && selectedProfile.inibuildsProductId
    ? selectedProfile.inibuildsProductId
    : 0);
  const selectedName = String(selectedProfile && selectedProfile.inibuildsProductName
    ? selectedProfile.inibuildsProductName
    : '').trim();
  const formId = Number(el.inibuildsProductId && el.inibuildsProductId.value
    ? el.inibuildsProductId.value
    : 0);
  const desired = formId > 0 ? formId : (selectedId > 0 ? selectedId : 0);
  setSelectOptions(el.inibuildsProductId, state.inibuildsProducts, desired, selectedName);

  syncIniBuildsActivationKeyUi();
}

function getIniBuildsProductNameById(id) {
  const target = String(id || '').trim();
  if (!target || target === '0') {
    return '';
  }

  const fromList = Array.isArray(state.inibuildsProducts)
    ? state.inibuildsProducts.find((item) => String(item && item.id ? item.id : '').trim() === target)
    : null;
  if (fromList && fromList.name) {
    return String(fromList.name).trim();
  }

  const selectedProfile = getSelectedProfile();
  const saved = String(selectedProfile && selectedProfile.inibuildsProductName
    ? selectedProfile.inibuildsProductName
    : '').trim();
  return saved;
}

function getIniBuildsActivationKeyById(id) {
  const target = String(id || '').trim();
  if (!target || target === '0') {
    return '';
  }

  // Primary: from the fetched product list (after check).
  const fromList = Array.isArray(state.inibuildsProducts)
    ? state.inibuildsProducts.find((item) => String(item && item.id ? item.id : '').trim() === target)
    : null;
  const key = fromList && (fromList.activationKey || fromList.productKey || fromList.key)
    ? (fromList.activationKey || fromList.productKey || fromList.key)
    : '';
  if (key) {
    return String(key).trim();
  }

  // Fallback: saved in profile (persisted from prior check).
  const selectedProfile = getSelectedProfile();
  const savedProductId = String(selectedProfile && selectedProfile.inibuildsProductId
    ? selectedProfile.inibuildsProductId
    : '').trim();
  if (savedProductId === target && selectedProfile && selectedProfile.inibuildsActivationKey) {
    return String(selectedProfile.inibuildsActivationKey).trim();
  }

  return '';
}

function syncIniBuildsActivationKeyUi() {
  if (!el.fieldIniBuildsActivationKeyWrap || !el.inibuildsActivationKey) {
    return;
  }

  const provider = normalizeProvider(el.provider.value, 'xupdater');
  const isIniBuilds = provider === 'inibuilds';
  if (!isIniBuilds) {
    el.fieldIniBuildsActivationKeyWrap.hidden = true;
    el.fieldIniBuildsActivationKeyWrap.style.display = 'none';
    el.inibuildsActivationKey.value = '';
    if (el.btnCopyIniBuildsActivationKey) {
      el.btnCopyIniBuildsActivationKey.disabled = true;
    }
    return;
  }

  const selectedId = Number(el.inibuildsProductId && el.inibuildsProductId.value
    ? el.inibuildsProductId.value
    : 0);
  const activationKey = getIniBuildsActivationKeyById(selectedId);
  el.inibuildsActivationKey.value = activationKey;
  // Always show the field for iniBuilds so users can see whether a key was loaded.
  el.fieldIniBuildsActivationKeyWrap.hidden = false;
  el.fieldIniBuildsActivationKeyWrap.style.display = '';
  if (el.btnCopyIniBuildsActivationKey) {
    el.btnCopyIniBuildsActivationKey.disabled = !activationKey;
  }
}

function syncProviderFields(options = {}) {
  const applyHostDefault = Boolean(options.applyHostDefault);
  const forceHostDefault = Boolean(options.forceHostDefault);
  const provider = normalizeProvider(el.provider.value, 'xupdater');
  const isIniBuilds = provider === 'inibuilds';

  // iniBuilds: users typically do not know/enter a license key; we fetch the activation/product key from backend.
  setWrapVisible(el.fieldLicenseKeyWrap, !isIniBuilds);
  setWrapVisible(el.fieldPasswordWrap, isIniBuilds);
  setWrapVisible(el.fieldIniBuildsProductWrap, isIniBuilds);
  setWrapVisible(el.fieldSinceWrap, !isIniBuilds);
  // Visibility handled by syncIniBuildsActivationKeyUi() to avoid display/hidden desync.
  if (el.sumSnapshotCard) {
    el.sumSnapshotCard.hidden = isIniBuilds;
  }
  if (el.summaryGrid) {
    if (isIniBuilds) {
      el.summaryGrid.dataset.columns = '4';
    } else {
      delete el.summaryGrid.dataset.columns;
    }
  }
  if (el.optionalPackagesPanel) {
    el.optionalPackagesPanel.hidden = isIniBuilds;
  }

  syncIniBuildsActivationKeyUi();

  // Swap productDir placeholder based on provider.
  if (el.productDir) {
    const phKey = isIniBuilds ? 'placeholder.productDir.inibuilds' : 'placeholder.productDir';
    el.productDir.setAttribute('placeholder', t(phKey));
  }

  el.licenseKey.disabled = isIniBuilds;
  el.password.disabled = !isIniBuilds;
  if (isIniBuilds) {
    el.packageVersion.disabled = true;
  }
  if (el.inibuildsProductId) {
    el.inibuildsProductId.disabled = !isIniBuilds;
  }

  const defaultHost = getDefaultHostForProvider(provider);
  const currentHost = String(el.host.value || '').trim();
  if (forceHostDefault || (applyHostDefault && (!currentHost || isKnownProviderDefaultHost(currentHost)))) {
    el.host.value = defaultHost;
  }

  maybeWarnProviderHostMismatch();
}

function collectProfileFromForm() {
  const inibuildsProductId = Number(el.inibuildsProductId && el.inibuildsProductId.value
    ? el.inibuildsProductId.value
    : 0);

  return {
    id: state.selectedProfileId,
    name: el.profileName.value.trim(),
    host: (el.host.value || DEFAULT_HOST).trim(),
    productDir: el.productDir.value.trim(),
    login: el.login.value.trim(),
    licenseKey: el.licenseKey.value.trim(),
    password: el.password.value.trim(),
    inibuildsProductId,
    inibuildsProductName: getIniBuildsProductNameById(inibuildsProductId),
    inibuildsActivationKey: getIniBuildsActivationKeyById(inibuildsProductId),
    ignoreList: parseIgnoreListInput(el.ignoreList.value),
    packageVersion: Number(el.packageVersion.value || '0'),
    rememberAuth: el.rememberAuth.checked,
    provider: normalizeProvider(el.provider.value, 'xupdater'),
    channel: String(el.channel.value || 'release')
  };
}

function fillForm(profile) {
  el.profileName.value = profile?.name || '';
  el.host.value = profile?.host || getDefaultHostForProvider(profile?.provider);
  el.productDir.value = profile?.productDir || '';
  el.login.value = profile?.login || '';
  el.licenseKey.value = profile?.licenseKey || '';
  el.password.value = profile?.password || '';
  if (el.inibuildsProductId) {
    const desired = Number(profile?.inibuildsProductId || 0);
    const desiredName = String(profile?.inibuildsProductName || '').trim();
    setSelectOptions(el.inibuildsProductId, filterIniBuildsProductsForUi(state.inibuildsProducts), desired, desiredName);
  }
  el.ignoreList.value = formatIgnoreListOutput(profile?.ignoreList || []);
  el.packageVersion.value = Number(profile?.packageVersion || 0);
  el.rememberAuth.checked = Boolean(profile?.rememberAuth ?? true);
  el.provider.value = normalizeProvider(profile?.provider, 'xupdater');
  el.channel.value = String(profile?.channel || 'release');
  syncProviderFields();
  syncFreshModeUi();
  // Show saved activation key immediately (before any check).
  syncIniBuildsActivationKeyUi();
}

function resetSummary() {
  el.sumSnapshot.textContent = '-';
  el.sumFiles.textContent = '-';
  el.sumDownload.textContent = '-';
  el.sumDisk.textContent = '-';
  el.sumWarnings.textContent = '-';
  el.actionCount.textContent = t('count.entries', { count: 0 });
}

function renderOptionalPackages(optionalPackages) {
  const packages = Array.isArray(optionalPackages) ? optionalPackages : [];
  el.optionalPackageCount.textContent = t('count.entries', { count: packages.length });

  if (packages.length === 0) {
    el.optionalPackagesEmpty.hidden = false;
    el.optionalPackagesList.innerHTML = '';
    return;
  }

  el.optionalPackagesEmpty.hidden = true;
  const lockProfileUi = state.installRunning || state.checkRunning || state.rollbackRunning;

  const rows = packages
    .map((item) => {
      const id = escapeHtml(String(item && item.id ? item.id : ''));
      const packageName = escapeHtml(String(item && item.name ? item.name : ''));
      const detected = Boolean(item && item.detected);
      const defaultAction = normalizeOptionalPackageAction(
        item && item.defaultAction,
        detected ? 'install' : 'ignore'
      );
      const selectedActionRaw = normalizeOptionalPackageAction(
        item && item.selectedAction,
        defaultAction
      );
      const selectedAction = selectedActionRaw;
      const hint = detected
        ? t('optional.detected')
        : t('optional.missingDetection');
      const customChoice = selectedAction !== defaultAction
        ? ` ${t('optional.customChoice')}`
        : '';
      const installSelected = selectedAction === 'install' ? ' selected' : '';
      const ignoreSelected = selectedAction === 'ignore' ? ' selected' : '';

      return `
        <div class="optional-package-item">
          <div class="optional-package-meta">
            <div class="optional-package-name" title="${packageName}">${packageName}</div>
            <div class="optional-package-hint">${escapeHtml(`${hint}${customChoice}`)}</div>
          </div>
          <label class="optional-package-choice">
            <span>${escapeHtml(t('optional.choice'))}</span>
            <select data-optional-package-id="${id}" data-optional-package-name="${packageName}"${lockProfileUi ? ' disabled' : ''}>
              <option value="install"${installSelected}>${escapeHtml(t('optional.actionInstall'))}</option>
              <option value="ignore"${ignoreSelected}>${escapeHtml(t('optional.actionIgnore'))}</option>
            </select>
          </label>
        </div>
      `;
    })
    .join('');

  el.optionalPackagesList.innerHTML = rows;
}

function renderActions(actions) {
  const allActions = Array.isArray(actions) ? actions : [];
  const totalCount = allActions.length;

  state.actionTable.action = normalizeActionTableFilter(state.actionTable.action, 'all');
  state.actionTable.pageSize = normalizeActionTablePageSize(
    state.actionTable.pageSize,
    normalizeActionTablePageSize(el.planPageSize.value, 100)
  );

  const filteredActions = getFilteredActions(allActions);
  const filteredCount = filteredActions.length;

  if (totalCount === 0) {
    syncActionTableControls(0, 0, 1);
    el.actionsTableBody.innerHTML = `<tr><td colspan="4" class="empty">${escapeHtml(t('table.noUpdates'))}</td></tr>`;
    el.actionCount.textContent = t('count.entries', { count: 0 });
    return;
  }

  if (filteredCount === 0) {
    state.actionTable.page = 1;
    syncActionTableControls(totalCount, 0, 1);
    el.actionsTableBody.innerHTML = `<tr><td colspan="4" class="empty">${escapeHtml(t('table.noFilterMatch'))}</td></tr>`;
    el.actionCount.textContent = t('count.entriesFiltered', { filtered: 0, total: totalCount });
    return;
  }

  const totalPages = Math.max(1, Math.ceil(filteredCount / state.actionTable.pageSize));
  const currentPage = Math.min(Math.max(1, Math.trunc(Number(state.actionTable.page || 1))), totalPages);
  state.actionTable.page = currentPage;
  const startIndex = (currentPage - 1) * state.actionTable.pageSize;
  const shown = filteredActions.slice(startIndex, startIndex + state.actionTable.pageSize);

  const rows = shown
    .map((item) => {
      const actionTag = item.type === 'delete'
        ? `<span class="tag-delete">${escapeHtml(t('table.tagDelete'))}</span>`
        : `<span class="tag-update">${escapeHtml(t('table.tagUpdate'))}</span>`;
      const compressedSize = Number(item.compressedSize || 0);
      const size = item.type === 'delete'
        ? '-'
        : compressedSize > 0
          ? formatBytes(compressedSize)
          : `${formatBytes(item.realSize)} (max)`;
      const packageName = escapeHtml(item.packageName);
      const relativePath = escapeHtml(item.relativePath);

      return `
        <tr>
          <td class="col-action">${actionTag}</td>
          <td class="col-package" title="${packageName}">${packageName}</td>
          <td class="col-file" title="${relativePath}">${relativePath}</td>
          <td class="col-size">${size}</td>
        </tr>
      `;
    })
    .join('');

  el.actionsTableBody.innerHTML = rows;
  syncActionTableControls(totalCount, filteredCount, totalPages);
  el.actionCount.textContent = filteredCount === totalCount
    ? t('count.entries', { count: totalCount })
    : t('count.entriesFiltered', { filtered: filteredCount, total: totalCount });
}

function renderProfiles() {
  el.profileList.innerHTML = '';

  if (!state.profiles.length) {
    const li = document.createElement('li');
    li.className = 'profile-item';
    li.textContent = t('sidebar.noProfiles');
    el.profileList.append(li);
    return;
  }

  for (const profile of state.profiles) {
    const li = document.createElement('li');
    li.className = `profile-item ${profile.id === state.selectedProfileId ? 'active' : ''}`;
    li.innerHTML = `
      <div class="name">${escapeHtml(profile.name)}</div>
      <div class="meta">${escapeHtml(profile.productDir)}</div>
    `;

    li.addEventListener('click', () => {
      if (state.installRunning || state.checkRunning || state.rollbackRunning) {
        setStatus(t('status.profileSwitchBlocked'));
        log(t('log.profileSwitchBlocked'));
        return;
      }

      state.selectedProfileId = profile.id;
      fillForm(profile);
      el.selectedProfileName.textContent = profile.name;
      renderProfiles();
      state.currentPlan = null;
      resetOptionalPackages();
      resetSummary();
      resetProgressUi();
      renderActions([]);
      syncActionButtons();
      setStatus(t('status.profileLoaded'));
      void refreshRollbackInfo(profile.id);
    });

    el.profileList.append(li);
  }
}

async function loadProfiles() {
  state.profiles = await window.aeroApi.listProfiles();

  if (state.profiles.length > 0) {
    if (!state.selectedProfileId || !state.profiles.some((p) => p.id === state.selectedProfileId)) {
      state.selectedProfileId = state.profiles[0].id;
    }

    const selected = getSelectedProfile();
    fillForm(selected);
    el.selectedProfileName.textContent = selected?.name || t('profile.none');
  } else {
    state.selectedProfileId = null;
    fillForm(null);
    el.selectedProfileName.textContent = t('profile.none');
  }

  resetOptionalPackages();
  renderProfiles();
  syncActionButtons();
  await refreshRollbackInfo();
}

async function saveProfile() {
  const profile = collectProfileFromForm();
  const transientCredentials = profile.rememberAuth
    ? null
    : {
        login: profile.login,
        licenseKey: profile.licenseKey,
        password: profile.password
      };

  const result = await window.aeroApi.saveProfile(profile);
  state.profiles = result.allProfiles;
  state.selectedProfileId = result.profile.id;
  renderProfiles();
  fillForm(result.profile);
  if (transientCredentials) {
    el.login.value = transientCredentials.login;
    el.licenseKey.value = transientCredentials.licenseKey;
    el.password.value = transientCredentials.password;
    el.rememberAuth.checked = false;
  }
  el.selectedProfileName.textContent = result.profile.name;
  log(t('log.profileSaved', { name: result.profile.name }));
  setStatus(t('status.profileSaved'));
  if (transientCredentials) {
    return {
      ...result.profile,
      login: transientCredentials.login,
      licenseKey: transientCredentials.licenseKey,
      password: transientCredentials.password
    };
  }

  return result.profile;
}

async function ensureProfileSaved() {
  const selected = getSelectedProfile();
  const inForm = collectProfileFromForm();

  if (!selected) {
    return saveProfile();
  }

  const changed = [
    'name',
    'host',
    'productDir',
    'ignoreList',
    'inibuildsProductId',
    'inibuildsProductName',
    'packageVersion',
    'rememberAuth',
    'provider',
    'channel'
  ].some((key) => String(selected[key] ?? '') !== String(inForm[key] ?? ''));

  const authChanged = Boolean(inForm.rememberAuth) && (
    String(selected.login ?? '') !== String(inForm.login ?? '')
    || String(selected.licenseKey ?? '') !== String(inForm.licenseKey ?? '')
    || String(selected.password ?? '') !== String(inForm.password ?? '')
  );

  if (changed || authChanged) {
    return saveProfile();
  }

  return selected;
}

function applyPlanToUi(planResult) {
  const sum = planResult.summary;
  const provider = normalizeProvider(el.provider.value, 'xupdater');
  const isIniBuilds = provider === 'inibuilds' || String(sum && sum.snapshotType ? sum.snapshotType : '') === 'inibuilds';
  if (el.sumSnapshotCard) {
    el.sumSnapshotCard.hidden = isIniBuilds;
  }
  if (el.summaryGrid) {
    if (isIniBuilds) {
      el.summaryGrid.dataset.columns = '4';
    } else {
      delete el.summaryGrid.dataset.columns;
    }
  }
  el.sumSnapshot.textContent = isIniBuilds ? '-' : `${sum.snapshotType} #${sum.snapshotNumber}`;
  el.sumFiles.textContent = t('summary.filesWithDelete', {
    fileCount: sum.fileCount,
    deleteCount: sum.deleteCount
  });
  el.sumDownload.textContent = formatDownload(sum);
  el.sumDisk.textContent = formatBytes(sum.diskSize);
  const warnings = Array.isArray(planResult.warnings) ? planResult.warnings : [];
  el.sumWarnings.textContent = `${warnings.length}`;
  if (el.optionalPackagesPanel) {
    el.optionalPackagesPanel.hidden = isIniBuilds;
  }
  if (!isIniBuilds) {
    renderOptionalPackages(planResult.optionalPackages || []);
  } else {
    renderOptionalPackages([]);
  }
  renderActions(planResult.actions);
}

async function onCheckUpdates() {
  if (state.installRunning || state.rollbackRunning) {
    return;
  }

  try {
    state.checkRunning = true;
    syncActionButtons();
    setStatus(t('status.checking'));

    const profile = await ensureProfileSaved();
    log(t('log.checkStarted', { name: profile.name }));

    const channel = el.channel.value || 'release';
    const options = {
      beta: channel === 'beta',
      alpha: channel === 'alpha',
      fresh: el.optFresh.checked,
      repair: el.optRepair.checked
    };
    if (Object.keys(state.optionalPackageSelection).length > 0) {
      options.optionalPackages = { ...state.optionalPackageSelection };
    }

    if (options.repair) {
      log(t('log.repairModeEnabled'));
    }

    const planResult = await window.aeroApi.checkUpdates({
      profileId: profile.id,
      options,
      credentials: {
        login: el.login.value.trim(),
        licenseKey: el.licenseKey.value.trim(),
        password: el.password.value.trim()
      }
    });

    applyIniBuildsProductsFromPlan(planResult);
    const optionalPackages = Array.isArray(planResult.optionalPackages)
      ? planResult.optionalPackages
      : [];
    syncOptionalSelectionFromPlan(optionalPackages);

    state.currentPlan = {
      planId: planResult.planId,
      profileId: profile.id,
      summary: planResult.summary,
      actions: planResult.actions,
      optionalPackages
    };
    state.actionTable.page = 1;

    applyPlanToUi(planResult);
    resetProgressUi();
    el.progressLabel.textContent = t('progress.readyToInstall');
    el.progressMeta.textContent = t('progress.meta', { index: 0, total: planResult.actions.length || 0 });
    syncActionButtons();

    const provider = normalizeProvider(el.provider.value, 'xupdater');
    const selectedIniBuildsProductId = Number(el.inibuildsProductId && el.inibuildsProductId.value
      ? el.inibuildsProductId.value
      : 0);
    if (
      provider === 'inibuilds'
      && (!Number.isFinite(selectedIniBuildsProductId) || selectedIniBuildsProductId <= 0)
      && Array.isArray(planResult.inibuildsProducts)
      && planResult.inibuildsProducts.length > 0
      && (!planResult.actions || planResult.actions.length === 0)
    ) {
      setStatus(t('status.selectIniBuildsProduct'));
      log(t('log.hintPrefix', { message: t('hint.inibuildsSelectProduct') }));
    }

    const warnings = Array.isArray(planResult.warnings) ? planResult.warnings : [];
    if (warnings.length > 0) {
      setStatus(t('status.planReadyWithWarnings'));
      for (const item of warnings) {
        log(t('log.hintPrefix', { message: item }));
      }
    } else if (!planResult.actions || planResult.actions.length === 0) {
      setStatus(t('status.noUpdateRequired'));
    } else {
      setStatus(t('status.planReady'));
    }

    const downloadText = formatDownload(planResult.summary);
    log(t('log.planCreated', {
      fileCount: planResult.summary.fileCount,
      download: downloadText
    }));
    if (Number(planResult.summary.ignoredCount || 0) > 0) {
      log(t('log.ignoreApplied', {
        count: planResult.summary.ignoredCount
      }));
    }
    if (Number(planResult.summary.optionalIgnoredCount || 0) > 0) {
      log(t('log.optionalIgnored', {
        count: planResult.summary.optionalIgnoredCount
      }));
    }
    if (Number(planResult.summary.optionalForcedInstallCount || 0) > 0) {
      log(t('log.optionalForcedInstall', {
        count: planResult.summary.optionalForcedInstallCount
      }));
    }
    if (Number(planResult.summary.downloadSizeUnknownCount || 0) > 0) {
      log(t('log.hintPrefix', {
        message: t('log.downloadUnknownHint', {
          count: planResult.summary.downloadSizeUnknownCount
        })
      }));
    }
  } catch (error) {
    setStatus(t('status.checkError'));
    log(t('log.error', { message: error.message }));
    window.alert(t('alert.checkFailed', { message: error.message }));
  } finally {
    state.checkRunning = false;
    syncActionButtons();
  }
}

async function onInstallUpdates() {
  if (!state.currentPlan) {
    window.alert(t('alert.noPlan'));
    return;
  }

  if (state.installRunning || state.rollbackRunning) {
    return;
  }

  try {
    state.installRunning = true;
    state.installPaused = false;
    syncActionButtons();
    setStatus(t('status.installing'));
    log(t('log.installStarted'));

    const result = await window.aeroApi.installUpdates({
      profileId: state.currentPlan.profileId,
      planId: state.currentPlan.planId
    });

    if (result && result.cancelled) {
      el.progressLabel.textContent = t('progress.cancelled');
      el.progressFile.textContent = t('progress.cancelledFile');
      setStatus(t('status.installCancelled'));
      log(t('log.installCancelled'));
      state.currentPlan = null;
      log(t('log.runCheckAgain'));
      await refreshRollbackInfo();
      return;
    }

    updateProgressUi({
      index: result.total,
      total: result.total,
      type: 'update',
      path: t('progress.completed')
    });
    setStatus(t('status.installCompleted'));
    log(t('log.installFinished', { updated: result.updated, deleted: result.deleted }));
    const provider = normalizeProvider(el.provider.value, 'xupdater');
    const isIniBuilds = provider === 'inibuilds' || String(result && result.snapshotType ? result.snapshotType : '') === 'inibuilds';
    if (!isIniBuilds) {
      log(t('log.newSnapshot', { number: result.snapshotNumber, type: result.snapshotType }));
      const newSnapshotNumber = Number(result.snapshotNumber);
      if (Number.isFinite(newSnapshotNumber) && newSnapshotNumber >= 0) {
        const selectedIndex = state.profiles.findIndex((item) => item.id === state.currentPlan.profileId);
        if (selectedIndex >= 0) {
          state.profiles[selectedIndex].packageVersion = newSnapshotNumber;
        }
        el.packageVersion.value = newSnapshotNumber;
      }

      window.alert(t('alert.installCompleted', {
        updated: result.updated,
        deleted: result.deleted,
        type: result.snapshotType,
        number: result.snapshotNumber
      }));
    } else {
      window.alert(t('alert.installCompletedNoSnapshot', {
        updated: result.updated,
        deleted: result.deleted
      }));
    }

    state.currentPlan = null;
    await refreshRollbackInfo();
  } catch (error) {
    const msg = String(error && error.message ? error.message : error);
    if (/cancelled by user|abgebrochen/i.test(msg)) {
      el.progressLabel.textContent = t('progress.cancelled');
      el.progressFile.textContent = t('progress.cancelledFile');
      setStatus(t('status.installCancelled'));
      log(t('log.installCancelled'));
      state.currentPlan = null;
      log(t('log.runCheckAgain'));
      await refreshRollbackInfo();
    } else {
      setStatus(t('status.installError'));
      log(t('log.installError', { message: msg }));
      window.alert(t('alert.installFailed', { message: msg }));
    }
  } finally {
    state.installRunning = false;
    state.installPaused = false;
    syncActionButtons();
  }
}

async function onTogglePauseInstall() {
  if (!state.installRunning) {
    return;
  }

  try {
    if (state.installPaused) {
      await window.aeroApi.resumeInstall();
      state.installPaused = false;
      el.progressLabel.textContent = t('progress.installingFiles');
      el.progressFile.textContent = t('progress.resumedFile');
      setStatus(t('status.installResumed'));
      log(t('log.installResumed'));
    } else {
      await window.aeroApi.pauseInstall();
      state.installPaused = true;
      el.progressLabel.textContent = t('progress.pausing');
      el.progressFile.textContent = t('progress.pausingFile');
      setStatus(t('status.installPausing'));
      log(t('log.pauseRequested'));
    }
  } catch (error) {
    log(t('log.pauseError', { message: error.message }));
    window.alert(t('alert.pauseFailed', { message: error.message }));
  } finally {
    syncActionButtons();
  }
}

async function onCheckAppUpdate() {
  if (state.appUpdateRunning || state.rollbackRunning) {
    return;
  }

  try {
    state.appUpdateRunning = true;
    syncActionButtons();
    setStatus(t('status.appUpdateChecking'));
    log(t('log.appUpdateChecking'));

    const result = await window.aeroApi.checkAppUpdate();
    setAppVersion(result.currentVersion);

    if (result.status === 'available') {
      setStatus(t('status.appUpdateAvailable'));
      log(t('log.appUpdateAvailable', {
        latest: result.latestVersion,
        current: result.currentVersion
      }));

      const openRelease = window.confirm(t('confirm.openReleasePage', {
        latest: result.latestVersion,
        current: result.currentVersion
      }));

      if (openRelease) {
        await window.aeroApi.openExternalUrl(result.releaseUrl);
      }

      return;
    }

    setStatus(t('status.appUpToDate'));
    log(t('log.appUpToDate', {
      current: result.currentVersion
    }));
  } catch (error) {
    setStatus(t('status.appUpdateError'));
    log(t('log.appUpdateError', { message: error.message }));
    window.alert(t('alert.appUpdateFailed', { message: error.message }));
  } finally {
    state.appUpdateRunning = false;
    syncActionButtons();
  }
}

function onCreateNewProfile() {
  state.selectedProfileId = null;
  state.currentPlan = null;
  resetOptionalPackages();
  fillForm(null);
  el.provider.value = 'xupdater';
  syncProviderFields({ forceHostDefault: true });
  el.selectedProfileName.textContent = t('profile.new');
  resetSummary();
  resetProgressUi();
  renderActions([]);
  state.rollbackAvailable = false;
  syncActionButtons();
  setStatus(t('status.newProfile'));
}

async function onRollbackLastInstall() {
  const selected = getSelectedProfile();
  if (!selected || state.installRunning || state.checkRunning || state.rollbackRunning) {
    return;
  }

  if (!state.rollbackAvailable) {
    window.alert(t('alert.rollbackUnavailable'));
    return;
  }

  const yes = window.confirm(t('confirm.rollbackInstall', { name: selected.name }));
  if (!yes) {
    return;
  }

  try {
    state.rollbackRunning = true;
    syncActionButtons();
    setStatus(t('status.rollbackRunning'));
    log(t('log.rollbackStarted'));

    const result = await window.aeroApi.rollbackLastInstall({
      profileId: selected.id
    });

    const restoredSnapshotNumber = Number(result.sourceSnapshotNumber);
    if (Number.isFinite(restoredSnapshotNumber) && restoredSnapshotNumber >= 0) {
      const selectedIndex = state.profiles.findIndex((item) => item.id === selected.id);
      if (selectedIndex >= 0) {
        state.profiles[selectedIndex].packageVersion = restoredSnapshotNumber;
      }
      el.packageVersion.value = restoredSnapshotNumber;
    }

    state.currentPlan = null;
    resetOptionalPackages();
    resetSummary();
    resetProgressUi();
    renderActions([]);

    setStatus(t('status.rollbackCompleted'));
    log(t('log.rollbackFinished', {
      restored: Number(result.restored || 0),
      removed: Number(result.removed || 0)
    }));
    log(t('log.runCheckAgain'));

    const provider = normalizeProvider(selected.provider || el.provider.value, 'xupdater');
    const isIniBuilds = provider === 'inibuilds';
    if (isIniBuilds) {
      window.alert(t('alert.rollbackCompletedNoSnapshot', {
        restored: Number(result.restored || 0),
        removed: Number(result.removed || 0)
      }));
    } else {
      window.alert(t('alert.rollbackCompleted', {
        restored: Number(result.restored || 0),
        removed: Number(result.removed || 0),
        number: Number(result.sourceSnapshotNumber || 0)
      }));
    }
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    setStatus(t('status.rollbackError'));
    log(t('log.rollbackError', { message }));
    window.alert(t('alert.rollbackFailed', { message }));
  } finally {
    state.rollbackRunning = false;
    await refreshRollbackInfo(selected.id);
    syncActionButtons();
  }
}

async function onSaveProfileClicked() {
  try {
    await saveProfile();
  } catch (error) {
    log(t('log.saveError', { message: error.message }));
    window.alert(t('alert.saveFailed', { message: error.message }));
  }
}

async function onDeleteProfileClicked() {
  const selected = getSelectedProfile();
  if (!selected) {
    return;
  }

  const yes = window.confirm(t('confirm.deleteProfile', { name: selected.name }));
  if (!yes) {
    return;
  }

  try {
    state.profiles = await window.aeroApi.deleteProfile(selected.id);
    state.selectedProfileId = state.profiles[0]?.id || null;
    await loadProfiles();
    state.currentPlan = null;
    resetSummary();
    resetProgressUi();
    renderActions([]);
    syncActionButtons();
    log(t('log.profileDeleted', { name: selected.name }));
    setStatus(t('status.profileDeleted'));
  } catch (error) {
    log(t('log.deleteError', { message: error.message }));
    window.alert(t('alert.deleteFailed', { message: error.message }));
  }
}

async function onPickDirectoryClicked() {
  try {
    const chosen = await window.aeroApi.pickDirectory();
    if (chosen) {
      el.productDir.value = chosen;
    }
  } catch (error) {
    log(t('log.pickDirError', { message: error.message }));
    window.alert(t('alert.pickDirFailed', { message: error.message }));
  }
}

function onClearLog() {
  el.logBox.textContent = '';
}

async function onOpenSelectedProfileDirectory() {
  const selected = getSelectedProfile();
  const targetPath = String(el.productDir.value || selected?.productDir || '').trim();

  if (!targetPath) {
    return;
  }

  try {
    await window.aeroApi.openPath(targetPath);
  } catch (error) {
    log(t('log.openPathError', { message: error.message }));
    window.alert(t('alert.openPathFailed', { message: error.message }));
  }
}

function buildDiagnosticsExportPayload() {
  const selected = getSelectedProfile();
  const profileSummaries = state.profiles.map((profile) => {
    const productDir = String(profile.productDir || '').trim();
    const depth = productDir
      ? productDir.split(/[\\/]+/).filter(Boolean).length
      : 0;

    return {
      id: String(profile.id || ''),
      host: String(profile.host || ''),
      provider: normalizeProvider(profile.provider, 'xupdater'),
      channel: String(profile.channel || 'release'),
      packageVersion: Number(profile.packageVersion || 0),
      rememberAuth: Boolean(profile.rememberAuth),
      ignoreRuleCount: Array.isArray(profile.ignoreList) ? profile.ignoreList.length : 0,
      productDirDepth: depth,
      profileNameLength: String(profile.name || '').length
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    ui: {
      selectedProfileId: selected ? selected.id : null,
      checkRunning: state.checkRunning,
      installRunning: state.installRunning,
      installPaused: state.installPaused,
      appUpdateRunning: state.appUpdateRunning
    },
    language: {
      code: state.i18n.locale,
      locale: state.i18n.localeTag
    },
    profiles: {
      count: profileSummaries.length,
      items: profileSummaries
    },
    currentPlan: state.currentPlan
      ? {
          profileId: state.currentPlan.profileId,
          planId: state.currentPlan.planId,
          summary: state.currentPlan.summary || {},
          actionCount: Array.isArray(state.currentPlan.actions) ? state.currentPlan.actions.length : 0,
          optionalPackageCount: Array.isArray(state.currentPlan.optionalPackages)
            ? state.currentPlan.optionalPackages.length
            : 0
        }
      : null,
    logText: String(el.logBox.textContent || '')
  };
}

async function onExportProfilesFromMenu() {
  try {
    if (!Array.isArray(state.profiles) || state.profiles.length === 0) {
      window.alert(t('alert.noProfilesToExport'));
      return;
    }

    const result = await window.aeroApi.exportProfiles({});
    if (!result || !result.saved) {
      return;
    }

    setStatus(t('status.profilesExported', { count: result.count }));
    log(t('log.profilesExported', { count: result.count, path: result.path }));
  } catch (error) {
    log(t('log.profilesExportError', { message: error.message }));
    window.alert(t('alert.profilesExportFailed', { message: error.message }));
  }
}

async function onImportProfilesFromMenu() {
  try {
    const result = await window.aeroApi.importProfiles();
    if (!result || !result.imported) {
      return;
    }

    state.profiles = Array.isArray(result.allProfiles) ? result.allProfiles : [];
    if (!state.profiles.some((item) => item.id === state.selectedProfileId)) {
      state.selectedProfileId = state.profiles[0]?.id || null;
    }

    const selected = getSelectedProfile();
    fillForm(selected || null);
    el.selectedProfileName.textContent = selected?.name || t('profile.none');

    state.currentPlan = null;
    resetOptionalPackages();
    resetSummary();
    resetProgressUi();
    renderActions([]);
    renderProfiles();
    syncActionButtons();

    setStatus(t('status.profilesImported', { count: result.importedCount }));
    log(t('log.profilesImported', {
      count: result.importedCount,
      created: result.createdCount,
      updated: result.updatedCount,
      path: result.path
    }));

    if (Number(result.warningCount || 0) > 0 && Array.isArray(result.warnings)) {
      for (const warning of result.warnings) {
        log(t('log.hintPrefix', { message: warning }));
      }
    }

    if (Number(result.errorCount || 0) > 0 && Array.isArray(result.errors)) {
      for (const entry of result.errors.slice(0, 8)) {
        log(t('log.hintPrefix', { message: entry }));
      }
    }
  } catch (error) {
    log(t('log.profilesImportError', { message: error.message }));
    window.alert(t('alert.profilesImportFailed', { message: error.message }));
  }
}

async function onExportDiagnosticsFromMenu() {
  try {
    const diagnostics = buildDiagnosticsExportPayload();
    const result = await window.aeroApi.exportDiagnostics(diagnostics);
    if (!result || !result.saved) {
      return;
    }

    setStatus(t('status.diagnosticsExported'));
    log(t('log.diagnosticsExported', { path: result.path }));
  } catch (error) {
    log(t('log.diagnosticsExportError', { message: error.message }));
    window.alert(t('alert.diagnosticsExportFailed', { message: error.message }));
  }
}

async function handleMenuAction(action) {
  switch (String(action || '')) {
    case MENU_ACTIONS.PROFILE_NEW:
      onCreateNewProfile();
      return;
    case MENU_ACTIONS.PROFILE_SAVE:
      await onSaveProfileClicked();
      return;
    case MENU_ACTIONS.PROFILE_DELETE:
      await onDeleteProfileClicked();
      return;
    case MENU_ACTIONS.PROFILE_IMPORT:
      await onImportProfilesFromMenu();
      return;
    case MENU_ACTIONS.PROFILE_EXPORT:
      await onExportProfilesFromMenu();
      return;
    case MENU_ACTIONS.PROFILE_OPEN_DIR:
      await onOpenSelectedProfileDirectory();
      return;
    case MENU_ACTIONS.UPDATES_CHECK:
      await onCheckUpdates();
      return;
    case MENU_ACTIONS.UPDATES_INSTALL:
      await onInstallUpdates();
      return;
    case MENU_ACTIONS.UPDATES_PAUSE_RESUME:
      await onTogglePauseInstall();
      return;
    case MENU_ACTIONS.UPDATES_CANCEL:
      await onCancelInstall();
      return;
    case MENU_ACTIONS.APP_EXPORT_DIAGNOSTICS:
      await onExportDiagnosticsFromMenu();
      return;
    case MENU_ACTIONS.APP_CHECK_UPDATE:
      await onCheckAppUpdate();
      return;
    case MENU_ACTIONS.LOG_CLEAR:
      onClearLog();
      return;
    default:
      return;
  }
}

async function onCancelInstall() {
  if (!state.installRunning) {
    return;
  }

  const yes = window.confirm(t('confirm.cancelInstall'));
  if (!yes) {
    return;
  }

  try {
    await window.aeroApi.cancelInstall();
    state.installPaused = false;
    el.progressLabel.textContent = t('progress.cancelling');
    el.progressFile.textContent = t('progress.cancellingFile');
    syncActionButtons();
    setStatus(t('status.cancelRequested'));
    log(t('log.cancelRequested'));
  } catch (error) {
    log(t('log.cancelError', { message: error.message }));
    window.alert(t('alert.cancelFailed', { message: error.message }));
  }
}

function onPlanSearchChanged() {
  state.actionTable.query = String(el.planSearch.value || '').trim();
  state.actionTable.page = 1;
  renderActions(state.currentPlan?.actions || []);
}

function onPlanActionFilterChanged() {
  state.actionTable.action = normalizeActionTableFilter(el.planActionFilter.value, 'all');
  state.actionTable.page = 1;
  renderActions(state.currentPlan?.actions || []);
}

function onPlanPageSizeChanged() {
  state.actionTable.pageSize = normalizeActionTablePageSize(
    el.planPageSize.value,
    state.actionTable.pageSize
  );
  state.actionTable.page = 1;
  renderActions(state.currentPlan?.actions || []);
}

function onPlanPrevPage() {
  state.actionTable.page = Math.max(1, Number(state.actionTable.page || 1) - 1);
  renderActions(state.currentPlan?.actions || []);
}

function onPlanNextPage() {
  state.actionTable.page = Number(state.actionTable.page || 1) + 1;
  renderActions(state.currentPlan?.actions || []);
}

async function onOptionalPackageSelectionChanged(event) {
  const target = event && event.target;
  if (!target || target.tagName !== 'SELECT') {
    return;
  }

  if (state.checkRunning || state.installRunning || state.rollbackRunning) {
    return;
  }

  const packageId = String(target.getAttribute('data-optional-package-id') || '').trim();
  if (!packageId) {
    return;
  }

  const packageName = String(target.getAttribute('data-optional-package-name') || packageId);
  const nextAction = normalizeOptionalPackageAction(target.value, 'ignore');
  const prevAction = normalizeOptionalPackageAction(state.optionalPackageSelection[packageId], '');
  if (nextAction === prevAction) {
    return;
  }

  state.optionalPackageSelection[packageId] = nextAction;
  log(t('log.optionalSelectionChanged', {
    name: packageName,
    action: nextAction === 'install'
      ? t('optional.actionInstall')
      : t('optional.actionIgnore')
  }));

  await onCheckUpdates();
}

function wireEvents() {
  el.btnNewProfile.addEventListener('click', onCreateNewProfile);
  el.btnSaveProfile.addEventListener('click', () => {
    void onSaveProfileClicked();
  });
  el.btnDeleteProfile.addEventListener('click', () => {
    void onDeleteProfileClicked();
  });
  el.btnPickDir.addEventListener('click', () => {
    void onPickDirectoryClicked();
  });
  el.provider.addEventListener('change', () => {
    syncProviderFields({ applyHostDefault: true });
  });

  if (el.inibuildsProductId) {
    el.inibuildsProductId.addEventListener('change', () => {
      syncIniBuildsActivationKeyUi();
    });
  }

  if (el.btnCopyIniBuildsActivationKey && el.inibuildsActivationKey) {
    el.btnCopyIniBuildsActivationKey.addEventListener('click', async () => {
      const value = String(el.inibuildsActivationKey.value || '').trim();
      if (!value) {
        return;
      }
      try {
        await navigator.clipboard.writeText(value);
        setStatus(t('status.copied'));
        log(t('log.copiedToClipboard'));
      } catch {
        // Fallback: show value so user can copy manually.
        window.prompt(t('prompt.copyManual'), value);
      }
    });
  }

  el.languageSelect.addEventListener('change', async () => {
    try {
      await loadAndApplyLanguage(el.languageSelect.value);
    } catch (error) {
      window.alert(t('alert.i18nLoadFailed', { message: error.message }));
    }
  });

  el.btnCheckAppUpdate.addEventListener('click', () => {
    void onCheckAppUpdate();
  });
  el.btnCheck.addEventListener('click', () => {
    void onCheckUpdates();
  });
  el.btnInstall.addEventListener('click', () => {
    void onInstallUpdates();
  });
  el.btnPause.addEventListener('click', () => {
    void onTogglePauseInstall();
  });
  el.btnCancel.addEventListener('click', () => {
    void onCancelInstall();
  });
  if (el.btnRollback) {
    el.btnRollback.addEventListener('click', () => {
      void onRollbackLastInstall();
    });
  }
  el.planSearch.addEventListener('input', onPlanSearchChanged);
  el.planActionFilter.addEventListener('change', onPlanActionFilterChanged);
  el.planPageSize.addEventListener('change', onPlanPageSizeChanged);
  el.btnPlanPrev.addEventListener('click', onPlanPrevPage);
  el.btnPlanNext.addEventListener('click', onPlanNextPage);
  el.optFresh.addEventListener('change', onToggleFreshMode);
  el.optRepair.addEventListener('change', onToggleRepairMode);
  el.btnClearLog.addEventListener('click', onClearLog);
  el.optionalPackagesList.addEventListener('change', (event) => {
    void onOptionalPackageSelectionChanged(event);
  });

  window.aeroApi.onMenuAction((action) => {
    void handleMenuAction(action);
  });

  let lastLoggedPercent = -1;
  window.aeroApi.onProgress((progress) => {
    updateProgressUi(progress);
    const msg = `${progress.index}/${progress.total} ${progress.message}`;
    setStatus(t('status.progressLine', {
      percent: el.progressPercent.textContent,
      message: msg
    }));

    // During byte-level download progress (bytesTotal > 0) only log on percent change
    // to avoid spamming the UI log with identical lines every 250 ms.
    const bytesTotal = Number(progress.bytesTotal || 0);
    const bytesDownloaded = Number(progress.bytesDownloaded || 0);
    const hasByteProgress = bytesTotal > 0;
    if (hasByteProgress) {
      const currentPercent = el.progressPercent.textContent;
      if (currentPercent !== lastLoggedPercent) {
        lastLoggedPercent = currentPercent;
        log(`${progress.message} — ${currentPercent} (${formatBytes(bytesDownloaded)} / ${formatBytes(bytesTotal)})`);
      }
    } else {
      lastLoggedPercent = -1;
      log(msg);
    }
  });
}

async function init() {
  wireEvents();
  try {
    await initI18n();
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    window.alert(`i18n init failed:\n${message}`);
  }
  try {
    const appVersion = await window.aeroApi.getAppVersion();
    setAppVersion(appVersion);
  } catch {
    setAppVersion('');
  }

  await loadProfiles();
  renderActions([]);
  resetSummary();
  resetProgressUi();
  syncProviderFields();
  syncFreshModeUi();
  syncActionButtons();
  setStatus(t('status.ready'));
  log(t('log.startup'));
}

init().catch((error) => {
  const message = String(error && error.message ? error.message : error);
  const startupMessage = state.i18n.messages && Object.keys(state.i18n.messages).length > 0
    ? t('alert.startupFailed', { message })
    : `Startup error:\n${message}`;
  window.alert(startupMessage);
});
