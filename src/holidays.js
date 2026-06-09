'use strict';
// Moroccan public holidays.
//   - FIXED civil holidays: same date every year (computed for any year).
//   - RELIGIOUS holidays: lunar, shift each year. We ship best-known estimates
//     per year; the user can confirm/adjust them in Settings (they are
//     moon-sighting dependent and may move +/-1 day).

// Fixed civil holidays as [month, day, name] (1-based month).
const FIXED = [
  [1, 1, "New Year's Day"],
  [1, 11, 'Proclamation of Independence'],
  [1, 14, 'Amazigh New Year'],
  [5, 1, 'Labour Day'],
  [7, 30, 'Throne Day'],
  [8, 14, 'Oued Ed-Dahab Day'],
  [8, 20, 'Revolution Day'],
  [8, 21, 'Youth Day'],
  [11, 6, 'Green March Day'],
  [11, 18, 'Independence Day'],
];

// Religious holiday ESTIMATES by year (YYYY-MM-DD). Moon-sighting dependent.
// Each Eid spans 2 days; single-day holidays are one entry.
const RELIGIOUS = {
  2026: {
    'Eid al-Fitr': ['2026-03-20', '2026-03-21'],
    'Eid al-Adha': ['2026-05-26', '2026-05-27'],
    'Islamic New Year': ['2026-06-16'],
    "Prophet's Birthday": ['2026-08-25', '2026-08-26'],
  },
  2027: {
    'Eid al-Fitr': ['2027-03-09', '2027-03-10', '2027-03-11'],
    'Eid al-Adha': ['2027-05-16', '2027-05-17'],
    'Islamic New Year': ['2027-06-06'],
    "Prophet's Birthday": ['2027-08-15'],
  },
  2028: {
    'Eid al-Fitr': ['2028-02-26', '2028-02-27'],
    'Eid al-Adha': ['2028-05-05', '2028-05-06'],
    'Islamic New Year': ['2028-05-25'],
    "Prophet's Birthday": ['2028-08-03'],
  },
};

function pad(n) { return String(n).padStart(2, '0'); }

// Fixed civil holiday dates (YYYY-MM-DD) for a given year.
function fixedHolidays(year) {
  return FIXED.map(([m, d]) => `${year}-${pad(m)}-${pad(d)}`);
}

// Fixed civil holidays with names: [{ date, name }] for a given year.
function fixedHolidaysNamed(year) {
  return FIXED.map(([m, d, name]) => ({ date: `${year}-${pad(m)}-${pad(d)}`, name }));
}

// Religious holiday estimates for a year: { name: [dates...] }. Empty if unknown.
function religiousHolidays(year) {
  return RELIGIOUS[year] || {};
}

// All known years we have religious estimates for.
function religiousYears() {
  return Object.keys(RELIGIOUS).map(Number).sort();
}

module.exports = { fixedHolidays, fixedHolidaysNamed, religiousHolidays, religiousYears };
