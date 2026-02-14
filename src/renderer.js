const DEFAULT_HOST = 'https://update.x-plane.org';
const LANGUAGE_STORAGE_KEY = 'aerosync.language';

const state = {
  profiles: [],
  selectedProfileId: null,
  currentPlan: null,
  checkRunning: false,
  installRunning: false,
  installPaused: false,
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

  btnNewProfile: document.getElementById('btnNewProfile'),
  btnDeleteProfile: document.getElementById('btnDeleteProfile'),
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
  actionCount: document.getElementById('actionCount'),
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

  if (state.currentPlan) {
    applyPlanToUi({
      summary: state.currentPlan.summary,
      actions: state.currentPlan.actions,
      warnings: []
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

function syncActionButtons() {
  const lockProfileUi = state.installRunning || state.checkRunning;
  const hasPlanActions = Boolean(state.currentPlan && state.currentPlan.actions && state.currentPlan.actions.length > 0);
  el.btnCheck.disabled = state.checkRunning || state.installRunning;
  el.btnInstall.disabled = state.checkRunning || state.installRunning || !hasPlanActions;
  el.btnPause.disabled = !state.installRunning;
  el.btnCancel.disabled = !state.installRunning;
  el.btnNewProfile.disabled = lockProfileUi;
  el.btnSaveProfile.disabled = lockProfileUi;
  el.btnDeleteProfile.disabled = lockProfileUi;
  el.btnPickDir.disabled = lockProfileUi;
  el.languageSelect.disabled = lockProfileUi || state.i18n.languages.length === 0;
  el.btnPause.textContent = state.installPaused ? t('btn.resume') : t('btn.pause');
  el.profileList.classList.toggle('blocked', lockProfileUi);
}

function syncFreshModeUi() {
  const isFresh = Boolean(el.optFresh.checked);
  el.packageVersion.disabled = isFresh;
  el.packageVersion.title = isFresh ? t('tooltip.freshSince') : '';
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

function renderActions(actions) {
  if (!Array.isArray(actions) || actions.length === 0) {
    el.actionsTableBody.innerHTML = `<tr><td colspan="4" class="empty">${escapeHtml(t('table.noUpdates'))}</td></tr>`;
    el.actionCount.textContent = t('count.entries', { count: 0 });
    return;
  }

  const maxRows = 600;
  const shown = actions.slice(0, maxRows);

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

  const clippedHint = actions.length > maxRows
    ? `<tr><td colspan="4" class="empty">${escapeHtml(t('table.moreHidden', { count: actions.length - maxRows }))}</td></tr>`
    : '';

  el.actionsTableBody.innerHTML = rows + clippedHint;
  el.actionCount.textContent = t('count.entries', { count: actions.length });
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
      fresh: el.optFresh.checked
    };

    const planResult = await window.aeroApi.checkUpdates({
      profileId: profile.id,
      options,
      credentials: {
        login: el.login.value.trim(),
        licenseKey: el.licenseKey.value.trim()
      }
    });

    state.currentPlan = {
      planId: planResult.planId,
      profileId: profile.id,
      summary: planResult.summary,
      actions: planResult.actions
    };

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

function wireEvents() {
  el.btnNewProfile.addEventListener('click', () => {
    state.selectedProfileId = null;
    state.currentPlan = null;
    fillForm(null);
    el.selectedProfileName.textContent = t('profile.new');
    resetSummary();
    resetProgressUi();
    renderActions([]);
    syncActionButtons();
    setStatus(t('status.newProfile'));
  });

  el.btnSaveProfile.addEventListener('click', async () => {
    try {
      await saveProfile();
    } catch (error) {
      log(t('log.saveError', { message: error.message }));
      window.alert(t('alert.saveFailed', { message: error.message }));
    }
  });

  el.btnDeleteProfile.addEventListener('click', async () => {
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
  });

  el.btnPickDir.addEventListener('click', async () => {
    try {
      const chosen = await window.aeroApi.pickDirectory();
      if (chosen) {
        el.productDir.value = chosen;
      }
    } catch (error) {
      log(t('log.pickDirError', { message: error.message }));
      window.alert(t('alert.pickDirFailed', { message: error.message }));
    }
  });

  el.languageSelect.addEventListener('change', async () => {
    try {
      await loadAndApplyLanguage(el.languageSelect.value);
    } catch (error) {
      window.alert(t('alert.i18nLoadFailed', { message: error.message }));
    }
  });

  el.btnCheck.addEventListener('click', onCheckUpdates);
  el.btnInstall.addEventListener('click', onInstallUpdates);
  el.btnPause.addEventListener('click', onTogglePauseInstall);
  el.btnCancel.addEventListener('click', onCancelInstall);
  el.optFresh.addEventListener('change', syncFreshModeUi);
  el.btnClearLog.addEventListener('click', () => {
    el.logBox.textContent = '';
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
