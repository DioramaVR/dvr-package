'use strict';
// The reader (docs/SPEC.md sections 3, 4, 8): checks a package zip and unpacks
// it. Every refusal is a PackageError with a code from section 9.
//
// Order, as section 8 has it: list the entries and refuse unsafe paths before
// extracting; extract into a temp folder; read the manifest (format, fields,
// minAppVersion); verify the signature; check the file list and every hash;
// check mod.json agrees; only then move the folder into place, with .ok
// written last. A failure at any step leaves nothing behind.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zip = require('./zip');
const sign = require('./sign');
const { PackageError } = require('./errors');
const { isPlainVersion, compareVersions, isDate, isId } = require('./version');

const FORMAT = 1;
const MANIFEST = 'dvr-package.json';
const SIGNATURE = 'dvr-package.sig';
const OK = '.ok'; // our marker in an unpacked folder; never in a zip
const MATURITIES = ['closed-beta', 'open-beta', 'stable'];
// The receipt, in manifest order. coreRepo ("owner/name") says which core
// repository coreCommit is in (closed and public betas build from different
// ones, with the same tags); nothing checks coreCommit against it.
const SOURCE_FIELDS = ['commit', 'coreRepo', 'coreCommit', 'coreFrom', 'actionsCommit', 'builtAt'];

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

// A path breaks the zip rules (section 3): "..", ".", empty segments,
// absolute paths, drive letters, ":", control characters, < > " | ? *, or a
// segment ending in a dot or space. Backslashes count as separators here.
function unsafePath(name) {
  const n = String(name).replace(/\\/g, '/');
  if (!n || n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.includes(':')) return true;
  const parts = n.replace(/\/$/, '').split('/');
  return parts.some((p) => p === '' || p === '.' || p === '..' || /[<>"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p));
}

// Files under dir, relative with forward slashes. Links or special files
// are refused.
function walkFiles(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkFiles(dir, r));
    else if (e.isFile()) out.push(r);
    else throw new PackageError('unsafe-path', `the package has a link or special file (${r})`);
  }
  return out;
}

// The zip's entry names, checked before anything is extracted.
function listZip(zipPath) {
  const names = zip.list(zipPath);
  const seen = new Set();
  for (const n of names) {
    if (unsafePath(n)) throw new PackageError('unsafe-path', `the package has an unsafe path: ${n}`);
    const key = n.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    if (key === OK) throw new PackageError('unsafe-path', `the package has a ${OK} file`);
    // Windows folders ignore case, so two such names would land on one file.
    if (seen.has(key) && !n.endsWith('/')) throw new PackageError('unsafe-path', `the package has ${n} twice (paths can't differ only in case)`);
    seen.add(key);
  }
  return names;
}

const bad = (msg) => { throw new PackageError('format', `the package's manifest is malformed: ${msg}`); };
const isBuildId = (v) => (typeof v === 'string' && /^\d+$/.test(v)) || (Number.isInteger(v) && v > 0);
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Checks the manifest's fields, not the files. opts.appVersion: the reader's
// own version; a minAppVersion above it is refused ('app-version'). Returns m.
function checkManifest(m, opts = {}) {
  if (!isObject(m)) bad('not a JSON object');
  if (!Number.isInteger(m.format) || m.format < 1) bad('no format number');
  if (m.format > FORMAT) throw new PackageError('format', `the package is format ${m.format}; this reader knows format ${FORMAT}. A newer installer is needed`);
  if (!isId(m.id)) bad(`id "${m.id}"`);
  if (!isPlainVersion(m.version)) bad(`version "${m.version}" (plain numbers, like 1.3.0)`);
  if (!MATURITIES.includes(m.maturity)) bad(`maturity "${m.maturity}" (${MATURITIES.join(', ')})`);
  if (!isDate(m.date)) bad(`date "${m.date}" (YYYY-MM-DD)`);
  if (m.coreVersion !== undefined && !isPlainVersion(m.coreVersion)) bad(`coreVersion "${m.coreVersion}"`);
  if (!Number.isInteger(m.appid) || m.appid <= 0) bad(`appid "${m.appid}"`);
  if (!isPlainVersion(m.minAppVersion)) bad(`minAppVersion "${m.minAppVersion}"`);
  if (!isObject(m.loader) || typeof m.loader.type !== 'string' || !m.loader.type) bad('no loader type');
  if (m.loader.version !== undefined && typeof m.loader.version !== 'string') bad('loader version');
  if (m.testedBuildIds !== undefined && !(Array.isArray(m.testedBuildIds) && m.testedBuildIds.every(isBuildId))) bad('testedBuildIds');
  if (m.notes !== undefined && (typeof m.notes !== 'string' || /[\r\n]/.test(m.notes) || m.notes.length > 500)) bad('notes (one line, at most 500 characters)');
  if (!isObject(m.source)) bad('no source');
  for (const k of SOURCE_FIELDS) if (m.source[k] !== undefined && typeof m.source[k] !== 'string') bad(`source.${k}`);
  if (!isObject(m.files) || !Object.keys(m.files).length) bad('no files');
  for (const [rel, hash] of Object.entries(m.files)) {
    if (unsafePath(rel) || rel.includes('\\')) throw new PackageError('unsafe-path', `the manifest lists an unsafe path: ${rel}`);
    if ([MANIFEST, SIGNATURE, OK].includes(rel.toLowerCase())) bad(`it lists ${rel} in its own files`);
    if (!/^[0-9A-Fa-f]{64}$/.test(String(hash))) bad(`SHA-256 of ${rel}`);
  }
  if (!m.files['mod.json']) bad("files has no mod.json");
  if (opts.appVersion !== undefined && compareVersions(m.minAppVersion, opts.appVersion) > 0) {
    throw new PackageError('app-version', `${m.id} ${m.version} needs installer ${m.minAppVersion} or newer (this is ${opts.appVersion})`);
  }
  return m;
}

// Verifies the manifest bytes against the signature text. sigText null: no
// signature, refused unless opts.allowUnsigned (development only). Returns
// the key id, or null when unsigned and allowed.
function verifySignature(manifestBytes, sigText, opts = {}) {
  if (sigText == null) {
    if (opts.allowUnsigned) return null;
    throw new PackageError('unsigned', `the package has no ${SIGNATURE}`);
  }
  return sign.verify(manifestBytes, sigText, opts.trustedKeys);
}

// Checks an extracted package folder (sections 8.4 to 8.7). Returns
// { manifest, key }. opts: appVersion, trustedKeys, allowUnsigned.
function verifyDir(dir, opts = {}) {
  const manifestFile = path.join(dir, MANIFEST);
  if (!fs.existsSync(manifestFile)) throw new PackageError('not-a-mod', `it has no ${MANIFEST}: not a DioramaVR mod package`);
  const bytes = fs.readFileSync(manifestFile);
  let m;
  try { m = JSON.parse(bytes.toString('utf8')); } catch (e) { bad(`not JSON (${e.message})`); }
  checkManifest(m, opts);

  const sigFile = path.join(dir, SIGNATURE);
  const key = verifySignature(bytes, fs.existsSync(sigFile) ? fs.readFileSync(sigFile, 'utf8') : null, opts);

  const listed = new Set(Object.keys(m.files));
  const present = walkFiles(dir).filter((r) => r !== MANIFEST && r !== SIGNATURE && r !== OK);
  const extra = present.filter((r) => !listed.has(r));
  if (extra.length) throw new PackageError('extra-file', `the package has files its manifest doesn't list: ${extra.slice(0, 5).join(', ')}`, extra);
  const have = new Set(present);
  const missing = [...listed].filter((r) => !have.has(r));
  if (missing.length) throw new PackageError('missing-file', `the package is missing files: ${missing.slice(0, 5).join(', ')}`, missing);
  for (const rel of present) {
    if (sha256File(path.join(dir, rel)) !== String(m.files[rel]).toUpperCase()) {
      throw new PackageError('hash', `${rel} doesn't match its SHA-256: the file is damaged or was changed`, [rel]);
    }
  }

  let mod;
  try { mod = JSON.parse(fs.readFileSync(path.join(dir, 'mod.json'), 'utf8')); } catch (e) { bad(`its mod.json can't be read (${e.message})`); }
  if (!isObject(mod)) bad('its mod.json is not an object');
  if ((mod.id ?? m.id) !== m.id) bad(`the manifest says ${m.id} but mod.json says ${mod.id}`);
  if (Number(mod.appid) !== m.appid) bad(`the manifest says appid ${m.appid} but mod.json says ${mod.appid}`);
  if (mod.loader?.type !== m.loader.type) bad(`the manifest's loader is ${m.loader.type} but mod.json's is ${mod.loader?.type}`);
  for (const k of ['payload', 'video']) {
    if (mod[k] != null && (typeof mod[k] !== 'string' || unsafePath(mod[k]))) throw new PackageError('unsafe-path', `mod.json's ${k} isn't a path inside the package`);
  }
  return { manifest: m, key };
}

// Checks a package zip and unpacks it to <destRoot>/<id>-<version>/, with .ok
// written last. opts: appVersion, trustedKeys, allowUnsigned, and check(dir,
// manifest) for the caller's own checks before the folder moves into place.
// The same version unpacked again replaces the old copy (it was checked).
// Returns { id, version, maturity, dir, manifest, key }.
function unpack(zipPath, destRoot, opts = {}) {
  listZip(zipPath);
  fs.mkdirSync(destRoot, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(destRoot, '.unpack-'));
  try {
    zip.extract(zipPath, tmp);
    const { manifest: m, key } = verifyDir(tmp, opts);
    if (opts.check) opts.check(tmp, m);
    const dir = path.join(destRoot, `${m.id}-${m.version}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
    fs.writeFileSync(path.join(dir, OK), `${m.version}\n`);
    return { id: m.id, version: m.version, maturity: m.maturity, dir, manifest: m, key };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Checks a zip end to end without keeping it: listZip, unpack into a temp
// folder, verifyDir. Returns { manifest, key }.
function checkZip(zipPath, opts = {}) {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'dvr-check-'));
  try {
    const r = unpack(zipPath, tmp, opts);
    return verifyDir(r.dir, opts);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Every complete unpacked package under destRoot (a folder with .ok and a
// readable manifest whose id-version is its name). Not re-hashed: unpack
// checked them. Returns [{ id, version, maturity, dir, manifest }].
function list(destRoot) {
  let names = [];
  try { names = fs.readdirSync(destRoot); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const dir = path.join(destRoot, name);
    if (!fs.existsSync(path.join(dir, OK))) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
      if (m.format !== FORMAT || `${m.id}-${m.version}` !== name) continue;
      out.push({ id: m.id, version: m.version, maturity: m.maturity, dir, manifest: m });
    } catch { /* broken entry: skip it */ }
  }
  return out;
}

module.exports = {
  FORMAT, MANIFEST, SIGNATURE, MATURITIES, SOURCE_FIELDS,
  sha256File, unsafePath, walkFiles, listZip, checkManifest, verifySignature, verifyDir, unpack, checkZip, list,
};
