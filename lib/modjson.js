// A game's data/game.json (one source for every game fact, docs/SPEC.md
// section 7) plus the installer-only build settings (tools/release/build.json:
// loader, payload, plugin, ...) -> the mod.json the installer engine reads.
//
//   const { readGameData, checkGameData, toModJson, namedFiles } = require('./modjson');
//   const { game, issues } = readGameData('<game repo>/data');
//   const problems = checkGameData(game, issues, { dataDir });   // [] = fine
//   const mod = toModJson(game, build);                          // throws on a clash
//
// mod.json keeps the shape the engine reads today: tutorial controls become
// [input, action] pairs, settings become sharedOptions/options, install's
// fields move to the top level, and the hover video is "video".
'use strict';
const fs = require('fs');
const path = require('path');
const { validate } = require('./schemas');

// Fields game.json owns. A build.json naming one of them would make two
// sources for the same fact, so toModJson refuses it.
const GAME_OWNED = ['name', 'game', 'appid', 'description', 'exe', 'launchArgs', 'steamAppIdFile', 'loaderConfig',
  'video', 'testedBuildIds', 'firstLaunch', 'needToKnow', 'tutorial', 'options', 'sharedOptions'];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

// <dataDir>/game.json and known-issues.json (absent known-issues = none).
function readGameData(dataDir) {
  const game = readJson(path.join(dataDir, 'game.json'));
  const issuesFile = path.join(dataDir, 'known-issues.json');
  const issues = fs.existsSync(issuesFile) ? readJson(issuesFile) : [];
  return { game, issues };
}

// Every problem with the game data, as "where: what" strings: the schemas, then
// what a schema can't say. dataDir (optional) also checks that media files exist.
function checkGameData(game, issues = [], { dataDir } = {}) {
  const problems = [];
  const add = (where, msg) => problems.push(`${where}: ${msg}`);
  for (const p of validate(game, 'game')) add(`game.json${p.path === '/' ? '' : p.path}`, p.message);
  for (const p of validate(issues, 'known-issues')) add(`known-issues.json${p.path === '/' ? '' : p.path}`, p.message);

  const inputs = new Set();
  (Array.isArray(game?.controls) ? game.controls : []).forEach((c, i) => {
    if (typeof c?.input !== 'string') return;
    if (inputs.has(c.input)) add(`game.json/controls/${i}`, `input "${c.input}" is listed twice`);
    inputs.add(c.input);
  });
  (Array.isArray(game?.tutorial) ? game.tutorial : []).forEach((s, i) => {
    (Array.isArray(s?.controls) ? s.controls : []).forEach((c, j) => {
      const input = typeof c === 'string' ? c : c?.input;
      if (typeof input === 'string' && !inputs.has(input)) add(`game.json/tutorial/${i}/controls/${j}`, `"${input}" isn't an input in controls`);
    });
  });

  const options = game?.settings?.options;
  if (Array.isArray(options)) {
    const ids = new Set(Object.keys(game.settings.shared || {}));
    options.forEach((o, i) => {
      if (typeof o?.id !== 'string') return;
      if (ids.has(o.id)) add(`game.json/settings/options/${i}`, `id "${o.id}" is used twice`);
      ids.add(o.id);
    });
  }

  if (Array.isArray(game?.media)) {
    const roleCount = (r) => game.media.filter((m) => m?.role === r).length;
    if (!roleCount('hero')) add('game.json/media', 'has no hero image (role "hero")');
    if (roleCount('hover') > 1) add('game.json/media', 'has more than one hover video');
    if (dataDir) {
      game.media.forEach((m, i) => {
        for (const f of [m?.file, m?.poster]) {
          if (typeof f === 'string' && !f.includes('..') && !fs.existsSync(path.join(dataDir, f))) add(`game.json/media/${i}`, `data/${f} doesn't exist`);
        }
      });
    }
  }

  if (Array.isArray(issues)) {
    const ids = new Set();
    issues.forEach((k, i) => {
      if (typeof k?.id !== 'string') return;
      if (ids.has(k.id)) add(`known-issues.json/${i}`, `id "${k.id}" is used twice`);
      ids.add(k.id);
    });
  }
  return problems;
}

// A tutorial step's controls as the engine's [input, action] pairs: a bare
// input takes its action from the top-level controls; {input, action}
// rewords it for this step.
function tutorialFor(game) {
  const actions = new Map((game.controls || []).map((c) => [c.input, c.action]));
  return (game.tutorial || []).map((s, i) => ({
    title: s.title,
    text: s.text,
    controls: (s.controls || []).map((c, j) => {
      const input = typeof c === 'string' ? c : c.input;
      const action = (typeof c === 'object' && c.action) || actions.get(input);
      if (!action) throw new Error(`tutorial step ${i + 1}, control ${j + 1}: "${input}" isn't an input in controls`);
      return [input, action];
    }),
  }));
}

// The hover clip (media role "hover"), as a path inside the mod folder; the
// writer copies data/<file> there.
const hoverVideo = (game) => (game.media || []).find((m) => m.role === 'hover' && m.kind === 'video')?.file;

// mod.json from game.json and the installer-only build settings.
function toModJson(game, build = {}) {
  if (build.id !== undefined && build.id !== game.id) throw new Error(`build.json id "${build.id}" isn't game.json's "${game.id}"`);
  const clash = GAME_OWNED.filter((k) => k in build);
  if (clash.length) throw new Error(`build.json sets ${clash.join(', ')}, which game.json owns (one source per fact)`);
  if (!build.loader?.type || !build.loader?.version) throw new Error('build.json needs loader {type, version}');
  const install = game.install || {};
  const { id: _id, loader, payload, plugin, ...rest } = build;
  const mod = {
    id: game.id,
    name: game.name,
    game: game.game,
    appid: game.appid,
    description: game.description,
    exe: install.exe,
    loader,
    payload,
    plugin,
    loaderConfig: install.loaderConfig,
    video: hoverVideo(game),
    launchArgs: install.launchArgs,
    steamAppIdFile: install.steamAppIdFile,
    testedBuildIds: game.testedBuildIds,
    firstLaunch: game.firstLaunch,
    sharedOptions: game.settings?.shared,
    options: game.settings?.options,
    needToKnow: game.needToKnow,
    tutorial: tutorialFor(game),
    ...rest,
  };
  for (const k of Object.keys(mod)) if (mod[k] === undefined) delete mod[k];
  return mod;
}

// Files a mod.json names that must sit next to it (today: the video).
function namedFiles(mod) {
  return [mod.video].filter((f) => typeof f === 'string' && f);
}

const canonical = (doc) => JSON.stringify(doc, null, 2) + '\n';

module.exports = { readGameData, checkGameData, tutorialFor, toModJson, namedFiles, canonical, GAME_OWNED };
