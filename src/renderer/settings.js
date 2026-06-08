'use strict';
const $ = (id) => document.getElementById(id);
let recurring = [];

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
  recurring = Array.isArray(s.recurring) ? s.recurring.slice() : [];
  if (s.myUserId) $('whoami').textContent = `Signed in (user id ${s.myUserId})`;
  renderRecurring(); roundExample();
  window.api.getVersion().then((v) => { $('version').textContent = `TimeAgent v${v}`; });
}

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
    recurring: recurring.filter((r) => r.taskId),
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
