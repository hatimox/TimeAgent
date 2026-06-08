'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Safe, minimal bridge between the renderer UI and the main process.
contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  loadData: () => ipcRenderer.invoke('load-data'),
  logTime: (p) => ipcRenderer.invoke('log-time', p),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openSettings: () => ipcRenderer.invoke('open-settings-window'),
  // popover
  getTotals: (monthOffset) => ipcRenderer.invoke('get-totals', monthOffset),
  forceRefresh: () => ipcRenderer.invoke('force-refresh'),
  openMain: () => ipcRenderer.invoke('open-main-window'),
  quit: () => ipcRenderer.invoke('quit-app'),
  onTotalsUpdated: (cb) => ipcRenderer.on('totals-updated', cb),
});
