'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog } = require('electron');
const path = require('path');
const { TPClient } = require('./tpclient');
const { SettingsStore } = require('./settings');
const { ZoomWatcher } = require('./zoomwatcher');
const holidays = require('./holidays');

// Combined set of days off for a year: user-added + confirmed religious +
// (when region is Morocco) the fixed civil holidays.
function allDaysOff(year) {
  const out = new Set(store.data.daysOff || []);
  // Enabled religious holiday dates (slot-keyed; user edits persist).
  for (const s of store.data.religiousSlots || []) if (s.on && s.date) out.add(s.date);
  if (store.data.region === 'morocco') {
    for (const d of holidays.fixedHolidays(year)) out.add(d);
  }
  return out;
}

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
    if (isMac) notifyManualUpdate(info);
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
    const info = res && res.updateInfo;
    const v = info && info.version;
    if (!v || v === app.getVersion()) {
      dialog.showMessageBox({ type: 'info', message: 'You’re up to date.',
        detail: `Version ${app.getVersion()}` });
    } else if (isMac) {
      notifyManualUpdate(info);
    }
  } catch (e) {
    dialog.showMessageBox({ type: 'warning', message: 'Could not check for updates.', detail: e.message });
  }
}

let lastNotifiedVersion = '';
let updateDownloading = false;

// Smooth Mac flow: detect → offer → download the .dmg IN-APP with progress →
// open it so the user just drags the app to Applications. No hunting on GitHub.
async function notifyManualUpdate(info) {
  const version = info && info.version;
  if (version && version === lastNotifiedVersion && !updateDownloading) {
    // already offered this version this session
  }
  lastNotifiedVersion = version;
  if (tray) tray.setToolTip(`TimeAgent — v${version} available`);

  const notes = (info && typeof info.releaseNotes === 'string')
    ? info.releaseNotes.replace(/<[^>]+>/g, '').trim().slice(0, 400) : '';

  const r = dialog.showMessageBoxSync({
    type: 'info', buttons: ['Download & Install', 'Later'], defaultId: 0, cancelId: 1,
    message: `TimeAgent ${version ? 'v' + version : 'update'} is available`,
    detail: (notes ? notes + '\n\n' : '') +
      'TimeAgent will download the update and open the installer — just drag it to Applications.',
  });
  if (r !== 0) return;
  await downloadAndOpenDmg(info);
}

// Find the arm64/x64 .dmg URL for this Mac from the update info, download it with
// a progress dialog, then open it.
async function downloadAndOpenDmg(info) {
  if (updateDownloading) return;
  updateDownloading = true;
  try {
    const isArm = process.arch === 'arm64';
    // Prefer a .dmg listed in the update info that matches this arch.
    const files = (info && info.files) || [];
    let dmg = files.find((f) => /\.dmg$/i.test(f.url) &&
      (isArm ? /arm64/i.test(f.url) : !/arm64/i.test(f.url)));
    if (!dmg) dmg = files.find((f) => /\.dmg$/i.test(f.url));   // any dmg
    // Fallback to electron-builder's default dmg name (x64 has NO arch suffix).
    const fileName = dmg ? decodeURIComponent(dmg.url.split('/').pop())
      : (isArm ? `TimeAgent-${info.version}-arm64.dmg` : `TimeAgent-${info.version}.dmg`);
    const base = `https://github.com/hatimox/TimeAgent/releases/download/${info.version}/`;
    const url = dmg && /^https?:/.test(dmg.url) ? dmg.url : base + encodeURIComponent(fileName);

    const dest = path.join(app.getPath('temp'), fileName);
    if (tray) tray.setToolTip(`Downloading TimeAgent v${info.version}…`);

    await downloadFile(url, dest, (pct) => {
      if (tray) tray.setToolTip(`Downloading update… ${pct}%`);
    });

    if (tray) tray.setToolTip(`TimeAgent — update downloaded`);
    const r = dialog.showMessageBoxSync({
      type: 'info', buttons: ['Open installer', 'Show in Finder'], defaultId: 0,
      message: 'Update downloaded',
      detail: 'The installer will open — drag TimeAgent onto the Applications folder, ' +
              'replacing the old version. Then reopen TimeAgent.',
    });
    if (r === 0) await require('electron').shell.openPath(dest);
    else require('electron').shell.showItemInFolder(dest);
  } catch (e) {
    const r = dialog.showMessageBoxSync({
      type: 'warning', buttons: ['Open releases page', 'Cancel'], defaultId: 0,
      message: 'Could not download the update automatically.',
      detail: e.message + '\n\nYou can download it from the releases page instead.',
    });
    if (r === 0) require('electron').shell.openExternal(RELEASES_URL);
  } finally {
    updateDownloading = false;
  }
}

// Stream a URL to a file, following redirects, reporting integer percent.
function downloadFile(url, dest, onProgress) {
  const https = require('https');
  const fs = require('fs');
  return new Promise((resolve, reject) => {
    const get = (u, redirects = 0) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); return get(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let done = 0, lastPct = -1;
        const out = fs.createWriteStream(dest);
        res.on('data', (chunk) => {
          done += chunk.length;
          if (total) {
            const pct = Math.floor((done / total) * 100);
            if (pct !== lastPct) { lastPct = pct; onProgress && onProgress(pct); }
          }
        });
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(dest)));
        out.on('error', reject);
      }).on('error', reject);
    };
    get(url);
  });
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

let iconMeeting = null;
let meetingStartedAt = null;     // Date when the current meeting began
let meetingTickTimer = null;

function loadIcon(file, template) {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', file));
  img.setTemplateImage(!!template);   // template = monochrome; non-template keeps color
  return img;
}

// The normal (not-in-meeting) tray icon, chosen for the current OS + theme.
//  - macOS: a template image auto-adapts to the menu bar — always correct.
//  - Linux/Windows: no template support, so pick WHITE on dark panels, BLACK on
//    light ones, based on the OS theme (this fixes the invisible icon on Ubuntu
//    dark mode).
function normalTrayIcon() {
  const { nativeTheme } = require('electron');
  if (process.platform === 'darwin') return loadIcon('trayTemplate.png', true);
  return nativeTheme.shouldUseDarkColors
    ? loadIcon('trayWhite.png', false)
    : loadIcon('trayBlack.png', false);
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
    tray.setImage(normalTrayIcon());       // theme-aware normal icon
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
  iconMeeting = loadIcon('trayMeetingRed.png', false);    // red, full color
  tray = new Tray(normalTrayIcon());
  tray.setToolTip('TimeAgent');
  // Re-apply the icon when the OS switches light/dark (Linux/Windows need it).
  require('electron').nativeTheme.on('updated', () => {
    if (tray && !inMeeting) tray.setImage(normalTrayIcon());
  });
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

  const { screen } = require('electron');
  const win = popover.getBounds();
  const hasBounds = bounds && bounds.width;
  // Pick the display the tray icon (or cursor) is on.
  const point = hasBounds
    ? { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) }
    : screen.getCursorScreenPoint();
  const wa = screen.getDisplayNearestPoint(point).workArea;

  let x, y;
  if (hasBounds) {
    // Center horizontally under/over the icon.
    x = Math.round(bounds.x + bounds.width / 2 - win.width / 2);
    // If the tray is in the TOP half of the screen (macOS menu bar / top taskbar)
    // drop the popover below the icon; if in the BOTTOM half (Windows taskbar)
    // place it ABOVE the icon so it stays on-screen.
    const trayInTopHalf = bounds.y < wa.y + wa.height / 2;
    y = trayInTopHalf ? Math.round(bounds.y + bounds.height + 4)
                      : Math.round(bounds.y - win.height - 4);
  } else {
    // No bounds (some Linux): anchor to the corner nearest the cursor.
    x = wa.x + wa.width - win.width - 8;
    y = (point.y < wa.y + wa.height / 2) ? wa.y + 8 : wa.y + wa.height - win.height - 8;
  }

  // Clamp fully inside the work area so it's never clipped off-screen.
  x = Math.max(wa.x + 4, Math.min(x, wa.x + wa.width - win.width - 4));
  y = Math.max(wa.y + 4, Math.min(y, wa.y + wa.height - win.height - 4));

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
  // A different token (or server) means a different logged-in user: drop the
  // cached id so ensureUserId() re-detects it, otherwise reads keep targeting
  // the old user while writes go to the new token's owner.
  const identityChanged = token !== store.token ||
    (incoming.tpURL != null && incoming.tpURL !== store.data.tpURL);
  store.data = { ...store.data, ...incoming };
  store.token = token;
  if (identityChanged) {
    store.data.myUserId = 0;
    cachedTimes = [];                     // stale: belongs to the previous user
  }
  await store.save();
  makeClient();
  await ensureUserId();
  startZoomWatcher();   // restart so meeting-process / rounding changes take effect
  logRecurringIfDue();  // a newly added recurring entry fires now if due today
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
ipcMain.handle('get-morocco-holidays', (_e, year) => ({
  fixed: holidays.fixedHolidays(year),
  fixedNamed: holidays.fixedHolidaysNamed(year),
  religious: holidays.religiousHolidays(year),
  years: holidays.religiousYears(),
}));
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
// Log every configured recurring entry once per working day (Mon–Fri, skipping
// days_off.json). Deduped via recurring_logged.json keyed by "date|taskId" so it
// never double-logs across restarts. Mirrors the Swift app's behavior.
async function logRecurringIfDue() {
  const fs = require('fs');
  if (!client) return;
  const recurring = store.data.recurring || [];
  if (!recurring.length) return;

  const tz = store.data.timezone || 'UTC';
  const off = tzOffset(tz);
  const now = new Date();
  // "today" and weekday in the work timezone.
  const local = new Date(now.getTime() + off * 60000);
  const today = local.toISOString().slice(0, 10);
  const weekday = local.getUTCDay();        // 0=Sun … 6=Sat

  // Weekly days off (configurable; default Sat+Sun).
  const weeklyOff = store.data.weeklyOff || [0, 6];
  if (weeklyOff.includes(weekday)) return;

  // All days off = user-added + religious + (if region=morocco) fixed civil.
  if (allDaysOff(local.getUTCFullYear()).has(today)) return;

  const ledgerFile = path.join(store.dir, 'recurring_logged.json');
  let logged = [];
  try { logged = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')); } catch (_) {}
  const set = new Set(logged);

  let anyLogged = false;
  for (const entry of recurring) {
    if (!entry.taskId || !(entry.hours > 0)) continue;
    const key = `${today}|${entry.taskId}`;
    if (set.has(key)) continue;

    try {
      await client.logTime({
        entityId: entry.taskId, hours: entry.hours,
        description: entry.label || '', date: now, tzOffsetMinutes: off,
      });
      set.add(key);
      fs.writeFileSync(ledgerFile, JSON.stringify([...set]));
      anyLogged = true;
      if (mainWindow) mainWindow.webContents.send('status',
        `Auto-logged ${entry.hours}h “${entry.label || entry.taskId}”`);
    } catch (e) {
      if (mainWindow) mainWindow.webContents.send('status',
        `Recurring log failed: ${e.message}`);
    }
  }
  if (anyLogged) updateTotals();
}

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
  await ensureUserId();
  logRecurringIfDue();  // fire today's recurring auto-logs once
  // Keep tray totals fresh while running (every 5 min).
  setInterval(updateTotals, 5 * 60 * 1000);
  // Re-check recurring hourly too, in case the app launched before midnight / on a day off.
  setInterval(logRecurringIfDue, 60 * 60 * 1000);
  setupAutoUpdate();
});

