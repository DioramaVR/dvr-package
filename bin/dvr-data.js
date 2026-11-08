#!/usr/bin/env node
// A game's data zip, <id>-data.zip (docs/SPEC.md section 11).
//
//   dvr-data check-source <data dir>                        game.json, known-issues.json and media/ as a data zip's source
//   dvr-data pack <data dir> <out dir> [--date YYYY-MM-DD]  makes <out dir>/<id>-data.zip; prints JSON { zip, sha256, size, date }
//   dvr-data check <zip> [--sha256 H --size N] [--id ID]    checks a data zip as a reader does
//
// <data dir> is a game repo's data/ folder. The zip's bytes don't depend on
// the day it's packed; --date (default today, UTC) is only printed, for the
// index's data.date. Warnings go to stderr.
// Exit codes: 0 fine, 1 refused ("<code>: <message>"), 2 usage.
'use strict';
const fs = require('fs');
const { parse, die, refuse } = require('./_cli');
const dataZip = require('../lib/datazip');

const usage = fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => /^\/\/ {3}dvr-data/.test(l)).map((l) => l.slice(3)).join('\n');
const [cmd, ...rest] = process.argv.slice(2);
const o = parse(rest, ['--date', '--sha256', '--size', '--id'], [], usage);
const warn = (ws) => { for (const w of ws) console.error(`dvr-data: warning: ${w}`); };
const only = (allowed) => { for (const k of ['date', 'sha256', 'size', 'id']) if (k in o && !allowed.includes(k)) die(2, `${cmd} doesn't take --${k}\n${usage}`); };

try {
  if (cmd === 'check-source') {
    only([]);
    if (o._.length !== 1) die(2, usage);
    const r = dataZip.checkSource(o._[0]);
    warn(r.warnings);
    console.log(`dvr-data: ${r.data.id}: the data is fine (${r.files.length} media file(s), ${(r.data.knownIssues || []).length} known issue(s))`);
  } else if (cmd === 'pack') {
    only(['date']);
    if (o._.length !== 2) die(2, usage);
    const r = dataZip.pack(o._[0], o._[1], o.date ? { date: o.date } : {});
    warn(r.warnings);
    console.log(JSON.stringify({ zip: r.zip, sha256: r.sha256, size: r.size, date: r.date }));
  } else if (cmd === 'check') {
    only(['sha256', 'size', 'id']);
    if (o._.length !== 1) die(2, usage);
    if (o.size !== undefined && !/^[0-9]+$/.test(o.size)) die(2, `--size must be a whole number of bytes\n${usage}`);
    const r = dataZip.read(o._[0], { sha256: o.sha256, size: o.size, id: o.id });
    console.log(`ok: ${r.data.id}, ${r.files.size - 1} media file(s)`);
  } else die(2, usage);
} catch (e) {
  refuse(e);
}
