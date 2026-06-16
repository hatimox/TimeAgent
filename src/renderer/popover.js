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

// Signed-in user (avatar + name) in the header; initials when no Gravatar.
async function showUser() {
  const u = await window.api.getUserInfo();
  if (!u || u.error || !u.id) { $('user').style.display = 'none'; return; }
  $('user').style.display = 'flex';
  $('userName').textContent = u.name || `user ${u.id}`;
  if (u.avatar) {
    $('userAvatar').src = u.avatar;
    $('userAvatar').style.display = '';
    $('userInitials').style.display = 'none';
  } else {
    const initials = (u.name || '?').split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
    $('userInitials').textContent = initials || '?';
    $('userInitials').style.display = 'inline-flex';
    $('userAvatar').style.display = 'none';
  }
}
showUser();

// Re-pull whenever the popover becomes visible or the main process pushes data.
window.addEventListener('focus', refresh);
window.api.onTotalsUpdated(() => refresh());
let meetingStart = 0, meetingTick = null;
function setMeeting(active, startedAt) {
  $('dot').classList.toggle('live', active);
  $('meetActions').style.display = active ? 'flex' : 'none';
  if (active) {
    // The "In meeting" text lives in the user block; make sure it's visible
    // even when there's no signed-in user to show.
    $('user').style.display = 'flex';
    meetingStart = startedAt || Date.now();
    tickMeeting();
    if (!meetingTick) meetingTick = setInterval(tickMeeting, 1000);
  } else {
    $('meeting').style.display = 'none';
    if (meetingTick) { clearInterval(meetingTick); meetingTick = null; }
  }
}

$('split').addEventListener('click', async () => {
  $('split').disabled = $('stopTrack').disabled = true;
  const res = await window.api.splitMeeting();
  $('split').disabled = $('stopTrack').disabled = false;
  if (!res || !res.ok) $('status').textContent = 'No active meeting to split';
});

$('stopTrack').addEventListener('click', async () => {
  $('split').disabled = $('stopTrack').disabled = true;
  const res = await window.api.stopTrackingMeeting();
  $('split').disabled = $('stopTrack').disabled = false;
  if (!res || !res.ok) $('status').textContent = 'No active meeting to stop';
});
function tickMeeting() {
  const s = Math.floor((Date.now() - meetingStart) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const t = h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`
                  : `${m}:${String(ss).padStart(2,'0')}`;
  $('meeting').textContent = `In meeting · ${t}`;
  $('meeting').style.display = 'inline';
}

window.api.onMeetingState((active, startedAt) => setMeeting(active, startedAt));
// On open, sync the current meeting state (so it shows mid-meeting).
window.api.getMeetingState().then((m) => { if (m.active) setMeeting(true, m.startedAt); });
window.api.getVersion().then((v) => { $('version').textContent = `TimeAgent v${v}`; });
refresh();
