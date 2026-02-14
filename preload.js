const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aeroApi', {
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  saveProfile: (profile) => ipcRenderer.invoke('profiles:save', profile),
  deleteProfile: (profileId) => ipcRenderer.invoke('profiles:delete', profileId),

  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),

  listLanguages: () => ipcRenderer.invoke('i18n:list'),
  loadLanguage: (payload) => ipcRenderer.invoke('i18n:load', payload),

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
  }
});
