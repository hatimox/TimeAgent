'use strict';
// Cross-platform meeting detection for Zoom AND Microsoft Teams (and any app
// whose in-meeting process you add in Settings). On macOS Zoom's in-meeting media
// host (CptHost / aomhost) appears only during an active call and exits on leave.
// When a meeting ends we ask Daily / Other / Cancel, optionally a description,
// and log the (rounded) time to TargetProcess in real time — same flow for all.
//
// Teams has no single clean in-meeting process; add its name via the probe +
// the "Extra meeting processes" setting.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { dialog, BrowserWindow } = require('electron');

// Processes that exist ONLY during an active meeting (not while the app is merely
// open). The main app process (Zoom.exe / ms-teams) must NOT be here, or the
// watcher thinks you're in a meeting the whole time the app runs.
// Covers Zoom + Microsoft Teams. Overridable per-user via settings.meetingProcs.
//
// Teams note: Teams has no single clean "in-meeting" process like Zoom's CptHost.
// The names below are best-effort for new Teams; verify with the probe and
// override in Settings if your version differs.
const PROCS = {
  darwin: ['CptHost', 'aomhost'],            // Zoom only by default on mac (Teams: add via probe)
  linux: ['aomhost', 'CptHost'],
  win32: ['CptHost', 'aomhost'],
};

// Teams in-meeting process candidates per OS — appended to the defaults so the
// watcher detects Teams calls too. Verify/adjust via the probe + Settings.
const TEAMS_PROCS = {
  darwin: [],                                 // unreliable on mac; user adds via probe
  linux: [],
  win32: [],
};

class ZoomWatcher {
  constructor({ getConfig, getClient, dataDir, onMeetingState, onStatus }) {
    this.getConfig = getConfig;       // () => config object (taskIds, tz, rounding)
    this.getClient = getClient;       // () => TPClient | null
    this.dataDir = dataDir;
    this.onMeetingState = onMeetingState || (() => {});
    this.onStatus = onStatus || (() => {});
    // Process list = built-in (Zoom + Teams) for this OS, PLUS any user override
    // (settings.meetingProcs: comma/space separated). Override ADDS to defaults so
    // users only need to add their Teams process name, not re-list Zoom's.
    const cfg = (this.getConfig && this.getConfig()) || {};
    const plat = process.platform;
    const builtins = [...(PROCS[plat] || ['CptHost']), ...(TEAMS_PROCS[plat] || [])];
    const override = (cfg.meetingProcs || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
    this.procs = [...new Set([...builtins, ...override])];
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

  // Is any microphone currently in use? The reliable, app-agnostic "in a call"
  // signal — catches Teams/Zoom/Meet/Webex with no config. Returns true/false,
  // or null if it can't be determined on this platform (caller falls back).
  _micInUse() {
    switch (process.platform) {
      case 'darwin': return this._micMac();
      case 'linux': return this._micLinux();
      case 'win32': return this._micWindows();
      default: return Promise.resolve(null);
    }
  }

  // macOS: bundled michelper binary (CoreAudio IsRunningSomewhere on inputs).
  _micMac() {
    return new Promise((resolve) => {
      const candidates = [
        path.join(process.resourcesPath || '', 'michelper'),  // packaged app
        path.join(__dirname, '..', 'native', 'michelper'),    // dev
      ];
      const bin = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
      if (!bin) { resolve(null); return; }
      execFile(bin, [], { timeout: 4000 }, (err, out) => {
        resolve(err ? null : String(out).trim() === '1');
      });
    });
  }

  // Linux: PulseAudio / PipeWire's pulse shim report capture streams as
  // "source-outputs". A live (non-corked) capture from a real input device
  // (not a .monitor source = desktop audio) means something is recording.
  // NOTE: these blocks have a "Corked:" line, NOT "State:" (that's sources).
  _micLinux() {
    return new Promise((resolve) => {
      // First map which source indices are monitors so we can exclude them.
      execFile('pactl', ['list', 'short', 'sources'], { timeout: 4000 }, (errS, outS) => {
        if (errS) { resolve(null); return; }   // pactl missing -> unknown, fall back
        const monitors = new Set();
        for (const line of String(outS).split('\n')) {
          const [idx, name] = line.split('\t');
          if (name && /\.monitor$/.test(name.trim())) monitors.add(idx.trim());
        }
        execFile('pactl', ['list', 'source-outputs'], { timeout: 4000 }, (err, out) => {
          if (err) { resolve(null); return; }
          const txt = String(out);
          if (!txt.trim()) { resolve(false); return; }
          const blocks = txt.split(/Source Output #/).slice(1);
          const active = blocks.some((b) => {
            const live = /Corked:\s*no/i.test(b) || /State:\s*RUNNING/i.test(b);
            if (!live) return false;
            const src = b.match(/^\s*Source:\s*(\d+)\s*$/m);
            const fromMonitor = (src && monitors.has(src[1])) || /\.monitor\b/i.test(b);
            return !fromMonitor;
          });
          resolve(active);
        });
      });
    });
  }

  // Windows: the CapabilityAccessManager registry tracks per-app mic usage.
  // An app currently using the mic has LastUsedTimeStop = 0.
  _micWindows() {
    return new Promise((resolve) => {
      const ps = 'Get-ChildItem -Path "HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone" -Recurse ' +
        '| Get-ItemProperty | Where-Object { $_.LastUsedTimeStop -eq 0 } | Measure-Object | Select-Object -ExpandProperty Count';
      execFile('powershell', ['-NoProfile', '-Command', ps], { timeout: 6000 }, (err, out) => {
        if (err) { resolve(null); return; }
        resolve(parseInt(String(out).trim(), 10) > 0);
      });
    });
  }

  async _inMeeting() {
    // Primary: microphone in use (reliable for any meeting app, no config).
    const mic = await this._micInUse();
    if (mic === null && !this._micWarned) {
      this._micWarned = true;
      this.log('mic detection unavailable (helper/pactl missing) — process fallback only');
    }
    if (mic) return true;
    // Process detection (Zoom + configured Teams names) still applies: it
    // covers mic-unavailable platforms AND meetings joined without a mic.
    for (const n of this.procs) if (await this._running(n)) return true;
    return false;
  }

  // Manually end the current meeting segment NOW and let a new one begin while
  // still in Zoom (e.g. switching breakout rooms). Logs the elapsed segment via
  // the normal Daily/Other flow; the next poll starts a fresh session if the
  // mic/process is still active. No-op when not in a meeting.
  async splitNow() {
    if (!this.sessionStart || this.busy) return { ok: false, reason: 'no-active-meeting' };
    const start = this.sessionStart;
    const end = Date.now();
    // Clear the session so the next poll opens a brand-new one.
    this.sessionStart = null; this.lastSeen = null;
    const durSec = (end - start) / 1000;
    this.log(`meeting SPLIT dur=${Math.round(durSec)}s`);
    if (durSec >= this.minSeconds) {
      await this.handleEnd(new Date(start), new Date(end));
    } else {
      this.log('-> split segment too short, skipped');
    }
    // Re-evaluate immediately so the new segment's timer starts without delay.
    this.schedule(0);
    return { ok: true };
  }

  async poll() {
    if (this.busy) { this.schedule(this.activePollMs); return; }
    let active = false;
    try { active = await this._inMeeting(); } catch (_) {}
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
    // Report state AFTER updating sessionStart so the displayed timer reflects
    // the current segment (important when a split begins a fresh session).
    this.onMeetingState(active, this.sessionStart || 0);
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

      // 1) Daily / Defined list / Search / Cancel
      const dynamicMeetings = cfg.dynamicMeetings || [];
      const hasDynamic = dynamicMeetings.length > 0;
      const choice = dialog.showMessageBoxSync({
        type: 'question',
        message: `Meeting ended (${win}, ${hours.toFixed(2)}h)`,
        detail: 'How should this be logged?',
        buttons: ['Daily', 'Defined list', 'Search', 'Cancel'],
        defaultId: 0, cancelId: 3, noLink: true,
      });
      if (choice === 3) { this.onStatus(`Meeting ${win} ignored`); this.log('cancelled'); return; }

      // Helper used by all three logging paths.
      const logToTask = async (taskId, description, label) => {
        if (!taskId) { this.onStatus('No meeting task id set in Settings'); return; }
        if (!client) { this.onStatus('Not configured — meeting not logged'); return; }
        await client.logTime({
          entityId: taskId, hours, description,
          date: start, tzOffsetMinutes: cfg.tzOffsetMinutes,
        });
        this.onStatus(`Logged ${hours.toFixed(2)}h to ${label}`);
        this.log(`logged ${hours}h to ${taskId} (${label})`);
      };

      if (choice === 0) {
        // Daily
        await logToTask(cfg.dailyTaskId, '', 'Daily');
        return;
      }

      if (choice === 2) {
        // Search: existing description + task-search prompt. "Skip" still logs
        // (with no description) — the user already chose to log by picking
        // Search; only the top-level "Cancel" button discards the meeting.
        const res = await promptText(`Meeting ${win} — ${hours.toFixed(2)}h`,
          'What was it about? (used as the time-log description)',
          { defaultTaskId: cfg.meetingsTaskId || 0 });
        const taskId = res.taskId || cfg.meetingsTaskId;
        await logToTask(taskId, res.description || '', `#${taskId}`);
        return;
      }

      // choice === 1: Defined list
      if (!hasDynamic) {
        dialog.showMessageBoxSync({
          type: 'info',
          message: 'No dynamic meetings configured',
          detail: 'Add them in Settings → Meetings.',
          buttons: ['OK'],
          defaultId: 0, noLink: true,
        });
        this.onStatus(`Meeting ${win} ignored — no dynamic meetings`);
        return;
      }
      const picked = await pickDynamicMeeting(dynamicMeetings);
      if (!picked) { this.onStatus(`Meeting ${win} ignored`); this.log('cancelled'); return; }
      // The user already picked a meeting; "Skip" on the description prompt
      // logs with the meeting's default description rather than discarding.
      const res = await promptText(`${picked.name} — ${hours.toFixed(2)}h`,
        'Description (editable)',
        { defaultTaskId: picked.taskId, defaultDescription: picked.description, readOnlyTask: true });
      const desc = res.skipped ? (picked.description || '') : (res.description || '');
      await logToTask(picked.taskId, desc, `${picked.name} (#${picked.taskId})`);
    } catch (e) {
      this.onStatus('Meeting log failed: ' + e.message);
      this.log('ERROR ' + e.message);
    } finally {
      this.busy = false;
    }
  }
}

// Pick a dynamic meeting from the configured list. Returns a meeting object
// or null if the user cancels. The real implementation is assigned below once
// module-scoped helpers are available.
let pickDynamicMeeting = async () => null;

// A small modal prompt window (Electron has no built-in text prompt). When
// `defaultTaskId` is given it also shows an editable task-id field (the task
// the time is saved to) and resolves to { description, taskId, skipped };
// otherwise it resolves to the plain description string (legacy callers).
let promptSeq = 0;
let dynamicSeq = 0;
function promptText(title, label, opts = {}) {
  const wantTaskId = opts.defaultTaskId != null;
  const readOnlyTask = !!opts.readOnlyTask;
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 400, height: wantTaskId ? (readOnlyTask ? 260 : 380) : 200, resizable: false, minimizable: false, maximizable: false,
      title, alwaysOnTop: true,
      icon: path.join(__dirname, 'assets', 'appicon.png'),
      webPreferences: { contextIsolation: true,
        preload: path.join(__dirname, 'promptPreload.js') },
    });
    const channel = 'prompt-result-' + (++promptSeq);
    const query = { title, label, channel };
    if (wantTaskId) query.taskId = String(opts.defaultTaskId);
    if (opts.defaultDescription) query.defaultDescription = opts.defaultDescription;
    if (readOnlyTask) query.readOnlyTask = 'true';
    win.loadFile(path.join(__dirname, 'renderer', 'prompt.html'), { query });
    const { ipcMain } = require('electron');
    let settled = false;
    const finish = (value) => {
      settled = true; try { win.close(); } catch (_) {}
      if (!wantTaskId) { resolve((value && value.description) || ''); return; }
      resolve(value || { description: '', taskId: opts.defaultTaskId, skipped: true });
    };
    ipcMain.once(channel, (_e, value) => finish(value));
    win.on('closed', () => { if (!settled) finish(null); });
  });
}

// Real implementation: open a small modal window listing the configured dynamic
// meetings and return the one the user selects.
pickDynamicMeeting = async (meetings) => {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 360, height: 380, resizable: false, minimizable: false, maximizable: false,
      title: 'Select meeting', alwaysOnTop: true,
      icon: path.join(__dirname, 'assets', 'appicon.png'),
      webPreferences: {
        contextIsolation: true,
        preload: path.join(__dirname, 'dynamicPickerPreload.js'),
      },
    });
    const channel = 'dynamic-result-' + (++dynamicSeq);
    const query = { channel, meetings: JSON.stringify(meetings) };
    win.loadFile(path.join(__dirname, 'renderer', 'dynamic-picker.html'), { query });
    let settled = false;
    const finish = (value) => {
      settled = true; try { win.close(); } catch (_) {}
      resolve(value || null);
    };
    const { ipcMain } = require('electron');
    ipcMain.once(channel, (_e, value) => finish(value));
    win.on('closed', () => { if (!settled) finish(null); });
  });
};

module.exports = { ZoomWatcher };
