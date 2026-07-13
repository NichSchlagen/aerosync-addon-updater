'use strict';

/*
 * CI / runtime smoke test.
 *
 * Boots the real application entry points under the current Electron/Node
 * runtime and verifies the app actually starts:
 *   1. every Electron API main.js relies on is present,
 *   2. every lib/* module loads cleanly,
 *   3. the real preload.js runs (contextBridge exposes `aeroApi`), and
 *   4. src/index.html finishes loading in a hidden window.
 *
 * Then it exits (0 on success, 1 on failure). Nothing is shown and no user
 * interaction is required. In headless CI run it under a virtual display, e.g.
 * `xvfb-run --auto-servernum npm run smoke`.
 */

const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, Menu } = require('electron');

// Robustness switches for this throwaway smoke run in headless / sandboxed
// environments only (CI runners, containers). main.js and the packaged app are
// unaffected.
//   no-sandbox           - the bundled chrome-sandbox is not setuid in node_modules
//   disable-dev-shm-usage - avoid FATAL crashes where /dev/shm is tiny/locked down
//   disable-gpu          - no GPU in headless CI; also dodges Wayland/Vulkan noise
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.commandLine.appendSwitch('disable-gpu');

const ROOT = path.join(__dirname, '..');
let failed = false;
const fail = (message) => {
  console.error('SMOKE_FAIL:', message);
  failed = true;
};

// 1) Electron APIs used by main.js must all exist in this Electron version.
const apis = { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, Menu };
for (const [name, value] of Object.entries(apis)) {
  if (value == null) {
    fail(`electron API missing: ${name}`);
  }
}

// 2) Every lib/* module must load cleanly under this runtime.
const libModules = [
  'lib/atomic-file',
  'lib/inibuilds-client',
  'lib/language-store',
  'lib/logger',
  'lib/profile-store',
  'lib/safe-json',
  'lib/update-client'
];
for (const moduleName of libModules) {
  try {
    require(path.join(ROOT, moduleName));
  } catch (err) {
    fail(`failed to require ${moduleName}: ${(err && err.message) || err}`);
  }
}

const TIMEOUT_MS = 60000;
let timer;

const finish = (code) => {
  clearTimeout(timer);
  const exitCode = failed ? 1 : code;
  if (exitCode === 0) {
    console.log(
      `SMOKE_OK electron ${process.versions.electron} chrome ${process.versions.chrome} node ${process.versions.node}`
    );
  }
  app.exit(exitCode);
};

app.whenReady().then(() => {
  timer = setTimeout(() => {
    fail('timed out waiting for the renderer to finish loading');
    finish(1);
  }, TIMEOUT_MS);

  let win;
  try {
    win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(ROOT, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
  } catch (err) {
    fail(`could not create BrowserWindow: ${(err && err.message) || err}`);
    finish(1);
    return;
  }

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, url) => {
    fail(`renderer did-fail-load: ${errorCode} ${errorDescription} ${url}`);
    finish(1);
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    fail(`render-process-gone: ${details && details.reason}`);
    finish(1);
  });

  win.webContents.once('did-finish-load', async () => {
    try {
      const hasBridge = await win.webContents.executeJavaScript(
        'Boolean(window.aeroApi && typeof window.aeroApi.getAppVersion === "function")'
      );
      if (hasBridge) {
        console.log('renderer loaded src/index.html and the preload bridge (aeroApi) is present');
      } else {
        fail('preload did not expose window.aeroApi (contextBridge failed)');
      }
    } catch (err) {
      fail(`executeJavaScript check failed: ${(err && err.message) || err}`);
    }
    finish(0);
  });

  win.loadFile(path.join(ROOT, 'src/index.html'));
});
