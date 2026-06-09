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

  // Linux: PipeWire (pw-cli) or PulseAudio (pactl) report active mic capture.
  // A "source-output" / running capture stream = something is recording.
  _micLinux() {
    return new Promise((resolve) => {
      // pactl works for both PulseAudio and PipeWire's pulse shim (most distros).
      execFile('pactl', ['list', 'source-outputs'], { timeout: 4000 }, (err, out) => {
        if (err) { resolve(null); return; }   // pactl missing -> unknown, fall back
        // Any source-output that's a real capture (not monitor) & RUNNING.
        const txt = String(out);
        if (!txt.trim()) { resolve(false); return; }
        // Heuristic: a running, non-monitor source-output means mic capture.
        const blocks = txt.split(/Source Output #/).slice(1);
        const active = blocks.some((b) =>
          /State:\s*RUNNING/i.test(b) && !/monitor/i.test(b));
        resolve(active);
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
    if (mic !== null) return mic;
    // Fallback: process detection (Zoom + configured Teams names).
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
