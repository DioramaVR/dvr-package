'use strict';
// version, zip, sign, privacy, errors.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const version = require('../lib/version');
const zip = require('../lib/zip');
const sign = require('../lib/sign');
const privacy = require('../lib/privacy');
const { PackageError, CODES } = require('../lib/errors');
const f = require('./fixtures/lib');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-package-basics-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('versions, dates and ids', () => {
  const c = version.compareVersions;
  assert.strictEqual(c('1.3.0', '1.2.10'), 1);
  assert.strictEqual(c('2026.11.1', '2026.11.01'), 0);
  assert.strictEqual(c('0.1', '0.1.0'), 0);
  assert.strictEqual(c('0.2.0', '0.10.0'), -1);
  assert.strictEqual(c('1.0.0-beta', '1.0.0'), -1);
  assert.strictEqual(c('1.0.0-test.10', '1.0.0-test.2'), 1);
  for (const v of ['1', '1.3.0', '2026.11.07', '1.2.3.4']) assert.ok(version.isPlainVersion(v), v);
  for (const v of ['1.3.0-beta.1', 'v1.0', '1..2', '', '1.2.3.4.5', 1]) assert.ok(!version.isPlainVersion(v), String(v));
  for (const d of ['2026-11-20', '2024-02-29']) assert.ok(version.isDate(d), d);
  for (const d of ['2026-02-30', '2025-02-29', '2026-1-01', '20261120', '2026-13-01', null]) assert.ok(!version.isDate(d), String(d));
  assert.ok(version.isDate(version.today()));
  for (const id of ['fake-vr', 'a', 'tpm.vr', '1']) assert.ok(version.isId(id), id);
  for (const id of ['Fake', '-a', '.a', 'a..b', 'a/b', 'a'.repeat(65), '']) assert.ok(!version.isId(id), id);
});

test('PackageError carries a known code', () => {
  const e = new PackageError('hash', 'x', ['a']);
  assert.ok(e instanceof Error);
  assert.deepStrictEqual([e.name, e.code, e.details], ['PackageError', 'hash', ['a']]);
  assert.throws(() => new PackageError('nope', 'x'), /unknown PackageError code/);
  assert.strictEqual(CODES.length, 15);
});

test('zip: sorted entries, fixed timestamps, same input gives the same bytes; tar reads it', () => {
  const entries = [
    { name: 'b/z.txt', data: 'zzz\n' },
    { name: 'a.txt', data: 'a'.repeat(1000) }, // deflated
    { name: 'b/é.txt', data: 'utf-8 name\n' },
    { name: 'tiny', data: 'x' }, // stored: deflate would be bigger
  ];
  const z1 = zip.create(path.join(tmp, 'one.zip'), entries, { date: '2026-11-20' });
  const z2 = zip.create(path.join(tmp, 'two.zip'), [...entries].reverse(), { date: '2026-11-20' });
  assert.deepStrictEqual(fs.readFileSync(z1), fs.readFileSync(z2));
  const z3 = zip.create(path.join(tmp, 'three.zip'), entries, { date: '2026-11-21' });
  assert.notDeepStrictEqual(fs.readFileSync(z1), fs.readFileSync(z3));
  assert.deepStrictEqual(zip.list(z1), ['a.txt', 'b/z.txt', 'b/é.txt', 'tiny']);
  const out = path.join(tmp, 'out');
  fs.mkdirSync(out);
  zip.extract(z1, out);
  assert.strictEqual(fs.readFileSync(path.join(out, 'a.txt'), 'utf8'), 'a'.repeat(1000));
  assert.strictEqual(fs.readFileSync(path.join(out, 'b', 'é.txt'), 'utf8'), 'utf-8 name\n');
  assert.strictEqual(zip.readEntry(z1, 'tiny').toString(), 'x');
  // Every timestamp is the date (tar reports it in local time, so compare the day).
  const mtime = fs.statSync(path.join(out, 'tiny')).mtime;
  assert.strictEqual(`${mtime.getFullYear()}-${String(mtime.getMonth() + 1).padStart(2, '0')}-${String(mtime.getDate()).padStart(2, '0')}`, '2026-11-20');
  assert.throws(() => zip.create(path.join(tmp, 'x.zip'), entries, {}), /YYYY-MM-DD/);
  assert.throws(() => zip.create(path.join(tmp, 'x.zip'), [entries[0], entries[0]], { date: '2026-11-20' }), /twice/);
  assert.ok(!fs.readdirSync(tmp).some((n) => n.endsWith('.tmp')));
  // Not a zip.
  fs.writeFileSync(path.join(tmp, 'text.zip'), 'plain text');
  assert.throws(() => zip.list(path.join(tmp, 'text.zip')), (e) => e.code === 'not-a-mod');
});

test('sign: key ids, sign and verify, untrusted, tampered, wrong key in the secret', () => {
  // The shipped trusted key's id is its own SPKI's.
  const shipped = JSON.parse(fs.readFileSync(sign.TRUSTED_FILE, 'utf8'));
  assert.ok(Array.isArray(shipped) && shipped.length >= 1);
  assert.deepStrictEqual([...sign.trustedKeys().keys()], shipped.map((k) => k.id));
  assert.strictEqual(sign.keyId(Buffer.from(f.KEYS.trusted.spki, 'base64')), f.KEYS.trusted.id);
  // The older { keys: [...] } shape reads the same.
  assert.deepStrictEqual([...sign.trustedKeys({ keys: f.TRUSTED }).keys()], [f.KEYS.trusted.id]);
  assert.throws(() => sign.trustedKeys([{ id: '0000000000000000', spki: f.KEYS.trusted.spki }]), /doesn't match its own key/);

  const bytes = Buffer.from('{"a":1}\n');
  const line = f.withKey('trusted', () => sign.signBytes(bytes, { trustedKeys: f.TRUSTED }));
  assert.match(line, /^\{"key":"[0-9a-f]{16}","sig":"[A-Za-z0-9+/=]+"\}\n$/);
  assert.strictEqual(sign.verify(bytes, line, f.TRUSTED), f.KEYS.trusted.id);
  assert.throws(() => sign.verify(Buffer.from('{"a":2}\n'), line, f.TRUSTED), (e) => e.code === 'signature');
  assert.throws(() => sign.verify(bytes, 'not json', f.TRUSTED), (e) => e.code === 'signature');
  assert.throws(() => sign.verify(bytes, '{"key":"x"}', f.TRUSTED), (e) => e.code === 'signature');
  assert.throws(() => sign.verify(bytes, f.sigLine('unknown', bytes), f.TRUSTED), (e) => e.code === 'untrusted-key');
  // Not trusted by the shipped list either: the test key is test-only.
  assert.throws(() => sign.verify(bytes, line), (e) => e.code === 'untrusted-key');
  // A key in DVR_SIGNING_KEY that isn't trusted is refused before anything is written.
  assert.throws(() => f.withKey('unknown', () => sign.signBytes(bytes, { trustedKeys: f.TRUSTED })), (e) => e.code === 'untrusted-key' && /not signing/.test(e.message));
  // PEM works as well as base64 DER; other keys don't.
  const pem = crypto.createPrivateKey({ key: Buffer.from(f.KEYS.trusted.pkcs8, 'base64'), format: 'der', type: 'pkcs8' }).export({ format: 'pem', type: 'pkcs8' });
  assert.strictEqual(sign.parsePrivateKey(pem).asymmetricKeyType, 'ed25519');
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ format: 'pem', type: 'pkcs8' });
  assert.throws(() => sign.parsePrivateKey(rsa), /not an Ed25519 key/);
  assert.throws(() => sign.parsePrivateKey(''), /not set/);
  assert.throws(() => sign.parsePrivateKey('garbage'), /not a PKCS8/);
  assert.strictEqual(f.withKey('trusted', () => sign.signingKeyId()), f.KEYS.trusted.id);

  // Files: <file>.sig next to it, exact bytes.
  const file = path.join(tmp, 'index.json');
  fs.writeFileSync(file, '{\n  "format": 1\n}\n');
  f.withKey('trusted', () => sign.signFile(file, undefined, { trustedKeys: f.TRUSTED }));
  assert.strictEqual(sign.verifyFile(file, undefined, { trustedKeys: f.TRUSTED }), f.KEYS.trusted.id);
  fs.writeFileSync(file, '{\r\n  "format": 1\r\n}\r\n'); // line ends changed: no longer the signed bytes
  assert.throws(() => sign.verifyFile(file, undefined, { trustedKeys: f.TRUSTED }), (e) => e.code === 'signature');
  assert.throws(() => sign.verifyFile(path.join(tmp, 'none.json'), undefined, { trustedKeys: f.TRUSTED }), (e) => e.code === 'unsigned');
});

test('privacy: home-folder paths as UTF-8 and UTF-16, either slash, any case', () => {
  const needles = privacy.privateNeedles('C:\\Users\\tester');
  assert.deepStrictEqual(needles, ['\\users\\tester', '/users/tester']);
  const dir = path.join(tmp, 'priv');
  f.write(path.join(dir, 'clean.dll'), 'nothing here');
  f.write(path.join(dir, 'a', 'utf8.pdb'), Buffer.from('built in C:\\Users\\Tester\\src\\x'));
  f.write(path.join(dir, 'utf16.dll'), Buffer.concat([Buffer.from([0x4d]), Buffer.from('c:/users/tester/obj', 'utf16le')]));
  f.write(path.join(dir, 'utf16-even.dll'), Buffer.from('C:\\USERS\\TESTER\\', 'utf16le'));
  f.write(path.join(dir, 'other.txt'), 'C:\\Users\\testerson\\'.replace('testerson', 'someone'));
  assert.deepStrictEqual(privacy.findPrivatePaths(dir, needles).map((h) => h.file).sort(), ['a/utf8.pdb', 'utf16-even.dll', 'utf16.dll']);
  assert.deepStrictEqual(privacy.findPrivatePaths(path.join(tmp, 'nowhere'), needles), []);
  // Too short to be a real home folder: no needle (it would match everything).
  assert.deepStrictEqual(privacy.privateNeedles('C:\\'), []);
});
