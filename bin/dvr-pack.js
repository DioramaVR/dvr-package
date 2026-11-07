#!/usr/bin/env node
'use strict';
// Makes a package zip from a built mod folder (docs/SPEC.md section 3).
//
//   dvr-pack <mod folder> --min-app-version V [--out DIR] [--version V]
//            [--maturity closed-beta|open-beta|stable] [--date YYYY-MM-DD]
//            [--notes TEXT] [--actions-commit SHA] [--sign]
//            [--trusted-keys FILE] [--check]
//
// --maturity makes it a release: it must be a release build (payload.json
// release: true and a clean actionsCommit), built against a core tag, with
// licence notices and no Unity or game files, and it is signed with
// DVR_SIGNING_KEY. Without --maturity it's a dev pack (labelled closed-beta,
// unsigned unless --sign). --out defaults to the current folder.
// --check verifies the zip end to end, prints its path, size and SHA-256, and
// writes <out>/<id>-<version>.release.json (the index entry, less url).
const fs = require('fs');
const path = require('path');
const { parse, die, refuse, trustedFrom } = require('./_cli');
const writer = require('../lib/writer');

const USAGE = 'usage: dvr-pack <mod folder> --min-app-version V [--out DIR] [--version V] [--maturity closed-beta|open-beta|stable] [--date YYYY-MM-DD] [--notes TEXT] [--actions-commit SHA] [--sign] [--trusted-keys FILE] [--check]';
const o = parse(process.argv.slice(2),
  ['--out', '--version', '--maturity', '--date', '--min-app-version', '--notes', '--actions-commit', '--trusted-keys'],
  ['--sign', '--check'], USAGE);
const modDir = o._[0];
if (o._.length !== 1 || !fs.existsSync(path.join(modDir, 'mod.json'))) die(2, USAGE);
if (!o['min-app-version']) die(2, `--min-app-version is required\n${USAGE}`);
const outDir = o.out || '.';
const trustedKeys = trustedFrom(o['trusted-keys']);

let res;
try {
  res = writer.pack(path.resolve(modDir), outDir, {
    version: o.version, maturity: o.maturity, date: o.date, minAppVersion: o['min-app-version'],
    notes: o.notes, actionsCommit: o['actions-commit'], sign: !!o.sign, trustedKeys,
  });
} catch (e) { refuse(e); }
const { zip, manifest, key } = res;
console.log(`packed ${manifest.id} ${manifest.version} (${o.maturity ? manifest.maturity : 'dev pack, not a release'}, ${Object.keys(manifest.files).length} files, ${key ? `signed with key ${key}` : 'unsigned'})`);
if (!o.check) { console.log(zip); process.exit(0); }

try {
  writer.checkZip(zip, { trustedKeys, allowUnsigned: !key, appVersion: manifest.minAppVersion });
} catch (e) { console.error('check failed:'); refuse(e); }
const entry = writer.releaseEntry(manifest, zip);
const entryFile = path.join(outDir, `${manifest.id}-${manifest.version}.release.json`);
fs.writeFileSync(entryFile, JSON.stringify(entry, null, 2) + '\n');
console.log('checked: unpacks, signature and every file verified');
console.log(`zip:     ${zip}`);
console.log(`size:    ${entry.size} bytes`);
console.log(`sha256:  ${entry.sha256}`);
console.log(`release: ${entryFile}`);
