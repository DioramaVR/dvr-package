'use strict';
// The data zip (docs/SPEC.md section 11): lib/datazip.js, bin/dvr-data.js,
// the fixtures in fixtures/data-zip/, and the index's data field.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const dataZip = require('../lib/datazip');
const zip = require('../lib/zip');
const ix = require('../lib/index-writer');
const mj = require('../lib/modjson');
const { validate } = require('../lib/schemas');
const { makeDataFixtures, rewrap, SOURCE } = require('./fixtures/make-data-fixtures');

const FIX = path.join(__dirname, 'fixtures', 'data-zip');
const FAKE = path.join(__dirname, 'fixtures', 'data', 'fake-vr'); // no line: tagline stands in
const BIN = path.join(__dirname, '..', 'bin');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-package-datazip-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const dir = (name) => path.join(tmp, `${++n}-${name}`);
const code = (fn) => { try { fn(); return 'ok'; } catch (e) { if (e.name !== 'PackageError') throw e; return e.code; } };
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
const copySource = (from = SOURCE) => { const d = dir('src'); fs.cpSync(from, d, { recursive: true }); return d; };
const editGame = (d, change) => {
  const f = path.join(d, 'game.json');
  const g = JSON.parse(fs.readFileSync(f, 'utf8'));
  change(g);
  fs.writeFileSync(f, JSON.stringify(g, null, 2) + '\n');
};
const cli = (args, opts = {}) => spawnSync(process.execPath, [...(opts.pre || []), path.join(BIN, args[0]), ...args.slice(1)], { encoding: 'utf8', env: { ...process.env, ...opts.env } });

test('every data-zip fixture gets the verdict in expected.json', () => {
  const expected = JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8'));
  assert.strictEqual(Object.keys(expected).length, 17);
  for (const [name, want] of Object.entries(expected)) assert.strictEqual(code(() => dataZip.read(path.join(FIX, name))), want, name);
});

test('the committed data-zip fixtures are what make-data-fixtures.js makes', () => {
  const out = dir('fixtures');
  fs.mkdirSync(out);
  const expected = makeDataFixtures(out);
  assert.deepStrictEqual(fs.readFileSync(path.join(out, 'expected.json')), fs.readFileSync(path.join(FIX, 'expected.json')));
  for (const name of Object.keys(expected)) assert.ok(fs.readFileSync(path.join(out, name)).equals(fs.readFileSync(path.join(FIX, name))), name);
});

test('pack: data.json has the zip fields only, in order; the media it names, nothing else', () => {
  const out = dir('out');
  const r = dataZip.pack(SOURCE, out, { date: '2026-11-20' });
  assert.strictEqual(r.zip, path.join(out, 'fake-vr-data.zip'));
  assert.strictEqual(r.date, '2026-11-20');
  assert.match(r.sha256, /^[0-9A-F]{64}$/, 'upper case (SPEC 2)');
  assert.strictEqual(r.sha256, sha(r.zip));
  assert.strictEqual(r.size, fs.statSync(r.zip).size);
  assert.deepStrictEqual(r.warnings, ["data/media/unused.webp isn't named in game.json's media: left out"]);
  assert.deepStrictEqual(Object.keys(r.data), ['format', 'id', 'line', 'firstLaunch', 'needToKnow', 'tutorial', 'knownIssues', 'owners', 'credits', 'media']);
  assert.strictEqual(r.data.line, 'Your pretend table, life size.');
  assert.deepStrictEqual(r.data.tutorial[0], { title: 'Getting started', text: 'Load a save.' }, 'tutorial[].controls dropped');
  assert.deepStrictEqual(r.data.knownIssues, JSON.parse(fs.readFileSync(path.join(SOURCE, 'known-issues.json'), 'utf8')));
  assert.deepStrictEqual(r.data.media[1], { file: 'media/turntable.webm', kind: 'video', role: 'turntable', alt: 'The fake table, turning.', poster: 'media/turntable-poster.jpg', sources: ['media/turntable.mp4'] });
  assert.deepStrictEqual(zip.list(r.zip), ['data.json', 'media/gallery-1.png', 'media/hero.jpg', 'media/turntable-poster.jpg', 'media/turntable.mp4', 'media/turntable.webm'], 'sorted; each file once; unused.webp and notes.txt left out');

  const { data, files } = dataZip.read(r.zip, { sha256: r.sha256.toLowerCase(), size: r.size, id: 'fake-vr' });
  assert.deepStrictEqual(data, r.data);
  assert.strictEqual(files.get('data.json').toString('utf8'), JSON.stringify(r.data, null, 2) + '\n', 'canonical, LF');
  assert.ok(files.get('media/hero.jpg').equals(fs.readFileSync(path.join(SOURCE, 'media', 'hero.jpg'))));
  assert.deepStrictEqual(validate(data, 'data'), []);
});

test('pack: line falls back to tagline, with a warning', () => {
  const r = dataZip.pack(FAKE, dir('out'), { date: '2026-11-20' });
  assert.strictEqual(r.data.line, 'A pretend game on a pretend table.');
  assert.ok(r.warnings.includes("line: placeholder from tagline (needs the user's line)"), r.warnings.join('; '));
  assert.strictEqual(dataZip.pack(SOURCE, dir('out'), {}).warnings.filter((w) => w.startsWith('line:')).length, 0, 'none when line is written');
});

test('determinism: the same folder packed on two dates gives the same bytes; every timestamp is 1980-01-01', () => {
  const a = dataZip.pack(SOURCE, dir('a'), { date: '2026-11-20' });
  const b = dataZip.pack(SOURCE, dir('b'), { date: '2027-06-30' });
  const c = dataZip.pack(SOURCE, dir('c'));
  assert.strictEqual(a.sha256, b.sha256);
  assert.strictEqual(a.sha256, c.sha256, 'and on the default date (today)');
  assert.ok(fs.readFileSync(a.zip).equals(fs.readFileSync(b.zip)));
  assert.strictEqual(b.date, '2027-06-30', 'the date is returned, for the index');
  // Every local header and central-directory entry: time 0, date 1980-01-01.
  const buf = fs.readFileSync(a.zip);
  let headers = 0;
  for (let i = 0; i + 4 <= buf.length; i++) {
    const sig = buf.readUInt32LE(i);
    if (sig === 0x04034b50 || sig === 0x02014b50) {
      const at = sig === 0x04034b50 ? i + 10 : i + 12;
      assert.strictEqual(buf.readUInt16LE(at), 0, 'time 00:00');
      assert.strictEqual(buf.readUInt16LE(at + 2), (0 << 9) | (1 << 5) | 1, 'date 1980-01-01');
      headers++;
    }
  }
  assert.strictEqual(headers, 12, '6 entries, local and central');
  // A changed file changes the hash.
  const d = copySource();
  fs.writeFileSync(path.join(d, 'media', 'hero.jpg'), 'a different hero\n');
  assert.notStrictEqual(dataZip.pack(d, dir('d')).sha256, a.sha256);
  assert.throws(() => dataZip.pack(SOURCE, dir('e'), { date: '2026-13-01' }), /YYYY-MM-DD/);
});

test('pack refuses a bad source: missing, unsafe, subfolder, wrong type, too big, bad game.json', () => {
  const refuse = (change, want, msg) => {
    const d = copySource();
    change(d);
    assert.strictEqual(code(() => dataZip.pack(d, dir('out'))), want, msg);
    assert.strictEqual(code(() => dataZip.checkSource(d)), want, `${msg} (check-source)`);
  };
  refuse((d) => fs.rmSync(path.join(d, 'media', 'turntable.mp4')), 'missing-file', 'a named source missing');
  refuse((d) => editGame(d, (g) => { g.media[0].file = 'media/sub/hero.jpg'; fs.mkdirSync(path.join(d, 'media', 'sub')); fs.copyFileSync(path.join(d, 'media', 'hero.jpg'), path.join(d, 'media', 'sub', 'hero.jpg')); }), 'unsafe-path', 'a subfolder in media');
  refuse((d) => editGame(d, (g) => { g.media[0].file = 'hero.jpg'; fs.copyFileSync(path.join(d, 'media', 'hero.jpg'), path.join(d, 'hero.jpg')); }), 'unsafe-path', 'outside media/');
  refuse((d) => editGame(d, (g) => { g.media[0].file = '../hero.jpg'; }), 'format', 'game.json itself refuses ..');
  refuse((d) => editGame(d, (g) => { g.media[3].file = 'media/gallery-1.gif'; fs.copyFileSync(path.join(d, 'media', 'gallery-1.png'), path.join(d, 'media', 'gallery-1.gif')); }), 'format', 'a type not allowed');
  refuse((d) => editGame(d, (g) => { g.media[3].file = 'media/gallery-1.PNG'; fs.renameSync(path.join(d, 'media', 'gallery-1.png'), path.join(d, 'media', 'gallery-1.PNG')); }), 'format', 'types are lower case');
  refuse((d) => editGame(d, (g) => { g.media[0].kind = 'video'; }), 'format', 'an image as a video');
  refuse((d) => editGame(d, (g) => { g.media[0].sources = ['media/turntable.mp4']; }), 'format', 'sources on an image');
  refuse((d) => editGame(d, (g) => { delete g.tagline; delete g.line; }), 'format', 'no line and no tagline');
  refuse((d) => fs.writeFileSync(path.join(d, 'media', 'turntable.mp4'), Buffer.alloc(dataZip.MAX_SIZE + 1)), 'format', 'over 64 MB');
  refuse((d) => fs.rmSync(path.join(d, 'game.json')), 'format', 'no game.json');
});

test('game.json: controls and description are optional now; the rest that was required still is', () => {
  const d = copySource();
  const g = JSON.parse(fs.readFileSync(path.join(d, 'game.json'), 'utf8'));
  assert.ok(!('controls' in g) && !('description' in g), 'the fixture has neither');
  assert.deepStrictEqual(mj.checkGameData(g, [], { dataDir: d }), []);
  const fake = JSON.parse(fs.readFileSync(path.join(FAKE, 'game.json'), 'utf8'));
  const required = ['id', 'name', 'game', 'appid', 'tagline', 'firstLaunch', 'tutorial', 'install', 'testedBuildIds', 'media'];
  for (const k of required) {
    const { [k]: _, ...less } = fake;
    assert.ok(validate(less, 'game').some((p) => p.message === `needs "${k}"`), k);
  }
  const { controls, description, ...less } = fake;
  assert.deepStrictEqual(validate(less, 'game'), []);
  assert.ok(validate({ ...fake, controls: [] }, 'game').length, 'controls, when there, still needs an entry');
});

test('read: size and SHA-256 first, then the names, data.json and the files', () => {
  const good = path.join(FIX, 'good.zip');
  const size = fs.statSync(good).size;
  assert.strictEqual(code(() => dataZip.read(good, { size: size + 1 })), 'hash');
  assert.strictEqual(code(() => dataZip.read(good, { sha256: 'A'.repeat(64) })), 'hash');
  assert.strictEqual(code(() => dataZip.read(good, { sha256: sha(good).toLowerCase(), size })), 'ok', 'either case');
  assert.strictEqual(code(() => dataZip.read(good, { id: 'other-vr' })), 'format', 'the index id must match');
  assert.strictEqual(code(() => dataZip.read(path.join(tmp, 'absent.zip'))), 'not-a-mod');
  // A hash check comes before anything else: a bad zip with a wrong hash is "hash".
  assert.strictEqual(code(() => dataZip.read(path.join(FIX, 'unsafe-path.zip'), { sha256: 'A'.repeat(64) })), 'hash');

  // Too big unpacked: refused from the central directory, before inflating.
  assert.strictEqual(code(() => zip.readEntries(good, { maxTotal: 10 })), 'format');
  // A damaged entry (CRC-32 no longer matches) is refused.
  const bom = dir('bom.zip');
  rewrap(good, bom, (e) => e.set('data.json', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), e.get('data.json')])));
  assert.strictEqual(code(() => dataZip.read(bom)), 'format', 'no BOM');
  const damaged = dir('damaged.zip');
  const buf = Buffer.from(fs.readFileSync(path.join(FIX, 'good.zip')));
  const at = buf.indexOf(Buffer.from('not a real hero.jpg'));
  assert.ok(at > 0, 'hero.jpg is stored, so its text is in the zip');
  buf[at] ^= 0x20;
  fs.writeFileSync(damaged, buf);
  assert.strictEqual(code(() => dataZip.read(damaged)), 'not-a-mod');
  // Over 64 MB on disk: refused before it's read.
  const huge = dir('huge.zip');
  fs.copyFileSync(good, huge);
  fs.truncateSync(huge, dataZip.MAX_SIZE + 1);
  assert.strictEqual(code(() => dataZip.read(huge)), 'format');
});

test('extract: the checked files into a new folder; nothing written for a bad zip', () => {
  const to = dir('x');
  const r = dataZip.extract(path.join(FIX, 'good.zip'), to, { id: 'fake-vr' });
  assert.deepStrictEqual(r.data.id, 'fake-vr');
  assert.deepStrictEqual(fs.readdirSync(path.join(to, 'media')).sort(), ['gallery-1.png', 'hero.jpg', 'turntable-poster.jpg', 'turntable.mp4', 'turntable.webm']);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(to, 'data.json'), 'utf8')), r.data);
  assert.throws(() => dataZip.extract(path.join(FIX, 'good.zip'), to), /isn't empty/);
  const bad = dir('bad');
  assert.strictEqual(code(() => dataZip.extract(path.join(FIX, 'unsafe-path.zip'), bad)), 'unsafe-path');
  assert.ok(!fs.existsSync(bad));
  assert.ok(!fs.existsSync(path.join(tmp, 'outside.jpg')));
});

// Linux-like terms (the website builds on Ubuntu): no tar, no SystemRoot, no
// PATH, and process.platform "linux". Any child process at all fails the run.
test('no tar: pack, read, extract and the CLI work with child processes forbidden', () => {
  const pre = path.join(tmp, 'no-tar.js');
  fs.writeFileSync(pre, [
    "Object.defineProperty(process, 'platform', { value: 'linux' });",
    "const cp = require('child_process');",
    "for (const k of ['execFileSync', 'execSync', 'spawnSync', 'execFile', 'exec', 'spawn', 'fork']) cp[k] = () => { throw new Error('child process: ' + k); };",
  ].join('\n'));
  const env = { PATH: '', Path: '', SystemRoot: path.join(tmp, 'no-windows') };
  const out = dir('linux');
  const script = `
    const dz = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'datazip'))});
    const r = dz.pack(${JSON.stringify(SOURCE)}, ${JSON.stringify(out)}, { date: '2026-11-20' });
    dz.read(r.zip, { sha256: r.sha256, size: r.size, id: 'fake-vr' });
    dz.extract(r.zip, ${JSON.stringify(path.join(out, 'x'))});
    // The guard works: anything that would run tar fails here.
    let blocked = false;
    try { require('child_process').execFileSync('tar', ['--version']); } catch { blocked = true; }
    if (!blocked || require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'zip'))}).readEntry(r.zip, 'data.json') !== null) process.exit(3);
    console.log(r.sha256);`;
  const run = spawnSync(process.execPath, ['-r', pre, '-e', script], { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.strictEqual(run.status, 0, run.stderr);
  assert.strictEqual(run.stdout.trim(), sha(path.join(FIX, 'good.zip')), 'the same bytes as on Windows');
  assert.ok(fs.existsSync(path.join(out, 'x', 'media', 'hero.jpg')));
  const check = cli(['dvr-data.js', 'check', path.join(FIX, 'good.zip')], { pre: ['-r', pre], env });
  assert.strictEqual(check.status, 0, check.stderr);
  const bad = cli(['dvr-data.js', 'check', path.join(FIX, 'extra-file.zip')], { pre: ['-r', pre], env });
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /^extra-file: /);
});

test('dvr-data: check-source, pack, check; exit 0, 1, 2', () => {
  const src = cli(['dvr-data.js', 'check-source', SOURCE]);
  assert.strictEqual(src.status, 0, src.stderr);
  assert.match(src.stderr, /warning: data\/media\/unused\.webp/);
  const out = dir('cli');
  const p = cli(['dvr-data.js', 'pack', FAKE, out, '--date', '2026-11-21']);
  assert.strictEqual(p.status, 0, p.stderr);
  assert.match(p.stderr, /warning: line: placeholder from tagline/);
  const r = JSON.parse(p.stdout);
  assert.deepStrictEqual(Object.keys(r), ['zip', 'sha256', 'size', 'date']);
  assert.strictEqual(r.date, '2026-11-21');
  assert.strictEqual(r.sha256, sha(r.zip));
  const ok = cli(['dvr-data.js', 'check', r.zip, '--sha256', r.sha256, '--size', String(r.size), '--id', 'fake-vr']);
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^ok: fake-vr/);
  const wrong = cli(['dvr-data.js', 'check', r.zip, '--size', '5']);
  assert.strictEqual(wrong.status, 1);
  assert.match(wrong.stderr, /^hash: /);
  for (const args of [['pack', FAKE], ['check'], ['check', r.zip, '--size'], ['check', r.zip, '--size', 'big'], ['check', r.zip, '--date', '2026-01-01'], ['check-source', FAKE, '--nope', 'x'], ['frobnicate']]) {
    assert.strictEqual(cli(['dvr-data.js', ...args]).status, 2, args.join(' '));
  }
});

// The index's data field: optional, signed with the index, carried forward.
const SHA = 'B'.repeat(64);
const source = { commit: 'a1b2c3d', actionsCommit: 'c7d8e9f', builtAt: '2026-11-20T10:00:00Z' };
const entry = (version, maturity = 'open-beta') => ({ version, maturity, date: '2026-11-20', coreVersion: '0.1.1', minAppVersion: '0.2.0', source, sha256: SHA, size: 1234 });
const zipUrl = (v) => `https://example.org/releases/v${v}/fake-vr-${v}.zip`;
const DATA = { url: 'https://example.org/releases/download/data-1/fake-vr-data.zip', sha256: 'c'.repeat(64), size: 4321, date: '2026-11-20' };

test('index data: setData sets it; addRelease and setMaturity carry it forward', () => {
  const { game, issues } = mj.readGameData(FAKE);
  const one = ix.addRelease({ game, issues, prev: {}, entry: entry('1.0.0'), url: zipUrl('1.0.0') });
  assert.ok(!('data' in one), 'absent until set');
  const withData = ix.setData(one, DATA);
  assert.deepStrictEqual(withData.data, DATA);
  assert.deepStrictEqual({ ...withData, data: undefined }, { ...one, data: undefined }, 'nothing else changes');
  const newIssues = [{ id: 'new-one', title: 'New', text: 'From the data zip.', severity: 'minor' }];
  assert.deepStrictEqual(ix.setData(one, DATA, newIssues).knownIssues, newIssues, 'knownIssues replaced when given');
  assert.deepStrictEqual(ix.setData(one, DATA).knownIssues, one.knownIssues, 'and kept when not');

  const two = ix.addRelease({ game, issues, prev: withData, entry: entry('1.1.0'), url: zipUrl('1.1.0') });
  assert.deepStrictEqual(two.data, DATA, 'addRelease keeps it');
  assert.deepStrictEqual(Object.keys(two).slice(-2), ['knownIssues', 'data']);
  const promoted = ix.setMaturity(two, '1.1.0', 'stable');
  assert.deepStrictEqual(promoted.data, DATA, 'setMaturity keeps it');
  assert.deepStrictEqual(ix.checkIndex(promoted), []);

  for (const bad of [{ ...DATA, size: 0 }, { ...DATA, sha256: 'xyz' }, { ...DATA, url: 'http://example.org/x.zip' }, { ...DATA, date: '20 Nov' }, { url: DATA.url }]) {
    assert.throws(() => ix.setData(one, bad), (e) => e.code === 'index', JSON.stringify(bad));
  }
  assert.throws(() => ix.setData(one, DATA, { not: 'a list' }), /must be a list/);
  assert.ok(validate({ ...one, data: { ...DATA, extra: 1 } }, 'index').length === 0, 'unknown fields ignored (SPEC 2)');
});

test('dvr-index set-data: in place, canonical; --known-issues from a data.json or a known-issues.json', () => {
  const { game, issues } = mj.readGameData(FAKE);
  const file = path.join(dir('ix'), 'index.json');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, ix.canonical(ix.addRelease({ game, issues, prev: {}, entry: entry('1.0.0'), url: zipUrl('1.0.0') })));
  const args = ['dvr-index.js', 'set-data', file, '--url', DATA.url, '--sha256', DATA.sha256, '--size', String(DATA.size), '--date', DATA.date];
  const r = cli(args);
  assert.strictEqual(r.status, 0, r.stderr);
  const text = fs.readFileSync(file, 'utf8');
  const doc = JSON.parse(text);
  assert.strictEqual(text, ix.canonical(doc));
  assert.deepStrictEqual(doc.data, DATA);
  assert.deepStrictEqual(doc.knownIssues, issues);

  // From the data zip's data.json: its knownIssues.
  const dataJson = path.join(path.dirname(file), 'data.json');
  const data = dataZip.read(path.join(FIX, 'good.zip')).data;
  fs.writeFileSync(dataJson, dataZip.canonical(data));
  assert.strictEqual(cli([...args, '--known-issues', dataJson]).status, 0);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).knownIssues, data.knownIssues);
  // A data.json without any: none.
  fs.writeFileSync(dataJson, dataZip.canonical({ format: 1, id: 'fake-vr', line: 'x' }));
  assert.strictEqual(cli([...args, '--known-issues', dataJson]).status, 0);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).knownIssues, []);
  // A known-issues.json: the list.
  assert.strictEqual(cli([...args, '--known-issues', path.join(FAKE, 'known-issues.json')]).status, 0);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).knownIssues, issues);

  const before = fs.readFileSync(file);
  assert.strictEqual(cli(['dvr-index.js', 'set-data', file, '--url', DATA.url, '--sha256', 'nope', '--size', '1', '--date', DATA.date]).status, 1, 'a bad hash');
  assert.strictEqual(cli(['dvr-index.js', 'set-data', file, '--url', DATA.url, '--sha256', DATA.sha256, '--size', '12kB', '--date', DATA.date]).status, 2, 'a bad size');
  assert.strictEqual(cli(['dvr-index.js', 'set-data', file, '--url', DATA.url]).status, 2, 'missing options');
  fs.writeFileSync(dataJson, '{"something": "else"}\n');
  assert.strictEqual(cli([...args, '--known-issues', dataJson]).status, 2, 'neither kind of file');
  assert.ok(fs.readFileSync(file).equals(before), 'unchanged after a refusal');
});
