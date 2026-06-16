'use strict';
const api = window.promptApi;
const $ = (id) => document.getElementById(id);
$('title').textContent = api.title;
$('label').textContent = api.label;

const input = $('text');
const hasTask = api.taskId != null;
const defaultId = hasTask ? (Number(api.taskId) || 0) : Number(api.taskId);
const readOnlyTask = api.readOnlyTask;
input.value = api.defaultDescription || '';

const search = $('taskSearch');
const results = $('results');
const chosenEl = $('chosen');

let TASKS = [];               // [{id, name, type}]
let chosenId = defaultId || 0;
let activeIdx = -1;           // highlighted result row (keyboard nav)
let dirty = false;            // input is being typed into (search mode), not
                              // showing a committed selection label

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// The label shown in the input once a task is chosen.
function labelFor(id) {
  const t = TASKS.find((x) => x.id === id);
  return t ? `#${t.id} — ${t.name}` : `#${id}`;
}

// Small confirmation line under the input.
function showChosen() {
  if (!chosenId) { chosenEl.textContent = ''; return; }
  chosenEl.innerHTML = `Time will be logged to <b>#${chosenId}</b>.`;
}

function closeResults() { results.classList.remove('open'); results.innerHTML = ''; activeIdx = -1; }

function renderResults(list) {
  if (!list.length) {
    const q = search.value.trim();
    const asId = /^\d+$/.test(q);
    results.innerHTML = asId
      ? `<li class="result" data-id="${q}"><span class="tid">#${q}</span><span class="tname">Use task #${q} directly</span></li>`
      : `<div class="empty">No matching active tasks.</div>`;
    results.classList.add('open');
    activeIdx = asId ? 0 : -1;
    if (asId) results.querySelector('.result').classList.add('active');
    return;
  }
  results.innerHTML = list.map((t, i) => `
    <li class="result ${i === 0 ? 'active' : ''}" data-id="${t.id}">
      <span class="tbadge ${t.type === 'Bug' ? 'bug' : 'task'}">${t.type === 'Bug' ? 'Bug' : 'Task'}</span>
      <span class="tname">${esc(t.name)}</span>
      <span class="tid">#${t.id}</span>
    </li>`).join('');
  results.classList.add('open');
  activeIdx = 0;
}

// Show matches for the current query — or the FULL list when the query is
// empty (so focusing the input reveals everything immediately).
function filter() {
  const q = dirty ? search.value.trim().toLowerCase() : '';
  const list = !q
    ? TASKS.slice(0, 50)
    : TASKS.filter((t) => t.name.toLowerCase().includes(q) || String(t.id).includes(q)).slice(0, 50);
  renderResults(list);
}

function choose(id) {
  chosenId = Number(id) || 0;
  closeResults();
  dirty = false;
  search.value = labelFor(chosenId);   // show the selection IN the input
  showChosen();
  search.blur();
}

if (hasTask) {
  $('taskRow').style.display = '';
  showChosen();

  if (readOnlyTask) {
    // Task is locked to the caller's choice; hide the search UI.
    search.style.display = 'none';
    chosenEl.innerHTML += ' <span class="pill">locked</span>';
  } else {
    if (chosenId) search.value = labelFor(chosenId);   // may refine once TASKS load
    api.getActiveTasks().then((res) => {
      if (res && Array.isArray(res.items)) {
        TASKS = res.items;
        if (chosenId && !dirty) search.value = labelFor(chosenId);
      }
    }).catch(() => {});

    search.addEventListener('input', () => { dirty = true; filter(); });
    // Focus: reveal the list. Select the current label so typing replaces it.
    search.addEventListener('focus', () => { dirty = false; search.select(); filter(); });
    search.addEventListener('blur', () => {
      // Restore the chosen label if the user focused but didn't pick anything.
      setTimeout(() => { if (!results.classList.contains('open') && !dirty && chosenId) search.value = labelFor(chosenId); }, 120);
    });
    search.addEventListener('keydown', (e) => {
      const rows = [...results.querySelectorAll('.result')];
      if (e.key === 'ArrowDown' && rows.length) {
        e.preventDefault(); activeIdx = Math.min(activeIdx + 1, rows.length - 1);
        rows.forEach((r, i) => r.classList.toggle('active', i === activeIdx));
        rows[activeIdx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp' && rows.length) {
        e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0);
        rows.forEach((r, i) => r.classList.toggle('active', i === activeIdx));
        rows[activeIdx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        if (results.classList.contains('open') && rows[activeIdx]) {
          e.preventDefault(); choose(rows[activeIdx].dataset.id);
        } else { done(false); }
      } else if (e.key === 'Escape') {
        if (results.classList.contains('open')) { e.preventDefault(); closeResults(); }
        else done(true);
      }
    });
    results.addEventListener('click', (e) => {
      const li = e.target.closest('.result');
      if (li) choose(li.dataset.id);
    });
  }
}

input.focus();

function done(skipped) {
  // If the user typed a raw id and didn't pick a row, honor it. Only when the
  // input is in search mode (dirty) — otherwise it holds the "#id — name" label.
  let id = chosenId;
  if (hasTask && dirty && /^\d+$/.test(search.value.trim())) id = Number(search.value.trim());
  api.submit({ description: skipped ? '' : input.value, taskId: id || defaultId, skipped });
}
$('save').addEventListener('click', () => done(false));
$('skip').addEventListener('click', () => done(true));
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') done(false);
  if (e.key === 'Escape') done(true);
});
