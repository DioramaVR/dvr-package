'use strict';
// Shared by make-fixtures.js and the tests: a fake mod (Fake Game, appid 4242,
// text files standing in for DLLs), the TEST-ONLY keys, and tools to rebuild
// a zip with one thing changed. Nothing here is a real game or a real key.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zip = require('../../lib/zip');

const KEYS = require('./test-keys.json');
// The trusted list the tests and fixtures use: the test key only.
const TRUSTED = [{ id: KEYS.trusted.id, spki: KEYS.trusted.spki }];
// The reader options expected.json's verdicts assume.
const READER_OPTS = { trustedKeys: TRUSTED, appVersion: '1.0.0' };
const DATE = '2026-11-20';

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

const MOD_JSON = {
  id: 'fake-vr', name: 'Fake Game VR', game: 'Fake Game', appid: 4242, exe: 'FakeGame.exe',
  loader: { type: 'bepinex5-mono', version: '5.4.23' },
  payload: 'payload',
  plugin: { folder: 'BepInEx/plugins/FakeVr', config: 'BepInEx/config/dvr.fake.cfg' },
  video: 'hover.webm',
  testedBuildIds: ['123456'],
};

// The receipt a dvr-actions release build writes.
const RELEASE_INFO = {
  commit: 'a1b2c3d', coreRepo: 'example/fake-core', coreCommit: 'e4f5a6b', coreFrom: 'tag v0.1.1', coreVersion: '0.1.1',
  actionsCommit: 'c7d8e9f', release: true, loader: MOD_JSON.loader, builtAt: '2026-11-20T10:00:00Z',
};

// A game's known-issues.json (test data).
const KNOWN_ISSUES = [
  { id: 'pitch-reset', title: 'Pitch resets after loading a save', text: 'Click the right stick to set it again.', severity: 'annoying', since: '0.9.0', fixedIn: null },
  { id: 'menu-flicker', title: 'The menu flickers on some headsets', text: 'Harmless.', severity: 'minor' },
];

// Release options for writer.pack.
const RELEASE_OPTS = { maturity: 'closed-beta', version: '1.0.0', minAppVersion: '0.2.0', date: DATE, trustedKeys: TRUSTED };

// A built mod folder, release-ready. change(dir) adjusts it.
function makeMod(dir, { info = RELEASE_INFO, mod = MOD_JSON, change } = {}) {
  fs.rmSync(dir, { recursive: true, force: true });
  write(path.join(dir, 'mod.json'), JSON.stringify(mod, null, 2) + '\n');
  write(path.join(dir, 'payload.json'), JSON.stringify(info, null, 2) + '\n');
  write(path.join(dir, 'hover.webm'), 'fake video\n');
  write(path.join(dir, 'build.json'), '{}\n'); // stays out of the zip
  write(path.join(dir, 'payload', 'BepInEx', 'core', 'BepInEx.dll'), 'fake loader\n');
  write(path.join(dir, 'payload', 'BepInEx', 'plugins', 'FakeVr', 'FakeVr.dll'), 'fake plugin\n');
  write(path.join(dir, 'payload', 'winhttp.dll'), 'fake proxy\n');
  write(path.join(dir, 'payload', 'licenses', 'README.txt'), 'Licences for Fake Game VR (test data)\n');
  if (change) change(dir);
  return dir;
}

// Runs fn with DVR_SIGNING_KEY set to a test key ('trusted' or 'unknown').
function withKey(which, fn) {
  const was = process.env.DVR_SIGNING_KEY;
  process.env.DVR_SIGNING_KEY = KEYS[which].pkcs8;
  try { return fn(); } finally {
    if (was === undefined) delete process.env.DVR_SIGNING_KEY; else process.env.DVR_SIGNING_KEY = was;
  }
}

// A signature line for bytes with a test key, no checks (for bad fixtures).
function sigLine(which, bytes) {
  const key = crypto.createPrivateKey({ key: Buffer.from(KEYS[which].pkcs8, 'base64'), format: 'der', type: 'pkcs8' });
  return JSON.stringify({ key: KEYS[which].id, sig: crypto.sign(null, Buffer.from(bytes), key).toString('base64') }) + '\n';
}

// A zip's entries as a Map(name -> Buffer), bad names included.
function readZip(zipPath) {
  return new Map(zip.readEntries(zipPath).map((e) => [e.name, e.data]));
}

// Writes a zip from a Map(name -> Buffer), names exactly as given.
function writeZip(zipPath, entries, date = DATE) {
  return zip.create(zipPath, [...entries].map(([name, data]) => ({ name, data })), { date });
}

// A copy of srcZip with fn(entries) applied (a Map you can edit).
function rewrap(srcZip, outZip, fn) {
  const entries = readZip(srcZip);
  fn(entries);
  return writeZip(outZip, entries);
}

// Changes the manifest (fn edits the parsed object) and re-signs it with a test key.
function editManifest(entries, fn, which = 'trusted') {
  const m = JSON.parse(entries.get('dvr-package.json').toString('utf8'));
  fn(m);
  const bytes = Buffer.from(JSON.stringify(m, null, 2) + '\n');
  entries.set('dvr-package.json', bytes);
  entries.set('dvr-package.sig', Buffer.from(sigLine(which, bytes)));
}

module.exports = {
  KEYS, TRUSTED, READER_OPTS, DATE, MOD_JSON, RELEASE_INFO, RELEASE_OPTS, KNOWN_ISSUES,
  write, makeMod, withKey, sigLine, readZip, writeZip, rewrap, editManifest,
};
