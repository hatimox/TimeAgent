'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const params = new URLSearchParams(location.search);
const channel = params.get('channel');
contextBridge.exposeInMainWorld('prompt', {
  title: params.get('title') || 'Meeting',
  label: params.get('label') || '',
  submit: (value) => ipcRenderer.send(channel, value),
});
