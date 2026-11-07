#!/usr/bin/env node
// Edits registry.json (docs/SPEC.md section 6). Every command changes only
// what it names, checks the result and writes the canonical form (LF).
//
//   dvr-registry check <registry.json>
//   dvr-registry set-game <registry.json> <id> [field=value ...] [--from-game <game.json>]
//   dvr-registry remove-game <registry.json> <id>
//   dvr-registry set-wave <registry.json> <id> [field=value ...]
//   dvr-registry remove-wave <registry.json> <id>
//   dvr-registry set-app <registry.json> field=value ...
//   dvr-registry add-app-release <registry.json> <release JSON or file> [--latest]
//   dvr-registry add-announcement <registry.json> <announcement JSON or file>
//   dvr-registry remove-announcement <registry.json> <id>
//   dvr-registry moved-to <registry.json> <url | null>
//
// field=value: appid is a number, closedBeta true or false, everything else
// text (so wave=1 stays the string "1"); field=null removes the field.
// --from-game copies name, game and appid from the game's game.json.
// Exit codes: 0 fine, 1 refused (the result would be invalid), 2 usage.
'use strict';
const fs = require('fs');
const reg = require('../lib/registry');

const usage = () => {
  console.error(fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => /^\/\/ {3}dvr-registry/.test(l)).map((l) => l.slice(3)).join('\n'));
  process.exit(2);
};
const die = (msg, code = 1) => { console.error(`dvr-registry: ${msg}`); process.exit(code); };
const readJson = (f) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch (e) { return die(`can't read ${f}: ${e.message}`, 2); }
};
const jsonArg = (s) => (s.trim().startsWith('{') ? JSON.parse(s) : readJson(s));

const TYPED = {
  appid: (v) => { const n = Number(v); if (!Number.isInteger(n)) die(`appid must be a whole number, not ${v}`, 2); return n; },
  closedBeta: (v) => { if (v !== 'true' && v !== 'false') die('closedBeta must be true or false', 2); return v === 'true'; },
};
function fieldsOf(pairs) {
  const out = {};
  for (const p of pairs) {
    const eq = p.indexOf('=');
    if (eq < 1) die(`expected field=value, got "${p}"`, 2);
    const k = p.slice(0, eq);
    const v = p.slice(eq + 1);
    // closedBeta=false removes it: the spec only knows "true" or absent.
    out[k] = v === 'null' ? null : TYPED[k] ? TYPED[k](v) : v;
    if (k === 'closedBeta' && out[k] === false) out[k] = null;
  }
  return out;
}

const argv = process.argv.slice(2);
const has = (f) => { const i = argv.indexOf(f); if (i < 0) return false; argv.splice(i, 1); return true; };
const take = (f) => { const i = argv.indexOf(f); if (i < 0) return null; const v = argv[i + 1]; if (v === undefined) die(`${f} needs a value`, 2); argv.splice(i, 2); return v; };
const latest = has('--latest');
const fromGame = take('--from-game');
const [cmd, file, ...rest] = argv;
if (!cmd || !file) usage();

if (cmd === 'check') {
  const doc = readJson(file);
  const ps = reg.checkRegistry(doc);
  if (ps.length) { console.error(`dvr-registry: ${file}: ${ps.length} problem(s)`); for (const p of ps) console.error(`  ${p.path}: ${p.message}`); process.exit(1); }
  console.log(`dvr-registry: ${file} is fine (${(doc.games || []).length} game(s), ${(doc.waves || []).length} wave(s))`);
  process.exit(0);
}

let doc;
try { doc = reg.read(file); } catch (e) { die(e.message); }
const edit = (fn) => { try { doc = fn(doc); } catch (e) { die(e.message); } };
const [id, ...pairs] = rest;

if (cmd === 'set-game') {
  if (!id) usage();
  const fields = fieldsOf(pairs);
  if (fromGame) {
    const g = readJson(fromGame);
    if (g.id !== id) die(`${fromGame} is for "${g.id}", not "${id}"`, 2);
    edit((d) => reg.syncGame(d, g, fields));
  } else edit((d) => reg.setGame(d, id, fields));
} else if (cmd === 'remove-game') {
  if (!id) usage();
  edit((d) => reg.removeGame(d, id));
} else if (cmd === 'set-wave') {
  if (!id) usage();
  edit((d) => reg.setWave(d, id, fieldsOf(pairs)));
} else if (cmd === 'remove-wave') {
  if (!id) usage();
  edit((d) => reg.removeWave(d, id));
} else if (cmd === 'set-app') {
  if (!rest.length) usage();
  edit((d) => reg.setApp(d, fieldsOf(rest)));
} else if (cmd === 'add-app-release') {
  if (!id) usage();
  edit((d) => reg.addAppRelease(d, jsonArg(id), { latest }));
} else if (cmd === 'add-announcement') {
  if (!id) usage();
  edit((d) => reg.addAnnouncement(d, jsonArg(id)));
} else if (cmd === 'remove-announcement') {
  if (!id) usage();
  edit((d) => reg.removeAnnouncement(d, id));
} else if (cmd === 'moved-to') {
  if (!id) usage();
  edit((d) => reg.setMovedTo(d, id === 'null' ? null : id));
} else usage();

reg.write(file, doc);
console.log(`dvr-registry: ${cmd} done -> ${file}`);
