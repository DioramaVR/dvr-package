'use strict';
// Makes the fixture zips in test/fixtures/ and expected.json (file -> "ok" or
// the error code a reader must report). Any reader of the format can run
// these zips and compare its verdicts.
//
//   node test/fixtures/make-fixtures.js [out folder]     (default: this folder)
//
// Verdicts assume the reader trusts only the TEST key in test-keys.json
// ("trusted"; never a real key) and is version 1.0.0. Every zip is made by
// the real writer and then changed in one way, so each fails for exactly one
// reason. Re-running gives the same contents (zips are deterministic).
const fs = require('fs');
const os = require('os');
const path = require('path');
const writer = require('../../lib/writer');
const f = require('./lib');

function makeFixtures(out = __dirname) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-fixtures-'));
  const expected = {};
  try {
    const mod = f.makeMod(path.join(work, 'fake-vr'));
    const packed = (name, opts) => {
      const r = f.withKey('trusted', () => writer.pack(mod, path.join(work, name), { ...f.RELEASE_OPTS, ...opts }));
      return r.zip;
    };
    const good = packed('cb', {});
    const save = (name, verdict, make) => {
      make(path.join(out, name));
      expected[name] = verdict;
    };

    save('good-closed-beta.zip', 'ok', (p) => fs.copyFileSync(good, p));
    save('good-stable.zip', 'ok', (p) => fs.copyFileSync(packed('st', { maturity: 'stable', notes: 'First stable release.' }), p));
    save('good-known-issues.zip', 'ok', (p) => fs.copyFileSync(packed('ki', { knownIssues: f.KNOWN_ISSUES }), p));
    save('unsigned.zip', 'unsigned', (p) => f.rewrap(good, p, (e) => e.delete('dvr-package.sig')));
    save('bad-signature.zip', 'signature', (p) => f.rewrap(good, p, (e) => {
      // A real signature, but over different bytes.
      e.set('dvr-package.sig', Buffer.from(f.sigLine('trusted', Buffer.from('something else\n'))));
    }));
    save('unknown-key.zip', 'untrusted-key', (p) => f.rewrap(good, p, (e) => f.editManifest(e, () => {}, 'unknown')));
    save('bad-hash.zip', 'hash', (p) => f.rewrap(good, p, (e) => e.set('payload/winhttp.dll', Buffer.from('changed after signing\n'))));
    save('extra-file.zip', 'extra-file', (p) => f.rewrap(good, p, (e) => e.set('payload/extra.dll', Buffer.from('not in the manifest\n'))));
    save('missing-file.zip', 'missing-file', (p) => f.rewrap(good, p, (e) => e.delete('payload/winhttp.dll')));
    save('unsafe-path.zip', 'unsafe-path', (p) => f.rewrap(good, p, (e) => e.set('../outside.txt', Buffer.from('escapes the folder\n'))));
    save('newer-format.zip', 'format', (p) => f.rewrap(good, p, (e) => f.editManifest(e, (m) => { m.format = 2; })));
    save('needs-newer-app.zip', 'app-version', (p) => f.rewrap(good, p, (e) => f.editManifest(e, (m) => { m.minAppVersion = '99.0.0'; })));
    save('not-a-mod.zip', 'not-a-mod', (p) => f.writeZip(p, new Map([['readme.txt', Buffer.from('just a zip\n')]])));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(out, 'expected.json'), JSON.stringify(expected, null, 2) + '\n');
  return expected;
}

// `node --test test/` runs every .js under test/ as a test file, this one
// included: it must not rewrite the fixtures while other tests read them.
if (require.main === module && !process.env.NODE_TEST_CONTEXT) {
  const out = path.resolve(process.argv[2] || __dirname);
  fs.mkdirSync(out, { recursive: true });
  const expected = makeFixtures(out);
  for (const [name, verdict] of Object.entries(expected)) console.log(`${name.padEnd(22)} ${verdict}`);
}

module.exports = { makeFixtures };
