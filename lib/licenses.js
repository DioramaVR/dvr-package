'use strict';
// Licence notices for a mod payload: writes payload/licenses/<id>.txt for each
// component the payload ships, and payload/licenses/README.txt.
//
// The data is always given explicitly (opts.data, a folder holding
// components.json and the licence texts), so the notices match the build:
// nothing is found relative to this file.
//
// <data>/components.json:
//   title       the package's name, for README.txt ("Fake Game VR")
//   notice      optional line for README.txt (e.g. the unofficial-fan-mod note)
//   components  [{id, name, version, license, copyright, source, text,
//                 extraTexts?, includes?, lgpl?, mod?, files, pin?}]
//               text / extraTexts: paths relative to <data>, or "payload:<path>"
//               for a licence file the payload ships itself. The component with
//               "mod": true gets opts.version as its version.
//   neverShipped globs that must never be in a payload (Unity's, the game's)
//   pins        SHA-256 of each pinned file, written with opts.pin
//
// It refuses (PackageError, every problem in .details):
//   'unity-files'  a neverShipped file is in the payload (allowUnityLibs turns
//                  BepInEx/unity-libs/ into a warning, for the installer's
//                  bundled builds only; packages never pass it);
//   'no-licences'  a shipped file no component covers, or a pinned file whose
//                  SHA-256 changed (a new version may have a new licence:
//                  check it, then re-pin with opts.pin).
// The notice files use CRLF line ends (they're read on Windows).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PackageError } = require('./errors');

// A glob ("**", "*", "?"; case-insensitive) as a RegExp over forward-slash paths.
function globToRegExp(g) {
  return new RegExp('^' + g.split('/').map((part) => (part === '**' ? '\u0000'
    : part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))).join('/')
    .replace(/\u0000\//g, '(?:.*/)?').replace(/\/\u0000/g, '(?:/.*)?').replace(/\u0000/g, '.*') + '$', 'i');
}
const matches = (globs, f) => (globs || []).some((g) => globToRegExp(g).test(f));

function listPayload(dir, rel = '') {
  const r = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (p === 'licenses') continue; // ours, rewritten below
    if (e.isDirectory()) r.push(...listPayload(dir, p)); else r.push(p);
  }
  return r;
}

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// opts: data (required), version (default "unreleased"), pin, allowUnityLibs.
// Returns { components, files, warnings, pinned }.
function writeNotices(payload, opts = {}) {
  const dataDir = opts.data;
  const version = opts.version || 'unreleased';
  if (!dataDir) throw new Error('licenses: the data folder (opts.data) is required');
  if (!payload || !fs.existsSync(payload)) throw new Error(`licenses: no payload folder ${payload}`);
  const dataFile = path.join(dataDir, 'components.json');
  if (!fs.existsSync(dataFile)) throw new Error(`licenses: no components.json in ${dataDir}`);
  const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const files = listPayload(payload);
  const warnings = [];
  const unity = [];
  const uncovered = [];

  // Never distributed: the player's own copies of Unity's and the game's files.
  let unityLibs = 0;
  for (const f of files) {
    if (!matches(data.neverShipped, f)) continue;
    if (opts.allowUnityLibs && f.startsWith('BepInEx/unity-libs/')) unityLibs++;
    else unity.push(`${f}: Unity's or the game's own file; it must not be in a package`);
  }
  if (unityLibs) warnings.push(`${unityLibs} files in BepInEx/unity-libs (Unity's own; allowed by allowUnityLibs, not listed)`);

  // Every other file belongs to a component.
  const shipped = new Map(); // id -> files
  for (const f of files) {
    if (matches(data.neverShipped, f)) continue;
    const c = data.components.find((x) => matches(x.files, f));
    if (!c) { uncovered.push(`${f}: not covered by any component in components.json`); continue; }
    if (!shipped.has(c.id)) shipped.set(c.id, []);
    shipped.get(c.id).push(f);
  }

  // Pins.
  data.pins = data.pins || {};
  for (const c of data.components) {
    if (!shipped.has(c.id)) continue;
    for (const p of c.pin || []) {
      if (!fs.existsSync(path.join(payload, p))) { uncovered.push(`${p}: pinned for ${c.id} but not in the payload`); continue; }
      const h = sha(path.join(payload, p));
      if (opts.pin) data.pins[p] = h;
      else if (!data.pins[p]) uncovered.push(`${p}: not pinned yet (check ${c.id}'s licence and version, then pin)`);
      else if (data.pins[p] !== h) uncovered.push(`${p}: changed since its licence was checked (check ${c.id}'s licence and version in components.json, then pin)`);
    }
  }

  if (unity.length) throw new PackageError('unity-files', `licences: ${unity.length} file(s) that must never ship`, [...unity, ...uncovered]);
  if (uncovered.length) throw new PackageError('no-licences', `licences: ${uncovered.length} problem(s)`, uncovered);
  if (opts.pin) fs.writeFileSync(dataFile, JSON.stringify(data, null, 2) + '\n');

  // The notices.
  const text = (ref) => (ref.startsWith('payload:')
    ? fs.readFileSync(path.join(payload, ref.slice(8)), 'utf8')
    : fs.readFileSync(path.join(dataDir, ref), 'utf8'));
  const out = path.join(payload, 'licenses');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out);
  const index = [];
  for (const c of data.components) {
    const got = shipped.get(c.id);
    if (!got) continue;
    const v = c.mod ? version : c.version;
    const head = [
      c.name,
      '='.repeat(Math.min(78, c.name.length)),
      `Version:   ${v}`,
      `Licence:   ${c.license}`,
      `Copyright: ${c.copyright}`,
      `Source:    ${c.source}`,
      ...(c.includes ? [`Includes:  ${c.includes}`] : []),
      ...(c.lgpl ? ['', c.lgpl] : []),
      '',
      'Files in this package:',
      ...(got.length > 12 ? [`  ${got.length} files under ${[...new Set(got.map((f) => f.split('/')[0]))].join(', ')}/`] : got.map((f) => '  ' + f)),
      '',
      '-'.repeat(78),
      '',
    ];
    const body = [c.text, ...(c.extraTexts || [])].map(text).join('\n' + '-'.repeat(78) + '\n\n');
    fs.writeFileSync(path.join(out, `${c.id}.txt`), head.join('\r\n') + body.replace(/\r?\n/g, '\r\n'));
    index.push(`${c.name}\r\n    ${v}; ${c.license}; ${c.source}\r\n    licenses/${c.id}.txt`);
  }
  fs.writeFileSync(path.join(out, 'README.txt'), [
    `Licences for ${data.title || 'this mod'} ${version}`,
    '',
    'Everything in this package, with its version, licence and source. Each',
    'file here has the full licence text as the component publishes it.',
    ...(data.notice ? [data.notice] : []),
    "Unity's and the game's own files are never included: the mod loader",
    'reads or downloads them on your PC.',
    '',
    ...index.flatMap((l) => [l, '']),
  ].join('\r\n'));
  return { components: index.length, files: files.length, warnings, pinned: opts.pin ? Object.keys(data.pins).length : 0 };
}

module.exports = { writeNotices, globToRegExp };
