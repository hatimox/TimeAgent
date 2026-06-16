'use strict';
// Main window logic: load items + times, filter, log time, compute totals.

let ITEMS = [], TIMES = [], STATES = [], TZOFF = -new Date().getTimezoneOffset();
let SCOPE = 'current';    // 'current' = only the active sprint is fetched; 'all' = everything
let monthOffset = 0;
let activeTimer = null;   // { id, name, start: Date }
let tickHandle = null;

const $ = (id) => document.getElementById(id);
const fmtH = (h) => `${(Math.round(h * 100) / 100).toFixed(2)}h`;

// Start/Stop button HTML for a given item id (reflects the running timer).
function timerButton(id) {
  if (activeTimer && activeTimer.id === id) {
    return `<button class="timerBtn stop" data-tid="${id}">⏹ Stop &amp; Log <span class="elapsed">00:00:00</span></button>`;
  }
  return `<button class="timerBtn start" data-tid="${id}">▶ Start</button>`;
}

function elapsedString(ms) {
  const s = Math.floor(ms / 1000);
  return [s / 3600, (s % 3600) / 60, s % 60]
    .map((n) => String(Math.floor(n)).padStart(2, '0')).join(':');
}

function startTimer(id, name) {
  if (activeTimer) stopTimer(true);   // only one at a time; log the previous
  activeTimer = { id, name, start: new Date() };
  render();
  tickHandle = setInterval(() => {
    const el = document.querySelector(`.timerBtn.stop[data-tid="${activeTimer.id}"] .elapsed`);
    if (el) el.textContent = elapsedString(Date.now() - activeTimer.start.getTime());
  }, 1000);
}

async function stopTimer(silent) {
  if (!activeTimer) return;
  const t = activeTimer; activeTimer = null;
  clearInterval(tickHandle); tickHandle = null;
  const hours = Math.round((Date.now() - t.start.getTime()) / 36000) / 100; // ms->h, 2dp
  render();
  if (hours <= 0) { if (!silent) $('status').textContent = 'Too short — nothing logged'; return; }
  $('status').textContent = 'Logging…';
  const res = await window.api.logTime({
    entityId: t.id, hours, description: '',
    dateISO: new Date().toISOString().slice(0, 10) + 'T12:00:00',
  });
  if (res.error) { $('status').textContent = 'Log failed: ' + res.error; return; }
  $('status').textContent = `Logged ${fmtH(hours)} to “${t.name}”`;
  await load();
}

async function load() {
  $('status').textContent = 'Loading…';
  const res = await window.api.loadData({ scope: SCOPE });
  if (res.error === 'not-configured') { $('status').textContent = 'Open Settings to configure your TargetProcess token.'; return; }
  if (res.error) { $('status').textContent = 'Load failed: ' + res.error; return; }
  ITEMS = res.items; TIMES = res.times; STATES = res.states;
  if (typeof res.tzOffsetMinutes === 'number') TZOFF = res.tzOffsetMinutes;
  populateFilters();
  render();
  computeTotals();
  $('status').textContent = `Loaded ${ITEMS.length} items${SCOPE === 'current' ? ' (current sprint)' : ''}`;
}

function populateFilters() {
  const stateSel = $('stateFilter');
  const cur = stateSel.value;
  stateSel.innerHTML = '<option>All</option>' + STATES.map((s) => `<option>${esc(s)}</option>`).join('');
  if ([...stateSel.options].some((o) => o.value === cur)) stateSel.value = cur;

  const sprints = [...new Set(ITEMS.map((i) => i.sprint).filter(Boolean))]
    .sort((a, b) => (num(b) - num(a)) || a.localeCompare(b));
  const sprintSel = $('sprintFilter');
  const cs = sprintSel.value;
  let opts = '<option value="__current">Current sprint</option><option>All</option>'
    + sprints.map((s) => `<option>${esc(s)}</option>`).join('');
  if (ITEMS.some((i) => !i.sprint)) opts += '<option>(none)</option>';
  sprintSel.innerHTML = opts;
  if ([...sprintSel.options].some((o) => o.value === cs)) sprintSel.value = cs;
}
function num(s) { const m = String(s).match(/\d+/); return m ? Number(m[0]) : -1; }

function filtered() {
  const q = $('search').value.toLowerCase();
  const activeOnly = $('activeOnly').checked;
  const st = $('stateFilter').value;
  const sp = $('sprintFilter').value;
  const list = ITEMS.filter((it) => {
    if (activeOnly && it.isFinal) return false;
    if (st !== 'All' && it.stateName !== st) return false;
    if (sp === '(none)') { if (it.sprint) return false; }
    // '__current' needs no predicate: the fetch itself was sprint-scoped.
    else if (sp !== 'All' && sp !== '__current' && it.sprint !== sp) return false;
    if (q && !(it.name.toLowerCase().includes(q) || String(it.id).includes(q))) return false;
    return true;
  });
  return sortItems(list, $('sortBy') ? $('sortBy').value : 'name');
}

function sortItems(list, by) {
  const byName = (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  const arr = list.slice();
  switch (by) {
    case 'id-desc': arr.sort((a, b) => b.id - a.id); break;
    case 'id-asc': arr.sort((a, b) => a.id - b.id); break;
    case 'type': arr.sort((a, b) => a.displayType.localeCompare(b.displayType) || byName(a, b)); break;
    case 'state': arr.sort((a, b) => a.stateName.localeCompare(b.stateName) || byName(a, b)); break;
    case 'sprint': arr.sort((a, b) => (num(b.sprint) - num(a.sprint)) || byName(a, b)); break;
    case 'hours': arr.sort((a, b) => (myHours(b.id) - myHours(a.id)) || byName(a, b)); break;
    case 'name': default: arr.sort(byName);
  }
  return arr;
}

function myHours(id) {
  let s = 0; for (const t of TIMES) if (t.itemId === id) s += t.hours; return s;
}

function render() {
  const items = filtered();
  $('count').textContent = `${items.length} shown`;
  const today = new Date().toISOString().slice(0, 10);
  if (!items.length) {
    $('list').innerHTML = `<div class="empty">No items match your filters.</div>`;
    return;
  }
  $('list').innerHTML = items.map((it) => {
    const cls = it.entityType === 'Bugs' ? 'bug' : 'task';
    const accent = cls === 'bug' ? 'var(--bug)' : 'var(--task)';
    const mine = myHours(it.id);
    const mineHtml = mine > 0
      ? `<button type="button" class="mine mineBtn" data-mine-id="${it.id}" title="Click to view / edit time entries">${fmtH(mine)} ▾</button>`
      : '';
    const sprint = it.sprint ? `<span class="pill">${esc(it.sprint)}</span>` : '';
    return `<div class="row" data-id="${it.id}">
      <div class="top">
        <div class="accent" style="background:${accent}"></div>
        <div class="body">
          <div class="name ${cls}">${esc(it.name)}</div>
          <div class="meta">
            <span class="badge ${cls}">${it.displayType}</span>
            <a href="#" data-tp="${it.id}">#${it.id} ↗</a>
            ${it.usId ? `<a href="#" class="us-link" data-tp="${it.usId}" title="${esc(it.usName)}">US #${it.usId} ↗</a>` : ''}
            <button type="button" class="state stateBtn ${it.isFinal ? '' : 'active'}" data-state-id="${it.id}" title="Click to change status">${esc(it.stateName)} ▾</button>
            <span>${esc(it.projectName)}</span> ${sprint}
          </div>
        </div>
        ${mineHtml}
        ${timerButton(it.id)}
      </div>
      <div class="logrow">
        <input type="number" step="0.25" min="0" placeholder="hrs" class="hrs">
        <input type="date" class="date" value="${today}">
        <input type="text" placeholder="optional note" class="note">
        <button class="logBtn primary">Log</button>
      </div>
      <div class="slots" data-slots-id="${it.id}" style="display:none"></div>
    </div>`;
  }).join('');
}

// Swap a state chip for a <select> of that item's process states, then confirm
// + apply the chosen change (the confirmation dialog lives in the main process).
let stateEditorOpen = null;   // the <select> currently shown, if any
async function openStateEditor(btn) {
  if (stateEditorOpen) return;            // one at a time
  const id = Number(btn.dataset.stateId);
  const it = ITEMS.find((x) => x.id === id);
  if (!it) return;

  const prev = btn.textContent;
  btn.textContent = '…'; btn.disabled = true;
  const all = await window.api.getEntityStates(it.processId);
  btn.disabled = false; btn.textContent = prev;
  if (!all || all.error) { $('status').textContent = 'Could not load states' + (all && all.error ? ': ' + all.error : ''); return; }
  const states = (it.entityType === 'Bugs' ? all.Bug : all.Task) || [];
  if (!states.length) { $('status').textContent = 'No states available for this item'; return; }

  const sel = document.createElement('select');
  sel.className = 'state stateSel';
  sel.innerHTML = states.map((s) =>
    `<option value="${s.id}" ${s.id === it.stateId ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  btn.replaceWith(sel);
  stateEditorOpen = sel;
  sel.focus();

  let applying = false;     // suppress blur-restore while a change is in flight
  const restore = () => {
    const cur = ITEMS.find((x) => x.id === id) || it;
    const fresh = document.createElement('button');
    fresh.type = 'button';
    fresh.className = `state stateBtn ${cur.isFinal ? '' : 'active'}`;
    fresh.dataset.stateId = String(id);
    fresh.title = 'Click to change status';
    fresh.textContent = `${cur.stateName} ▾`;
    sel.replaceWith(fresh);
    stateEditorOpen = null;
  };

  sel.addEventListener('change', async () => {
    const stateId = Number(sel.value);
    const target = states.find((s) => s.id === stateId);
    if (!target || stateId === it.stateId) { restore(); return; }
    applying = true;
    sel.disabled = true; $('status').textContent = 'Changing status…';
    const res = await window.api.setEntityState({
      entityType: it.entityType, entityId: id, stateId,
      fromName: it.stateName, toName: target.name, itemName: it.name,
    });
    applying = false;
    if (res && res.ok) {
      it.stateId = stateId; it.stateName = res.stateName; it.isFinal = res.isFinal;
      $('status').textContent = `#${id} → ${res.stateName}`;
      stateEditorOpen = null;   // render() rebuilds the list, detaching sel
      render();   // re-render so "active only" / state filter reflect the change
    } else {
      if (res && res.error) $('status').textContent = 'Status change failed: ' + res.error;
      else $('status').textContent = 'Status change cancelled';
      restore();
    }
  });
  // Abandon the editor if it loses focus without a change (but not while the
  // confirmation dialog has stolen focus mid-apply).
  sel.addEventListener('blur', () => { if (stateEditorOpen === sel && !applying) restore(); });
}

// ---- editable per-task time breakdown ----
// Show/hide the slots panel under a row; lists each TP Time entry for the task
// (date, hours, description) with edit + delete, plus the total.
function toggleSlots(itemId) {
  const panel = document.querySelector(`.slots[data-slots-id="${itemId}"]`);
  if (!panel) return;
  if (panel.style.display !== 'none') { panel.style.display = 'none'; panel.innerHTML = ''; return; }
  renderSlots(itemId, panel);
  panel.style.display = 'block';
}

function renderSlots(itemId, panel) {
  const slots = TIMES.filter((t) => t.itemId === itemId)
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));   // newest first
  const total = slots.reduce((s, t) => s + t.hours, 0);
  if (!slots.length) { panel.innerHTML = `<div class="slotEmpty">No time entries.</div>`; return; }
  panel.innerHTML = `
    <div class="slotHead"><span>Time entries</span><span class="slotTotal">Total ${fmtH(total)}</span></div>
    ${slots.map((t) => `
      <div class="slot" data-time-id="${t.id}">
        <input type="date" class="sDate" value="${esc(t.day)}">
        <input type="number" step="0.25" min="0" class="sHrs" value="${t.hours}">
        <input type="text" class="sNote" placeholder="note" value="${esc(t.description)}">
        <button type="button" class="slotAct sSave primary" data-act="save" data-time-id="${t.id}">Save</button>
        <button type="button" class="slotAct sDel" data-act="delete" data-time-id="${t.id}">✕</button>
      </div>`).join('')}`;
}

async function handleSlotAction(btn) {
  const timeId = Number(btn.dataset.timeId);
  const slot = btn.closest('.slot');
  const row = btn.closest('.row');
  const itemId = Number(row.dataset.id);
  const act = btn.dataset.act;

  if (act === 'delete') {
    const it = ITEMS.find((x) => x.id === itemId);
    const hours = parseFloat(slot.querySelector('.sHrs').value.replace(',', '.'));
    const day = slot.querySelector('.sDate').value;
    slot.querySelectorAll('button,input').forEach((el) => (el.disabled = true));
    const res = await window.api.deleteTime({ timeId, day, hours, itemName: it ? it.name : '' });
    if (res.cancelled) { slot.querySelectorAll('button,input').forEach((el) => (el.disabled = false)); return; }
    if (res.error) { $('status').textContent = 'Delete failed: ' + res.error; slot.querySelectorAll('button,input').forEach((el) => (el.disabled = false)); return; }
    $('status').textContent = 'Time entry deleted';
    await reloadKeepingSlot(itemId);
    return;
  }

  // save
  const hours = parseFloat(slot.querySelector('.sHrs').value.replace(',', '.'));
  const date = slot.querySelector('.sDate').value;
  const note = slot.querySelector('.sNote').value;
  if (!(hours > 0)) { $('status').textContent = 'Hours must be > 0'; return; }
  slot.querySelectorAll('button,input').forEach((el) => (el.disabled = true));
  $('status').textContent = 'Saving…';
  const res = await window.api.updateTime({ timeId, hours, description: note, dateISO: date + 'T12:00:00' });
  if (res.error) { $('status').textContent = 'Save failed: ' + res.error; slot.querySelectorAll('button,input').forEach((el) => (el.disabled = false)); return; }
  $('status').textContent = 'Time entry updated';
  await reloadKeepingSlot(itemId);
}

// Reload data, then re-open the same task's slot panel so the edit context stays.
async function reloadKeepingSlot(itemId) {
  await load();
  // Re-open the panel only if the task still has time entries (otherwise the
  // ▾ toggle is gone and an empty panel would dangle).
  if (myHours(itemId) <= 0) return;
  const panel = document.querySelector(`.slots[data-slots-id="${itemId}"]`);
  if (panel) { renderSlots(itemId, panel); panel.style.display = 'block'; }
}

// Event delegation for the list (TP links + timer + log buttons).
$('list').addEventListener('click', async (e) => {
  const tp = e.target.closest('a[data-tp]');
  if (tp) { e.preventDefault(); const s = await window.api.getSettings(); window.api.openExternal(`${s.tpURL.replace(/\/+$/, '')}/entity/${tp.dataset.tp}`); return; }

  const timer = e.target.closest('.timerBtn');
  if (timer) {
    const id = Number(timer.dataset.tid);
    if (activeTimer && activeTimer.id === id) { await stopTimer(false); }
    else { const it = ITEMS.find((x) => x.id === id); startTimer(id, it ? it.name : `#${id}`); }
    return;
  }

  const stateBtn = e.target.closest('.stateBtn');
  if (stateBtn) { await openStateEditor(stateBtn); return; }

  const mineBtn = e.target.closest('.mineBtn');
  if (mineBtn) { toggleSlots(Number(mineBtn.dataset.mineId)); return; }

  // Edit/save/delete within an open time-slots panel.
  const slotAct = e.target.closest('.slotAct');
  if (slotAct) { await handleSlotAction(slotAct); return; }

  const btn = e.target.closest('.logBtn');
  if (btn) {
    const row = btn.closest('.row');
    const id = Number(row.dataset.id);
    const hrs = parseFloat(row.querySelector('.hrs').value.replace(',', '.'));
    const date = row.querySelector('.date').value;
    const note = row.querySelector('.note').value;
    if (!(hrs > 0)) { $('status').textContent = 'Enter hours > 0'; return; }
    btn.disabled = true; $('status').textContent = 'Logging…';
    const res = await window.api.logTime({ entityId: id, hours: hrs, description: note, dateISO: date + 'T12:00:00' });
    btn.disabled = false;
    if (res.error) { $('status').textContent = 'Log failed: ' + res.error; return; }
    row.querySelector('.hrs').value = ''; row.querySelector('.note').value = '';
    $('status').textContent = `Logged ${fmtH(hrs)} on ${date}`;
    await load();   // refresh totals
  }
});

// Totals (today / week / month) — bucket by day strings, like the Swift app.
function computeTotals() {
  const now = new Date();
  const todayStr = localDay(now, 0);
  const weekStart = localDay(now, -((now.getDay() + 6) % 7)); // Monday
  let today = 0, week = 0;
  for (const t of TIMES) {
    if (t.day === todayStr) today += t.hours;
    if (t.day >= weekStart) week += t.hours;
  }
  $('today').textContent = fmtH(today);
  $('week').textContent = fmtH(week);
  computeMonth();
}
function computeMonth() {
  const base = new Date(); base.setMonth(base.getMonth() + monthOffset);
  const prefix = `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}`;
  let sum = 0; for (const t of TIMES) if (t.day.startsWith(prefix)) sum += t.hours;
  $('month').textContent = fmtH(sum);
  $('monthLabel').textContent = base.toLocaleString(undefined, { month: 'long', year: 'numeric' });
  $('nextMonth').disabled = monthOffset >= 0;
}
function localDay(d, addDays) {
  const x = new Date(d); x.setDate(x.getDate() + addDays);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// Wire controls.
['search', 'activeOnly', 'stateFilter', 'sortBy'].forEach((id) =>
  $(id).addEventListener('input', render));
// The sprint filter drives the fetch scope: "Current sprint" keeps the cheap
// sprint-scoped query; anything else needs the full assignment list once.
$('sprintFilter').addEventListener('input', async () => {
  const want = $('sprintFilter').value === '__current' ? 'current' : 'all';
  if (want !== SCOPE) { SCOPE = want; await load(); return; }
  render();
});
$('refresh').addEventListener('click', load);
$('settings').addEventListener('click', () => window.api.openSettings());
$('prevMonth').addEventListener('click', () => { monthOffset--; computeMonth(); });
$('nextMonth').addEventListener('click', () => { if (monthOffset < 0) { monthOffset++; computeMonth(); } });

load();
