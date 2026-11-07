// node --test test/
// lib/index-writer.js and lib/registry.js, and their command-line tools.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const ix = require('../lib/index-writer');
const reg = require('../lib/registry');
const mj = require('../lib/modjson');

const data = path.join(__dirname, 'fixtures', 'data');
const dataDir = path.join(data, 'fake-vr');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-package-schemas-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const SHA = 'B'.repeat(64);
const source = { commit: 'a1b2c3d', coreRepo: 'example/core', coreCommit: 'e4f5a6b', coreFrom: 'tag v0.1.1', actionsCommit: 'c7d8e9f', builtAt: '2026-11-20T10:00:00Z' };
const entry = (version, maturity = 'open-beta', extra = {}) => ({ version, maturity, date: '2026-11-20', coreVersion: '0.1.1', minAppVersion: '0.2.0', source, sha256: SHA, size: 1234, ...extra });
const url = (v) => `https://example.org/releases/v${v}/fake-vr-${v}.zip`;

test('index: a first release, then a second; earlier ones kept as they were', () => {
  const { game, issues } = mj.readGameData(dataDir);
  const one = ix.addRelease({ game, issues, prev: {}, entry: entry('1.0.0'), url: url('1.0.0') });
  assert.deepStrictEqual(Object.keys(one), ['format', 'id', 'name', 'game', 'appid', 'description', 'releases', 'knownIssues']);
  assert.strictEqual(one.description, game.tagline);
  assert.deepStrictEqual(Object.keys(one.releases[0]), ['version', 'maturity', 'date', 'coreVersion', 'minAppVersion', 'testedBuildIds', 'url', 'sha256', 'size', 'source']);
  assert.deepStrictEqual(one.releases[0].testedBuildIds, ['123456'], 'from game.json when the entry has none');
  assert.deepStrictEqual(Object.keys(one.releases[0].source), ['commit', 'coreRepo', 'coreCommit', 'coreFrom', 'actionsCommit', 'builtAt']);
  assert.deepStrictEqual(one.knownIssues, issues);

  const two = ix.addRelease({ game, issues: [], prev: one, entry: entry('1.1.0', 'stable', { testedBuildIds: ['654321'], notes: 'From the entry.' }), url: url('1.1.0'), notes: 'Given here.' });
  assert.deepStrictEqual(two.releases.map((r) => r.version), ['1.1.0', '1.0.0']);
  assert.deepStrictEqual(two.releases[1], one.releases[0]);
  assert.strictEqual(two.releases[0].notes, 'Given here.', 'notes given here win');
  assert.deepStrictEqual(two.releases[0].testedBuildIds, ['654321']);
  assert.deepStrictEqual(two.knownIssues, []);
  assert.deepStrictEqual(ix.checkIndex(two), []);
});

test('index: what addRelease refuses', () => {
  const { game, issues } = mj.readGameData(dataDir);
  const one = ix.addRelease({ game, issues, prev: {}, entry: entry('1.0.0'), url: url('1.0.0') });
  assert.throws(() => ix.addRelease({ game, issues, prev: one, entry: entry('1.0.0'), url: url('1.0.0') }), /1.0.0 is already listed/);
  assert.throws(() => ix.addRelease({ game, issues, prev: {}, entry: entry('1.0.0', 'closed-beta'), url: url('1.0.0') }), /closed-beta is never listed/);
  assert.throws(() => ix.addRelease({ game, issues, prev: {}, entry: entry('1.0.0-beta.1'), url: url('1') }), /release entry:\n {2}\/version/);
  assert.throws(() => ix.addRelease({ game, issues, prev: {}, entry: entry('1.0.0'), url: 'http://example.org/x.zip' }), /\/url/);
  assert.throws(() => ix.addRelease({ game, issues, prev: { ...one, id: 'other-vr' }, entry: entry('1.1.0'), url: url('1.1.0') }), /for "other-vr"/);
  assert.throws(() => ix.addRelease({ game, issues: [{ id: 'x' }], prev: {}, entry: entry('1.0.0'), url: url('1.0.0') }), /new index:\n {2}\/knownIssues\/0/);
});

test('index: promotion changes the maturity and nothing else', () => {
  const { game, issues } = mj.readGameData(dataDir);
  let doc = ix.addRelease({ game, issues, prev: {}, entry: entry('1.0.0'), url: url('1.0.0') });
  doc = ix.addRelease({ game, issues, prev: doc, entry: entry('1.1.0'), url: url('1.1.0') });
  const promoted = ix.setMaturity(doc, '1.0.0', 'stable');
  assert.deepStrictEqual({ ...promoted.releases[1], maturity: 'open-beta' }, doc.releases[1]);
  assert.deepStrictEqual(promoted.releases[0], doc.releases[0]);
  assert.strictEqual(doc.releases[1].maturity, 'open-beta', 'the input is left alone');
  assert.throws(() => ix.setMaturity(doc, '9.9.9', 'stable'), /isn't listed/);
  assert.throws(() => ix.setMaturity(doc, '1.0.0', 'closed-beta'), /open-beta or stable/);
  const dup = { ...doc, releases: [doc.releases[0], doc.releases[0]] };
  assert.match(ix.checkIndex(dup)[0].message, /listed twice/);
});

test('registry: an edit changes only the fields it names', () => {
  const file = path.join(data, 'registry.json');
  const doc = reg.read(file);
  const before = reg.canonical(doc);
  const next = reg.setGame(doc, 'other-vr', { status: 'open-beta', index: 'https://example.org/other-vr/index.json', closedBeta: null });
  assert.strictEqual(reg.canonical(doc), before, 'the input is left alone');
  const expected = JSON.parse(before);
  Object.assign(expected.games[1], { status: 'open-beta', index: 'https://example.org/other-vr/index.json' });
  delete expected.games[1].closedBeta;
  assert.strictEqual(reg.canonical(next), reg.canonical(expected));
  assert.strictEqual(next.games[1].siteNote, 'an unknown field, kept as is');
  assert.deepStrictEqual(Object.keys(next.games[1]), ['id', 'name', 'game', 'appid', 'status', 'wave', 'siteNote', 'index'], 'existing keys keep their place');
});

test('registry: adding, removing and refusing', () => {
  const doc = reg.read(path.join(data, 'registry.json'));
  const { game } = mj.readGameData(dataDir);
  const added = reg.setGame(doc, 'third-vr', { name: 'Third VR', game: 'Third', appid: 4244, status: 'coming', wave: '1' });
  assert.strictEqual(added.games.at(-1).id, 'third-vr');
  assert.throws(() => reg.setGame(doc, 'fourth-vr', { name: 'Fourth VR', status: 'coming' }), /needs "game"[\s\S]*needs "appid"/);
  assert.throws(() => reg.setGame(doc, 'fake-vr', { status: 'coming' }), /\/games\/0/, 'coming with an index');
  assert.throws(() => reg.setGame(doc, 'fake-vr', { wave: 'nope' }), /wave "nope" isn't in waves/);
  assert.throws(() => reg.setGame(doc, 'fake-vr', { index: null }), /games\/0/, 'stable needs its index');
  assert.deepStrictEqual(reg.removeGame(doc, 'other-vr').games.map((g) => g.id), ['fake-vr']);
  assert.throws(() => reg.removeGame(doc, 'nope'), /no game "nope"/);
  assert.strictEqual(reg.syncGame(doc, { ...game, name: 'Renamed VR' }).games[0].name, 'Renamed VR');

  assert.strictEqual(reg.setWave(doc, '1', { name: 'December' }).waves[1].name, 'December');
  assert.throws(() => reg.removeWave(doc, '1'), /wave "1" isn't in waves/, 'a game still uses it');

  const rel = { version: '0.3.0', date: '2026-12-20', url: 'https://example.org/Setup-0.3.0.exe', size: 2, sha256: SHA };
  const up = reg.addAppRelease(doc, rel);
  assert.deepStrictEqual(up.app.releases.map((r) => r.version), ['0.3.0', '0.2.0']);
  assert.strictEqual(up.app.latest, '0.2.0', 'latest only moves when asked');
  assert.strictEqual(reg.addAppRelease(doc, rel, { latest: true }).app.latest, '0.3.0');
  assert.throws(() => reg.addAppRelease(up, rel), /already listed/);
  const old = { ...doc, app: { ...doc.app, releases: [...doc.app.releases, { ...rel, version: '0.9.0' }] } };
  assert.match(reg.checkRegistry(old)[0].message, /newest first/);
  assert.throws(() => reg.setApp(doc, { releases: [] }), /addAppRelease/);
  assert.strictEqual(reg.setApp(doc, { url: 'https://example.org/get/' }).app.url, 'https://example.org/get/');

  const a = { id: 'hello', from: '2026-12-01', until: '2026-12-02', title: 'Hello', text: 'Plain text.' };
  const withA = reg.addAnnouncement(doc, a);
  assert.throws(() => reg.addAnnouncement(withA, a), /already exists/);
  assert.throws(() => reg.addAnnouncement(doc, { ...a, id: 'b', until: '2026-11-30' }), /is before from/);
  assert.deepStrictEqual(reg.removeAnnouncement(withA, 'hello').announcements, []);
  assert.strictEqual(reg.setMovedTo(doc, 'https://example.net/registry.json').movedTo, 'https://example.net/registry.json');
  assert.throws(() => reg.setMovedTo(doc, 'http://example.net/registry.json'), /movedTo/);
});

test('registry: write is canonical with LF, and refuses an invalid document', () => {
  const file = path.join(tmp, 'registry.json');
  const doc = reg.read(path.join(data, 'registry.json'));
  reg.write(file, doc);
  const text = fs.readFileSync(file, 'utf8');
  assert.strictEqual(text, JSON.stringify(doc, null, 2) + '\n');
  assert.ok(!text.includes('\r'));
  assert.throws(() => reg.write(file, { format: 2, games: [] }), /format/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), text, 'unchanged after a refusal');
  assert.deepStrictEqual(fs.readdirSync(tmp).filter((f) => f.endsWith('.tmp')), []);
});

// ---- the command-line tools ----
const bin = (name, args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', name), ...args], { encoding: 'utf8' });

test('dvr-index: add, promote, check, check-data, mod-json', () => {
  const out = path.join(tmp, 'site', 'fake-vr', 'index.json');
  const e = path.join(tmp, 'fake-vr-1.0.0.release.json');
  fs.writeFileSync(e, JSON.stringify(entry('1.0.0')));
  let r = bin('dvr-index.js', ['add', dataDir, '-', out, '--entry', e, '--url', url('1.0.0')]);
  assert.strictEqual(r.status, 0, r.stderr);
  r = bin('dvr-index.js', ['add', dataDir, out, out, '--entry', JSON.stringify(entry('1.1.0')), '--url', url('1.1.0'), '--notes', 'Second.']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(readJson(out).releases.map((x) => x.version), ['1.1.0', '1.0.0']);
  r = bin('dvr-index.js', ['add', dataDir, out, out, '--entry', JSON.stringify(entry('1.1.0')), '--url', url('1.1.0')]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /already listed/);
  assert.strictEqual(bin('dvr-index.js', ['promote', out, '1.0.0', 'stable']).status, 0);
  assert.strictEqual(readJson(out).releases[1].maturity, 'stable');
  assert.ok(!fs.readFileSync(out, 'utf8').includes('\r'));
  assert.strictEqual(bin('dvr-index.js', ['check', out]).status, 0);

  r = bin('dvr-index.js', ['check-data', dataDir]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /fake-vr: game.json and known-issues.json are fine \(4 controls, 3 tutorial steps, 2 media, 2 known issues\)/);

  const mod = path.join(tmp, 'mod', 'mod.json');
  r = bin('dvr-index.js', ['mod-json', dataDir, path.join(dataDir, 'build.json'), mod]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(readJson(mod).video, 'media/hover.webm');

  assert.strictEqual(bin('dvr-index.js', []).status, 2);
  assert.match(bin('dvr-index.js', ['nope']).stderr, /dvr-index add/);
});

test('dvr-index check-data: lists every problem', () => {
  const copy = path.join(tmp, 'bad-data');
  fs.cpSync(dataDir, copy, { recursive: true });
  const g = readJson(path.join(copy, 'game.json'));
  g.tutorial[2].controls.push('Missing input');
  delete g.firstLaunch;
  fs.writeFileSync(path.join(copy, 'game.json'), JSON.stringify(g));
  fs.rmSync(path.join(copy, 'media', 'hero.jpg'));
  const r = bin('dvr-index.js', ['check-data', copy]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /3 problem\(s\)/);
  assert.match(r.stderr, /needs "firstLaunch"/);
  assert.match(r.stderr, /"Missing input" isn't an input/);
  assert.match(r.stderr, /data\/media\/hero.jpg doesn't exist/);
});

test('dvr-registry: edits from the command line', () => {
  const file = path.join(tmp, 'cli-registry.json');
  fs.copyFileSync(path.join(data, 'registry.json'), file);
  let r = bin('dvr-registry.js', ['set-game', file, 'other-vr', 'status=open-beta', 'index=https://example.org/other-vr/index.json', 'closedBeta=false']);
  assert.strictEqual(r.status, 0, r.stderr);
  let doc = readJson(file);
  assert.strictEqual(doc.games[1].status, 'open-beta');
  assert.ok(!('closedBeta' in doc.games[1]));
  assert.strictEqual(doc.games[1].wave, '1', 'still a string');
  r = bin('dvr-registry.js', ['set-game', file, 'third-vr', 'name=Third VR', 'game=Third', 'appid=4244', 'status=coming', 'wave=1']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(readJson(file).games[2].appid, 4244);
  r = bin('dvr-registry.js', ['set-game', file, 'fake-vr', '--from-game', path.join(dataDir, 'game.json'), 'status=stable']);
  assert.strictEqual(r.status, 0, r.stderr);
  r = bin('dvr-registry.js', ['add-app-release', file, JSON.stringify({ version: '0.3.0', date: '2026-12-20', url: 'https://example.org/Setup-0.3.0.exe', size: 2, sha256: SHA }), '--latest']);
  assert.strictEqual(r.status, 0, r.stderr);
  doc = readJson(file);
  assert.strictEqual(doc.app.latest, '0.3.0');
  const before = fs.readFileSync(file, 'utf8');
  r = bin('dvr-registry.js', ['set-game', file, 'fake-vr', 'wave=nope']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /wave "nope" isn't in waves/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'a refused edit writes nothing');
  assert.strictEqual(bin('dvr-registry.js', ['set-game', file, 'fake-vr', 'appid=abc']).status, 2);
  assert.strictEqual(bin('dvr-registry.js', ['check', file]).status, 0);
  assert.strictEqual(bin('dvr-registry.js', ['moved-to', file, 'null']).status, 0);
  assert.strictEqual(readJson(file).movedTo, null);
});
