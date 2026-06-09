'use strict';
const api = window.promptApi;
document.getElementById('title').textContent = api.title;
document.getElementById('label').textContent = api.label;
const input = document.getElementById('text');
input.focus();
function done(v) { api.submit(v); }
document.getElementById('save').addEventListener('click', () => done(input.value));
document.getElementById('skip').addEventListener('click', () => done(''));
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') done(input.value);
  if (e.key === 'Escape') done('');
});
