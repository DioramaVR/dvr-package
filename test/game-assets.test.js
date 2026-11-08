'use strict';
// A game's media from the assets repo (docs/SPEC.md section 12):
// lib/game-assets.js, bin/dvr-assets.js, the index's assets list and
// dvr-index set-assets.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const ga = require('../lib/game-assets');
const ix = require('../lib/index-writer');
const mj = require('../lib/modjson');
const { validate } = require('../lib/schemas');
const fx = require('./fixtures/make-assets-fixtures');

const FIX = path.join(__dirname, 'fixtures', 'assets');
const GOOD = path.join(FIX, 'fake-vr');
const FLAGGED = path.join(FIX, 'flagged-vr');
const DATA = path.join(__dirname, 'fixtures', 'data', 'fake-vr');
const BIN = path.join(__dirname, '..', 'bin');
const BASE = 'https://example.org/releases/download/assets-1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-package-assets-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const pairs = (r) => r.problems.map((p) => [p.code, p.path]);
const cli = (args) => spawnSync(process.execPath, [path.join(BIN, args[0]), ...args.slice(1)], { encoding: 'utf8' });
// A copy of the good folder (named id, so the id check holds), changed by fn(dir, doc).
function game(fn = () => {}, id = 'fake-vr') {
  const dir = path.join(tmp, `${++n}`, id);
  fx.writeGame(dir, fx.MEDIA(id), fx.cleanFiles());
  const doc = fx.MEDIA(id);
  fn(dir, doc);
  fs.writeFileSync(path.join(dir, 'media.json'), JSON.stringify(doc, null, 2) + '\n');
  return dir;
}
const media = (dir, name) => path.join(dir, 'media', name);

function index(extra = {}) {
  const { game: g, issues } = mj.readGameData(DATA);
  const entry = { version: '1.0.0', maturity: 'open-beta', date: '2026-11-20', coreVersion: '0.1.1', minAppVersion: '0.2.0',
    source: { commit: 'a1b2c3d', actionsCommit: 'c7d8e9f', builtAt: '2026-11-20T10:00:00Z' }, sha256: 'B'.repeat(64), size: 1234 };
  return { ...ix.addRelease({ game: g, issues, prev: {}, entry, url: 'https://example.org/fake-vr-1.0.0.zip' }), ...extra };
}
const built = () => ga.build(GOOD, { release: 'assets-1', baseUrl: BASE, date: '2026-11-08' });

test('the assets fixtures: each folder gets the problems in expected.json, and they are what the maker makes', () => {
  const expected = JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8'));
  for (const [name, want] of Object.entries(expected)) assert.deepStrictEqual(pairs(ga.check(path.join(FIX, name))), want, name);
  const out = path.join(tmp, 'fixtures');
  fx.makeAssetsFixtures(out);
  const walk = (d, rel = '') => fs.readdirSync(path.join(d, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(d, path.join(rel, e.name)) : [path.join(rel, e.name)]));
  const mine = walk(FIX).filter((f) => f !== 'make-assets-fixtures.js').sort();
  assert.deepStrictEqual(walk(out).sort(), mine);
  for (const f of mine) assert.ok(fs.readFileSync(path.join(out, f)).equals(fs.readFileSync(path.join(FIX, f))), f);
});

test('check: a clean folder; every file with its size and lower-case SHA-256', () => {
  const r = ga.check(GOOD);
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.id, 'fake-vr');
  assert.deepStrictEqual(r.files.map((f) => f.name), ['hero.jpg', 'turntable.webm', 'turntable-poster.png', 'turntable.mp4', 'gallery-1.png'], 'file, poster, sources, in media order');
  for (const f of r.files) {
    const b = fs.readFileSync(f.path);
    assert.strictEqual(f.size, b.length);
    assert.strictEqual(f.sha256, sha(b));
  }
});

test('check flags metadata, never strips it: JPG Exif, XMP, IPTC; PNG tEXt, zTXt, iTXt, eXIf, tIME', () => {
  const before = fs.readFileSync(media(FLAGGED, 'hero.jpg'));
  const r = ga.check(FLAGGED);
  assert.deepStrictEqual(r.problems.map((p) => p.message), [
    'has JPG APP1 Exif metadata: strip it and commit the file again',
    'has PNG tEXt "Comment" metadata: strip it and commit the file again',
  ]);
  assert.ok(fs.readFileSync(media(FLAGGED, 'hero.jpg')).equals(before), 'the file is untouched');
  assert.deepStrictEqual(ga.jpgMetadata(fx.jpg({ xmp: true })), ['JPG APP1 XMP']);
  assert.deepStrictEqual(ga.jpgMetadata(fx.jpg({ iptc: true })), ['JPG APP13 IPTC (Photoshop)']);
  assert.deepStrictEqual(ga.jpgMetadata(fx.jpg({ exif: true, xmp: true, iptc: true })), ['JPG APP1 Exif', 'JPG APP1 XMP', 'JPG APP13 IPTC (Photoshop)']);
  assert.deepStrictEqual(ga.jpgMetadata(fx.jpg()), [], 'APP0 (JFIF) is fine');
  const chunks = [['zTXt', Buffer.from('Title\0\0x')], ['iTXt', Buffer.from('Author\0\0\0\0\0x')], ['eXIf', Buffer.from('MM\0*')], ['tIME', Buffer.from([7, 234, 11, 8, 12, 0, 0])]];
  assert.deepStrictEqual(ga.pngMetadata(fx.png(undefined, chunks)), ['PNG zTXt "Title"', 'PNG iTXt "Author"', 'PNG eXIf', 'PNG tIME']);
  assert.deepStrictEqual(ga.pngMetadata(fx.png(undefined, [['gAMA', Buffer.from([0, 0, 0xb1, 0x8f])]])), [], 'other chunks are fine');
  // Every flagged kind, through check().
  const dir = game((d) => {
    fs.writeFileSync(media(d, 'hero.jpg'), fx.jpg({ xmp: true, iptc: true }));
    fs.writeFileSync(media(d, 'turntable-poster.png'), fx.png(undefined, chunks));
  });
  assert.strictEqual(ga.check(dir).problems.filter((p) => p.code === 'metadata').length, 6);
});

test('check reports every other problem: names, files, types, sizes, the media rules', () => {
  const cases = [
    [(d) => fs.rmSync(media(d, 'turntable.mp4')), [['missing-file', 'media/turntable.mp4']]],
    [(d) => fs.writeFileSync(media(d, 'extra.png'), fx.png()), [['extra-file', 'media/extra.png']]],
    [(d) => fs.mkdirSync(media(d, 'more')), [['unsafe-path', 'media/more']]],
    [(d) => fs.writeFileSync(media(d, 'hero.jpg'), fx.png()), [['format', 'media/hero.jpg']], 'a PNG named .jpg'],
    [(d) => fs.writeFileSync(media(d, 'hero.jpg'), Buffer.alloc(0)), [['format', 'media/hero.jpg']], 'empty'],
    [(d) => fs.writeFileSync(media(d, 'turntable.mp4'), Buffer.alloc(ga.MAX_FILE + 1)), [['format', 'media/turntable.mp4']], 'over 64 MB'],
    [(d, m) => { m.media[0].file = 'Hero.JPG'; }, [['format', 'media.json/media/0/file'], ['format', 'media.json/media/0/file'], ['extra-file', 'media/hero.jpg'], ['missing-file', 'media/Hero.JPG']], 'names are lower case'],
    [(d, m) => { m.media[0].file = 'media/hero.jpg'; }, [['format', 'media.json/media/0/file'], ['extra-file', 'media/hero.jpg'], ['missing-file', 'media/media/hero.jpg']], 'no slashes'],
    [(d, m) => { m.media[2].file = 'gallery-1.gif'; fs.renameSync(media(d, 'gallery-1.png'), media(d, 'gallery-1.gif')); }, [['format', 'media.json/media/2/file'], ['format', 'media.json/media/2/file']], 'a type not allowed (the name, and its kind)'],
    [(d, m) => { m.media[2].role = 'hero'; }, [['format', 'media.json/media']], 'two heroes'],
    [(d, m) => { m.media[0].role = 'gallery'; }, [['format', 'media.json/media']], 'no hero'],
    [(d, m) => { m.media[2].role = 'turntable'; }, [['format', 'media.json/media']], 'two turntables'],
    [(d, m) => { m.media[2].role = 'hover'; }, [['format', 'media.json/media/2/role']], 'hover is gone'],
    [(d, m) => { m.media[0].kind = 'video'; }, [['format', 'media.json/media/0/file']], 'an image as a video'],
    [(d, m) => { m.media[1].poster = 'turntable.mp4'; }, [['format', 'media.json/media/1/poster'], ['extra-file', 'media/turntable-poster.png']], 'a poster is an image'],
    [(d, m) => { m.media[0].sources = ['turntable.mp4']; }, [['format', 'media.json/media/0/sources']], 'sources on an image'],
    [(d, m) => { m.id = 'other-vr'; }, [['format', 'media.json/id']], 'the id is the folder name'],
    [(d, m) => { m.format = 2; }, [['format', 'media.json/format']], 'a newer format'],
    [(d, m) => { m.media = []; }, [['format', 'media.json/media'], ['format', 'media.json/media'], ...['gallery-1.png', 'hero.jpg', 'turntable-poster.png', 'turntable.mp4', 'turntable.webm'].map((f) => ['extra-file', `media/${f}`])], 'an empty list'],
  ];
  for (const [change, want, label] of cases) {
    assert.deepStrictEqual(pairs(ga.check(game(change))), want, label || JSON.stringify(want));
  }
  const noJson = game((d) => fs.rmSync(path.join(d, 'media.json')));
  fs.rmSync(path.join(noJson, 'media.json'));
  assert.deepStrictEqual(pairs(ga.check(noJson)), [['format', 'media.json']]);
});

test('build: the assets list for the index, hashes and sizes filled in; refuses on any problem', () => {
  const { assets, files } = built();
  assert.deepStrictEqual(Object.keys(assets), ['release', 'date', 'files', 'media']);
  assert.strictEqual(assets.release, 'assets-1');
  assert.strictEqual(assets.date, '2026-11-08');
  assert.deepStrictEqual(assets.media, JSON.parse(fs.readFileSync(path.join(GOOD, 'media.json'), 'utf8')).media, 'media.json\'s list, unchanged');
  assert.deepStrictEqual(Object.keys(assets.files), ['hero.jpg', 'turntable.webm', 'turntable-poster.png', 'turntable.mp4', 'gallery-1.png']);
  const hero = fs.readFileSync(media(GOOD, 'hero.jpg'));
  assert.deepStrictEqual(assets.files['hero.jpg'], { url: `${BASE}/hero.jpg`, sha256: sha(hero), size: hero.length });
  assert.deepStrictEqual(files, Object.keys(assets.files).map((name) => ({ name, path: media(GOOD, name) })));
  assert.deepStrictEqual(ga.build(GOOD, { release: 'assets-1', baseUrl: `${BASE}/`, date: '2026-11-08' }).assets, assets, 'a trailing slash is fine');
  assert.deepStrictEqual(validate({ ...index(), assets }, 'index'), []);

  assert.throws(() => ga.build(FLAGGED, { release: 'assets-1', baseUrl: BASE, date: '2026-11-08' }), (e) => e.code === 'metadata' && e.details.length === 2);
  for (const [opts, what] of [[{ release: 'assets-0' }, 'release'], [{ release: 'v1' }, 'release'], [{ baseUrl: 'http://example.org/x' }, 'baseUrl'], [{ date: '8 Nov' }, 'date']]) {
    assert.throws(() => ga.build(GOOD, { release: 'assets-1', baseUrl: BASE, date: '2026-11-08', ...opts }), new RegExp(what));
  }
});

test('the index: setAssets checks it; addRelease, setMaturity and setData carry it forward', () => {
  const { assets } = built();
  const one = ix.setAssets(index(), assets);
  assert.deepStrictEqual(one.assets, assets);
  assert.deepStrictEqual(ix.checkIndex(one), []);
  const { game: g, issues } = mj.readGameData(DATA);
  const entry = { version: '1.1.0', maturity: 'open-beta', date: '2026-11-21', coreVersion: '0.1.1', minAppVersion: '0.2.0',
    source: { commit: 'a1b2c3d', actionsCommit: 'c7d8e9f', builtAt: '2026-11-21T10:00:00Z' }, sha256: 'C'.repeat(64), size: 99 };
  const two = ix.addRelease({ game: g, issues, prev: one, entry, url: 'https://example.org/fake-vr-1.1.0.zip' });
  assert.deepStrictEqual(two.assets, assets, 'addRelease');
  assert.deepStrictEqual(ix.setMaturity(two, '1.1.0', 'stable').assets, assets, 'setMaturity');
  const data = { url: 'https://example.org/data-1/fake-vr-data.zip', sha256: 'd'.repeat(64), size: 10, date: '2026-11-08' };
  assert.deepStrictEqual(ix.setData(two, data).assets, assets, 'setData');
  assert.deepStrictEqual(ix.setAssets(ix.setData(two, data), assets).data, data, 'and setAssets keeps data');

  const bad = (change, why) => {
    const a = JSON.parse(JSON.stringify(assets));
    change(a);
    assert.throws(() => ix.setAssets(index(), a), (e) => e.code === 'index', why);
  };
  bad((a) => { delete a.files['turntable.mp4']; }, 'a file media uses is missing');
  bad((a) => { a.files['other.jpg'] = a.files['hero.jpg']; }, 'an extra file');
  bad((a) => { a.files['hero.jpg'].url = 'http://example.org/hero.jpg'; }, 'https only');
  bad((a) => { a.files['hero.jpg'].url = 'http://localhost/hero.jpg'; }, 'not even localhost');
  bad((a) => { a.files['hero.jpg'].size = 0; }, 'a size');
  bad((a) => { a.files['hero.jpg'].size = ga.MAX_FILE + 1; }, 'over 64 MB');
  bad((a) => { a.files['hero.jpg'].sha256 = 'x'; }, 'a hash');
  bad((a) => { a.files['Hero.jpg'] = a.files['hero.jpg']; delete a.files['hero.jpg']; a.media[0].file = 'Hero.jpg'; }, 'a name');
  bad((a) => { a.release = 'assets-01'; }, 'release');
  bad((a) => { delete a.date; }, 'date');
  bad((a) => { a.media[2].role = 'hero'; }, 'one hero');
  bad((a) => { a.media[2].role = 'hover'; }, 'no hover');
  bad((a) => { a.media = []; a.files = {}; }, 'at least one');
  assert.throws(() => ix.setAssets(index(), null), /needs/);
  const upper = JSON.parse(JSON.stringify(assets));
  upper.files['hero.jpg'].sha256 = upper.files['hero.jpg'].sha256.toUpperCase();
  assert.doesNotThrow(() => ix.setAssets(index(), upper), 'either case');
});

test('list and verify: what a reader downloads, and the check of each file', () => {
  const { assets } = built();
  const doc = ix.setAssets(index(), assets);
  const l = ga.list(doc);
  assert.deepStrictEqual(l.map((f) => f.name), Object.keys(assets.files));
  assert.deepStrictEqual(l[0], { name: 'hero.jpg', ...assets.files['hero.jpg'] });
  assert.deepStrictEqual(ga.list(index()), [], 'no assets list: use the data zip');
  assert.throws(() => ga.list({ ...doc, assets: { ...assets, files: {} } }), (e) => e.code === 'format');

  const hero = fs.readFileSync(media(GOOD, 'hero.jpg'));
  assert.strictEqual(ga.verify('hero.jpg', hero, doc), true);
  const upper = JSON.parse(JSON.stringify(doc));
  upper.assets.files['hero.jpg'].sha256 = upper.assets.files['hero.jpg'].sha256.toUpperCase();
  assert.strictEqual(ga.verify('hero.jpg', hero, upper), true, 'either case');
  const code = (fn) => { try { fn(); return 'ok'; } catch (e) { return e.code; } };
  assert.strictEqual(code(() => ga.verify('hero.jpg', Buffer.concat([hero, Buffer.from([0])]), doc)), 'hash', 'size');
  const flipped = Buffer.from(hero);
  flipped[20] ^= 1;
  assert.strictEqual(code(() => ga.verify('hero.jpg', flipped, doc)), 'hash', 'sha256');
  assert.strictEqual(code(() => ga.verify('other.jpg', hero, doc)), 'extra-file');
  assert.strictEqual(code(() => ga.verify('toString', hero, doc)), 'extra-file', 'never an inherited property');
  assert.strictEqual(code(() => ga.verify('hero.jpg', hero, index())), 'extra-file', 'no assets list');
});

test('sniff: each type from its first bytes', () => {
  assert.strictEqual(ga.sniff(fx.jpg()), 'jpg');
  assert.strictEqual(ga.sniff(fx.png()), 'png');
  assert.strictEqual(ga.sniff(fx.webm()), 'webm');
  assert.strictEqual(ga.sniff(fx.mp4()), 'mp4');
  assert.strictEqual(ga.sniff(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')), 'webp');
  assert.strictEqual(ga.sniff(Buffer.from('not media')), null);
});

test('dvr-assets: check and build; dvr-index set-assets; exit 0, 1, 2', () => {
  const ok = cli(['dvr-assets.js', 'check', GOOD]);
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^dvr-assets: fake-vr: fine \(3 media, 5 file\(s\), \d+ bytes\)/);
  const flagged = cli(['dvr-assets.js', 'check', FLAGGED]);
  assert.strictEqual(flagged.status, 1);
  assert.match(flagged.stderr, /^metadata: media\/hero\.jpg: has JPG APP1 Exif metadata/m);
  assert.match(flagged.stderr, /^metadata: media\/gallery-1\.png: has PNG tEXt "Comment" metadata/m);

  const out = path.join(tmp, 'cli', 'assets.json');
  const b = cli(['dvr-assets.js', 'build', GOOD, '--release', 'assets-1', '--base-url', BASE, '--date', '2026-11-08', '--out', out]);
  assert.strictEqual(b.status, 0, b.stderr);
  const text = fs.readFileSync(out, 'utf8');
  assert.strictEqual(text, JSON.stringify(built().assets, null, 2) + '\n');
  assert.deepStrictEqual(JSON.parse(b.stdout), built().files);
  assert.strictEqual(cli(['dvr-assets.js', 'build', FLAGGED, '--release', 'assets-1', '--base-url', BASE, '--date', '2026-11-08', '--out', path.join(tmp, 'cli', 'no.json')]).status, 1);
  assert.ok(!fs.existsSync(path.join(tmp, 'cli', 'no.json')), 'nothing written on a refusal');
  for (const args of [['check'], ['check', GOOD, GOOD], ['check', GOOD, '--date', '2026-11-08'], ['build', GOOD], ['build', GOOD, '--release', 'v1', '--base-url', BASE, '--date', '2026-11-08'], ['nope']]) {
    assert.strictEqual(cli(['dvr-assets.js', ...args]).status, 2, args.join(' '));
  }

  const file = path.join(tmp, 'cli', 'index.json');
  fs.writeFileSync(file, ix.canonical(index()));
  const s = cli(['dvr-index.js', 'set-assets', file, out]);
  assert.strictEqual(s.status, 0, s.stderr);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), ix.canonical(doc));
  assert.deepStrictEqual(doc.assets, built().assets);
  const before = fs.readFileSync(file);
  const broken = path.join(tmp, 'cli', 'broken.json');
  fs.writeFileSync(broken, JSON.stringify({ ...built().assets, files: {} }));
  assert.strictEqual(cli(['dvr-index.js', 'set-assets', file, broken]).status, 1);
  assert.strictEqual(cli(['dvr-index.js', 'set-assets', file]).status, 2);
  assert.ok(fs.readFileSync(file).equals(before), 'unchanged after a refusal');
});
