'use strict';
document.getElementById('title').textContent = window.prompt.title;
document.getElementById('label').textContent = window.prompt.label;
const input = document.getElementById('text');
input.focus();
function done(v) { window.prompt.submit(v); }
document.getElementById('save').addEventListener('click', () => done(input.value));
document.getElementById('skip').addEventListener('click', () => done(''));
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') done(input.value);
  if (e.key === 'Escape') done('');
});
