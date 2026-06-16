'use strict';
const api = window.promptApi;
document.getElementById('title').textContent = api.title;
document.getElementById('label').textContent = api.label;
const input = document.getElementById('text');
const taskInput = document.getElementById('taskId');
const hasTask = api.taskId != null;
if (hasTask) {
  document.getElementById('taskRow').style.display = '';
  taskInput.value = api.taskId;
}
input.focus();

// Always return a structured result; the main process unwraps it for legacy callers.
function result(skipped) {
  const taskId = hasTask ? (parseInt(taskInput.value, 10) || Number(api.taskId)) : Number(api.taskId);
  return { description: skipped ? '' : input.value, taskId, skipped };
}
function done(skipped) { api.submit(result(skipped)); }

document.getElementById('save').addEventListener('click', () => done(false));
document.getElementById('skip').addEventListener('click', () => done(true));
for (const el of [input, taskInput]) {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') done(false);
    if (e.key === 'Escape') done(true);
  });
}
