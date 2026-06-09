'use strict';
// Cross-platform Zoom meeting detection. On macOS the in-meeting media host
// (CptHost / aomhost) appears only during an active call and exits on leave.
// When a meeting ends we ask Daily / Other / Cancel, optionally a description,
// and log the (rounded) time to TargetProcess in real time.
//
// Linux/Windows process names differ — set them in PROCS per platform once known.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { dialog, BrowserWindow } = require('electron');

// Processes that exist ONLY during an active meeting (not while the Zoom app is
// merely open). 'Zoom'/'Zoom.exe' is the main app — it must NOT be here, or the
// watcher thinks you're in a meeting the whole time Zoom is running.
// These can be overridden per-user via settings.meetingProcs.
const PROCS = {
  darwin: ['CptHost', 'aomhost'],
  linux: ['aomhost', 'CptHost'],   // verify on Linux; override in settings if needed
  win32: ['CptHost', 'aomhost'],   // CptHost.exe = in-meeting host; verify per Zoom version
};

class ZoomWatcher {
  constructor({ getConfig, getClient, dataDir, onMeetingState, onStatus }) {
    this.getConfig = getConfig;       // () => config object (taskIds, tz, rounding)
    this.getClient = getClient;       // () => TPClient | null
    this.dataDir = dataDir;
    this.onMeetingState = onMeetingState || (() => {});
    this.onStatus = onStatus || (() => {});
    // Allow a user override (settings.meetingProcs: comma/space separated names).
    const cfg = (this.getConfig && this.getConfig()) || {};
    const override = (cfg.meetingProcs || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
    this.procs = override.length ? override : (PROCS[process.platform] || ['CptHost']);
    this.minSeconds = 60;
    this.idlePollMs = 8000;     // when NOT in a meeting
    this.activePollMs = 3000;   // when in a meeting (catch the end fast)
    this.timer = null;
    this.sessionStart = null;
    this.lastSeen = null;
    this.busy = false;                // a dialog is open
  }

  start() {
    this.log(`ZoomWatcher started procs=${this.procs} idle=${this.idlePollMs / 1000}s active=${this.activePollMs / 1000}s`);
    this.schedule(this.idlePollMs);
    this.poll();
  }
  stop() { if (this.timer) clearTimeout(this.timer); this.timer = null; }

  // Self-scheduling loop so we can change cadence based on meeting state.
  schedule(ms) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.poll(), ms);
  }

  log(msg) {
    try {
      fs.appendFileSync(path.join(this.dataDir, 'zoom-debug.log'),
        `${new Date().toISOString()} ${msg}\n`);
    } catch (_) {}
  }

  _running(name) {
    return new Promise((resolve) => {
      // pgrep on mac/linux; tasklist on Windows.
      if (process.platform === 'win32') {
        execFile('tasklist', ['/FI', `IMAGENAME eq ${name}.exe`], (err, out) =>
          resolve(!err && /\.exe/i.test(out)));
      } else {
        execFile('/usr/bin/pgrep', ['-x', name], (err) => resolve(!err));
      }
    });
  }

  async _inMeeting() {
    for (const n of this.procs) if (await this._running(n)) return true;
    return false;
  }

  async poll() {
    if (this.busy) { this.schedule(this.activePollMs); return; }
    let active = false;
    try { active = await this._inMeeting(); } catch (_) {}
    this.onMeetingState(active);
    const now = Date.now();
    if (active) {
      if (!this.sessionStart) { this.sessionStart = now; this.log('meeting STARTED'); }
      this.lastSeen = now;
    } else if (this.sessionStart) {
      const start = this.sessionStart;
      const seen = this.lastSeen || start;
      this.sessionStart = null; this.lastSeen = null;
      // End = now unless there was a long gap (sleep) — then trust last heartbeat.
      const end = (now - seen) > this.idlePollMs * 3 ? seen : now;
      const durSec = (end - start) / 1000;
      this.log(`meeting ENDED dur=${Math.round(durSec)}s`);
      if (durSec >= this.minSeconds) this.handleEnd(new Date(start), new Date(end));
      else this.log('-> too short, skipped');
    }
    // Poll faster while in a meeting so we catch the end within a few seconds.
    this.schedule(this.sessionStart ? this.activePollMs : this.idlePollMs);
  }

  billableHours(rawHours) {
    const cfg = this.getConfig() || {};
    const stepH = Math.max(1, cfg.meetingStepMinutes || 15) / 60;
    const minH = Math.max(0, cfg.meetingMinMinutes ?? 30) / 60;
    return Math.max(minH, Math.ceil(rawHours / stepH) * stepH);
  }

  async handleEnd(start, end) {
    this.busy = true;
    try {
      const cfg = this.getConfig() || {};
      const client = this.getClient();
      const rawH = (end - start) / 3600000;
      const hours = Math.round(this.billableHours(rawH) * 100) / 100;
      const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const win = `${hhmm(start)}-${hhmm(end)}`;

      // 1) Daily / Other / Cancel
      const choice = dialog.showMessageBoxSync({
        type: 'question',
        message: `Zoom meeting ended (${win}, ${hours.toFixed(2)}h)`,
        detail: 'How should this be logged?',
        buttons: ['Daily meeting', 'Other meeting', 'Cancel'],
        defaultId: 0, cancelId: 2, noLink: true,
      });
      if (choice === 2) { this.onStatus(`Meeting ${win} ignored`); this.log('cancelled'); return; }
      const isDaily = choice === 0;

      // 2) Description for non-daily
      let desc = '';
      if (!isDaily) desc = await promptText(`Meeting ${win} — ${hours.toFixed(2)}h`,
        'What was it about? (used as the time-log description)');

      const taskId = isDaily ? cfg.dailyTaskId : cfg.meetingsTaskId;
      if (!taskId) { this.onStatus('No meeting task id set in Settings'); return; }
      if (!client) { this.onStatus('Not configured — meeting not logged'); return; }

      await client.logTime({
        entityId: taskId, hours, description: desc,
        date: start, tzOffsetMinutes: cfg.tzOffsetMinutes,
      });
      this.onStatus(`Logged ${hours.toFixed(2)}h to ${isDaily ? 'Daily' : 'Meetings'}`);
      this.log(`logged ${hours}h to ${taskId} (${isDaily ? 'daily' : 'other'})`);
    } catch (e) {
      this.onStatus('Meeting log failed: ' + e.message);
      this.log('ERROR ' + e.message);
    } finally {
      this.busy = false;
    }
  }
}

// A small modal text-input window (Electron has no built-in text prompt).
let promptSeq = 0;
function promptText(title, label) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 380, height: 200, resizable: false, minimizable: false, maximizable: false,
      title, alwaysOnTop: true,
      icon: path.join(__dirname, 'assets', 'appicon.png'),
      webPreferences: { contextIsolation: true,
        preload: path.join(__dirname, 'promptPreload.js') },
    });
    const channel = 'prompt-result-' + (++promptSeq);
    win.loadFile(path.join(__dirname, 'renderer', 'prompt.html'),
      { query: { title, label, channel } });
    const { ipcMain } = require('electron');
    let settled = false;
    ipcMain.once(channel, (_e, value) => {
      settled = true; try { win.close(); } catch (_) {} resolve(value || '');
    });
    win.on('closed', () => { if (!settled) resolve(''); });
  });
}

module.exports = { ZoomWatcher };
