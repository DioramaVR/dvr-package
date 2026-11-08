'use strict';
// A game's media from the assets repo (docs/SPEC.md section 12): one folder
// per game, <game>/media.json plus <game>/media/<file>. Each file is
// published on its own (a release assets-N on the game's public repo) and
// listed, with its URL, SHA-256 and size, in the game's signed index.json
// under "assets". Readers download each file and check it against the list.
//
//   const gameAssets = require('./game-assets');
//   gameAssets.check(folder)                          -> { id, media, files: [{ name, path, size, sha256 }], problems }
//   gameAssets.build(folder, { release, baseUrl, date }) -> { assets, files: [{ name, path }] }   (throws on any problem)
//   gameAssets.list(index)                            -> [{ name, url, sha256, size }]           (the files to download)
//   gameAssets.verify(name, buf, index)               -> true, or throws a PackageError (hash, extra-file)
//
// check() reports every problem, each { code, path, message }: format
// (media.json, a type, a size), missing-file, extra-file, unsafe-path, and
// metadata. The metadata check flags and never strips, so the published
// bytes stay the committed ones: JPG APP1 (Exif, XMP) and APP13 (IPTC), PNG
// tEXt, zTXt, iTXt, eXIf and tIME. The fix is to strip the file and commit it
// again.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PackageError } = require('./errors');
const { validate } = require('./schemas');

const FORMAT = 1;
const MEDIA_JSON = 'media.json';
const MEDIA_DIR = 'media';
const MAX_FILE = 64 * 1024 * 1024;
const IMAGE = ['.jpg', '.jpeg', '.png', '.webp'];
const VIDEO = ['.webm', '.mp4'];
const ASSETS_SCHEMA = { $ref: 'media.schema.json#/$defs/assets' };
const PNG_FLAGGED = ['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'];

const ext = (name) => path.posix.extname(name);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const problem = (code, where, message) => ({ code, path: where, message });

// Every file name a media list uses, once each, in order: file, poster, sources.
function namesOf(media) {
  const out = [];
  for (const m of Array.isArray(media) ? media : []) {
    for (const f of [m?.file, m?.poster, ...(Array.isArray(m?.sources) ? m.sources : [])]) {
      if (typeof f === 'string' && !out.includes(f)) out.push(f);
    }
  }
  return out;
}

// What a schema can't say about a media list: exactly one hero, at most one
// turntable, each type fits its kind (posters are images; sources are other
// encodings of a video). where: the list's path, for the messages.
function mediaProblems(media, where) {
  const out = [];
  if (!Array.isArray(media)) return out;
  const roles = (r) => media.filter((m) => m?.role === r).length;
  if (roles('hero') !== 1) out.push(problem('format', where, `needs exactly one hero (role "hero"), has ${roles('hero')}`));
  if (roles('turntable') > 1) out.push(problem('format', where, `has ${roles('turntable')} turntables (at most one)`));
  media.forEach((m, i) => {
    const at = `${where}/${i}`;
    if (typeof m?.file === 'string') {
      const want = m.kind === 'image' ? IMAGE : m.kind === 'video' ? VIDEO : null;
      if (want && !want.includes(ext(m.file))) out.push(problem('format', `${at}/file`, `a${m.kind === 'image' ? 'n image' : ' video'} must be ${want.join(' ')}`));
    }
    if (typeof m?.poster === 'string' && !IMAGE.includes(ext(m.poster))) out.push(problem('format', `${at}/poster`, `must be an image (${IMAGE.join(' ')})`));
    if (m?.sources !== undefined && m?.kind !== 'video') out.push(problem('format', `${at}/sources`, 'only a video has other encodings'));
    (Array.isArray(m?.sources) ? m.sources : []).forEach((s, j) => {
      if (typeof s === 'string' && !VIDEO.includes(ext(s))) out.push(problem('format', `${at}/sources/${j}`, `must be a video (${VIDEO.join(' ')})`));
    });
  });
  return out;
}

// Problems with an index's assets block, as { path, message } (checkIndex's
// shape): the schema (via the index schema), the media rules, and files
// listing exactly the names media uses. where: "/assets".
function assetsProblems(assets, where = '/assets') {
  if (!assets || typeof assets !== 'object' || Array.isArray(assets)) return [];
  const out = mediaProblems(assets.media, `${where}/media`).map(({ path: p, message }) => ({ path: p, message }));
  if (assets.files && typeof assets.files === 'object' && !Array.isArray(assets.files)) {
    const used = namesOf(assets.media);
    const listed = Object.keys(assets.files);
    for (const n of used) if (!listed.includes(n)) out.push({ path: `${where}/files`, message: `has no entry for ${n}, which media uses` });
    for (const n of listed) if (!used.includes(n)) out.push({ path: `${where}/files/${n}`, message: `${n} isn't used by media` });
  }
  return out;
}

// The file's type, from its first bytes: 'jpg', 'png', 'webp', 'webm', 'mp4' or null.
function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x1a45dfa3) return 'webm';
  if (buf.length >= 8 && buf.toString('latin1', 4, 8) === 'ftyp') return 'mp4';
  return null;
}
const TYPE_OF_EXT = { '.jpg': 'jpg', '.jpeg': 'jpg', '.png': 'png', '.webp': 'webp', '.webm': 'webm', '.mp4': 'mp4' };

// Metadata a picture carries that the check flags: a list of descriptions.
function jpgMetadata(buf) {
  const out = [];
  let p = 2;
  while (p + 4 <= buf.length) {
    if (buf[p] !== 0xff) break; // not a marker: the header is damaged; stop looking
    const marker = buf[p + 1];
    if (marker === 0xff) { p++; continue; } // fill byte
    if (marker === 0xd9 || marker === 0xda) break; // EOI, or SOS: the image data starts
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
    const len = buf.readUInt16BE(p + 2);
    if (len < 2) break;
    const body = buf.subarray(p + 4, Math.min(buf.length, p + 2 + len));
    if (marker === 0xe1) {
      const head = body.toString('latin1', 0, 32);
      out.push(head.startsWith('Exif\0') ? 'JPG APP1 Exif' : head.startsWith('http://ns.adobe.com/xap/1.0/') ? 'JPG APP1 XMP' : 'JPG APP1');
    } else if (marker === 0xed) {
      out.push(body.toString('latin1', 0, 13) === 'Photoshop 3.0' ? 'JPG APP13 IPTC (Photoshop)' : 'JPG APP13');
    }
    p += 2 + len;
  }
  return out;
}
function pngMetadata(buf) {
  const out = [];
  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (PNG_FLAGGED.includes(type)) {
      // tEXt/zTXt/iTXt start with a keyword: name it, never the text.
      const kw = ['tEXt', 'zTXt', 'iTXt'].includes(type) ? buf.toString('latin1', p + 8, Math.min(p + 8 + len, p + 8 + 79)).split('\0')[0] : '';
      out.push(`PNG ${type}${kw ? ` "${kw}"` : ''}`);
    }
    if (type === 'IEND') break;
    p += 12 + len;
  }
  return out;
}

// A game's folder in the assets repo, checked: media.json (schema, the media
// rules, its id is the folder's name), then media/: every named file there,
// nothing else, each a plain file of an allowed type whose bytes are that
// type, at most 64 MB, and no flagged metadata. Every problem is reported.
function check(folder) {
  const problems = [];
  const add = (code, where, message) => problems.push(problem(code, where, message));
  let doc = null;
  try {
    const text = fs.readFileSync(path.join(folder, MEDIA_JSON), 'utf8');
    if (text.charCodeAt(0) === 0xfeff) add('format', MEDIA_JSON, 'starts with a BOM (UTF-8 without one)');
    doc = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    add('format', MEDIA_JSON, `can't be read (${e.message})`);
    return { id: undefined, media: [], files: [], problems };
  }
  if (typeof doc?.format === 'number' && doc.format > FORMAT) add('format', `${MEDIA_JSON}/format`, `is ${doc.format}; this tool knows format ${FORMAT}`);
  else for (const p of validate(doc, 'media')) add('format', `${MEDIA_JSON}${p.path === '/' ? '' : p.path}`, p.message);
  problems.push(...mediaProblems(doc?.media, `${MEDIA_JSON}/media`));
  const id = doc?.id;
  if (typeof id === 'string' && id !== path.basename(path.resolve(folder))) add('format', `${MEDIA_JSON}/id`, `is "${id}", but the folder is ${path.basename(path.resolve(folder))}`);

  const names = namesOf(doc?.media);
  const dir = path.join(folder, MEDIA_DIR);
  const present = new Map(); // name -> Dirent
  if (fs.existsSync(dir)) for (const e of fs.readdirSync(dir, { withFileTypes: true })) present.set(e.name, e);
  else add('missing-file', MEDIA_DIR, `${MEDIA_DIR}/ doesn't exist`);
  for (const [n, e] of present) {
    if (!names.includes(n)) add(e.isDirectory() ? 'unsafe-path' : 'extra-file', `${MEDIA_DIR}/${n}`, e.isDirectory() ? 'is a folder (media has no subfolders)' : `isn't named in ${MEDIA_JSON}`);
  }
  const lower = new Map();
  for (const n of present.keys()) {
    const k = n.toLowerCase();
    if (lower.has(k)) add('unsafe-path', `${MEDIA_DIR}/${n}`, `differs from ${lower.get(k)} only in case`);
    lower.set(k, n);
  }

  const files = [];
  for (const n of names) {
    const where = `${MEDIA_DIR}/${n}`;
    const e = present.get(n);
    if (!e) { add('missing-file', where, `${MEDIA_JSON} names it, but it isn't there`); continue; }
    if (!e.isFile()) { add('unsafe-path', where, "isn't a plain file"); continue; }
    const abs = path.join(dir, n);
    const size = fs.statSync(abs).size;
    if (size === 0) { add('format', where, 'is empty'); continue; }
    if (size > MAX_FILE) { add('format', where, `is ${size} bytes, more than the ${MAX_FILE} allowed per file`); continue; }
    const buf = fs.readFileSync(abs);
    const want = TYPE_OF_EXT[ext(n)];
    const got = sniff(buf);
    if (want && got !== want) add('format', where, `isn't a ${want} file inside (${got ? `it's ${got}` : 'unknown type'})`);
    const meta = got === 'jpg' ? jpgMetadata(buf) : got === 'png' ? pngMetadata(buf) : [];
    for (const m of meta) add('metadata', where, `has ${m} metadata: strip it and commit the file again`);
    files.push({ name: n, path: abs, size, sha256: sha256(buf) });
  }
  return { id, media: doc?.media, files, problems };
}

// The index's assets list for a checked folder: { release, date, files, media }
// with each file's url (baseUrl + "/" + name), sha256 (lower case) and size,
// and media.json's media unchanged. Throws a PackageError (the first
// problem's code, every problem in .details) if check() finds anything.
function build(folder, { release, baseUrl, date } = {}) {
  if (!/^assets-[1-9][0-9]*$/.test(String(release))) throw new Error(`release must be assets-N, not "${release}"`);
  if (!/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(String(baseUrl))) throw new Error(`baseUrl must be an https URL, not "${baseUrl}"`);
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(String(date))) throw new Error(`date must be YYYY-MM-DD, not "${date}"`);
  const r = check(folder);
  if (r.problems.length) {
    const lines = r.problems.map((p) => `${p.path}: ${p.message} (${p.code})`);
    throw new PackageError(r.problems[0].code, `${folder} has ${lines.length} problem(s):\n  ${lines.join('\n  ')}`, lines);
  }
  const base = String(baseUrl).replace(/\/+$/, '');
  const files = {};
  for (const f of r.files) files[f.name] = { url: `${base}/${f.name}`, sha256: f.sha256, size: f.size };
  const assets = { release, date, files, media: r.media };
  const bad = [...validate(assets, ASSETS_SCHEMA), ...assetsProblems(assets, '')];
  if (bad.length) throw new PackageError('format', `the assets list would be invalid:\n  ${bad.map((p) => `${p.path || '/'}: ${p.message}`).join('\n  ')}`);
  return { assets, files: r.files.map((f) => ({ name: f.name, path: f.path })) };
}

// The index's assets block, checked; null when the index has none.
function assetsOf(index) {
  const assets = index?.assets;
  if (assets === undefined) return null;
  const bad = [...validate(assets, ASSETS_SCHEMA), ...assetsProblems(assets, '')];
  if (bad.length) throw new PackageError('format', `the index's assets list is malformed:\n  ${bad.map((p) => `${p.path || '/'}: ${p.message}`).join('\n  ')}`);
  return assets;
}

// The files a reader should download: [{ name, url, sha256, size }], in the
// index's order; [] when the index has no assets list (use the data zip's media).
function list(index) {
  const assets = assetsOf(index);
  if (!assets) return [];
  return Object.entries(assets.files).map(([name, f]) => ({ name, url: f.url, sha256: f.sha256, size: f.size }));
}

// Checks a downloaded file against the index: listed (extra-file), its size,
// then its SHA-256, either case (hash). Returns true.
function verify(name, buf, index) {
  const assets = assetsOf(index);
  const f = assets && Object.prototype.hasOwnProperty.call(assets.files, name) ? assets.files[name] : null;
  if (!f) throw new PackageError('extra-file', `${name} isn't in the index's assets list`);
  if (!Buffer.isBuffer(buf)) throw new TypeError('verify needs the file as a Buffer');
  if (buf.length !== f.size) throw new PackageError('hash', `${name} is ${buf.length} bytes, not the ${f.size} listed`);
  const got = sha256(buf);
  if (got !== String(f.sha256).toLowerCase()) throw new PackageError('hash', `${name}'s SHA-256 is ${got}, not the ${f.sha256} listed`);
  return true;
}

module.exports = {
  check, build, list, verify, assetsProblems, mediaProblems, namesOf, sniff, jpgMetadata, pngMetadata,
  FORMAT, MAX_FILE, IMAGE, VIDEO, PNG_FLAGGED,
};
