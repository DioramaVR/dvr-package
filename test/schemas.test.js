// node --test test/
// lib/schemas.js: the validator, and the schemas against good and bad documents.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const s = require('../lib/schemas');

const data = path.join(__dirname, 'fixtures', 'data');
const read = (f) => JSON.parse(fs.readFileSync(path.join(data, f), 'utf8'));
const paths = (errs) => errs.map((e) => e.path);
const SHA = 'a'.repeat(64);
const source = { commit: 'a1b2c3d', coreRepo: 'example/core', coreCommit: 'e4f5a6b', coreFrom: 'tag v0.1.1', actionsCommit: 'c7d8e9f', builtAt: '2026-11-20T10:00:00Z' };

test('every schema loads and uses only keywords the validator supports', () => {
  assert.deepStrictEqual(s.names(), ['game', 'index', 'known-issues', 'manifest', 'registry', 'release-entry']);
  for (const n of s.names()) assert.doesNotThrow(() => s.load(n), n);
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'schemas'))) {
    const text = fs.readFileSync(path.join(__dirname, '..', 'schemas', f), 'utf8');
    assert.ok(!text.includes('\r'), `${f}: LF only`);
    assert.strictEqual(JSON.parse(text).$schema, 'https://json-schema.org/draft/2020-12/schema', f);
  }
});

test('the validator: types, enum, const, required, patterns, items, nesting', () => {
  const schema = {
    type: 'object', required: ['a'], additionalProperties: false,
    properties: {
      a: { type: 'integer', minimum: 1 }, b: { enum: ['x', 'y'] }, c: { const: true },
      d: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', pattern: '^[a-z]+$' } },
      e: { type: ['string', 'null'] }, f: { type: 'number', maximum: 2 },
    },
  };
  assert.deepStrictEqual(s.validate({ a: 1, b: 'x', c: true, d: ['ab'], e: null, f: 1.5 }, schema), []);
  const errs = s.validate({ a: 0, b: 'z', c: false, d: ['ab', 'ab', 'A'], e: 3, f: 3, g: 1 }, schema);
  assert.deepStrictEqual(paths(errs).sort(), ['/a', '/b', '/c', '/d', '/d/2', '/e', '/f', '/g'].sort());
  assert.match(s.validate({}, schema)[0].message, /needs "a"/);
  assert.match(s.validate([], schema)[0].message, /must be object \(is array\)/);
  assert.strictEqual(s.validate(1.5, { type: 'integer' }).length, 1);
  assert.deepStrictEqual(s.validate(2, { type: 'number' }), []);
});

test('the validator: anyOf, oneOf, not, if/then/else, propertyNames, $ref', () => {
  const schema = {
    $defs: { small: { type: 'integer', maximum: 9 } },
    type: 'object',
    properties: {
      any: { anyOf: [{ type: 'string' }, { $ref: '#/$defs/small' }] },
      one: { oneOf: [{ type: 'integer' }, { type: 'number' }] },
      not: { not: { const: 'no' } },
    },
    propertyNames: { pattern: '^[a-z]+$' },
    if: { required: ['kind'], properties: { kind: { const: 'big' } } }, then: { required: ['size'] }, else: { not: { required: ['size'] } },
  };
  assert.deepStrictEqual(s.validate({ any: 'x', one: 1.5, not: 'yes' }, schema), []);
  assert.deepStrictEqual(paths(s.validate({ any: 10 }, schema)), ['/any']);
  assert.match(s.validate({ one: 2 }, schema)[0].message, /more than one/);
  assert.deepStrictEqual(paths(s.validate({ not: 'no' }, schema)), ['/not']);
  assert.deepStrictEqual(paths(s.validate({ Bad: 1 }, schema)), ['/Bad']);
  assert.match(s.validate({ kind: 'big' }, schema)[0].message, /needs "size"/);
  assert.strictEqual(s.validate({ kind: 'small', size: 1 }, schema).length, 1);
  assert.throws(() => s.validate(1, { $ref: '#/$defs/missing' }), /doesn't resolve/);
});

test('a schema with an unsupported keyword is refused, not half-checked', () => {
  assert.throws(() => s.validate('x', { type: 'string', format: 'email' }), /keyword "format" isn't supported/);
  assert.throws(() => s.validate({}, { properties: { a: { dependentRequired: {} } } }), /\/properties\/a: keyword "dependentRequired"/);
});

test('check() throws with every problem listed', () => {
  assert.strictEqual(s.check([], 'known-issues').length, 0);
  try {
    s.check({ format: 1 }, 'registry');
    assert.fail('should throw');
  } catch (e) {
    assert.strictEqual(e.code, 'schema');
    assert.match(e.message, /registry: 1 problem\(s\)\n {2}\/: needs "games"/);
  }
});

test('game.json: the fixture is valid; bad fields are caught', () => {
  const game = read('fake-vr/game.json');
  assert.deepStrictEqual(s.validate(game, 'game'), []);
  const bad = {
    ...game, id: 'Fake VR', appid: 0, testedBuildIds: [], controls: [],
    media: [{ file: '../secret.jpg', kind: 'sound', alt: 'x' }, { file: 'C:/x.jpg', kind: 'image', alt: 'x' }, { file: 'media\\a.jpg', kind: 'image', alt: 'x' }],
    settings: { options: [{ id: 'q', label: 'Q', type: 'choice', cfg: { section: 'S', key: 'K' } }, { id: 'n', label: 'N', type: 'number', cfg: { section: 'S', key: 'K' } }] },
  };
  const ps = paths(s.validate(bad, 'game'));
  for (const p of ['/id', '/appid', '/testedBuildIds', '/controls', '/media/0/file', '/media/0/kind', '/media/1/file', '/media/2/file', '/settings/options/0', '/settings/options/1']) {
    assert.ok(ps.includes(p), `${p} in ${ps.join(', ')}`);
  }
  assert.deepStrictEqual(paths(s.validate({ ...game, credits: ['Built on BepInEx'] }, 'game')), ['/credits/0'], 'credits are objects (SPEC 7)');
  assert.deepStrictEqual(s.validate({ ...game, siteOnly: 1 }, 'game'), [], 'unknown fields are ignored (SPEC 2)');
});

test('known-issues.json', () => {
  assert.deepStrictEqual(s.validate(read('fake-vr/known-issues.json'), 'known-issues'), []);
  const ps = s.validate([{ id: 'x', title: 'T', text: 'T', severity: 'fatal', since: '1.0.0-beta', fixedIn: 'soon' }, { title: 'T' }], 'known-issues');
  assert.deepStrictEqual(paths(ps).sort(), ['/0/fixedIn', '/0/severity', '/0/since', '/1', '/1', '/1'].sort());
  assert.deepStrictEqual(s.validate([{ id: 'x', title: 'T', text: 'T', severity: 'minor', fixedIn: null }], 'known-issues'), []);
});

const manifest = () => ({
  format: 1, id: 'fake-vr', version: '1.0.0', maturity: 'closed-beta', date: '2026-11-20', coreVersion: '0.1.1', appid: 4242,
  minAppVersion: '0.2.0', loader: { type: 'bepinex6-il2cpp', version: '6.0.0-be.791' }, testedBuildIds: ['123456'], notes: 'One line.',
  source: { ...source }, files: { 'mod.json': SHA.toUpperCase(), 'payload/BepInEx/plugins/FakeVr/FakeVr.dll': SHA },
});

test('manifest (dvr-package.json)', () => {
  assert.deepStrictEqual(s.validate(manifest(), 'manifest'), []);
  const m = manifest();
  Object.assign(m, { format: 2, version: '1.0.0-beta.1', maturity: 'beta', date: '2026-13-01', installerCommit: 'x' });
  m.files['dvr-package.sig'] = SHA;
  m.files['payload/x'] = 'not-a-hash';
  delete m.source.actionsCommit;
  const ps = paths(s.validate(m, 'manifest'));
  for (const p of ['/format', '/version', '/maturity', '/date', '/files/dvr-package.sig', '/files/payload~1x', '/source']) assert.ok(ps.includes(p), `${p} in ${ps.join(', ')}`);
  assert.ok(!ps.includes('/installerCommit'), 'unknown fields are ignored');
  const noCore = manifest();
  delete noCore.coreVersion; delete noCore.source.coreRepo; delete noCore.source.coreCommit; delete noCore.source.coreFrom;
  assert.deepStrictEqual(s.validate(noCore, 'manifest'), [], 'a mod without the core');
  assert.ok(paths(s.validate({ ...manifest(), source: { ...source, coreRepo: 'no-slash' } }, 'manifest')).includes('/source/coreRepo'));
});

const entry = () => ({ version: '1.0.0', maturity: 'stable', date: '2026-11-20', coreVersion: '0.1.1', minAppVersion: '0.2.0', testedBuildIds: ['123456'], source: { ...source }, sha256: SHA, size: 31234567 });

test('release entry and index', () => {
  assert.deepStrictEqual(s.validate(entry(), 'release-entry'), []);
  assert.deepStrictEqual(s.validate({ ...entry(), maturity: 'closed-beta' }, 'release-entry'), [], 'pack writes one for every maturity');
  assert.deepStrictEqual(paths(s.validate({ ...entry(), url: 'http://example.org/x.zip', size: 0 }, 'release-entry')).sort(), ['/size', '/url']);
  assert.deepStrictEqual(s.validate({ ...entry(), url: 'http://127.0.0.1:8080/x.zip' }, 'release-entry'), [], 'plain http to this PC (tests)');

  const index = { format: 1, id: 'fake-vr', name: 'Fake Game VR', game: 'Fake Game', appid: 4242, description: 'Short.',
    releases: [{ ...entry(), url: 'https://example.org/fake-vr-1.0.0.zip' }], knownIssues: read('fake-vr/known-issues.json') };
  assert.deepStrictEqual(s.validate(index, 'index'), []);
  const closed = { ...index, releases: [{ ...index.releases[0], maturity: 'closed-beta' }, { ...entry() }] };
  assert.deepStrictEqual(paths(s.validate(closed, 'index')).sort(), ['/releases/0/maturity', '/releases/1'], 'never closed-beta; url required');
});

test('registry', () => {
  const reg = read('registry.json');
  assert.deepStrictEqual(s.validate(reg, 'registry'), []);
  const bad = JSON.parse(JSON.stringify(reg));
  bad.games[0].index = undefined; delete bad.games[0].index;           // stable needs index
  bad.games[1].index = 'https://example.org/other/index.json';         // coming must not have one
  bad.games[1].closedBeta = false;
  bad.waves[0].status = 'closed-beta';
  bad.movedTo = 'ftp://example.org/registry.json';
  bad.announcements = [{ id: 'a', from: '2026-12-01', until: '2026-12-02', title: 'T', text: 'T', appVersions: '~0.3' }];
  const ps = paths(s.validate(bad, 'registry'));
  for (const p of ['/games/0', '/games/1', '/games/1/closedBeta', '/waves/0/status', '/movedTo', '/announcements/0/appVersions']) assert.ok(ps.includes(p), `${p} in ${ps.join(', ')}`);
  for (const v of ['<0.3.0', '<=1', '>2.0', '>=0.2.0', '=0.2.0']) {
    assert.deepStrictEqual(s.validate({ ...reg, announcements: [{ id: 'a', from: '2026-12-01', until: '2026-12-02', title: 'T', text: 'T', appVersions: v }] }, 'registry'), [], v);
  }
});
