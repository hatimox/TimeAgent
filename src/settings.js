'use strict';
// Cross-platform settings store. Non-secret config in settings.json (atomic
// write + .bak backup); the TP token in the OS secret store via keytar
// (Keychain on mac, libsecret on Linux, Credential Vault on Windows).

const fs = require('fs');
const path = require('path');
const os = require('os');

let keytar = null;
try { keytar = require('keytar'); } catch (_) { /* fall back to file token */ }

const KEYTAR_SERVICE = 'net.omnevo.timeagent';
const KEYTAR_ACCOUNT = 'tp-token';

function dataDir(app) {
  // app.getPath('userData') when running in Electron; fallback for CLI tests.
  const base = app ? app.getPath('userData')
    : path.join(os.homedir(), '.config', 'TimeAgent');
  fs.mkdirSync(base, { recursive: true });
  return base;
}

const DEFAULTS = () => ({
  tpURL: '',
  myUserId: 0,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  dailyTaskId: 0,
  meetingsTaskId: 0,
  meetingMinMinutes: 30,
  meetingStepMinutes: 15,
  meetingProcs: '',   // optional override of the in-meeting process names
  recurring: [],
  daysOff: [],            // user-added specific YYYY-MM-DD dates (no auto-logging)
  weeklyOff: [0, 6],      // weekdays always off (0=Sun … 6=Sat); default Sat+Sun
  region: 'none',         // 'morocco' = auto-apply fixed civil holidays
  // Religious holidays as slot-keyed objects so user edits persist across reloads:
  //   { key: "2026|Eid al-Adha|0", date: "2026-05-28", on: true }
  religiousSlots: [],
  // token is NOT stored here; it lives in keytar (or token.secret fallback)
});

class SettingsStore {
  constructor(app) {
    this.dir = dataDir(app);
    this.file = path.join(this.dir, 'settings.json');
    this.backup = path.join(this.dir, 'settings.json.bak');
    this.tokenFallback = path.join(this.dir, 'token.secret');
    this.data = DEFAULTS();
    this.token = '';
  }

  async load() {
    let parsed = null;
    for (const f of [this.file, this.backup]) {
      try { parsed = JSON.parse(fs.readFileSync(f, 'utf8')); break; }
      catch (_) { /* try next */ }
    }
    if (parsed) this.data = { ...DEFAULTS(), ...parsed };
    this.token = await this._loadToken();
    // Migrate a legacy plaintext token if present in JSON.
    if (!this.token && parsed && parsed.tpToken) {
      this.token = parsed.tpToken;
      await this._saveToken(this.token);
    }
    // Ensure a backup exists.
    if (parsed && !fs.existsSync(this.backup)) this.save();
    return this;
  }

  save() {
    const json = JSON.stringify(this.data, null, 2);
    const tmp = this.file + '.tmp';
    try {
      fs.writeFileSync(tmp, json);
      fs.renameSync(tmp, this.file);     // atomic on same volume
      fs.writeFileSync(this.backup, json);
    } catch (e) {
      try { fs.writeFileSync(this.file, json); } catch (_) {}
    }
    return this._saveToken(this.token);
  }

  async _loadToken() {
    if (keytar) {
      try { const t = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT); if (t) return t; }
      catch (_) {}
    }
    try { return fs.readFileSync(this.tokenFallback, 'utf8').trim(); } catch (_) { return ''; }
  }

  async _saveToken(token) {
    if (keytar) {
      try {
        if (token) await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, token);
        else await keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
        return;
      } catch (_) { /* fall through to file */ }
    }
    try {
      if (token) fs.writeFileSync(this.tokenFallback, token, { mode: 0o600 });
      else fs.existsSync(this.tokenFallback) && fs.unlinkSync(this.tokenFallback);
    } catch (_) {}
  }

  get isConfigured() {
    return !!this.token && /^https?:\/\//.test(this.data.tpURL || '');
  }

  // Convenience accessors used by the rest of the app.
  asConfig() {
    return {
      baseURL: this.data.tpURL,
      token: this.token,
      myUserId: this.data.myUserId,
      timezone: this.data.timezone,
      dailyTaskId: this.data.dailyTaskId,
      meetingsTaskId: this.data.meetingsTaskId,
      meetingMinMinutes: this.data.meetingMinMinutes,
      meetingStepMinutes: this.data.meetingStepMinutes,
      meetingProcs: this.data.meetingProcs,
      recurring: this.data.recurring,
      daysOff: this.data.daysOff,
      weeklyOff: this.data.weeklyOff,
      region: this.data.region,
      religiousSlots: this.data.religiousSlots,
      // Flat list of enabled religious dates, for the day-off check in main.
      religiousDays: (this.data.religiousSlots || []).filter((s) => s.on).map((s) => s.date),
    };
  }
}

module.exports = { SettingsStore };
