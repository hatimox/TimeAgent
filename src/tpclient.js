'use strict';
// TargetProcess REST client — ported from the Swift TPClient, including the
// date/timezone fixes (noon-anchor writes, offset-aware day bucketing).

const https = require('https');
const { URL } = require('url');

class TPClient {
  constructor({ baseURL, token, myUserId }) {
    this.baseURL = baseURL.replace(/\/+$/, '');
    this.token = token;
    this.myUserId = myUserId || 0;
  }

  // --- low-level request ---
  // Build the URL manually with encodeURIComponent (%20 for spaces). TP's OData
  // parser rejects the '+'-for-space form that URLSearchParams produces.
  _url(path, query = {}) {
    const params = { format: 'json', access_token: this.token, ...query };
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    return new URL(`${this.baseURL}/api/v1/${path}?${qs}`);
  }

  _request(method, url, body) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const opts = {
        method,
        headers: { Accept: 'application/json' },
      };
      if (data) {
        opts.headers['Content-Type'] = 'application/json';
        opts.headers['Content-Length'] = Buffer.byteLength(data);
      }
      const req = https.request(url, opts, (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(buf ? JSON.parse(buf) : {}); }
            catch (e) { reject(new Error(`Bad JSON: ${buf.slice(0, 200)}`)); }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 200)}`));
          }
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  _get(path, query) { return this._request('GET', this._url(path, query)); }

  // GET every page of a collection. TP caps `take` at 1000, so a single
  // request silently drops anything past the first page.
  async _getAllItems(path, query) {
    const take = 1000;
    const items = [];
    for (let skip = 0; ; skip += take) {
      const obj = await this._get(path, { ...query, take: String(take), skip: String(skip) });
      const batch = obj.Items || [];
      items.push(...batch);
      if (batch.length < take && !obj.Next) break;
      if (batch.length === 0) break;
    }
    return items;
  }
  _post(path, body, query) { return this._request('POST', this._url(path, query), body); }

  // --- identity ---
  async whoAmI() {
    const obj = await this._get('Context');
    const u = obj.LoggedUser;
    if (!u || u.Id == null) throw new Error('Could not read logged-in user from token');
    return { id: u.Id, name: `${u.FirstName || ''} ${u.LastName || ''}`.trim() };
  }

  // --- items (Tasks + Bugs assigned to me) ---
  async fetchAllAssigned() {
    const [tasks, bugs] = await Promise.all([
      this._fetchCollection('Tasks'),
      this._fetchCollection('Bugs'),
    ]);
    return [...tasks, ...bugs].sort((a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  }

  async _fetchCollection(collection) {
    const items = await this._getAllItems(collection, {
      where: `AssignedUser.Id eq ${this.myUserId}`,
      include: '[Id,Name,EntityState[Name,IsFinal],Project[Name,Process[Id]],TeamIteration[Name]]',
    });
    return items.map((it) => {
      const es = it.EntityState || {};
      const project = it.Project || {};
      return {
        id: it.Id,
        name: it.Name,
        entityType: collection,            // "Tasks" | "Bugs"
        displayType: collection === 'Bugs' ? 'Bug' : 'Task',
        stateName: es.Name || '?',
        isFinal: !!es.IsFinal,
        projectName: project.Name || '',
        processId: (project.Process || {}).Id || 0,
        sprint: (it.TeamIteration || {}).Name || '',
      };
    }).filter((x) => x.id != null);
  }

  // --- full workflow state list for a process (so the filter shows ALL states) ---
  // TP's OData parser rejects a nested ((A) or (B)) inside an and, so we query
  // Task and Bug states separately and merge them.
  async fetchWorkflowStates(processId) {
    if (!processId) return [];
    const order = new Map();
    for (const etype of ['Task', 'Bug']) {
      let obj;
      try {
        obj = await this._get('EntityStates', {
          where: `(Process.Id eq ${processId}) and (EntityType.Name eq '${etype}')`,
          include: '[Name,NumericPriority]',
          take: '200',
        });
      } catch (e) { continue; }
      for (const s of obj.Items || []) {
        const n = s.Name;
        const p = s.NumericPriority || 0;
        order.set(n, order.has(n) ? Math.min(order.get(n), p) : p);
      }
    }
    return [...order.keys()].sort((a, b) => (order.get(a) - order.get(b)) || a.localeCompare(b));
  }

  // --- my time entries, with the TP-assigned calendar day (offset-aware) ---
  async fetchMyTimes() {
    const items = await this._getAllItems('Times', {
      where: `User.Id eq ${this.myUserId}`,
      include: '[Spent,Date,Assignable[Id]]',
    });
    const out = [];
    for (const t of items) {
      const itemId = (t.Assignable || {}).Id || 0;
      const hours = Number(t.Spent) || 0;
      const day = TPClient.tpDay(t.Date);
      if (day) out.push({ itemId, hours, day });
    }
    return out;
  }

  // --- log a real Time entry (noon-anchored to the intended day) ---
  async logTime({ entityId, hours, description = '', date = new Date(), tzOffsetMinutes }) {
    // Anchor to noon on the target calendar day so a ±offset disagreement with
    // TP's server can never push the entry across midnight.
    const off = tzOffsetMinutes == null ? -date.getTimezoneOffset() : tzOffsetMinutes;
    // Build "noon local" by taking the date's Y/M/D and setting 12:00 at `off`.
    const y = date.getFullYear(), m = date.getMonth(), d = date.getDate();
    // ms for 12:00 at the given offset = Date.UTC(y,m,d,12) - off*60000
    const ms = Date.UTC(y, m, d, 12, 0, 0) - off * 60000;
    const sign = off >= 0 ? '+' : '-';
    const ao = Math.abs(off);
    const offStr = `${sign}${String(Math.floor(ao / 60)).padStart(2, '0')}${String(ao % 60).padStart(2, '0')}`;
    const body = {
      Spent: hours,
      Remain: 0,
      Date: `/Date(${ms}${offStr})/`,
      Assignable: { Id: entityId },
    };
    const desc = (description || '').trim();
    if (desc) body.Description = desc;
    const resp = await this._post('Times', body);
    if (resp.Id == null) throw new Error(`Time entry not created: ${JSON.stringify(resp).slice(0, 200)}`);
    return resp.Id;
  }

  // --- helpers ---

  // Parse "/Date(ms±HHMM)/" -> "YYYY-MM-DD" using the EMBEDDED offset, so the app
  // buckets each entry into exactly the day TP shows it on.
  static tpDay(s) {
    if (!s) return null;
    const msMatch = s.match(/-?\d{10,}/);
    if (!msMatch) return null;
    const ms = Number(msMatch[0]);
    let offSec = 0;
    const offMatch = s.match(/[+-]\d{4}/);
    if (offMatch) {
      const o = offMatch[0];
      const sign = o[0] === '-' ? -1 : 1;
      offSec = sign * (Number(o.slice(1, 3)) * 3600 + Number(o.slice(3, 5)) * 60);
    }
    const shifted = new Date(ms + offSec * 1000);
    // Read the day in UTC (we already applied the offset).
    return shifted.toISOString().slice(0, 10);
  }
}

module.exports = { TPClient };
