const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, Menu } = require('electron');

const { ProfileStore } = require('./lib/profile-store');
const { LanguageStore } = require('./lib/language-store');
const { UpdateClient, UpdateHttpError } = require('./lib/update-client');
const { parseJsonSafe } = require('./lib/safe-json');
const { createLogger } = require('./lib/logger');

let mainWindow;
let profileStore;
let languageStore;
let updaterClient;
let activeInstall = null;
const logger = createLogger('main');

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

const menuState = {
  hasProfile: false,
  hasPlan: false,
  checkRunning: false,
  installRunning: false,
  installPaused: false,
  appUpdateRunning: false
};

const APP_UPDATE_REPO = {
  owner: 'NichSchlagen',
  repo: 'aerosync-addon-updater'
};

const APP_UPDATE_RELEASES_URL = `https://github.com/${APP_UPDATE_REPO.owner}/${APP_UPDATE_REPO.repo}/releases`;
const APP_UPDATE_API_LATEST_URL = `https://api.github.com/repos/${APP_UPDATE_REPO.owner}/${APP_UPDATE_REPO.repo}/releases/latest`;
const APP_DOCS_URL = `https://github.com/${APP_UPDATE_REPO.owner}/${APP_UPDATE_REPO.repo}/blob/main/docs/user-guide.md`;
const PROFILE_EXPORT_SCHEMA = 'aerosync.profiles.v1';
const DIAGNOSTICS_EXPORT_SCHEMA = 'aerosync.diagnostics.v1';

function fileTimestamp(now = new Date()) {
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function resolveExportDirectory() {
  const candidates = ['documents', 'downloads', 'desktop', 'home', 'userData'];
  for (const key of candidates) {
    try {
      const value = app.getPath(key);
      if (value) {
        return value;
      }
    } catch {
      // Ignore unsupported directory keys.
    }
  }

  return process.cwd();
}

function normalizeProfileForExport(profile) {
  const source = profile && typeof profile === 'object' ? profile : {};
  return {
    id: String(source.id || '').trim(),
    name: String(source.name || '').trim(),
    host: String(source.host || '').trim(),
    productDir: String(source.productDir || '').trim(),
    login: String(source.login || '').trim(),
    licenseKey: String(source.licenseKey || '').trim(),
    packageVersion: Number(source.packageVersion || 0),
    rememberAuth: Boolean(source.rememberAuth),
    channel: String(source.channel || 'release').trim(),
    ignoreList: Array.isArray(source.ignoreList) ? source.ignoreList : []
  };
}

function extractProfilesFromImportPayload(parsed) {
  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (!parsed || typeof parsed !== 'object') {
    return [];
  }

  if (Array.isArray(parsed.profiles)) {
    return parsed.profiles;
  }

  return [];
}

function normalizeImportedProfile(rawProfile, index) {
  if (!rawProfile || typeof rawProfile !== 'object') {
    throw new Error(`Entry ${index + 1}: profile must be an object.`);
  }

  const profile = {
    id: String(rawProfile.id || '').trim() || undefined,
    name: String(rawProfile.name || '').trim(),
    host: String(rawProfile.host || '').trim(),
    productDir: String(rawProfile.productDir || '').trim(),
    login: String(rawProfile.login || '').trim(),
    licenseKey: String(rawProfile.licenseKey || '').trim(),
    packageVersion: Number(rawProfile.packageVersion || 0),
    rememberAuth: Boolean(rawProfile.rememberAuth),
    channel: String(rawProfile.channel || '').trim(),
    ignoreList: Array.isArray(rawProfile.ignoreList) ? rawProfile.ignoreList : []
  };

  if (!profile.name || !profile.productDir) {
    throw new Error(`Entry ${index + 1}: missing required fields (name/productDir).`);
  }

  const warnings = [];
  if (profile.rememberAuth && (!profile.login || !profile.licenseKey)) {
    profile.rememberAuth = false;
    profile.login = '';
    profile.licenseKey = '';
    warnings.push(`Entry ${index + 1}: rememberAuth disabled because login/license key is missing.`);
  }

  return {
    profile,
    warnings
  };
}

function isSensitiveKey(rawKey) {
  return /password|token|secret|license|login|credential|auth/i.test(String(rawKey || ''));
}

function sanitizeDiagnosticValue(value, depth = 0) {
  if (depth > 8) {
    return '[max-depth]';
  }

  if (value === null) {
    return null;
  }

  const valueType = typeof value;
  if (valueType === 'string') {
    return value.length > 20000 ? `${value.slice(0, 20000)}...[truncated]` : value;
  }

  if (valueType === 'number' || valueType === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    const limited = value.slice(0, 200);
    return limited.map((item) => sanitizeDiagnosticValue(item, depth + 1));
  }

  if (valueType === 'object') {
    const out = {};
    for (const [rawKey, rawValue] of Object.entries(value)) {
      const key = String(rawKey || '').slice(0, 120);
      out[key] = isSensitiveKey(key)
        ? '[redacted]'
        : sanitizeDiagnosticValue(rawValue, depth + 1);
    }
    return out;
  }

  return String(value);
}

function normalizeVersionParts(rawVersion) {
  const match = String(rawVersion || '').trim().match(/^v?(\d+(?:\.\d+)*)/i);
  if (!match) {
    return [];
  }

  return match[1]
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}

function compareVersionTags(left, right) {
  const leftParts = normalizeVersionParts(left);
  const rightParts = normalizeVersionParts(right);

  if (leftParts.length === 0 && rightParts.length === 0) {
    return 0;
  }

  if (leftParts.length === 0) {
    return -1;
  }

  if (rightParts.length === 0) {
    return 1;
  }

  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = leftParts[index] || 0;
    const rightPart = rightParts[index] || 0;

    if (leftPart > rightPart) {
      return 1;
    }

    if (leftPart < rightPart) {
      return -1;
    }
  }

  return 0;
}

async function checkForAppUpdate() {
  const response = await fetch(APP_UPDATE_API_LATEST_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'AeroSync-Addon-Updater'
    }
  });

  if (!response.ok) {
    if (response.status === 403) {
      throw new Error('GitHub API rate limit reached. Please try again later.');
    }

    if (response.status === 404) {
      throw new Error('No published release found yet.');
    }

    throw new Error(`App update check failed (HTTP ${response.status}).`);
  }

  const release = await response.json();
  const latestVersion = String(release.tag_name || release.name || '').trim();

  if (!latestVersion) {
    throw new Error('Invalid release metadata: version tag is missing.');
  }

  const currentVersion = String(app.getVersion() || '').trim();

  return {
    status: compareVersionTags(latestVersion, currentVersion) > 0 ? 'available' : 'up-to-date',
    currentVersion,
    latestVersion,
    releaseName: String(release.name || latestVersion).trim(),
    releaseUrl: String(release.html_url || APP_UPDATE_RELEASES_URL).trim(),
    publishedAt: release.published_at || null
  };
}

function dispatchMenuAction(action) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send('menu:action', { action });
}

function updateMenuItem(menu, id, updates) {
  const item = menu.getMenuItemById(id);
  if (!item) {
    return;
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'enabled')) {
    item.enabled = Boolean(updates.enabled);
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'label')) {
    item.label = String(updates.label);
  }
}

function applyMenuState() {
  const menu = Menu.getApplicationMenu();
  if (!menu) {
    return;
  }

  const lockProfile = menuState.checkRunning || menuState.installRunning;
  const checkEnabled = !menuState.checkRunning && !menuState.installRunning;
  const updatesCheckEnabled = checkEnabled && menuState.hasProfile;
  const appUpdateEnabled = checkEnabled && !menuState.appUpdateRunning;

  updateMenuItem(menu, 'file.newProfile', { enabled: !lockProfile });
  updateMenuItem(menu, 'file.saveProfile', { enabled: !lockProfile });
  updateMenuItem(menu, 'file.deleteProfile', { enabled: menuState.hasProfile && !lockProfile });
  updateMenuItem(menu, 'file.importProfiles', { enabled: !lockProfile });
  updateMenuItem(menu, 'file.exportProfiles', { enabled: !lockProfile });
  updateMenuItem(menu, 'file.openProductDir', { enabled: menuState.hasProfile && !lockProfile });

  updateMenuItem(menu, 'action.checkUpdates', { enabled: updatesCheckEnabled });
  updateMenuItem(menu, 'action.installUpdates', { enabled: checkEnabled && menuState.hasPlan });
  updateMenuItem(menu, 'action.pauseResume', {
    enabled: menuState.installRunning,
    label: menuState.installPaused ? 'Resume Installation' : 'Pause Installation'
  });
  updateMenuItem(menu, 'action.cancelInstall', { enabled: menuState.installRunning });
  updateMenuItem(menu, 'action.exportDiagnostics', { enabled: true });
  updateMenuItem(menu, 'action.checkAppUpdate', { enabled: appUpdateEnabled });
  updateMenuItem(menu, 'help.checkAppUpdate', { enabled: appUpdateEnabled });
}

function updateMenuState(nextState = {}) {
  if (!nextState || typeof nextState !== 'object') {
    return;
  }

  if (Object.prototype.hasOwnProperty.call(nextState, 'hasProfile')) {
    menuState.hasProfile = Boolean(nextState.hasProfile);
  }

  if (Object.prototype.hasOwnProperty.call(nextState, 'hasPlan')) {
    menuState.hasPlan = Boolean(nextState.hasPlan);
  }

  if (Object.prototype.hasOwnProperty.call(nextState, 'checkRunning')) {
    menuState.checkRunning = Boolean(nextState.checkRunning);
  }

  if (Object.prototype.hasOwnProperty.call(nextState, 'installRunning')) {
    menuState.installRunning = Boolean(nextState.installRunning);
  }

  if (Object.prototype.hasOwnProperty.call(nextState, 'installPaused')) {
    menuState.installPaused = Boolean(nextState.installPaused);
  }

  if (Object.prototype.hasOwnProperty.call(nextState, 'appUpdateRunning')) {
    menuState.appUpdateRunning = Boolean(nextState.appUpdateRunning);
  }

  applyMenuState();
}

function buildApplicationMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          id: 'file.newProfile',
          label: 'New Profile',
          accelerator: 'CmdOrCtrl+N',
          click: () => dispatchMenuAction(MENU_ACTIONS.PROFILE_NEW)
        },
        {
          id: 'file.saveProfile',
          label: 'Save Profile',
          accelerator: 'CmdOrCtrl+S',
          click: () => dispatchMenuAction(MENU_ACTIONS.PROFILE_SAVE)
        },
        {
          id: 'file.deleteProfile',
          label: 'Delete Profile',
          accelerator: 'CmdOrCtrl+Backspace',
          click: () => dispatchMenuAction(MENU_ACTIONS.PROFILE_DELETE)
        },
        { type: 'separator' },
        {
          id: 'file.importProfiles',
          label: 'Import Profiles...',
          click: () => dispatchMenuAction(MENU_ACTIONS.PROFILE_IMPORT)
        },
        {
          id: 'file.exportProfiles',
          label: 'Export Profiles...',
          click: () => dispatchMenuAction(MENU_ACTIONS.PROFILE_EXPORT)
        },
        { type: 'separator' },
        {
          id: 'file.openProductDir',
          label: 'Open Aircraft Folder',
          accelerator: 'CmdOrCtrl+O',
          click: () => dispatchMenuAction(MENU_ACTIONS.PROFILE_OPEN_DIR)
        },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Actions',
      submenu: [
        {
          id: 'action.checkUpdates',
          label: 'Check Updates',
          accelerator: 'F5',
          click: () => dispatchMenuAction(MENU_ACTIONS.UPDATES_CHECK)
        },
        {
          id: 'action.installUpdates',
          label: 'Install Updates',
          accelerator: 'CmdOrCtrl+I',
          click: () => dispatchMenuAction(MENU_ACTIONS.UPDATES_INSTALL)
        },
        {
          id: 'action.pauseResume',
          label: 'Pause Installation',
          accelerator: 'CmdOrCtrl+P',
          click: () => dispatchMenuAction(MENU_ACTIONS.UPDATES_PAUSE_RESUME)
        },
        {
          id: 'action.cancelInstall',
          label: 'Cancel Installation',
          accelerator: 'Esc',
          click: () => dispatchMenuAction(MENU_ACTIONS.UPDATES_CANCEL)
        },
        { type: 'separator' },
        {
          id: 'action.checkAppUpdate',
          label: 'Check App Update',
          accelerator: 'CmdOrCtrl+U',
          click: () => dispatchMenuAction(MENU_ACTIONS.APP_CHECK_UPDATE)
        },
        {
          id: 'action.exportDiagnostics',
          label: 'Export Diagnostics...',
          click: () => dispatchMenuAction(MENU_ACTIONS.APP_EXPORT_DIAGNOSTICS)
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          id: 'view.clearLog',
          label: 'Clear Log',
          accelerator: 'CmdOrCtrl+L',
          click: () => dispatchMenuAction(MENU_ACTIONS.LOG_CLEAR)
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'User Guide',
          click: () => {
            void shell.openExternal(APP_DOCS_URL);
          }
        },
        {
          label: 'GitHub Releases',
          click: () => {
            void shell.openExternal(APP_UPDATE_RELEASES_URL);
          }
        },
        { type: 'separator' },
        {
          id: 'help.checkAppUpdate',
          label: 'Check App Update',
          click: () => dispatchMenuAction(MENU_ACTIONS.APP_CHECK_UPDATE)
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  applyMenuState();
}

function resolveLanguageDirectory(langDirFromEnv) {
  if (langDirFromEnv) {
    return path.resolve(langDirFromEnv);
  }

  const packagedResourcesDir = path.join(process.resourcesPath, 'languages');
  const bundledAppDir = path.join(app.getAppPath(), 'languages');
  const fallbackUserDir = path.join(app.getPath('userData'), 'languages');

  if (app.isPackaged) {
    if (fs.existsSync(packagedResourcesDir)) {
      return packagedResourcesDir;
    }

    if (fs.existsSync(bundledAppDir)) {
      return bundledAppDir;
    }

    return fallbackUserDir;
  }

  return bundledAppDir;
}

function resolveWindowIconPath() {
  const candidates = [
    path.join(process.resourcesPath, 'build', 'icons', 'icon.png'),
    path.join(__dirname, 'build', 'icons', 'icon.png')
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#f2efe7',
    icon: resolveWindowIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src/index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpcHandlers() {
  const assertObject = (name, value) => {
    if (!value || typeof value !== 'object') {
      throw new Error(`Invalid ${name} payload.`);
    }
    return value;
  };

  const assertNonEmptyString = (name, value) => {
    const text = String(value || '').trim();
    if (!text) {
      throw new Error(`Missing required field: ${name}`);
    }
    return text;
  };

  const sanitizeCheckOptions = (rawOptions) => {
    const source = rawOptions && typeof rawOptions === 'object' && !Array.isArray(rawOptions)
      ? rawOptions
      : {};
    const normalized = {
      alpha: Boolean(source.alpha),
      beta: Boolean(source.beta),
      fresh: Boolean(source.fresh),
      repair: Boolean(source.repair)
    };

    const rawOptionalPackages = source.optionalPackages;
    if (rawOptionalPackages && typeof rawOptionalPackages === 'object' && !Array.isArray(rawOptionalPackages)) {
      const optionalPackages = {};

      for (const [rawId, rawAction] of Object.entries(rawOptionalPackages)) {
        const id = String(rawId || '').trim();
        if (!id) {
          continue;
        }

        const action = String(rawAction || '').trim().toLowerCase();
        if (action === 'install' || action === 'ignore') {
          optionalPackages[id] = action;
        }
      }

      normalized.optionalPackages = optionalPackages;
    }

    return normalized;
  };

  const buildRuntimeProfileWithCredentials = (profile, requestPayload = {}) => {
    if (!profile) {
      throw new Error('Profile not found.');
    }

    const credentials = requestPayload.credentials && typeof requestPayload.credentials === 'object'
      ? requestPayload.credentials
      : {};
    const requestLogin = String(credentials.login || '').trim();
    const requestLicenseKey = String(credentials.licenseKey || '').trim();

    if (profile.credentialsUnavailable && (!requestLogin || !requestLicenseKey)) {
      throw new Error(
        'Stored credentials could not be decrypted. Please re-enter login and license key in the profile and save again.'
      );
    }

    const login = requestLogin || String(profile.login || '').trim();
    const licenseKey = requestLicenseKey || String(profile.licenseKey || '').trim();

    if (!login || !licenseKey) {
      throw new Error(
        'Login and license key are missing. Enter them in the form or enable "Store credentials in profile".'
      );
    }

    return {
      ...profile,
      login,
      licenseKey
    };
  };

  const mapUpdaterError = (error) => {
    if (error instanceof UpdateHttpError && error.status === 401) {
      return new Error(
        'Authentication failed (HTTP 401). Please verify login/license key and save the profile again.'
      );
    }
    return error;
  };

  const getActiveInstallForSender = (sender) => {
    if (!activeInstall) {
      return null;
    }

    if (activeInstall.senderId !== sender.id) {
      return null;
    }

    return activeInstall;
  };

  ipcMain.handle('profiles:list', async () => {
    return await profileStore.listProfiles();
  });

  ipcMain.handle('profiles:save', async (_event, profile) => {
    const saved = await profileStore.saveProfile(profile);
    return {
      profile: saved,
      allProfiles: await profileStore.listProfiles()
    };
  });

  ipcMain.handle('profiles:delete', async (_event, profileId) => {
    await profileStore.deleteProfile(profileId);
    return await profileStore.listProfiles();
  });

  ipcMain.handle('profiles:export', async (_event, request = {}) => {
    assertObject('profiles:export', request);

    const profiles = (await profileStore.listProfiles()).map(normalizeProfileForExport);
    if (profiles.length === 0) {
      throw new Error('No profiles available to export.');
    }

    const defaultPath = path.join(
      resolveExportDirectory(),
      `aerosync-profiles-${fileTimestamp()}.json`
    );
    const saveResult = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Profiles',
      defaultPath,
      filters: [
        { name: 'JSON', extensions: ['json'] }
      ]
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return { saved: false };
    }

    const payload = {
      format: PROFILE_EXPORT_SCHEMA,
      exportedAt: new Date().toISOString(),
      appVersion: app.getVersion(),
      profiles
    };
    fs.writeFileSync(saveResult.filePath, JSON.stringify(payload, null, 2), 'utf8');

    return {
      saved: true,
      path: saveResult.filePath,
      count: profiles.length
    };
  });

  ipcMain.handle('profiles:import', async () => {
    const openResult = await dialog.showOpenDialog(mainWindow, {
      title: 'Import Profiles',
      properties: ['openFile'],
      filters: [
        { name: 'JSON', extensions: ['json'] }
      ]
    });

    if (openResult.canceled || !openResult.filePaths.length) {
      return { imported: false };
    }

    const filePath = openResult.filePaths[0];
    const rawText = fs.readFileSync(filePath, 'utf8');
    const parsed = parseJsonSafe(rawText);

    if (!parsed) {
      logger.error('Profile import failed: invalid JSON', { filePath });
      throw new Error('Invalid JSON file: Unable to parse profile data.');
    }

    const importedProfiles = extractProfilesFromImportPayload(parsed);
    if (importedProfiles.length === 0) {
      throw new Error('No profiles found in import file.');
    }

    const existingIds = new Set((await profileStore.listProfiles()).map((item) => String(item.id || '')));
    let createdCount = 0;
    let updatedCount = 0;
    let importedCount = 0;
    const warnings = [];
    const errors = [];

    for (let index = 0; index < importedProfiles.length; index += 1) {
      try {
        const normalized = normalizeImportedProfile(importedProfiles[index], index);
        for (const warning of normalized.warnings) {
          warnings.push(warning);
        }

        const savedProfile = await profileStore.saveProfile(normalized.profile);
        importedCount += 1;

        if (existingIds.has(savedProfile.id)) {
          updatedCount += 1;
        } else {
          existingIds.add(savedProfile.id);
          createdCount += 1;
        }
      } catch (error) {
        errors.push(String(error && error.message ? error.message : error));
      }
    }

    if (importedCount === 0) {
      const details = errors.slice(0, 3).join(' | ');
      throw new Error(
        details
          ? `No valid profiles imported. ${details}`
          : 'No valid profiles imported.'
      );
    }

    return {
      imported: true,
      path: filePath,
      importedCount,
      createdCount,
      updatedCount,
      warningCount: warnings.length,
      warnings,
      errorCount: errors.length,
      errors,
      allProfiles: await profileStore.listProfiles()
    };
  });

  ipcMain.handle('dialog:pickDirectory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory']
    });

    if (result.canceled || !result.filePaths.length) {
      return null;
    }

    return result.filePaths[0];
  });

  ipcMain.handle('i18n:list', async () => {
    return {
      directory: languageStore.getDirectory(),
      languages: await languageStore.listLanguages()
    };
  });

  ipcMain.handle('i18n:load', async (_event, request = {}) => {
    return languageStore.loadLanguage(request.code);
  });

  ipcMain.handle('app:get-version', async () => {
    return app.getVersion();
  });

  ipcMain.handle('app:update-check', async () => {
    return checkForAppUpdate();
  });

  ipcMain.handle('app:export-diagnostics', async (_event, request = {}) => {
    const payload = assertObject('app:export-diagnostics', request);
    const sanitizedRendererPayload = sanitizeDiagnosticValue(payload);

    const defaultPath = path.join(
      resolveExportDirectory(),
      `aerosync-diagnostics-${fileTimestamp()}.json`
    );
    const saveResult = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Diagnostics',
      defaultPath,
      filters: [
        { name: 'JSON', extensions: ['json'] }
      ]
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return { saved: false };
    }

    const diagnostics = {
      format: DIAGNOSTICS_EXPORT_SCHEMA,
      generatedAt: new Date().toISOString(),
      appVersion: app.getVersion(),
      runtime: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        electron: process.versions.electron
      },
      renderer: sanitizedRendererPayload
    };

    fs.writeFileSync(saveResult.filePath, JSON.stringify(diagnostics, null, 2), 'utf8');
    return {
      saved: true,
      path: saveResult.filePath
    };
  });

  ipcMain.handle('app:open-external', async (_event, request = {}) => {
    const payload = assertObject('app:open-external', request);
    const targetUrl = String(payload.url || APP_UPDATE_RELEASES_URL).trim();

    if (!/^https?:\/\//i.test(targetUrl)) {
      throw new Error('Invalid external URL.');
    }

    await shell.openExternal(targetUrl);
    return { opened: true };
  });

  ipcMain.handle('app:open-path', async (_event, request = {}) => {
    const payload = assertObject('app:open-path', request);
    const targetPath = assertNonEmptyString('path', payload.path);

    const errorText = await shell.openPath(targetPath);
    if (errorText) {
      throw new Error(errorText);
    }

    return { opened: true };
  });

  ipcMain.handle('menu:update-state', async (_event, request = {}) => {
    const payload = assertObject('menu:update-state', request);
    updateMenuState(payload);
    return { ok: true };
  });

  ipcMain.handle('updates:check', async (_event, request) => {
    const payload = assertObject('updates:check', request);
    const profileId = assertNonEmptyString('profileId', payload.profileId);
    const profile = await profileStore.getProfile(profileId);
    const runtimeProfile = buildRuntimeProfileWithCredentials(profile, payload);
    const options = sanitizeCheckOptions(payload.options);

    try {
      return await updaterClient.createUpdatePlan(runtimeProfile, options);
    } catch (error) {
      throw mapUpdaterError(error);
    }
  });

  ipcMain.handle('updates:install', async (event, request) => {
    const payload = assertObject('updates:install', request);
    const profileId = assertNonEmptyString('profileId', payload.profileId);
    const planId = assertNonEmptyString('planId', payload.planId);

    if (activeInstall) {
      throw new Error('An installation is already running.');
    }

    const profile = await profileStore.getProfile(profileId);
    if (!profile) {
      throw new Error('Profile not found.');
    }

    const job = {
      senderId: event.sender.id,
      profileId,
      planId,
      paused: false,
      cancelRequested: false,
      abortController: new AbortController()
    };

    activeInstall = job;

    try {
      const result = await updaterClient.installPlan(
        profile,
        planId,
        (progress) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('updates:progress', progress);
          }
        },
        {
          isPaused: () => job.paused,
          isCancelled: () => job.cancelRequested,
          signal: job.abortController.signal
        }
      );

      if (
        result
        && !result.cancelled
        && Number.isFinite(Number(result.snapshotNumber))
      ) {
        await profileStore.setPackageVersion(profileId, Number(result.snapshotNumber));
      }

      return result;
    } catch (error) {
      if (error && error.code === 'INSTALL_CANCELLED') {
        return { cancelled: true };
      }

      throw mapUpdaterError(error);
    } finally {
      if (activeInstall === job) {
        activeInstall = null;
      }
    }
  });

  ipcMain.handle('updates:pause', async (event) => {
    const job = getActiveInstallForSender(event.sender);
    if (!job) {
      throw new Error('No running installation found.');
    }

    job.paused = true;
    return { paused: true };
  });

  ipcMain.handle('updates:resume', async (event) => {
    const job = getActiveInstallForSender(event.sender);
    if (!job) {
      throw new Error('No running installation found.');
    }

    job.paused = false;
    return { paused: false };
  });

  ipcMain.handle('updates:cancel', async (event) => {
    const job = getActiveInstallForSender(event.sender);
    if (!job) {
      throw new Error('No running installation found.');
    }

    job.cancelRequested = true;
    job.paused = false;
    if (!job.abortController.signal.aborted) {
      job.abortController.abort('cancelled-by-user');
    }
    return { cancelled: true };
  });
}

app.whenReady().then(() => {
  const dataDir = app.getPath('userData');
  const langDirFromEnv = process.env.AEROSYNC_LANG_DIR;
  const languageDir = resolveLanguageDirectory(langDirFromEnv);
  const hasSafeStorage = safeStorage.isEncryptionAvailable();

  logger.info('Application starting', {
    version: app.getVersion(),
    platform: process.platform,
    dataDir,
    languageDir,
    hasSafeStorage
  });

  if (!hasSafeStorage) {
    logger.warn('safeStorage encryption unavailable: credentials will be stored as plain text.');
    console.warn('safeStorage encryption unavailable: credentials will be stored as plain text.');
  }

  profileStore = new ProfileStore(dataDir, {
    encryptString: hasSafeStorage
      ? (value) => safeStorage.encryptString(String(value)).toString('base64')
      : null,
    decryptString: hasSafeStorage
      ? (value) => safeStorage.decryptString(Buffer.from(String(value), 'base64'))
      : null
  });
  languageStore = new LanguageStore(languageDir);
  updaterClient = new UpdateClient({
    tempDir: app.getPath('temp')
  });

  registerIpcHandlers();
  createMainWindow();
  buildApplicationMenu();

  logger.info('Application initialized successfully');

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  logger.info('All windows closed');
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
