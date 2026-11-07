'use strict';
// The writer (docs/SPEC.md section 3): makes a package zip from a built mod
// folder (mod.json, payload/, payload.json and the files mod.json names).
//
// payload.json is the build's receipt, written by dvr-actions' build:
// { commit, coreRepo, coreCommit, coreFrom, coreVersion, actionsCommit,
//   release: true, loader, builtAt }. It isn't packed; its fields become the
// manifest's coreVersion and source.
//
// A pack with a maturity is a release: it must come from a release build, be
// built against a core tag, carry licence notices, contain no Unity or game
// files, and be signed (DVR_SIGNING_KEY). Every pack is refused if the
// payload contains the build machine's home-folder path.
const fs = require('fs');
const path = require('path');
const zip = require('./zip');
const sign = require('./sign');
const reader = require('./reader');
const privacy = require('./privacy');
const { PackageError } = require('./errors');
const { today } = require('./version');

const { FORMAT, MANIFEST, SIGNATURE, MATURITIES, SOURCE_FIELDS } = reader;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Files under the payload that are Unity's or the game's own.
function unityFiles(payloadDir) {
  if (!fs.existsSync(payloadDir)) return [];
  return reader.walkFiles(payloadDir).filter((rel) => {
    const l = rel.toLowerCase();
    const base = l.split('/').pop();
    return l.startsWith('bepinex/unity-libs/') || /^unityengine.*\.dll$/.test(base) || base.startsWith('assembly-csharp');
  });
}

// Why a built mod folder can't be released: [{ code, message }], empty when
// it can. info is its payload.json.
function releaseProblems(modDir, mod, info) {
  const problems = [];
  // Only a release build of dvr-actions is released: it says so, and names a
  // clean actions commit (so the zip traces back to the tooling that made it).
  if (info.release !== true || typeof info.actionsCommit !== 'string' || !/^[0-9a-f]{7,40}$/.test(info.actionsCommit)) {
    problems.push({ code: 'not-release-build', message: "payload.json isn't from a release build (it needs release: true and a clean actionsCommit)" });
  }
  const coreMod = ['coreRepo', 'coreCommit', 'coreVersion', 'coreFrom'].some((k) => info[k] !== undefined);
  if (coreMod && (!info.coreVersion || info.coreFrom !== `tag v${info.coreVersion}`)) {
    problems.push({ code: 'core-not-tagged', message: `payload.json coreFrom is "${info.coreFrom ?? '(none)'}", not "tag v${info.coreVersion ?? '<coreVersion>'}": build against the core's release tag` });
  }
  const payloadDir = path.join(modDir, mod.payload || 'payload');
  if (!fs.existsSync(path.join(payloadDir, 'licenses', 'README.txt'))) {
    problems.push({ code: 'no-licences', message: 'the payload has no licenses/README.txt' });
  }
  const unity = unityFiles(payloadDir);
  if (unity.length) {
    problems.push({ code: 'unity-files', message: `the payload has Unity or game files, which can't ship: ${unity.slice(0, 5).join(', ')}${unity.length > 5 ? ` (+${unity.length - 5} more)` : ''}` });
  }
  return problems;
}

// What goes in the zip besides the manifest and signature: mod.json, the
// payload folder and the files mod.json names (video). Returns
// [{ name, file }] with forward-slash names.
function packEntries(modDir, mod) {
  const payload = mod.payload || 'payload';
  const named = [payload, ...[mod.video].filter(Boolean)];
  for (const n of named) {
    if (typeof n !== 'string' || reader.unsafePath(n)) throw new PackageError('unsafe-path', `mod.json names a path outside the package: ${n}`);
  }
  if (!fs.existsSync(path.join(modDir, payload))) throw new Error(`${mod.id} has no ${payload}/ folder; build it first`);
  const out = [{ name: 'mod.json', file: path.join(modDir, 'mod.json') }];
  for (const n of named) {
    const p = path.join(modDir, n);
    if (!fs.existsSync(p)) continue;
    const rel = n.replace(/\\/g, '/').replace(/\/$/, '');
    const rels = fs.statSync(p).isDirectory() ? reader.walkFiles(modDir, rel) : [rel];
    for (const r of rels) out.push({ name: r, file: path.join(modDir, r) });
  }
  for (const e of out) if (reader.unsafePath(e.name)) throw new PackageError('unsafe-path', `can't pack an unsafe path: ${e.name}`);
  return out;
}

// Makes <outDir>/<id>-<version>.zip from a built mod folder.
// opts:
//   version        default payload.json's
//   maturity       closed-beta | open-beta | stable: a release (see top);
//                  without one it's a dev pack, labelled closed-beta
//   date           YYYY-MM-DD, default today (UTC); also every zip timestamp
//   minAppVersion  required: the oldest installer that can install it
//   notes          one line
//   actionsCommit  for a dev pack whose payload.json has none
//   testedBuildIds default mod.json's
//   sign           sign a dev pack too (a release is always signed)
//   trustedKeys    for the signature's self-check (tests); default trusted-keys.json
//   needles        what privacy looks for (tests); default this machine's home folder
// Returns { zip, manifest, key } (key: the signing key id, or null).
function pack(modDir, outDir, opts = {}) {
  const mod = readJson(path.join(modDir, 'mod.json'));
  const infoFile = path.join(modDir, 'payload.json');
  const info = fs.existsSync(infoFile) ? readJson(infoFile) : {};
  const id = mod.id || path.basename(modDir);
  const release = opts.maturity !== undefined;
  if (release && !MATURITIES.includes(opts.maturity)) {
    throw new PackageError('format', `maturity must be ${MATURITIES.join(', ')}, not "${opts.maturity}"`);
  }
  if (!mod.loader?.type) throw new PackageError('format', `${id}'s mod.json has no loader type`);

  if (release) {
    const problems = releaseProblems(modDir, mod, info);
    if (problems.length) {
      throw new PackageError(problems[0].code, `not packing ${id} as a release:\n- ${problems.map((p) => p.message).join('\n- ')}`, problems.map((p) => `${p.code}: ${p.message}`));
    }
  }
  const entries = packEntries(modDir, mod);

  // Nothing that names the build machine's user, release or not.
  const hits = [];
  for (const e of entries) {
    const needle = privacy.findInBuffer(fs.readFileSync(e.file), opts.needles || privacy.privateNeedles());
    if (needle) hits.push(e.name);
  }
  if (hits.length) throw new PackageError('private-path', `the package would contain the build machine's home-folder path: ${hits.slice(0, 5).join(', ')}`, hits);

  const files = {};
  for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) files[e.name] = reader.sha256File(e.file);
  const source = {};
  for (const k of SOURCE_FIELDS) {
    const v = k === 'actionsCommit' ? info.actionsCommit || opts.actionsCommit : info[k];
    if (v !== undefined) source[k] = v;
  }
  // Key order as in docs/SPEC.md section 3; undefined fields are left out.
  const manifest = JSON.parse(JSON.stringify({
    format: FORMAT,
    id,
    version: opts.version || info.version,
    maturity: opts.maturity || 'closed-beta',
    date: opts.date || today(),
    coreVersion: info.coreVersion,
    appid: mod.appid,
    minAppVersion: opts.minAppVersion,
    loader: { type: mod.loader.type, version: mod.loader.version },
    testedBuildIds: opts.testedBuildIds || mod.testedBuildIds || undefined,
    notes: opts.notes || undefined,
    source,
    files,
  }));
  reader.checkManifest(manifest);
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  let sigLine = null;
  if (release || opts.sign) {
    if (!sign.hasKey()) throw new PackageError('unsigned', `${release ? 'a release' : 'this'} pack must be signed, and DVR_SIGNING_KEY is not set`);
    sigLine = sign.signBytes(bytes, { trustedKeys: opts.trustedKeys });
  }

  const zipPath = path.join(outDir, `${id}-${manifest.version}.zip`);
  zip.create(zipPath, [
    ...entries,
    { name: MANIFEST, data: bytes },
    ...(sigLine ? [{ name: SIGNATURE, data: sigLine }] : []),
  ], { date: manifest.date });
  return { zip: zipPath, manifest, key: sigLine ? JSON.parse(sigLine).key : null };
}

// The zip's release entry for a game's index (docs/SPEC.md section 5), less
// url, which the publisher adds.
function releaseEntry(manifest, zipPath) {
  return JSON.parse(JSON.stringify({
    version: manifest.version,
    maturity: manifest.maturity,
    date: manifest.date,
    coreVersion: manifest.coreVersion,
    minAppVersion: manifest.minAppVersion,
    testedBuildIds: manifest.testedBuildIds,
    notes: manifest.notes,
    sha256: reader.sha256File(zipPath),
    size: fs.statSync(zipPath).size,
    source: manifest.source,
  }));
}

// Checks a zip end to end (reader.checkZip). Returns { manifest, key }.
const checkZip = (zipPath, opts) => reader.checkZip(zipPath, opts);

module.exports = { pack, releaseProblems, releaseEntry, checkZip, unityFiles, packEntries };
