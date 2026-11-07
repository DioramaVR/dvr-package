'use strict';
// Versions, dates and ids (docs/SPEC.md section 2).

// Plain dotted numbers: "1.3.0", "2026.11.07"; never "1.3.0-beta.1".
const PLAIN_VERSION = /^\d{1,9}(\.\d{1,9}){0,3}$/;
const isPlainVersion = (v) => typeof v === 'string' && PLAIN_VERSION.test(v);

// "1.3.0" > "1.2.10"; "2026.11.1" == "2026.11.01". Numeric parts compare as
// numbers and missing parts count as 0. A pre-release suffix (accepted here
// for older data, never in a package) sorts before the plain version, and
// suffixes compare numeric-aware ("test.10" > "test.2"). Returns -1, 0 or 1.
function compareVersions(a, b) {
  const split = (v) => {
    const [main, ...pre] = String(v ?? '').split('-');
    return { main: main.split('.').map((n) => parseInt(n, 10) || 0), pre: pre.join('-') };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.main.length, y.main.length); i++) {
    const d = (x.main[i] || 0) - (y.main[i] || 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre.localeCompare(y.pre, 'en', { numeric: true }) < 0 ? -1 : 1;
}

// "YYYY-MM-DD" and a real day.
function isDate(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const [y, m, day] = d.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, day));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === day;
}

// Today in UTC, "YYYY-MM-DD".
const today = () => new Date().toISOString().slice(0, 10);

// Ids of games, waves, known issues: they become folder names, so plain characters.
const ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const isId = (v) => typeof v === 'string' && ID.test(v) && !v.includes('..');

module.exports = { PLAIN_VERSION, isPlainVersion, compareVersions, isDate, today, isId };
