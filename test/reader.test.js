'use strict';
// The reader: every fixture's verdict, unpack, list, and the edge cases.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const reader = require('../lib/reader');
const writer = require('../lib/writer');
const f = require('./fixtures/lib');
const { makeFixtures } = require('./fixtures/make-fixtures');

const FIX = path.join(__dirname, 'fixtures');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-package-reader-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const verdict = (zipPath, opts = f.READER_OPTS) => {
  try { reader.checkZip(zipPath, opts); return 'ok'; } catch (e) {
    if (e.name !== 'PackageError') throw e;
    return e.code;
  }
};

test('every fixture gets the verdict in expected.json', () => {
  const expected = JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8'));
  assert.strictEqual(Object.keys(expected).length, 12);
  for (const [name, want] of Object.entries(expected)) assert.strictEqual(verdict(path.join(FIX, name)), want, name);
});

test('the committed fixtures are what make-fixtures.js makes', () => {
  const out = path.join(tmp, 'regen');
  fs.mkdirSync(out);
  const expected = makeFixtures(out);
  assert.deepStrictEqual(expected, JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8')));
  for (const name of Object.keys(expected)) {
    // Contents, not zip bytes: zlib builds may compress differently.
    const a = f.readZip(path.join(FIX, name));
    const b = f.readZip(path.join(out, name));
    assert.deepStrictEqual([...a.keys()].sort(), [...b.keys()].sort(), name);
    for (const [k, v] of a) assert.ok(v.equals(b.get(k)), `${name}: ${k}`);
  }
});

test('reader options: allowUnsigned, the reader version, the trusted list', () => {
  assert.strictEqual(verdict(path.join(FIX, 'unsigned.zip'), { ...f.READER_OPTS, allowUnsigned: true }), 'ok');
  // allowUnsigned still checks a signature that is there.
  assert.strictEqual(verdict(path.join(FIX, 'bad-signature.zip'), { ...f.READER_OPTS, allowUnsigned: true }), 'signature');
  assert.strictEqual(verdict(path.join(FIX, 'good-closed-beta.zip'), { ...f.READER_OPTS, appVersion: '0.1.9' }), 'app-version');
  assert.strictEqual(verdict(path.join(FIX, 'good-closed-beta.zip'), { ...f.READER_OPTS, appVersion: '0.2.0' }), 'ok');
  assert.strictEqual(verdict(path.join(FIX, 'needs-newer-app.zip'), { trustedKeys: f.TRUSTED }), 'ok', 'no appVersion: not checked');
  // The shipped trusted-keys.json doesn't trust the test key.
  assert.strictEqual(verdict(path.join(FIX, 'good-closed-beta.zip'), { appVersion: '1.0.0' }), 'untrusted-key');
});

test('unpack: into <root>/<id>-<version>, .ok last; a failure leaves nothing', () => {
  const root = path.join(tmp, 'cache');
  const r = reader.unpack(path.join(FIX, 'good-closed-beta.zip'), root, f.READER_OPTS);
  assert.deepStrictEqual([r.id, r.version, r.maturity, r.key], ['fake-vr', '1.0.0', 'closed-beta', f.KEYS.trusted.id]);
  assert.strictEqual(r.dir, path.join(root, 'fake-vr-1.0.0'));
  for (const p of ['.ok', 'dvr-package.json', 'dvr-package.sig', 'mod.json', 'hover.webm', 'payload/winhttp.dll']) assert.ok(fs.existsSync(path.join(r.dir, p)), p);
  assert.ok(!fs.existsSync(path.join(r.dir, 'payload.json')) && !fs.existsSync(path.join(r.dir, 'build.json')));
  // The unpacked folder verifies again (the .ok marker is ours).
  assert.strictEqual(reader.verifyDir(r.dir, f.READER_OPTS).key, f.KEYS.trusted.id);
  assert.deepStrictEqual(reader.list(root).map((p) => [p.id, p.version, p.maturity]), [['fake-vr', '1.0.0', 'closed-beta']]);
  // Same version again replaces it.
  reader.unpack(path.join(FIX, 'good-stable.zip'), root, f.READER_OPTS);
  assert.deepStrictEqual(fs.readdirSync(root), ['fake-vr-1.0.0']);
  assert.strictEqual(reader.list(root)[0].maturity, 'stable');

  const expected = JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8'));
  for (const [name, want] of Object.entries(expected)) {
    if (want === 'ok') continue;
    const before = fs.readdirSync(root).join();
    assert.throws(() => reader.unpack(path.join(FIX, name), root, f.READER_OPTS), (e) => e.code === want, name);
    assert.strictEqual(fs.readdirSync(root).join(), before, `${name} left something behind`);
  }
  // The caller's check runs before the move and can refuse too.
  const r2 = path.join(tmp, 'cache2');
  assert.throws(() => reader.unpack(path.join(FIX, 'good-closed-beta.zip'), r2, { ...f.READER_OPTS, check: () => { throw new Error('nope'); } }), /nope/);
  assert.deepStrictEqual(fs.readdirSync(r2), []);
});

test('list skips folders without .ok, temp folders and mismatched names', () => {
  const root = path.join(tmp, 'listing');
  f.write(path.join(root, 'fake-vr-1.0.0', 'dvr-package.json'), JSON.stringify({ format: 1, id: 'fake-vr', version: '1.0.0' }));
  f.write(path.join(root, '.unpack-x', '.ok'), '');
  f.write(path.join(root, 'fake-vr-2.0.0', 'dvr-package.json'), JSON.stringify({ format: 1, id: 'fake-vr', version: '3.0.0' }));
  f.write(path.join(root, 'fake-vr-2.0.0', '.ok'), '');
  assert.deepStrictEqual(reader.list(root), []);
  assert.deepStrictEqual(reader.list(path.join(tmp, 'none')), []);
});

test('unsafe paths', () => {
  for (const p of ['../x', 'a/../../x', '/etc/x', '\\x', 'C:/x', 'c:x', 'a\\..\\x', 'a//b', './a', 'a/file.txt:stream', 'con.', 'a /b', 'a<b', 'a\u0001b']) {
    assert.ok(reader.unsafePath(p), JSON.stringify(p));
  }
  for (const p of ['mod.json', 'payload/BepInEx/core/a.dll', 'payload/', '.doorstop_version', 'é.txt']) assert.ok(!reader.unsafePath(p), p);
});

test('zip-level refusals: case-only twins, .ok, mismatched local names', () => {
  const good = path.join(FIX, 'good-closed-beta.zip');
  const make = (name, fn) => f.rewrap(good, path.join(tmp, name), fn);
  assert.strictEqual(verdict(make('twins.zip', (e) => e.set('PAYLOAD/WINHTTP.DLL', Buffer.from('x')))), 'unsafe-path');
  assert.strictEqual(verdict(make('ok.zip', (e) => e.set('.ok', Buffer.from('x')))), 'unsafe-path');
  assert.strictEqual(verdict(make('backslash.zip', (e) => e.set('payload\\..\\..\\x.txt', Buffer.from('x')))), 'unsafe-path');
  // A local header naming another file than the central directory says.
  const bytes = fs.readFileSync(good);
  const i = bytes.indexOf(Buffer.from('hover.webm'));
  const forged = Buffer.from(bytes);
  forged.write('../ver.webm', i, 'latin1'); // same length, local header only (the first match)
  fs.writeFileSync(path.join(tmp, 'forged.zip'), forged);
  assert.strictEqual(verdict(path.join(tmp, 'forged.zip')), 'unsafe-path');
});

test('manifest refusals are format, with the reason', () => {
  const good = path.join(FIX, 'good-closed-beta.zip');
  const cases = [
    [(m) => { m.maturity = 'beta'; }, /maturity/],
    [(m) => { delete m.maturity; m.channel = 'stable'; }, /maturity/],
    [(m) => { m.date = '2026-02-30'; }, /date/],
    [(m) => { m.version = '1.0.0-beta.1'; }, /version/],
    [(m) => { m.id = 'Fake'; }, /id/],
    [(m) => { m.appid = '4242'; }, /appid/],
    [(m) => { delete m.minAppVersion; }, /minAppVersion/],
    [(m) => { delete m.loader; }, /loader/],
    [(m) => { m.notes = 'two\nlines'; }, /notes/],
    [(m) => { m.testedBuildIds = ['abc']; }, /testedBuildIds/],
    [(m) => { delete m.source; }, /source/],
    [(m) => { m.source.coreRepo = 5; }, /source\.coreRepo/],
    [(m) => { m.format = 0; }, /format/],
    [(m) => { m.files['.ok'] = m.files['mod.json']; }, /own files/],
    [(m) => { m.files['payload/x'] = 'abc'; }, /SHA-256/],
    [(m) => { m.appid = 4243; }, /mod\.json says 4242/],
    [(m) => { m.loader.type = 'uevr'; }, /loader/],
  ];
  for (const [i, [change, re]] of cases.entries()) {
    const z = f.rewrap(good, path.join(tmp, `m${i}.zip`), (e) => f.editManifest(e, change));
    assert.throws(() => reader.checkZip(z, f.READER_OPTS), (e) => e.code === 'format' && re.test(e.message), `case ${i}: ${re}`);
  }
  // A listed path that's unsafe is unsafe-path, not format.
  const z = f.rewrap(good, path.join(tmp, 'mpath.zip'), (e) => f.editManifest(e, (m) => { m.files['../x'] = m.files['mod.json']; }));
  assert.strictEqual(verdict(z), 'unsafe-path');
  // SHA-256 compares case-insensitively.
  const lower = f.rewrap(good, path.join(tmp, 'lower.zip'), (e) => f.editManifest(e, (m) => {
    for (const k of Object.keys(m.files)) m.files[k] = m.files[k].toLowerCase();
  }));
  assert.strictEqual(verdict(lower), 'ok');
  // Unknown fields are ignored.
  const extra = f.rewrap(good, path.join(tmp, 'unknown-field.zip'), (e) => f.editManifest(e, (m) => { m.somethingNew = { a: 1 }; }));
  assert.strictEqual(verdict(extra), 'ok');
  // mod.json named as a payload outside the package.
  const out = f.makeMod(path.join(tmp, 'evil-mod'), { mod: { ...f.MOD_JSON, video: '../../elsewhere.webm' } });
  assert.throws(() => f.withKey('trusted', () => writer.pack(out, path.join(tmp, 'o'), f.RELEASE_OPTS)), (e) => e.code === 'unsafe-path');
});
