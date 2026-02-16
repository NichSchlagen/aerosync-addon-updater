const DEFAULT_HOST = 'https://update.x-plane.org';
const LANGUAGE_STORAGE_KEY = 'aerosync.language';
const ACTION_TABLE_MAX_ROWS = 600;
const ACTION_TABLE_PAGE_SIZES = [50, 100, 200, 300, 600];

const MENU_ACTIONS = Object.freeze({
  PROFILE_NEW: 'profile:new',
  PROFILE_SAVE: 'profile:save',
  PROFILE_DELETE: 'profile:delete',
  PROFILE_OPEN_DIR: 'profile:open-dir',
  UPDATES_CHECK: 'updates:check',
  UPDATES_INSTALL: 'updates:install',
  UPDATES_PAUSE_RESUME: 'updates:pause-resume',
  UPDATES_CANCEL: 'updates:cancel',
  APP_CHECK_UPDATE: 'app:check-update',
  LOG_CLEAR: 'log:clear'
});

let lastMenuStateSnapshot = '';

const state = {
  profiles: [],
  selectedProfileId: null,
  currentPlan: null,
  optionalPackageSelection: {},
  actionTable: {
    query: '',
    action: 'all',
    page: 1,
    pageSize: 100
  },
  checkRunning: false,
  installRunning: false,
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
  ignoreList: document.getElementById('ignoreList'),
  packageVersion: document.getElementById('packageVersion'),
  rememberAuth: document.getElementById('rememberAuth'),
  channel: document.getElementById('channel'),

  optFresh: document.getElementById('optFresh'),
  optRepair: document.getElementById('optRepair'),

  btnNewProfile: document.getElementById('btnNewProfile'),
  btnDeleteProfile: document.getElementById('btnDeleteProfile'),
  btnCheckAppUpdate: document.getElementById('btnCheckAppUpdate'),
  btnSaveProfile: document.getElementById('btnSaveProfile'),
  btnPickDir: document.getElementById('btnPickDir'),
  btnCheck: document.getElementById('btnCheck'),
  btnInstall: document.getElementById('btnInstall'),
  btnPause: document.getElementById('btnPause'),
  btnCancel: document.getElementById('btnCancel'),
  btnClearLog: document.getElementById('btnClearLog'),

  runStatus: document.getElementById('runStatus'),
  sumSnapshot: document.getElementById('sumSnapshot'),
  sumFiles: document.getElementById('sumFiles'),
  sumDownload: document.getElementById('sumDownload'),
  sumDisk: document.getElementById('sumDisk'),
  sumWarnings: document.getElementById('sumWarnings'),
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
  const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((index / total) * 100))) : 0;

  el.progressFill.style.width = `${percent}%`;
  el.progressPercent.textContent = `${percent}%`;
  el.progressMeta.textContent = t('progress.meta', { index, total });
  el.progressLabel.textContent = progress.type === 'delete'
    ? t('progress.deletingFiles')
    : t('progress.installingFiles');
  el.progressFile.textContent = progress.path || progress.message || '-';
}

function syncNativeMenuState() {
  const snapshot = {
    hasProfile: Boolean(getSelectedProfile()),
    hasPlan: Boolean(state.currentPlan && Array.isArray(state.currentPlan.actions) && state.currentPlan.actions.length > 0),
    checkRunning: state.checkRunning,
    installRunning: state.installRunning,
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
  const lockProfileUi = state.installRunning || state.checkRunning;
  const hasPlanActions = Boolean(state.currentPlan && state.currentPlan.actions && state.currentPlan.actions.length > 0);
  el.btnCheck.disabled = state.checkRunning || state.installRunning;
  el.btnInstall.disabled = state.checkRunning || state.installRunning || !hasPlanActions;
  el.btnPause.disabled = !state.installRunning;
  el.btnCancel.disabled = !state.installRunning;
  el.btnCheckAppUpdate.disabled = state.installRunning || state.checkRunning || state.appUpdateRunning;
  el.btnNewProfile.disabled = lockProfileUi;
  el.btnSaveProfile.disabled = lockProfileUi;
  el.btnDeleteProfile.disabled = lockProfileUi;
  el.btnPickDir.disabled = lockProfileUi;
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

function syncFreshModeUi() {
  const isFresh = Boolean(el.optFresh.checked);
  const isRepair = Boolean(el.optRepair.checked);
  const ignoreSince = isFresh || isRepair;

  el.packageVersion.disabled = ignoreSince;
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

function collectProfileFromForm() {
  return {
    id: state.selectedProfileId,
    name: el.profileName.value.trim(),
    host: (el.host.value || DEFAULT_HOST).trim(),
    productDir: el.productDir.value.trim(),
    login: el.login.value.trim(),
    licenseKey: el.licenseKey.value.trim(),
    ignoreList: parseIgnoreListInput(el.ignoreList.value),
    packageVersion: Number(el.packageVersion.value || '0'),
    rememberAuth: el.rememberAuth.checked,
    channel: String(el.channel.value || 'release')
  };
}

function fillForm(profile) {
  el.profileName.value = profile?.name || '';
  el.host.value = profile?.host || DEFAULT_HOST;
  el.productDir.value = profile?.productDir || '';
  el.login.value = profile?.login || '';
  el.licenseKey.value = profile?.licenseKey || '';
  el.ignoreList.value = formatIgnoreListOutput(profile?.ignoreList || []);
  el.packageVersion.value = Number(profile?.packageVersion || 0);
  el.rememberAuth.checked = Boolean(profile?.rememberAuth ?? true);
  el.channel.value = String(profile?.channel || 'release');
  syncFreshModeUi();
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
  const lockProfileUi = state.installRunning || state.checkRunning;

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
      if (state.installRunning || state.checkRunning) {
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
}

async function saveProfile() {
  const profile = collectProfileFromForm();
  const transientCredentials = profile.rememberAuth
    ? null
    : {
        login: profile.login,
        licenseKey: profile.licenseKey
      };
  const result = await window.aeroApi.saveProfile(profile);
  state.profiles = result.allProfiles;
  state.selectedProfileId = result.profile.id;
  renderProfiles();
  fillForm(result.profile);
  if (transientCredentials) {
    el.login.value = transientCredentials.login;
    el.licenseKey.value = transientCredentials.licenseKey;
    el.rememberAuth.checked = false;
  }
  el.selectedProfileName.textContent = result.profile.name;
  log(t('log.profileSaved', { name: result.profile.name }));
  setStatus(t('status.profileSaved'));
  if (transientCredentials) {
    return {
      ...result.profile,
      login: transientCredentials.login,
      licenseKey: transientCredentials.licenseKey
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
    'packageVersion',
    'rememberAuth',
    'channel'
  ].some((key) => String(selected[key] ?? '') !== String(inForm[key] ?? ''));

  const authChanged = Boolean(inForm.rememberAuth) && (
    String(selected.login ?? '') !== String(inForm.login ?? '')
    || String(selected.licenseKey ?? '') !== String(inForm.licenseKey ?? '')
  );

  if (changed || authChanged) {
    return saveProfile();
  }

  return selected;
}

function applyPlanToUi(planResult) {
  const sum = planResult.summary;
  el.sumSnapshot.textContent = `${sum.snapshotType} #${sum.snapshotNumber}`;
  el.sumFiles.textContent = t('summary.filesWithDelete', {
    fileCount: sum.fileCount,
    deleteCount: sum.deleteCount
  });
  el.sumDownload.textContent = formatDownload(sum);
  el.sumDisk.textContent = formatBytes(sum.diskSize);
  const warnings = Array.isArray(planResult.warnings) ? planResult.warnings : [];
  el.sumWarnings.textContent = `${warnings.length}`;
  renderOptionalPackages(planResult.optionalPackages || []);
  renderActions(planResult.actions);
}

async function onCheckUpdates() {
  if (state.installRunning) {
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
        licenseKey: el.licenseKey.value.trim()
      }
    });
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

  if (state.installRunning) {
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

    state.currentPlan = null;
  } catch (error) {
    const msg = String(error && error.message ? error.message : error);
    if (/cancelled by user|abgebrochen/i.test(msg)) {
      el.progressLabel.textContent = t('progress.cancelled');
      el.progressFile.textContent = t('progress.cancelledFile');
      setStatus(t('status.installCancelled'));
      log(t('log.installCancelled'));
      state.currentPlan = null;
      log(t('log.runCheckAgain'));
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
  if (state.appUpdateRunning) {
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
  el.selectedProfileName.textContent = t('profile.new');
  resetSummary();
  resetProgressUi();
  renderActions([]);
  syncActionButtons();
  setStatus(t('status.newProfile'));
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

  if (state.checkRunning || state.installRunning) {
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

  window.aeroApi.onProgress((progress) => {
    updateProgressUi(progress);
    const msg = `${progress.index}/${progress.total} ${progress.message}`;
    setStatus(t('status.progressLine', {
      percent: el.progressPercent.textContent,
      message: msg
    }));
    log(msg);
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
