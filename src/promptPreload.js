'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const params = new URLSearchParams(location.search);
const channel = params.get('channel');
// NOTE: do NOT name this 'prompt' — it collides with the built-in window.prompt
// and the bridged methods become inaccessible.
contextBridge.exposeInMainWorld('promptApi', {
  title: params.get('title') || 'Meeting',
  label: params.get('label') || '',
  submit: (value) => ipcRenderer.send(channel, value),
});
