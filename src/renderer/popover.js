'use strict';
const $ = (id) => document.getElementById(id);
const fmtH = (h) => `${(Math.round(h * 100) / 100).toFixed(2)}h`;
let monthOffset = 0;

async function refresh() {
  const t = await window.api.getTotals(monthOffset);
  if (!t || t.error) { $('status').textContent = t && t.error ? t.error : 'Not configured'; return; }
  $('today').textContent = fmtH(t.today);
  $('week').textContent = fmtH(t.week);
  $('month').textContent = fmtH(t.month);
  $('monthLabel').textContent = t.monthLabel;
  $('nextMonth').disabled = monthOffset >= 0;
  $('status').textContent = t.updated ? `Updated ${t.updated}` : '';
}

$('prevMonth').addEventListener('click', () => { monthOffset--; refresh(); });
$('nextMonth').addEventListener('click', () => { if (monthOffset < 0) { monthOffset++; refresh(); } });
$('open').addEventListener('click', () => window.api.openMain());
$('settings').addEventListener('click', () => window.api.openSettings());
$('refresh').addEventListener('click', async () => { await window.api.forceRefresh(); refresh(); });
$('quit').addEventListener('click', () => window.api.quit());

// Re-pull whenever the popover becomes visible or the main process pushes data.
window.addEventListener('focus', refresh);
window.api.onTotalsUpdated(() => refresh());
window.api.onMeetingState((active) => {
  $('dot').classList.toggle('live', active);
  $('meeting').style.display = active ? 'inline' : 'none';
});
refresh();
