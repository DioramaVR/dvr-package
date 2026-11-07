'use strict';
// Would a built file identify the person who built it? The tell is the home
// folder's path (C:\Users\<name>\...), which compilers and tools bake into
// DLLs, PDBs and logs. Checked with either slash, in any case, as UTF-8/ANSI
// and as UTF-16 (.NET keeps strings as UTF-16). Not the bare user name: as a
// word it matches ordinary text.
const fs = require('fs');
const os = require('os');
const path = require('path');

// The strings to look for, for a home folder (default: this machine's).
function privateNeedles(home = os.homedir()) {
  const rel = path.win32.resolve(home).replace(/^[A-Za-z]:/, '');
  const back = rel.replace(/\//g, '\\');
  const fwd = rel.replace(/\\/g, '/');
  return [...new Set([back, fwd])].filter((n) => n.length > 3).map((n) => n.toLowerCase());
}

// Which needle a buffer contains, or null.
function findInBuffer(buf, needles) {
  const texts = [buf.toString('latin1'), buf.toString('utf16le'), buf.subarray(1).toString('utf16le')].map((t) => t.toLowerCase());
  return needles.find((n) => texts.some((t) => t.includes(n))) || null;
}

// Files under dir (paths relative to it, forward slashes) that contain a
// needle. Returns [{ file, needle }].
function findPrivatePaths(dir, needles = privateNeedles()) {
  const hits = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(r); continue; }
      if (!e.isFile()) continue;
      const needle = findInBuffer(fs.readFileSync(path.join(dir, r)), needles);
      if (needle) hits.push({ file: r, needle });
    }
  };
  if (fs.existsSync(dir)) walk('');
  return hits;
}

module.exports = { privateNeedles, findInBuffer, findPrivatePaths };
