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
  game.tutorial[1].controls.push('Left trigger', { input: 'Nope' });
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

test('with no controls table, {input, action} tutorial controls stand alone', () => {
  const { game, issues } = fresh();
  delete game.controls;
  for (const step of game.tutorial) step.controls = [{ input: 'Right trigger', action: 'Pick up' }];
  assert.deepStrictEqual(mj.checkGameData(game, issues, { dataDir }), []);
  assert.deepStrictEqual(mj.toModJson(game, build()).tutorial[0].controls[0], ['Right trigger', 'Pick up']);
  // A bare input, or {input} with no action, still needs the table.
  game.tutorial[0].controls.push('Right trigger', { input: 'Grip' });
  const ps = mj.checkGameData(game, issues, { dataDir });
  assert.ok(ps.some((p) => /tutorial\/0\/controls\/1: "Right trigger" isn't an input/.test(p)), ps.join('\n'));
  assert.ok(ps.some((p) => /tutorial\/0\/controls\/2: "Grip" isn't an input/.test(p)), ps.join('\n'));
  assert.strictEqual(ps.length, 2, ps.join('\n'));
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

test('the build recipe stays out of mod.json', () => {
  const { game } = fresh();
  const recipe = {
    ...build(), project: 'src/Fake/Fake.csproj', archive: ['src'], stripTargets: ['Deploy'], pluginFiles: ['out/Fake.dll'],
    _about: 'notes', loader: { ...build().loader, files: ['winhttp.dll'], from: 'somewhere' }, plugin: { ...build().plugin, extra: 1 },
  };
  const mod = mj.toModJson(game, recipe);
  for (const k of ['project', 'archive', 'stripTargets', 'pluginFiles', '_about']) assert.ok(!(k in mod), `${k} left out`);
  assert.deepStrictEqual(Object.keys(mod.loader).sort(), Object.keys(build().loader).sort());
  assert.ok(!('extra' in mod.plugin));
});

test('no hover video, no video field', () => {
  const { game } = fresh();
  game.media = game.media.filter((m) => m.role !== 'hover');
  const mod = mj.toModJson(game, build());
  assert.ok(!('video' in mod));
  assert.deepStrictEqual(mj.namedFiles(mod), []);
});

test('a folder mod: game.json install.folder becomes mod.json folder; the rules', () => {
  const { game, issues } = fresh();
  const folder = { target: 'documents', path: 'Fake Game/Mods/FakeVr' };
  const g = { ...game, install: { exe: 'FakeGame.exe', launchArgs: '-x', folder } };
  const b = { loader: { type: 'folder', version: '1' }, plugin: { folder: 'FakeVr', config: 'FakeVr/vr-menu.cfg' } };
  assert.deepStrictEqual(mj.checkGameData(g, issues), []);
  const mod = mj.toModJson(g, b);
  assert.deepStrictEqual(mod.folder, folder);
  assert.deepStrictEqual(mod.loader, { type: 'folder', version: '1' });
  assert.ok(!('loaderConfig' in mod));
  // build.json can't say where: game.json owns it.
  assert.throws(() => mj.toModJson(g, { ...b, folder }), /sets folder, which game.json owns/);
  // A folder build needs install.folder, and nothing to download or configure.
  assert.throws(() => mj.toModJson(game, b), /needs game\.json install\.folder/);
  assert.throws(() => mj.toModJson(g, { ...b, loader: { type: 'folder', version: '1', url: 'https://example.org/x.zip' } }), /nothing to download/);
  assert.throws(() => mj.toModJson({ ...g, install: { ...g.install, loaderConfig: { A: { b: 1 } } } }, b), /no loader to configure/);
  // install.folder with another loader is a mistake.
  assert.throws(() => mj.toModJson(g, build()), /only for loader type "folder"/);
  // Unsafe or unknown places are refused, by checkGameData and by toModJson.
  for (const bad of [{ target: 'documents', path: '../Mods' }, { target: 'documents', path: '/abs' }, { target: 'documents', path: 'C:/x' },
    { target: 'documents', path: 'a\\b' }, { target: 'documents', path: 'a\tb' }, { target: 'documents', path: 'a//b' }, { target: 'documents', path: '' }, { target: 'home', path: 'x' },
    { target: 'game', path: 'Mods/./x' }, { target: 'game', path: 'Mods/x.' }, { target: 'game', path: 'x', extra: 1 }]) {
    const gb = { ...g, install: { ...g.install, folder: bad } };
    assert.ok(mj.checkGameData(gb, issues).some((p) => p.startsWith('game.json/install/folder')), JSON.stringify(bad));
    assert.throws(() => mj.toModJson(gb, b), /install\.folder/, JSON.stringify(bad));
  }
  assert.strictEqual(require('../lib/folder').folderProblem({ target: 'game', path: 'Mods/Fake VR' }), null);
});
