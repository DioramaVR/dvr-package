#!/usr/bin/env node
'use strict';
// Checks a package zip as a reader would (docs/SPEC.md section 8, without
// the index step) and says the verdict: "ok" or an error code (section 9).
//
//   dvr-verify <zip> [--app-version V] [--trusted-keys FILE] [--allow-unsigned] [--json]
//
// --allow-unsigned is for development builds only. --json prints
// { ok, code?, message?, id?, version?, maturity?, key? }.
const { parse, die, trustedFrom } = require('./_cli');
const reader = require('../lib/reader');

const USAGE = 'usage: dvr-verify <zip> [--app-version V] [--trusted-keys FILE] [--allow-unsigned] [--json]';
const o = parse(process.argv.slice(2), ['--app-version', '--trusted-keys'], ['--allow-unsigned', '--json'], USAGE);
if (o._.length !== 1) die(2, USAGE);

let verdict;
try {
  const { manifest: m, key } = reader.checkZip(o._[0], {
    appVersion: o['app-version'], trustedKeys: trustedFrom(o['trusted-keys']), allowUnsigned: !!o['allow-unsigned'],
  });
  verdict = { ok: true, id: m.id, version: m.version, maturity: m.maturity, key };
} catch (e) {
  if (!(e && e.name === 'PackageError')) die(2, `error: ${e && e.message}`);
  verdict = { ok: false, code: e.code, message: e.message };
}
if (o.json) console.log(JSON.stringify(verdict));
else if (verdict.ok) console.log(`ok: ${verdict.id} ${verdict.version} (${verdict.maturity}), ${verdict.key ? `signed with key ${verdict.key}` : 'unsigned (allowed)'}`);
else console.error(`${verdict.code}: ${verdict.message}`);
process.exit(verdict.ok ? 0 : 1);
