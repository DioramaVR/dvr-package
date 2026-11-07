// node --test test/
// lib/modjson.js: game data checks and mod.json for the installer.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const mj = require('../lib/modjson');

const dataDir = path.join(__dirname, 'fixtures', 'data', 'fake-vr');
const build = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'build.json'), 'utf8'));
const fresh = () => mj.readGameData(dataDir);

test('the fixture data is fine, media files included', () => {
  const { game, issues } = fresh();
  assert.strictEqual(issues.length, 2);
  assert.deepStrictEqual(mj.checkGameData(game, issues, { dataDir }), []);
});

test('problems a schema alone can\'t see', () => {
  const { game, issues } = fresh();
  game.controls.push({ input: 'Right trigger', action: 'Again' });
  game.tutorial[1].controls.push('Left trigger', { input: 'Nope', action: 'x' });
  game.settings.options.push({ id: 'leftHanded', label: 'L', type: 'bool', cfg: { section: 'S', key: 'K' } });
  game.media = [{ file: 'media/missing.jpg', kind: 'image', role: 'gallery', alt: 'x' }];
  issues.push({ ...issues[0] });
  const ps = mj.checkGameData(game, issues, { dataDir });
  for (const re of [/controls\/4: input "Right trigger" is listed twice/, /tutorial\/1\/controls\/3: "Left trigger" isn't an input/, /tutorial\/1\/controls\/4: "Nope"/,
    /options\/1: id "leftHanded" is used twice/, /media: has no hero image/, /media\/0: data\/media\/missing.jpg doesn't exist/, /known-issues.json\/2: id "pretend-bug" is used twice/]) {
    assert.ok(ps.some((p) => re.test(p)), `${re} in\n${ps.join('\n')}`);
  }
  assert.ok(!mj.checkGameData(game, issues).some((p) => /doesn't exist/.test(p)), 'files are only checked with dataDir');
});

test('mod.json in the engine\'s shape', () => {
  const { game } = fresh();
  const mod = mj.toModJson(game, build());
  assert.deepStrictEqual(Object.keys(mod), ['id', 'name', 'game', 'appid', 'description', 'exe', 'loader', 'payload', 'plugin', 'loaderConfig', 'video',
    'launchArgs', 'steamAppIdFile', 'testedBuildIds', 'firstLaunch', 'sharedOptions', 'options', 'needToKnow', 'tutorial']);
  assert.strictEqual(mod.exe, 'FakeGame.exe');
  assert.strictEqual(mod.video, 'media/hover.webm');
  assert.deepStrictEqual(mod.loaderConfig, { 'Logging.Console': { Enabled: false } });
  assert.deepStrictEqual(mod.sharedOptions, game.settings.shared);
  assert.deepStrictEqual(mod.options, game.settings.options);
  assert.deepStrictEqual(mod.tutorial[1], {
    title: 'Move the table', text: 'Reach out and grab it.',
    controls: [['Either grip', 'Move the table'], ['Right stick', 'Pan around the table'], ['Right trigger', 'Click']],
  });
  assert.deepStrictEqual(mod.tutorial[0].controls, []);
  assert.deepStrictEqual(mj.namedFiles(mod), ['media/hover.webm']);
  assert.ok(mj.canonical(mod).endsWith('}\n') && !mj.canonical(mod).includes('\r'));
});

test('build.json holds only what the installer knows', () => {
  const { game } = fresh();
  assert.throws(() => mj.toModJson(game, { ...build(), exe: 'Other.exe', tutorial: [] }), /sets exe, tutorial, which game.json owns/);
  assert.throws(() => mj.toModJson(game, { ...build(), id: 'other-vr' }), /isn't game.json's "fake-vr"/);
  assert.throws(() => mj.toModJson(game, { plugin: {} }), /needs loader/);
  const uevr = mj.toModJson(game, { loader: { type: 'uevr', version: '1.0', url: 'https://example.org/u.zip', sha256: 'A'.repeat(64) }, uevr: { profile: 'P', process: 'P' }, plugin: { folder: 'DioramaVR/fake-vr' } });
  assert.deepStrictEqual(uevr.uevr, { profile: 'P', process: 'P' }, 'other installer fields pass through');
  assert.ok(!('payload' in uevr));
});

test('no hover video, no video field', () => {
  const { game } = fresh();
  game.media = game.media.filter((m) => m.role !== 'hover');
  const mod = mj.toModJson(game, build());
  assert.ok(!('video' in mod));
  assert.deepStrictEqual(mj.namedFiles(mod), []);
});
