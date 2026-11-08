#!/usr/bin/env node
// A game's media in the assets repo (docs/SPEC.md section 12).
//
//   dvr-assets check <game folder>                     media.json and media/: names, types, sizes, metadata
//   dvr-assets build <game folder> --release assets-N --base-url U --date YYYY-MM-DD [--out assets.json]
//                                                      the index's assets list, written to --out (default ./assets.json)
//
// <game folder> is <assets repo>/<id>: media.json plus media/. Each file's
// URL is <base-url>/<file name>. Metadata is flagged, never stripped: strip
// the file and commit it again. build refuses on any problem check reports,
// and prints the files to upload as JSON: [{ name, path }].
// Exit codes: 0 fine, 1 problems ("<code>: <path>: <message>" each), 2 usage.
'use strict';
const fs = require('fs');
const path = require('path');
const { parse, die, refuse } = require('./_cli');
const gameAssets = require('../lib/game-assets');

const usage = fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => /^\/\/ {3}dvr-assets/.test(l)).map((l) => l.slice(3)).join('\n');
const [cmd, ...rest] = process.argv.slice(2);
const o = parse(rest, ['--release', '--base-url', '--date', '--out'], [], usage);

try {
  if (cmd === 'check') {
    if (o._.length !== 1 || Object.keys(o).length !== 1) die(2, usage);
    const r = gameAssets.check(o._[0]);
    for (const p of r.problems) console.error(`${p.code}: ${p.path}: ${p.message}`);
    if (r.problems.length) die(1, `dvr-assets: ${r.id || o._[0]}: ${r.problems.length} problem(s)`);
    const bytes = r.files.reduce((n, f) => n + f.size, 0);
    console.log(`dvr-assets: ${r.id}: fine (${r.media.length} media, ${r.files.length} file(s), ${bytes} bytes)`);
  } else if (cmd === 'build') {
    if (o._.length !== 1 || !o.release || !o['base-url'] || !o.date) die(2, usage);
    let r;
    try { r = gameAssets.build(o._[0], { release: o.release, baseUrl: o['base-url'], date: o.date }); } catch (e) {
      if (e.name !== 'PackageError') die(2, `dvr-assets: ${e.message}\n${usage}`);
      throw e;
    }
    const out = o.out || 'assets.json';
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(r.assets, null, 2) + '\n');
    console.error(`dvr-assets: ${o.release}: ${r.files.length} file(s) -> ${out}`);
    console.log(JSON.stringify(r.files));
  } else die(2, usage);
} catch (e) {
  refuse(e);
}
