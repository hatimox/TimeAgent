'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const params = new URLSearchParams(location.search);
const channel = params.get('channel');

// Bridge for the dynamic-meeting picker window.
contextBridge.exposeInMainWorld('dynamicApi', {
  meetings: JSON.parse(params.get('meetings') || '[]'),
  submit: (value) => ipcRenderer.send(channel, value),
});
