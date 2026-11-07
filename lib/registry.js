// registry.json (docs/SPEC.md section 6): read, edit, check and write it in
// the canonical form. Every edit changes only the fields it names; anything
// else in the file (unknown fields included) stays exactly as it was, so a
// re-signed registry differs from the last one only where it was edited.
//
//   const reg = require('./registry');
//   let doc = reg.read('registry.json');
//   doc = reg.setGame(doc, 'fake-vr', { status: 'open-beta', index: 'https://example.org/fake-vr/index.json' });
//   reg.write('registry.json', doc);
//
// Edits return a new document (the input isn't changed) and refuse to produce
// an invalid one. A field set to null is removed.
'use strict';
const fs = require('fs');
const path = require('path');
const { validate } = require('./schemas');
// Registry versions are plain dotted numbers (the schema checks), so this needs
// none of lib/version.js's pre-release handling.
function compareVersions(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
  return 0;
}

const canonical = (doc) => JSON.stringify(doc, null, 2) + '\n';
const fail = (msg) => { const e = new Error(msg); e.code = 'registry'; throw e; };
const copy = (doc) => JSON.parse(JSON.stringify(doc));

// Problems with a registry: the schema, then ids used once, waves that exist,
// installer versions listed once and newest first, announcement dates in order.
function checkRegistry(doc) {
  const problems = validate(doc, 'registry');
  const add = (p, message) => problems.push({ path: p, message });
  const list = (v) => (Array.isArray(v) ? v : []);
  const unique = (items, where) => {
    const seen = new Set();
    items.forEach((x, i) => {
      if (typeof x?.id !== 'string') return;
      if (seen.has(x.id)) add(`/${where}/${i}/id`, `id "${x.id}" is used twice`);
      seen.add(x.id);
    });
    return seen;
  };
  unique(list(doc?.games), 'games');
  unique(list(doc?.announcements), 'announcements');
  const waves = unique(list(doc?.waves), 'waves');
  if (Array.isArray(doc?.waves)) {
    list(doc?.games).forEach((g, i) => {
      if (typeof g?.wave === 'string' && !waves.has(g.wave)) add(`/games/${i}/wave`, `wave "${g.wave}" isn't in waves`);
    });
  }
  const rel = list(doc?.app?.releases);
  rel.forEach((r, i) => {
    if (i && typeof r?.version === 'string' && typeof rel[i - 1]?.version === 'string' && compareVersions(r.version, rel[i - 1].version) >= 0) {
      add(`/app/releases/${i}/version`, `${r.version} is listed after ${rel[i - 1].version}: newest first, each once`);
    }
  });
  list(doc?.announcements).forEach((a, i) => {
    if (typeof a?.from === 'string' && typeof a?.until === 'string' && a.until < a.from) add(`/announcements/${i}/until`, 'is before from');
  });
  return problems;
}

function assertValid(doc, what) {
  const bad = checkRegistry(doc);
  if (bad.length) fail(`${what}:\n  ${bad.map((p) => `${p.path}: ${p.message}`).join('\n  ')}`);
  return doc;
}

function read(file) {
  return assertValid(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')), file);
}

// Canonical, LF, written through a temp file so a half-written registry never exists.
function write(file, doc) {
  assertValid(doc, 'registry');
  const tmp = path.join(path.dirname(path.resolve(file)), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, canonical(doc));
  fs.renameSync(tmp, file);
}

// Sets the named fields on obj (null removes one); keys keep their order, new
// ones go at the end.
function setFields(obj, fields) {
  for (const [k, v] of Object.entries(fields)) {
    if (v === null) delete obj[k];
    else obj[k] = v;
  }
  return obj;
}

// A game: changes the named fields, or adds the game at the end when it's
// new (then id, name, game, appid and status are needed).
function setGame(doc, id, fields) {
  const next = copy(doc);
  next.games ||= [];
  const g = next.games.find((x) => x.id === id);
  if (g) setFields(g, fields);
  else next.games.push(setFields({ id }, fields));
  return assertValid(next, `game ${id}`);
}

function removeGame(doc, id) {
  const next = copy(doc);
  const n = (next.games || []).length;
  next.games = (next.games || []).filter((g) => g.id !== id);
  if (next.games.length === n) fail(`no game "${id}"`);
  return assertValid(next, `without ${id}`);
}

// A game's name, game and appid from its game.json (the one source for them).
function syncGame(doc, game, fields = {}) {
  return setGame(doc, game.id, { name: game.name, game: game.game, appid: game.appid, ...fields });
}

// A wave: changes the named fields, or adds it at the end (id, name, status).
function setWave(doc, id, fields) {
  const next = copy(doc);
  next.waves ||= [];
  const w = next.waves.find((x) => x.id === id);
  if (w) setFields(w, fields);
  else next.waves.push(setFields({ id }, fields));
  return assertValid(next, `wave ${id}`);
}

function removeWave(doc, id) {
  const next = copy(doc);
  const n = (next.waves || []).length;
  next.waves = (next.waves || []).filter((w) => w.id !== id);
  if (next.waves.length === n) fail(`no wave "${id}"`);
  return assertValid(next, `without wave ${id}`);
}

// app's own fields (latest, url).
function setApp(doc, fields) {
  if ('releases' in fields) fail('use addAppRelease for app.releases');
  const next = copy(doc);
  next.app = setFields(next.app || {}, fields);
  return assertValid(next, 'app');
}

// A new installer version, first in app.releases (newest first). latest: true
// also points app.latest at it; otherwise app.latest isn't touched.
function addAppRelease(doc, release, { latest = false } = {}) {
  const next = copy(doc);
  next.app ||= {};
  next.app.releases ||= [];
  if (next.app.releases.some((r) => r.version === release.version)) fail(`installer ${release.version} is already listed`);
  next.app.releases.unshift(release);
  if (latest) next.app.latest = release.version;
  return assertValid(next, `installer ${release.version}`);
}

function addAnnouncement(doc, a) {
  const next = copy(doc);
  next.announcements ||= [];
  if (next.announcements.some((x) => x.id === a.id)) fail(`announcement "${a.id}" already exists`);
  next.announcements.push(a);
  return assertValid(next, `announcement ${a.id}`);
}

function removeAnnouncement(doc, id) {
  const next = copy(doc);
  const n = (next.announcements || []).length;
  next.announcements = (next.announcements || []).filter((a) => a.id !== id);
  if (next.announcements.length === n) fail(`no announcement "${id}"`);
  return assertValid(next, `without announcement ${id}`);
}

function setMovedTo(doc, url) {
  const next = copy(doc);
  next.movedTo = url;
  return assertValid(next, 'movedTo');
}

module.exports = {
  read, write, canonical, checkRegistry,
  setGame, removeGame, syncGame, setWave, removeWave, setApp, addAppRelease, addAnnouncement, removeAnnouncement, setMovedTo,
};
