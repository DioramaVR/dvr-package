'use strict';
// The writer: the manifest exactly as docs/SPEC.md section 3 has it, release
// refusals, signing, determinism, releaseEntry; licences; the CLIs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const writer = require('../lib/writer');
const reader = require('../lib/reader');
const licenses = require('../lib/licenses');
const f = require('./fixtures/lib');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-package-writer-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const out = (name) => path.join(tmp, `out-${name}`);
const packRelease = (dir, name, opts = {}) => f.withKey('trusted', () => writer.pack(dir, out(name), { ...f.RELEASE_OPTS, ...opts }));

test('a release pack: the manifest in section 3 order, signed, verifiable', () => {
  const dir = f.makeMod(path.join(tmp, 'mod'));
  const { zip, manifest, key } = packRelease(dir, 'ok', { notes: 'First closed beta.' });
  assert.strictEqual(path.basename(zip), 'fake-vr-1.0.0.zip');
  assert.strictEqual(key, f.KEYS.trusted.id);
  assert.deepStrictEqual(Object.keys(manifest), [
    'format', 'id', 'version', 'maturity', 'date', 'coreVersion', 'appid', 'minAppVersion', 'loader',
    'testedBuildIds', 'notes', 'source', 'files',
  ]);
  const { files, ...rest } = manifest;
  assert.deepStrictEqual(rest, {
    format: 1, id: 'fake-vr', version: '1.0.0', maturity: 'closed-beta', date: '2026-11-20', coreVersion: '0.1.1',
    appid: 4242, minAppVersion: '0.2.0', loader: { type: 'bepinex5-mono', version: '5.4.23' },
    testedBuildIds: ['123456'], notes: 'First closed beta.',
    source: { commit: 'a1b2c3d', coreRepo: 'example/fake-core', coreCommit: 'e4f5a6b', coreFrom: 'tag v0.1.1', actionsCommit: 'c7d8e9f', builtAt: '2026-11-20T10:00:00Z' },
  });
  assert.deepStrictEqual(Object.keys(files), [
    'hover.webm', 'mod.json', 'payload/BepInEx/core/BepInEx.dll', 'payload/BepInEx/plugins/FakeVr/FakeVr.dll',
    'payload/licenses/README.txt', 'payload/winhttp.dll',
  ]);
  for (const h of Object.values(files)) assert.match(h, /^[0-9A-F]{64}$/);
  // The zip: sorted entries, the manifest bytes canonical, the signature one LF-terminated line over them.
  const entries = f.readZip(zip);
  assert.deepStrictEqual([...entries.keys()], ['dvr-package.json', 'dvr-package.sig', ...Object.keys(files)].sort());
  assert.strictEqual(entries.get('dvr-package.json').toString(), JSON.stringify(manifest, null, 2) + '\n');
  assert.match(entries.get('dvr-package.sig').toString(), /^\{"key":"[0-9a-f]{16}","sig":"[^"]+"\}\n$/);
  assert.strictEqual(reader.checkZip(zip, f.READER_OPTS).key, f.KEYS.trusted.id);
  // No payload.json, build.json in the zip; dvr-package.json's receipt replaces payload.json.
  assert.ok(!entries.has('payload.json') && !entries.has('build.json'));
});

test('the same input gives the same zip; another date gives another', () => {
  const dir = f.makeMod(path.join(tmp, 'det'));
  const a = fs.readFileSync(packRelease(dir, 'det1').zip);
  // Touch every file: timestamps on disk don't reach the zip.
  const later = new Date('2030-01-01T00:00:00Z');
  for (const p of ['mod.json', 'hover.webm', 'payload/winhttp.dll']) fs.utimesSync(path.join(dir, p), later, later);
  const b = fs.readFileSync(packRelease(dir, 'det2').zip);
  assert.ok(a.equals(b));
  const c = fs.readFileSync(packRelease(dir, 'det3', { date: '2026-11-21' }).zip);
  assert.ok(!a.equals(c));
});

test('release refusals, each with its code; a dev pack of the same folder still packs', () => {
  const info = (over) => ({ info: { ...f.RELEASE_INFO, ...over } });
  const cases = [
    ['not-release-build', info({ release: undefined })],
    ['not-release-build', info({ actionsCommit: 'c7d8e9f+dirty' })],
    ['not-release-build', info({ actionsCommit: undefined })],
    ['not-release-build', info({ actionsCommit: 'main' })],
    ['core-not-tagged', info({ coreFrom: 'HEAD (no tag v0.1.1)' })],
    ['core-not-tagged', info({ coreFrom: 'tag v0.1.0' })],
    ['core-not-tagged', info({ coreVersion: undefined, coreFrom: 'HEAD (mod names no DvrCoreVersion)' })],
    ['no-licences', { change: (d) => fs.rmSync(path.join(d, 'payload', 'licenses'), { recursive: true }) }],
    ['unity-files', { change: (d) => f.write(path.join(d, 'payload', 'BepInEx', 'unity-libs', 'x.dll'), 'u') }],
    ['unity-files', { change: (d) => f.write(path.join(d, 'payload', 'BepInEx', 'interop', 'UnityEngine.CoreModule.dll'), 'u') }],
    ['unity-files', { change: (d) => f.write(path.join(d, 'payload', 'Assembly-CSharp-firstpass.dll'), 'u') }],
  ];
  for (const [i, [code, opts]] of cases.entries()) {
    const dir = f.makeMod(path.join(tmp, `ref${i}`), opts);
    assert.throws(() => packRelease(dir, `ref${i}`), (e) => e.code === code, `case ${i}: ${code}`);
    assert.ok(!fs.existsSync(out(`ref${i}`)), `case ${i}: nothing written`);
    writer.pack(dir, out(`ref${i}-dev`), { version: '1.0.0', minAppVersion: '0.2.0', date: '2026-11-20' });
  }
  // A mod without the core needs no core tag.
  const noCore = { commit: 'a1b2c3d', actionsCommit: 'c7d8e9f', release: true, builtAt: '2026-11-20T10:00:00Z' };
  const m = packRelease(f.makeMod(path.join(tmp, 'nocore'), { info: noCore }), 'nocore').manifest;
  assert.ok(!('coreVersion' in m) && !('notes' in m));
  assert.deepStrictEqual(m.source, { commit: 'a1b2c3d', actionsCommit: 'c7d8e9f', builtAt: '2026-11-20T10:00:00Z' });
  // Every problem is reported, not just the first.
  const many = f.makeMod(path.join(tmp, 'many'), { info: { ...f.RELEASE_INFO, release: false }, change: (d) => fs.rmSync(path.join(d, 'payload', 'licenses'), { recursive: true }) });
  assert.throws(() => packRelease(many, 'many'), (e) => e.code === 'not-release-build' && e.details.length === 2 && /licenses/.test(e.message));
  assert.throws(() => packRelease(f.makeMod(path.join(tmp, 'mat')), 'mat', { maturity: 'beta' }), (e) => e.code === 'format');
});

test('signing: a release needs DVR_SIGNING_KEY and a trusted key; a dev pack is unsigned unless asked', () => {
  const dir = f.makeMod(path.join(tmp, 'sig'));
  const was = process.env.DVR_SIGNING_KEY;
  delete process.env.DVR_SIGNING_KEY;
  try {
    assert.throws(() => writer.pack(dir, out('sig-none'), f.RELEASE_OPTS), (e) => e.code === 'unsigned' && /DVR_SIGNING_KEY/.test(e.message));
    const dev = writer.pack(dir, out('sig-dev'), { version: '1.0.0', minAppVersion: '0.2.0', date: '2026-11-20' });
    assert.strictEqual(dev.key, null);
    assert.strictEqual(dev.manifest.maturity, 'closed-beta');
    assert.ok(!f.readZip(dev.zip).has('dvr-package.sig'));
    assert.throws(() => reader.checkZip(dev.zip, f.READER_OPTS), (e) => e.code === 'unsigned');
    assert.strictEqual(reader.checkZip(dev.zip, { ...f.READER_OPTS, allowUnsigned: true }).key, null);
  } finally {
    if (was !== undefined) process.env.DVR_SIGNING_KEY = was;
  }
  // The wrong key in the secret: refused before anything is written.
  assert.throws(() => f.withKey('unknown', () => writer.pack(dir, out('sig-wrong'), f.RELEASE_OPTS)), (e) => e.code === 'untrusted-key');
  assert.ok(!fs.existsSync(out('sig-wrong')));
  const signedDev = f.withKey('trusted', () => writer.pack(dir, out('sig-dev2'), { version: '1.0.0', minAppVersion: '0.2.0', date: '2026-11-20', sign: true, trustedKeys: f.TRUSTED }));
  assert.strictEqual(signedDev.key, f.KEYS.trusted.id);
});

test('private-path: a home-folder path anywhere in the package stops every pack', () => {
  const needles = ['\\users\\tester', '/users/tester'];
  const dir = f.makeMod(path.join(tmp, 'priv'), {
    change: (d) => f.write(path.join(d, 'payload', 'BepInEx', 'plugins', 'FakeVr', 'FakeVr.dll'), Buffer.from('C:\\Users\\Tester\\src\\FakeVr.pdb', 'utf16le')),
  });
  assert.throws(() => packRelease(dir, 'priv', { needles }), (e) => e.code === 'private-path' && /FakeVr\.dll/.test(e.message));
  assert.throws(() => writer.pack(dir, out('priv-dev'), { version: '1.0.0', minAppVersion: '0.2.0', needles }), (e) => e.code === 'private-path');
  const clean = f.makeMod(path.join(tmp, 'clean'));
  assert.ok(packRelease(clean, 'clean', { needles }).zip);
});

test('releaseEntry: the index fields of section 5, less url', () => {
  const { zip, manifest } = packRelease(f.makeMod(path.join(tmp, 'entry')), 'entry', { maturity: 'stable', notes: 'One line.' });
  const e = writer.releaseEntry(manifest, zip);
  assert.deepStrictEqual(Object.keys(e), ['version', 'maturity', 'date', 'coreVersion', 'minAppVersion', 'testedBuildIds', 'notes', 'sha256', 'size', 'source']);
  assert.strictEqual(e.sha256, reader.sha256File(zip));
  assert.strictEqual(e.size, fs.statSync(zip).size);
  assert.deepStrictEqual(e.source, manifest.source);
});

test('licences: notices for what ships; refuses uncovered, never-shipped and changed pinned files', () => {
  const data = path.join(tmp, 'licdata');
  f.write(path.join(data, 'MIT.txt'), 'MIT licence text\nline two\n');
  f.write(path.join(data, 'LGPL.txt'), 'LGPL text\n');
  const components = {
    title: 'Fake Game VR', notice: 'An unofficial fan mod (test data).',
    components: [
      { id: 'fake-vr', name: 'Fake Game VR', mod: true, license: 'MIT', copyright: 'scrire', source: 'https://example.org/fake-vr', text: 'MIT.txt', files: ['BepInEx/plugins/FakeVr/**'] },
      { id: 'loader', name: 'Fake Loader', version: '5.4.23', license: 'LGPL-2.1', copyright: 'Someone', source: 'https://example.org/loader', text: 'LGPL.txt', lgpl: 'Source: https://example.org/loader/src', files: ['BepInEx/core/*', 'winhttp.dll'], pin: ['winhttp.dll'] },
      { id: 'unused', name: 'Not Shipped', version: '1', license: 'MIT', copyright: 'x', source: 'https://example.org', text: 'MIT.txt', files: ['nothing/**'] },
    ],
    neverShipped: ['BepInEx/unity-libs/**', '**/UnityEngine*.dll', '**/Assembly-CSharp*'],
  };
  f.write(path.join(data, 'components.json'), JSON.stringify(components, null, 2) + '\n');
  const payload = path.join(f.makeMod(path.join(tmp, 'lic')), 'payload');
  fs.rmSync(path.join(payload, 'licenses'), { recursive: true });

  assert.throws(() => licenses.writeNotices(payload, { data, version: '1.0.0' }), (e) => e.code === 'no-licences' && /not pinned yet/.test(e.details.join()));
  const pinned = licenses.writeNotices(payload, { data, version: '1.0.0', pin: true });
  assert.strictEqual(pinned.pinned, 1);
  const r = licenses.writeNotices(payload, { data, version: '1.0.0' });
  assert.deepStrictEqual([r.components, r.files], [2, 3]);
  const readme = fs.readFileSync(path.join(payload, 'licenses', 'README.txt'), 'utf8');
  assert.match(readme, /^Licences for Fake Game VR 1\.0\.0\r\n/);
  assert.match(readme, /An unofficial fan mod/);
  assert.ok(!readme.includes('Not Shipped'));
  const mod = fs.readFileSync(path.join(payload, 'licenses', 'fake-vr.txt'), 'utf8');
  assert.match(mod, /Version: {3}1\.0\.0\r\n/);
  assert.match(mod, /MIT licence text\r\nline two\r\n$/);
  assert.match(fs.readFileSync(path.join(payload, 'licenses', 'loader.txt'), 'utf8'), /Source: https:\/\/example\.org\/loader\/src/);
  // The licences folder is ours: rewriting it leaves nothing stale.
  assert.deepStrictEqual(fs.readdirSync(path.join(payload, 'licenses')).sort(), ['README.txt', 'fake-vr.txt', 'loader.txt']);

  f.write(path.join(payload, 'stray.dll'), 'x');
  assert.throws(() => licenses.writeNotices(payload, { data }), (e) => e.code === 'no-licences' && /stray\.dll: not covered/.test(e.details.join()));
  fs.rmSync(path.join(payload, 'stray.dll'));
  f.write(path.join(payload, 'winhttp.dll'), 'a new version');
  assert.throws(() => licenses.writeNotices(payload, { data }), (e) => e.code === 'no-licences' && /changed since its licence was checked/.test(e.details.join()));
  licenses.writeNotices(payload, { data, pin: true });
  f.write(path.join(payload, 'BepInEx', 'unity-libs', 'UnityEngine.dll'), 'u');
  assert.throws(() => licenses.writeNotices(payload, { data }), (e) => e.code === 'unity-files');
  const w = licenses.writeNotices(payload, { data, allowUnityLibs: true });
  assert.match(w.warnings.join(), /1 files in BepInEx\/unity-libs/);
  assert.throws(() => licenses.writeNotices(payload, {}), /data folder/);
});

test('CLIs: dvr-pack --check, dvr-verify, dvr-sign, exit codes', () => {
  const trustedFile = path.join(tmp, 'trusted.json');
  fs.writeFileSync(trustedFile, JSON.stringify(f.TRUSTED) + '\n');
  const bin = (name) => path.join(__dirname, '..', 'bin', `${name}.js`);
  const run = (name, args, env = {}) => {
    try {
      return { status: 0, stdout: execFileSync(process.execPath, [bin(name), ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...env } }) };
    } catch (e) { return { status: e.status, stdout: e.stdout, stderr: e.stderr }; }
  };
  const key = { DVR_SIGNING_KEY: f.KEYS.trusted.pkcs8 };
  const dir = f.makeMod(path.join(tmp, 'cli'));
  const o = path.join(tmp, 'cli-out');
  const r = run('dvr-pack', [dir, '--out', o, '--maturity', 'closed-beta', '--version', '1.0.0', '--min-app-version', '0.2.0',
    '--date', '2026-11-20', '--notes', 'First closed beta.', '--trusted-keys', trustedFile, '--check'], key);
  assert.strictEqual(r.status, 0, r.stderr);
  const zipPath = path.join(o, 'fake-vr-1.0.0.zip');
  assert.ok(r.stdout.includes(reader.sha256File(zipPath)));
  const entry = JSON.parse(fs.readFileSync(path.join(o, 'fake-vr-1.0.0.release.json'), 'utf8'));
  assert.strictEqual(entry.sha256, reader.sha256File(zipPath));
  assert.strictEqual(fs.readFileSync(path.join(o, 'fake-vr-1.0.0.release.json'), 'utf8').endsWith('}\n'), true);
  assert.ok(!r.stdout.includes(f.KEYS.trusted.pkcs8) && !(r.stderr || '').includes(f.KEYS.trusted.pkcs8), 'the key is never printed');

  // Refusals exit 1 with the code; usage exits 2.
  const bad = f.makeMod(path.join(tmp, 'cli-bad'), { info: { ...f.RELEASE_INFO, release: undefined } });
  const rb = run('dvr-pack', [bad, '--out', path.join(tmp, 'cli-bad-out'), '--maturity', 'closed-beta', '--min-app-version', '0.2.0', '--trusted-keys', trustedFile], key);
  assert.strictEqual(rb.status, 1);
  assert.match(rb.stderr, /^not-release-build: /);
  assert.strictEqual(run('dvr-pack', [dir]).status, 2);
  assert.strictEqual(run('dvr-pack', [dir, '--min-app-version', '0.2.0', '--channel', 'stable']).status, 2);

  const v = run('dvr-verify', [zipPath, '--trusted-keys', trustedFile, '--app-version', '1.0.0', '--json']);
  assert.deepStrictEqual(JSON.parse(v.stdout), { ok: true, id: 'fake-vr', version: '1.0.0', maturity: 'closed-beta', key: f.KEYS.trusted.id });
  const v2 = run('dvr-verify', [path.join(__dirname, 'fixtures', 'bad-hash.zip'), '--trusted-keys', trustedFile, '--json']);
  assert.strictEqual(v2.status, 1);
  assert.strictEqual(JSON.parse(v2.stdout).code, 'hash');
  assert.strictEqual(run('dvr-verify', [zipPath]).status, 1, 'the shipped list does not trust the test key');

  const idx = path.join(tmp, 'index.json');
  fs.writeFileSync(idx, '{\n  "format": 1\n}\n');
  assert.strictEqual(run('dvr-sign', ['sign', idx, '--trusted-keys', trustedFile], key).status, 0);
  assert.strictEqual(run('dvr-sign', ['verify', idx, '--trusted-keys', trustedFile]).status, 0);
  assert.strictEqual(run('dvr-sign', ['keyid'], key).stdout.trim(), f.KEYS.trusted.id);
  fs.appendFileSync(idx, ' ');
  assert.strictEqual(run('dvr-sign', ['verify', idx, '--trusted-keys', trustedFile]).status, 1);
  assert.strictEqual(run('dvr-sign', ['keyid'], { DVR_SIGNING_KEY: '' }).status, 2);
  assert.strictEqual(run('dvr-sign', ['frobnicate']).status, 2);

  assert.strictEqual(run('dvr-licenses', [path.join(dir, 'payload')]).status, 2, '--data is required');
});

test('the public index: exports load lazily; w2 parts may be missing on this branch', () => {
  const api = require('../lib');
  assert.strictEqual(api.FORMAT, 1);
  for (const k of ['reader', 'writer', 'sign', 'licenses', 'privacy', 'version', 'zip', 'errors']) assert.ok(api[k], k);
  assert.strictEqual(api.PackageError, require('../lib/errors').PackageError);
  assert.deepStrictEqual(Object.keys(api).sort(), ['FORMAT', 'PackageError', 'errors', 'index', 'licenses', 'modJson', 'privacy', 'reader', 'registry', 'schemas', 'sign', 'version', 'writer', 'zip']);
});
