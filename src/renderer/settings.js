'use strict';
const $ = (id) => document.getElementById(id);
let recurring = [];
let daysOff = [];
let weeklyOff = [0, 6];
let region = 'none';
// Religious holidays keyed by slot so edits stick: { "year|name|idx": {date, on} }
let religiousSlots = {};
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function renderWeekly() {
  $('weekly').innerHTML = WD.map((d, i) =>
    `<label class="checkbox" style="margin-right:8px">
       <input type="checkbox" class="wk" data-wd="${i}" ${weeklyOff.includes(i) ? 'checked' : ''}> ${d}
     </label>`).join('');
}

function renderDaysOff() {
  daysOff = [...new Set(daysOff)].sort();
  $('daysOffList').innerHTML = daysOff.length
    ? daysOff.map((d) => `<span class="pill" style="margin:3px 6px 3px 0; display:inline-flex; gap:6px; align-items:center">
        ${d} <a href="#" class="rmDay" data-d="${d}" style="text-decoration:none">✕</a></span>`).join('')
    : '<span class="hint">No specific days off.</span>';
}

// Show/hide the Morocco box, populate years, render the religious editor.
async function renderRegion() {
  $('region').value = region;
  $('moroccoBox').style.display = region === 'morocco' ? 'block' : 'none';
  if (region !== 'morocco') return;
  const thisYear = new Date().getFullYear();
  const data = await window.api.getMoroccoHolidays(thisYear);
  const years = (data.years && data.years.length) ? data.years : [thisYear];
  if (!$('holYear').options.length) {
    $('holYear').innerHTML = years.map((y) => `<option>${y}</option>`).join('');
    $('holYear').value = years.includes(thisYear) ? thisYear : years[0];
  }
  await renderFixed(); await renderReligious();
}

// Render the read-only fixed civil holidays list for the selected year.
async function renderFixed() {
  const year = Number($('holYear').value);
  const data = await window.api.getMoroccoHolidays(year);
  const fixed = data.fixedNamed || [];
  $('fixedList').innerHTML = fixed.map((h) =>
    `<div class="rec"><span style="flex:1">${h.name}</span>
       <span class="pill">${h.date}</span></div>`).join('');
}

// One editable row per religious holiday day for the selected year. Each row is
// identified by a stable slot key (year|name|idx), so an edited date/checkbox
// is remembered even though the date no longer matches the estimate.
async function renderReligious() {
  const year = Number($('holYear').value);
  const data = await window.api.getMoroccoHolidays(year);
  const rel = data.religious || {};
  const rows = [];
  for (const [name, dates] of Object.entries(rel)) {
    dates.forEach((estimate, i) => {
      const key = `${year}|${name}|${i}`;
      const saved = religiousSlots[key];
      const date = saved ? saved.date : estimate;     // keep user's edit
      const on = saved ? saved.on : true;             // default: on
      rows.push(`<div class="rec" data-key="${key}">
        <span style="flex:1">${name}${dates.length > 1 ? ' (day ' + (i + 1) + ')' : ''}</span>
        <input type="date" class="relDate" value="${date}">
        <label class="checkbox"><input type="checkbox" class="relOn" ${on ? 'checked' : ''}> off</label>
      </div>`);
    });
  }
  $('religiousList').innerHTML = rows.length ? rows.join('')
    : `<span class="hint">No religious-holiday estimates for ${year}. Add them via "Add a day off".</span>`;
}

// Read the rows currently shown and update religiousSlots by their slot keys.
function collectReligious() {
  $('religiousList').querySelectorAll('.rec').forEach((row) => {
    const key = row.dataset.key;
    if (!key) return;
    religiousSlots[key] = {
      date: row.querySelector('.relDate').value,
      on: row.querySelector('.relOn').checked,
    };
  });
}

function tzOptions() {
  const tzs = (Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [Intl.DateTimeFormat().resolvedOptions().timeZone]);
  $('timezone').innerHTML = tzs.map((t) => `<option>${t}</option>`).join('');
}

function renderRecurring() {
  $('recList').innerHTML = recurring.map((r, i) => `
    <div class="rec" data-i="${i}">
      <input class="lbl" placeholder="Label" value="${esc(r.label)}">
      <input class="num" type="number" placeholder="Task id" value="${r.taskId || ''}">
      <input class="hr" type="number" step="0.25" placeholder="hrs" value="${r.hours || ''}">
      <button class="del">✕</button>
    </div>`).join('');
}

function roundExample() {
  const mn = Math.max(0, Number($('meetingMinMinutes').value) || 0);
  const step = Math.max(1, Number($('meetingStepMinutes').value) || 1);
  const r = Math.max(mn, Math.ceil(35 / step) * step);
  $('roundHint').textContent = `Rounds UP: min ${mn} min, then ${step}-min steps. e.g. 35 min → ${r} min.`;
}

async function init() {
  tzOptions();
  const s = await window.api.getSettings();
  $('welcome').style.display = s.isConfigured ? 'none' : 'block';
  $('tpURL').value = s.tpURL || '';
  $('tpToken').value = s.tpToken || '';
  $('timezone').value = s.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  $('dailyTaskId').value = s.dailyTaskId || '';
  $('meetingsTaskId').value = s.meetingsTaskId || '';
  $('meetingMinMinutes').value = s.meetingMinMinutes ?? 30;
  $('meetingStepMinutes').value = s.meetingStepMinutes ?? 15;
  $('meetingProcs').value = s.meetingProcs || '';
  recurring = Array.isArray(s.recurring) ? s.recurring.slice() : [];
  daysOff = Array.isArray(s.daysOff) ? s.daysOff.slice() : [];
  weeklyOff = Array.isArray(s.weeklyOff) ? s.weeklyOff.slice() : [0, 6];
  region = s.region || 'none';
  religiousSlots = {};
  (Array.isArray(s.religiousSlots) ? s.religiousSlots : []).forEach((slot) => {
    if (slot && slot.key) religiousSlots[slot.key] = { date: slot.date, on: slot.on };
  });
  if (s.myUserId) $('whoami').textContent = `Signed in (user id ${s.myUserId})`;
  renderRecurring(); roundExample(); renderWeekly(); renderDaysOff();
  await renderRegion();
  window.api.getVersion().then((v) => { $('version').textContent = `TimeAgent v${v}`; });
}

// Tab switching.
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tabpane').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    const pane = document.querySelector(`.tabpane[data-pane="${tab.dataset.tab}"]`);
    if (pane) pane.classList.add('active');
  });
});

$('region').addEventListener('change', async () => { region = $('region').value; await renderRegion(); });
$('holYear').addEventListener('change', async () => { collectReligious(); await renderFixed(); await renderReligious(); });
$('religiousList').addEventListener('change', () => { collectReligious(); });

// Days-off interactions.
$('addDayOff').addEventListener('click', () => {
  const d = $('dayOffPicker').value;
  if (d) { daysOff.push(d); $('dayOffPicker').value = ''; renderDaysOff(); }
});
$('daysOffList').addEventListener('click', (e) => {
  const rm = e.target.closest('.rmDay');
  if (rm) { e.preventDefault(); daysOff = daysOff.filter((x) => x !== rm.dataset.d); renderDaysOff(); }
});
$('weekly').addEventListener('change', (e) => {
  if (e.target.classList.contains('wk')) {
    const wd = Number(e.target.dataset.wd);
    weeklyOff = e.target.checked ? [...new Set([...weeklyOff, wd])] : weeklyOff.filter((x) => x !== wd);
  }
});

$('recList').addEventListener('click', (e) => {
  if (e.target.classList.contains('del')) {
    recurring.splice(Number(e.target.closest('.rec').dataset.i), 1);
    renderRecurring();
  }
});
$('recList').addEventListener('input', (e) => {
  const row = e.target.closest('.rec'); if (!row) return;
  const i = Number(row.dataset.i);
  recurring[i] = {
    label: row.querySelector('.lbl').value,
    taskId: Number(row.querySelector('.num').value) || 0,
    hours: Number(row.querySelector('.hr').value) || 0,
  };
});
$('addRec').addEventListener('click', () => { recurring.push({ label: 'New entry', taskId: 0, hours: 1 }); renderRecurring(); });
['meetingMinMinutes', 'meetingStepMinutes'].forEach((id) => $(id).addEventListener('input', roundExample));

$('save').addEventListener('click', async () => {
  $('status').textContent = 'Saving…';
  const payload = {
    tpURL: $('tpURL').value.trim(),
    tpToken: $('tpToken').value.trim(),
    timezone: $('timezone').value,
    dailyTaskId: Number($('dailyTaskId').value) || 0,
    meetingsTaskId: Number($('meetingsTaskId').value) || 0,
    meetingMinMinutes: Number($('meetingMinMinutes').value) || 30,
    meetingStepMinutes: Number($('meetingStepMinutes').value) || 15,
    meetingProcs: $('meetingProcs').value.trim(),
    recurring: recurring.filter((r) => r.taskId),
    daysOff: [...new Set(daysOff)].sort(),
    weeklyOff: weeklyOff.slice().sort(),
    region,
    religiousSlots: (collectReligious(),
      Object.entries(religiousSlots).map(([key, v]) => ({ key, date: v.date, on: v.on }))),
  };
  const res = await window.api.saveSettings(payload);
  if (res.ok) {
    $('status').textContent = res.isConfigured ? 'Saved ✓' : 'Saved — but token/URL incomplete';
    const s2 = await window.api.getSettings();
    if (s2.myUserId) $('whoami').textContent = `Signed in (user id ${s2.myUserId})`;
  } else { $('status').textContent = 'Save failed'; }
});

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
init();
