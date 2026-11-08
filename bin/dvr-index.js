#!/usr/bin/env node
// A game's index.json and data (docs/SPEC.md sections 5 and 7).
//
//   dvr-index add <data dir> <previous index.json | -> <out> --entry <file or JSON> --url <zip url> [--notes <text>]
//   dvr-index promote <index.json> <version> <open-beta|stable>
//   dvr-index check <index.json>
//   dvr-index check-data <data dir>                      game.json + known-issues.json (+ media files)
//   dvr-index mod-json <data dir> <build.json> <out>     mod.json for the installer
//   dvr-index set-data <index.json> --url U --sha256 H --size N --date YYYY-MM-DD [--known-issues <data.json | known-issues.json>]
//                                                        the game's data zip (section 11), in place
//
// <data dir> is a game repo's data/ folder. "-" as the previous index means the
// game's first release. Output is canonical JSON with LF line ends.
// Exit codes: 0 fine, 1 the data or index has problems, 2 usage or unreadable files.
'use strict';
const fs = require('fs');
const path = require('path');
const ix = require('../lib/index-writer');
const mj = require('../lib/modjson');

const usage = () => {
  console.error(fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => /^\/\/ {3}dvr-index/.test(l)).map((l) => l.slice(3)).join('\n'));
  process.exit(2);
};
const readJson = (f) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch (e) { console.error(`dvr-index: can't read ${f}: ${e.message}`); process.exit(2); }
};
const flags = (argv) => {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      if (i + 1 >= argv.length) { console.error(`dvr-index: --${k} needs a value`); process.exit(2); }
      out[k] = argv[++i];
    } else out._.push(argv[i]);
  }
  return out;
};
const writeOut = (file, doc) => {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, ix.canonical(doc));
};
const problems = (label, ps) => {
  console.error(`dvr-index: ${label}: ${ps.length} problem(s)`);
  for (const p of ps) console.error(`  ${typeof p === 'string' ? p : `${p.path}: ${p.message}`}`);
  process.exit(1);
};
const attempt = (fn) => { try { return fn(); } catch (e) { console.error(`dvr-index: ${e.message}`); process.exit(1); } };

const [cmd, ...rest] = process.argv.slice(2);
const a = flags(rest);

if (cmd === 'add') {
  const [dataDir, prevFile, out] = a._;
  if (!dataDir || !prevFile || !out || !a.entry || !a.url) usage();
  const { game, issues } = mj.readGameData(dataDir);
  const entry = a.entry.trim().startsWith('{') ? JSON.parse(a.entry) : readJson(a.entry);
  const prev = prevFile === '-' ? {} : readJson(prevFile);
  const index = attempt(() => ix.addRelease({ game, issues, prev, entry, url: a.url, notes: a.notes }));
  writeOut(out, index);
  console.log(`dvr-index: ${game.id} ${entry.version} (${entry.maturity}) added; ${index.releases.length} release(s) listed -> ${out}`);
} else if (cmd === 'promote') {
  const [file, version, maturity] = a._;
  if (!file || !version || !maturity) usage();
  writeOut(file, attempt(() => ix.setMaturity(readJson(file), version, maturity)));
  console.log(`dvr-index: ${version} is now ${maturity} in ${file}`);
} else if (cmd === 'check') {
  const [file] = a._;
  if (!file) usage();
  const doc = readJson(file);
  const ps = ix.checkIndex(doc);
  if (ps.length) problems(file, ps);
  console.log(`dvr-index: ${file} is fine (${doc.releases.length} release(s))`);
} else if (cmd === 'check-data') {
  const [dataDir] = a._;
  if (!dataDir) usage();
  const { game, issues } = mj.readGameData(dataDir);
  const ps = mj.checkGameData(game, issues, { dataDir });
  if (ps.length) problems(dataDir, ps);
  console.log(`dvr-index: ${game.id}: game.json and known-issues.json are fine (${(game.controls || []).length} controls, ${game.tutorial.length} tutorial steps, ${game.media.length} media, ${issues.length} known issues)`);
} else if (cmd === 'mod-json') {
  const [dataDir, buildFile, out] = a._;
  if (!dataDir || !buildFile || !out) usage();
  const { game, issues } = mj.readGameData(dataDir);
  const ps = mj.checkGameData(game, issues, { dataDir });
  if (ps.length) problems(dataDir, ps);
  const mod = attempt(() => mj.toModJson(game, readJson(buildFile)));
  writeOut(out, mod);
  console.log(`dvr-index: mod.json for ${mod.id} -> ${out}${mod.video ? ` (copy data/${mod.video} next to it)` : ''}`);
} else if (cmd === 'set-data') {
  const [file] = a._;
  if (!file || a._.length !== 1 || !a.url || !a.sha256 || !a.size || !a.date) usage();
  if (!/^[0-9]+$/.test(a.size)) { console.error(`dvr-index: --size must be a whole number of bytes, not "${a.size}"`); process.exit(2); }
  let issues;
  if (a['known-issues']) {
    // A data.json (its knownIssues; none listed = none) or a known-issues.json (the list).
    const doc = readJson(a['known-issues']);
    issues = Array.isArray(doc) ? doc : doc && typeof doc === 'object' && doc.format !== undefined ? (doc.knownIssues || []) : null;
    if (!Array.isArray(issues)) { console.error(`dvr-index: ${a['known-issues']} is neither a data.json nor a known-issues.json`); process.exit(2); }
  }
  const data = { url: a.url, sha256: a.sha256, size: Number(a.size), date: a.date };
  writeOut(file, attempt(() => ix.setData(readJson(file), data, issues)));
  console.log(`dvr-index: ${file} data -> ${a.url} (${a.size} bytes, ${a.date})${issues ? `; ${issues.length} known issue(s)` : ''}`);
} else usage();
