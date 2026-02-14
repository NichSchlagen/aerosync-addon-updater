const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, dialog, ipcMain, safeStorage } = require('electron');

const { ProfileStore } = require('./lib/profile-store');
const { LanguageStore } = require('./lib/language-store');
const { UpdateClient, UpdateHttpError } = require('./lib/update-client');

let mainWindow;
let profileStore;
let languageStore;
let updaterClient;
let activeInstall = null;

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

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#f2efe7',
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
        'Gespeicherte Zugangsdaten konnten nicht entschluesselt werden. Bitte Login und License Key im Profil neu eintragen und speichern.'
      );
    }

    const login = requestLogin || String(profile.login || '').trim();
    const licenseKey = requestLicenseKey || String(profile.licenseKey || '').trim();

    if (!login || !licenseKey) {
      throw new Error(
        'Login und License Key fehlen. Bitte im Formular eintragen oder "Zugangsdaten speichern" aktivieren.'
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
        'Authentifizierung fehlgeschlagen (HTTP 401). Bitte Login/License Key prüfen und Profil erneut speichern.'
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
      throw new Error('Es läuft bereits eine Installation.');
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
      throw new Error('Keine laufende Installation gefunden.');
    }

    job.paused = true;
    return { paused: true };
  });

  ipcMain.handle('updates:resume', async (event) => {
    const job = getActiveInstallForSender(event.sender);
    if (!job) {
      throw new Error('Keine laufende Installation gefunden.');
    }

    job.paused = false;
    return { paused: false };
  });

  ipcMain.handle('updates:cancel', async (event) => {
    const job = getActiveInstallForSender(event.sender);
    if (!job) {
      throw new Error('Keine laufende Installation gefunden.');
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
