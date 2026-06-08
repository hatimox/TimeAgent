'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog } = require('electron');
const path = require('path');
const { TPClient } = require('./tpclient');
const { SettingsStore } = require('./settings');

// Auto-update via GitHub Releases (no-op in dev / unpackaged).
let autoUpdater = null;
try { autoUpdater = require('electron-updater').autoUpdater; } catch (_) {}

function setupAutoUpdate() {
  if (!autoUpdater || !app.isPackaged) return;   // only in built apps
  autoUpdater.autoDownload = true;
  autoUpdater.on('update-downloaded', () => {
    // Install on next quit; or prompt to restart now.
    if (tray) tray.setToolTip('TimeAgent — update ready (restart to apply)');
  });
  autoUpdater.on('error', (e) => { /* silent; logged */ console.error('updater', e && e.message); });
  autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  // Re-check every 6 hours while running.
  setInterval(() => autoUpdater.checkForUpdatesAndNotify().catch(() => {}), 6 * 3600 * 1000);
}

let tray = null;
let mainWindow = null;
let settingsWindow = null;
let store = null;
let client = null;

// Keep the app alive with no windows (tray app).
app.on('window-all-closed', (e) => { /* don't quit */ });

function makeClient() {
  if (!store.isConfigured) { client = null; return; }
  const c = store.asConfig();
  client = new TPClient({ baseURL: c.baseURL, token: c.token, myUserId: c.myUserId });
}

async function ensureUserId() {
  if (!client) return;
  if (!store.data.myUserId) {
    try {
      const me = await client.whoAmI();
      store.data.myUserId = me.id;
      client.myUserId = me.id;
      await store.save();
    } catch (e) { /* surfaced in UI when queries fail */ }
  }
}

// ---- windows ----
function createMainWindow() {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); return; }
  mainWindow = new BrowserWindow({
    width: 760, height: 560, show: false, title: 'TimeAgent',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => { mainWindow.show(); mainWindow.focus(); });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function createSettingsWindow() {
  if (settingsWindow) { settingsWindow.show(); settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    width: 480, height: 600, show: false, title: 'TimeAgent Settings',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWindow.once('ready-to-show', () => { settingsWindow.show(); settingsWindow.focus(); });
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

let cachedTimes = [];      // all my time entries (for month re-slicing)
let lastUpdated = '';      // HH:MM of last fetch
let popover = null;        // the borderless popover window

function buildTray() {
  // Load the clock icon from disk. The "Template" filename + setTemplateImage
  // makes macOS render it correctly (adapts to light/dark menu bar). Electron
  // auto-loads the @2x variant for retina.
  const iconPath = path.join(__dirname, 'assets', 'trayTemplate.png');
  const img = nativeImage.createFromPath(iconPath);
  img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip('TimeAgent');
  tray.on('click', (_e, bounds) => togglePopover(bounds));
  // Right-click still gives a minimal menu (quit etc).
  tray.on('right-click', () => {
    tray.popUpContextMenu(Menu.buildFromTemplate([
      { label: 'Open tasks…', click: createMainWindow },
      { label: 'Settings…', click: createSettingsWindow },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]));
  });
}

function createPopover() {
  popover = new BrowserWindow({
    width: 280, height: 320, show: false, frame: false, resizable: false,
    transparent: false, skipTaskbar: true, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  popover.loadFile(path.join(__dirname, 'renderer', 'popover.html'));
  // Hide when it loses focus (click elsewhere), like a real menu-bar popover.
  popover.on('blur', () => { if (popover && !popover.webContents.isDevToolsOpened()) popover.hide(); });
}

function togglePopover(bounds) {
  if (!popover) createPopover();
  if (popover.isVisible()) { popover.hide(); return; }
  // Position centered under the tray icon (fallback: top-right).
  const { screen } = require('electron');
  const winBounds = popover.getBounds();
  let x = Math.round((bounds && bounds.x || 0) + (bounds && bounds.width || 0) / 2 - winBounds.width / 2);
  let y = Math.round((bounds && bounds.y || 0) + (bounds && bounds.height || 0) + 4);
  if (!bounds || !bounds.width) { // Linux/Win sometimes give empty bounds
    const wa = screen.getPrimaryDisplay().workArea;
    x = wa.x + wa.width - winBounds.width - 8; y = wa.y + 8;
  }
  popover.setPosition(x, y, false);
  popover.show();
  popover.focus();
  updateTotals();
}

// Fetch my times and cache them; refresh popover if open.
async function updateTotals() {
  if (!client) return;
  try {
    await ensureUserId();
    cachedTimes = await client.fetchMyTimes();
    const d = new Date();
    lastUpdated = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (popover && popover.isVisible()) popover.webContents.send('totals-updated');
  } catch (_) { /* keep previous cache */ }
}

// Compute Today/Week/Month for a given month offset from the cached times.
function computeTotals(monthOffset) {
  const off = tzOffset(store.data.timezone);
  const now = new Date();
  const todayStr = dayInTz(now, off);
  const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const weekStr = dayInTz(monday, off);
  const mbase = new Date(now); mbase.setMonth(mbase.getMonth() + (monthOffset || 0));
  const monthPrefix = `${mbase.getFullYear()}-${String(mbase.getMonth() + 1).padStart(2, '0')}`;
  let today = 0, week = 0, month = 0;
  for (const t of cachedTimes) {
    if (t.day === todayStr) today += t.hours;
    if (t.day >= weekStr) week += t.hours;
    if (t.day.startsWith(monthPrefix)) month += t.hours;
  }
  const monthLabel = mbase.toLocaleString(undefined, { month: 'long', year: 'numeric' });
  return { today, week, month, monthLabel, updated: lastUpdated };
}

// "YYYY-MM-DD" for a date viewed at offset `offMin` (minutes).
function dayInTz(d, offMin) {
  return new Date(d.getTime() + offMin * 60000).toISOString().slice(0, 10);
}

// ---- IPC: the renderer calls these ----
ipcMain.handle('get-settings', () => ({ ...store.data, tpToken: store.token, isConfigured: store.isConfigured }));

ipcMain.handle('save-settings', async (_e, incoming) => {
  const token = incoming.tpToken || '';
  delete incoming.tpToken;
  store.data = { ...store.data, ...incoming };
  store.token = token;
  await store.save();
  makeClient();
  await ensureUserId();
  return { ok: true, isConfigured: store.isConfigured };
});

ipcMain.handle('load-data', async () => {
  if (!client) return { error: 'not-configured' };
  await ensureUserId();
  try {
    const [items, times] = await Promise.all([
      client.fetchAllAssigned(),
      client.fetchMyTimes(),
    ]);
    const dom = dominantProcessId(items);
    const states = dom ? await client.fetchWorkflowStates(dom) : [];
    return { items, times, states, tzOffsetMinutes: tzOffset(store.data.timezone) };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('log-time', async (_e, { entityId, hours, description, dateISO }) => {
  if (!client) return { error: 'not-configured' };
  try {
    const date = dateISO ? new Date(dateISO) : new Date();
    const id = await client.logTime({
      entityId, hours, description,
      date, tzOffsetMinutes: tzOffset(store.data.timezone),
    });
    updateTotals();   // refresh tray totals after logging
    return { ok: true, id };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('open-external', (_e, url) => { require('electron').shell.openExternal(url); });
ipcMain.handle('open-settings-window', () => { if (popover) popover.hide(); createSettingsWindow(); });

// ---- popover IPC ----
ipcMain.handle('get-totals', (_e, monthOffset) => {
  if (!client) return { error: 'Not configured' };
  return computeTotals(monthOffset);
});
ipcMain.handle('force-refresh', async () => { await updateTotals(); return { ok: true }; });
ipcMain.handle('open-main-window', () => { if (popover) popover.hide(); createMainWindow(); });
ipcMain.handle('quit-app', () => app.quit());

// ---- helpers ----
function dominantProcessId(items) {
  const counts = {};
  for (const it of items) if (it.processId) counts[it.processId] = (counts[it.processId] || 0) + 1;
  let best = null, n = -1;
  for (const [k, v] of Object.entries(counts)) if (v > n) { n = v; best = Number(k); }
  return best;
}

// Offset (minutes) for an IANA timezone right now.
function tzOffset(tz) {
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' });
    const part = fmt.formatToParts(now).find((p) => p.type === 'timeZoneName');
    const m = part && part.value.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!m) return -now.getTimezoneOffset();
    const sign = m[1] === '-' ? -1 : 1;
    return sign * (Number(m[2]) * 60 + Number(m[3] || 0));
  } catch (_) { return -new Date().getTimezoneOffset(); }
}

// ---- startup ----
app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide(); // menu-bar style
  store = new SettingsStore(app);
  await store.load();
  makeClient();
  buildTray();
  if (!store.isConfigured) createSettingsWindow();
  else { createMainWindow(); updateTotals(); }
  // Keep tray totals fresh while running (every 5 min).
  setInterval(updateTotals, 5 * 60 * 1000);
  setupAutoUpdate();
});

