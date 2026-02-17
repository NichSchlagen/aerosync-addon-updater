const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aeroApi', {
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  saveProfile: (profile) => ipcRenderer.invoke('profiles:save', profile),
  deleteProfile: (profileId) => ipcRenderer.invoke('profiles:delete', profileId),
  exportProfiles: (payload) => ipcRenderer.invoke('profiles:export', payload),
  importProfiles: () => ipcRenderer.invoke('profiles:import'),

  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),

  listLanguages: () => ipcRenderer.invoke('i18n:list'),
  loadLanguage: (payload) => ipcRenderer.invoke('i18n:load', payload),

  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  checkAppUpdate: () => ipcRenderer.invoke('app:update-check'),
  exportDiagnostics: (payload) => ipcRenderer.invoke('app:export-diagnostics', payload),
  openExternalUrl: (url) => ipcRenderer.invoke('app:open-external', { url }),
  openPath: (targetPath) => ipcRenderer.invoke('app:open-path', { path: targetPath }),
  updateMenuState: (state) => ipcRenderer.invoke('menu:update-state', state),

  checkUpdates: (payload) => ipcRenderer.invoke('updates:check', payload),
  installUpdates: (payload) => ipcRenderer.invoke('updates:install', payload),
  pauseInstall: () => ipcRenderer.invoke('updates:pause'),
  resumeInstall: () => ipcRenderer.invoke('updates:resume'),
  cancelInstall: () => ipcRenderer.invoke('updates:cancel'),

  onProgress: (listener) => {
    const wrapped = (_event, data) => listener(data);
    ipcRenderer.on('updates:progress', wrapped);
    return () => {
      ipcRenderer.removeListener('updates:progress', wrapped);
    };
  },

  onMenuAction: (listener) => {
    const wrapped = (_event, payload) => listener(String(payload?.action || ''));
    ipcRenderer.on('menu:action', wrapped);
    return () => {
      ipcRenderer.removeListener('menu:action', wrapped);
    };
  }
});
