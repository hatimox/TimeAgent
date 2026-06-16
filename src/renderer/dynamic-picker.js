'use strict';
const api = window.dynamicApi;
const $ = (id) => document.getElementById(id);
const meetings = api.meetings || [];
let filtered = meetings.slice();
let activeIdx = -1;

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function render() {
  if (!filtered.length) {
    $('list').innerHTML = '<li class="empty">No meetings match.</li>';
    activeIdx = -1;
    return;
  }
  $('list').innerHTML = filtered.map((m, i) => `
    <li class="item ${i === 0 ? 'active' : ''}" data-i="${i}">
      <span class="name">${esc(m.name)}</span>
      <span class="meta">Task #${m.taskId}${m.description ? ' · ' + esc(m.description) : ''}</span>
    </li>`).join('');
  activeIdx = 0;
}

function filter() {
  const q = $('search').value.trim().toLowerCase();
  if (!q) filtered = meetings.slice();
  else {
    filtered = meetings.filter((m) =>
      (m.name || '').toLowerCase().includes(q) ||
      String(m.taskId).includes(q)
    );
  }
  render();
}

function submit(idx) {
  const m = filtered[idx];
  api.submit(m || null);
}

$('search').addEventListener('input', filter);
$('search').addEventListener('keydown', (e) => {
  const rows = [...$('list').querySelectorAll('.item')];
  if (e.key === 'ArrowDown' && rows.length) {
    e.preventDefault();
    activeIdx = Math.min(activeIdx + 1, rows.length - 1);
    rows.forEach((r, i) => r.classList.toggle('active', i === activeIdx));
    rows[activeIdx].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'ArrowUp' && rows.length) {
    e.preventDefault();
    activeIdx = Math.max(activeIdx - 1, 0);
    rows.forEach((r, i) => r.classList.toggle('active', i === activeIdx));
    rows[activeIdx].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    submit(activeIdx);
  } else if (e.key === 'Escape') {
    api.submit(null);
  }
});

$('list').addEventListener('click', (e) => {
  const li = e.target.closest('.item');
  if (li) submit(Number(li.dataset.i));
});

$('list').addEventListener('mouseover', (e) => {
  const li = e.target.closest('.item');
  if (li) {
    activeIdx = Number(li.dataset.i);
    $('list').querySelectorAll('.item').forEach((r, i) => r.classList.toggle('active', i === activeIdx));
  }
});

$('cancel').addEventListener('click', () => api.submit(null));

render();
$('search').focus();
