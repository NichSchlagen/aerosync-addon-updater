const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require('electron');

const { ProfileStore } = require('./lib/profile-store');
const { LanguageStore } = require('./lib/language-store');
const { UpdateClient, UpdateHttpError } = require('./lib/update-client');

let mainWindow;
let profileStore;
let languageStore;
let updaterClient;
let activeInstall = null;

const APP_UPDATE_REPO = {
  owner: 'NichSchlagen',
  repo: 'aerosync-addon-updater'
};

const APP_UPDATE_RELEASES_URL = `https://github.com/${APP_UPDATE_REPO.owner}/${APP_UPDATE_REPO.repo}/releases`;
const APP_UPDATE_API_LATEST_URL = `https://api.github.com/repos/${APP_UPDATE_REPO.owner}/${APP_UPDATE_REPO.repo}/releases/latest`;

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
    return profileStore.listProfiles();
  });

  ipcMain.handle('profiles:save', async (_event, profile) => {
    const saved = profileStore.saveProfile(profile);
    return {
      profile: saved,
      allProfiles: profileStore.listProfiles()
    };
  });

  ipcMain.handle('profiles:delete', async (_event, profileId) => {
    profileStore.deleteProfile(profileId);
    return profileStore.listProfiles();
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

  ipcMain.handle('app:open-external', async (_event, request = {}) => {
    const payload = assertObject('app:open-external', request);
    const targetUrl = String(payload.url || APP_UPDATE_RELEASES_URL).trim();

    if (!/^https?:\/\//i.test(targetUrl)) {
      throw new Error('Invalid external URL.');
    }

    await shell.openExternal(targetUrl);
    return { opened: true };
  });

  ipcMain.handle('updates:check', async (_event, request) => {
    const payload = assertObject('updates:check', request);
    const profileId = assertNonEmptyString('profileId', payload.profileId);
    const profile = profileStore.getProfile(profileId);
    const runtimeProfile = buildRuntimeProfileWithCredentials(profile, payload);

    try {
      return await updaterClient.createUpdatePlan(runtimeProfile, payload.options || {});
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

    const profile = profileStore.getProfile(profileId);
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
        profileStore.setPackageVersion(profileId, Number(result.snapshotNumber));
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
  if (!hasSafeStorage) {
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
