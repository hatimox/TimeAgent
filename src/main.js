'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog } = require('electron');
const path = require('path');
const { TPClient } = require('./tpclient');
const { SettingsStore } = require('./settings');
const { ZoomWatcher } = require('./zoomwatcher');

// Updates via GitHub Releases (no-op in dev / unpackaged).
//   - Linux/Windows: silent auto-download + install on restart.
//   - macOS: unsigned apps can't self-install, so we NOTIFY and open the
//     Release page for a manual download instead.
let autoUpdater = null;
try { autoUpdater = require('electron-updater').autoUpdater; } catch (_) {}

const RELEASES_URL = 'https://github.com/hatimox/TimeAgent/releases/latest';
const isMac = process.platform === 'darwin';

function setupAutoUpdate() {
  if (!autoUpdater || !app.isPackaged) return;   // only in built apps

  // On Mac we don't try to auto-install (unsigned) — just detect + notify.
  autoUpdater.autoDownload = !isMac;

  autoUpdater.on('update-available', (info) => {
    if (isMac) notifyManualUpdate(info && info.version);
  });

  autoUpdater.on('update-downloaded', () => {
    // Linux/Windows: ready to install on restart.
    if (tray) tray.setToolTip('TimeAgent — update ready (restart to apply)');
    const r = dialog.showMessageBoxSync({
      type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0,
      message: 'A TimeAgent update has been downloaded.',
      detail: 'Restart to apply it.',
    });
    if (r === 0) { autoUpdater.quitAndInstall(); }
  });

  autoUpdater.on('error', (e) => { console.error('updater', e && e.message); });
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 3600 * 1000);
}

// Triggered from the tray menu — gives explicit feedback either way.
async function checkForUpdatesManual() {
  if (!autoUpdater || !app.isPackaged) {
    dialog.showMessageBox({ type: 'info', message: 'Updates are only checked in the installed app.',
      detail: `Current version: ${app.getVersion()}` });
    return;
  }
  try {
    const res = await autoUpdater.checkForUpdates();
    const v = res && res.updateInfo && res.updateInfo.version;
    if (!v || v === app.getVersion()) {
      dialog.showMessageBox({ type: 'info', message: 'You’re up to date.',
        detail: `Version ${app.getVersion()}` });
    } else if (isMac) {
      notifyManualUpdate(v);
    }
  } catch (e) {
    dialog.showMessageBox({ type: 'warning', message: 'Could not check for updates.', detail: e.message });
  }
}

let lastNotifiedVersion = '';
function notifyManualUpdate(version) {
  if (version && version === lastNotifiedVersion) return;  // don't nag repeatedly
  lastNotifiedVersion = version;
  if (tray) tray.setToolTip(`TimeAgent — v${version} available`);
  const r = dialog.showMessageBoxSync({
    type: 'info', buttons: ['Download', 'Later'], defaultId: 0,
    message: `TimeAgent ${version ? 'v' + version : 'update'} is available`,
    detail: 'Click Download to get the latest version, then install it over the current app.',
  });
  if (r === 0) require('electron').shell.openExternal(RELEASES_URL);
}

const APP_ICON = path.join(__dirname, 'assets', 'appicon.png');

let tray = null;
let mainWindow = null;
let settingsWindow = null;
let store = null;
let client = null;
let zoomWatcher = null;
let inMeeting = false;

// Keep the app alive with no windows (tray app).
app.on('window-all-closed', (e) => { /* don't quit */ });

function makeClient() {
  if (!store.isConfigured) { client = null; return; }
  const c = store.asConfig();
  client = new TPClient({ baseURL: c.baseURL, token: c.token, myUserId: c.myUserId });
}

function startZoomWatcher() {
  if (zoomWatcher) zoomWatcher.stop();
  zoomWatcher = new ZoomWatcher({
    getConfig: () => ({ ...store.asConfig(), tzOffsetMinutes: tzOffset(store.data.timezone) }),
    getClient: () => client,
    dataDir: store.dir,
    onMeetingState: (active) => {
      if (active !== inMeeting) {
        inMeeting = active;
        setTrayIcon(active);   // swap the menu-bar icon + start/stop the timer
        if (popover && popover.isVisible()) {
          popover.webContents.send('meeting-state', active,
            active && meetingStartedAt ? meetingStartedAt.getTime() : 0);
        }
      }
    },
    onStatus: (msg) => {
      if (mainWindow) mainWindow.webContents.send('status', msg);
      updateTotals();
    },
  });
  zoomWatcher.start();
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
    width: 760, height: 560, show: false, title: 'TimeAgent', icon: APP_ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => { mainWindow.show(); mainWindow.focus(); });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function createSettingsWindow() {
  if (settingsWindow) { settingsWindow.show(); settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    width: 480, height: 600, show: false, title: 'TimeAgent Settings', icon: APP_ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWindow.once('ready-to-show', () => { settingsWindow.show(); settingsWindow.focus(); });
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

let cachedTimes = [];      // all my time entries (for month re-slicing)
let lastUpdated = '';      // HH:MM of last fetch
let popover = null;        // the borderless popover window

let iconNormal = null, iconMeeting = null;
let meetingStartedAt = null;     // Date when the current meeting began
let meetingTickTimer = null;

function loadIcon(file, template) {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', file));
  img.setTemplateImage(!!template);   // template = monochrome; non-template keeps color
  return img;
}

function mmss(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
              : `${m}:${String(ss).padStart(2, '0')}`;
}

function setTrayIcon(meeting) {
  if (!tray) return;
  if (meeting) {
    tray.setImage(iconMeeting);            // RED, non-template
    meetingStartedAt = meetingStartedAt || new Date();
    updateMeetingTitle();
    if (!meetingTickTimer) meetingTickTimer = setInterval(updateMeetingTitle, 1000);
  } else {
    tray.setImage(iconNormal);             // black template
    tray.setTitle('');                     // clear the elapsed text
    tray.setToolTip('TimeAgent');
    meetingStartedAt = null;
    if (meetingTickTimer) { clearInterval(meetingTickTimer); meetingTickTimer = null; }
  }
}

// Show the live meeting duration as the tray title (text beside the icon).
function updateMeetingTitle() {
  if (!tray || !meetingStartedAt) return;
  const elapsed = mmss(Date.now() - meetingStartedAt.getTime());
  tray.setTitle(` ${elapsed}`);
  tray.setToolTip(`TimeAgent — in meeting (${elapsed})`);
}

function buildTray() {
  iconNormal = loadIcon('trayTemplate.png', true);        // template (adapts light/dark)
  iconMeeting = loadIcon('trayMeetingRed.png', false);    // red, full color
  tray = new Tray(iconNormal);
  tray.setToolTip('TimeAgent');
  tray.on('click', (_e, bounds) => togglePopover(bounds));
  // Right-click still gives a minimal menu (quit etc).
  tray.on('right-click', () => {
    tray.popUpContextMenu(Menu.buildFromTemplate([
      { label: 'Open tasks…', click: createMainWindow },
      { label: 'Settings…', click: createSettingsWindow },
      { label: 'Check for updates…', click: checkForUpdatesManual },
      { type: 'separator' },
      { label: `Version ${app.getVersion()}`, enabled: false },
      { label: 'Quit', click: () => app.quit() },
    ]));
  });
}

function createPopover() {
  popover = new BrowserWindow({
    width: 280, height: 320, show: false, frame: false, resizable: false,
    transparent: false, skipTaskbar: true, alwaysOnTop: true, icon: APP_ICON,
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
ipcMain.handle('get-version', () => app.getVersion());
ipcMain.handle('get-meeting-state', () => ({
  active: inMeeting, startedAt: meetingStartedAt ? meetingStartedAt.getTime() : 0,
}));

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
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(APP_ICON); } catch (_) {}   // for Cmd-Tab / transient dock
    app.dock.hide(); // menu-bar style
  }
  store = new SettingsStore(app);
  await store.load();
  makeClient();
  buildTray();
  if (!store.isConfigured) createSettingsWindow();
  else { createMainWindow(); updateTotals(); }
  startZoomWatcher();   // begins polling for Zoom meetings
  // Keep tray totals fresh while running (every 5 min).
  setInterval(updateTotals, 5 * 60 * 1000);
  setupAutoUpdate();
});

