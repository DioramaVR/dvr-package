'use strict';
// A game's data zip, <id>-data.zip (docs/SPEC.md section 11): data.json and
// the media it names, nothing else. Made from the game repo's data/ folder
// (game.json, known-issues.json, media/); read by the website and the
// installer. Pure Node, no tar: zip.create writes it and zip.readEntries reads
// it, so it works the same on Windows and on a Linux build machine.
//
//   const dataZip = require('./datazip');
//   dataZip.checkSource(dataDir)                -> { data, files, warnings }  (throws a PackageError)
//   dataZip.pack(dataDir, outDir, { date })     -> { zip, sha256, size, date, data, warnings }
//   dataZip.read(zipPath, { sha256, size, id }) -> { data, files: Map name -> Buffer }
//   dataZip.extract(zipPath, dir, opts)         -> the same, after writing the files into dir
//
// Every refusal is a PackageError with a code from section 9: unsafe-path,
// extra-file, missing-file, hash (size or SHA-256), format (data.json, a
// media type, too big), not-a-mod (not a zip, or a damaged one).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zip = require('./zip');
const { PackageError } = require('./errors');
const { validate } = require('./schemas');
const { readGameData, checkGameData } = require('./modjson');
const { unsafePath } = require('./reader');

const FORMAT = 1;
const DATA = 'data.json';
const MAX_SIZE = 64 * 1024 * 1024; // the zip, and everything in it unpacked
const ZIP_DATE = '1980-01-01'; // every entry's timestamp (00:00): the bytes never depend on the day
const IMAGE = ['.jpg', '.jpeg', '.png', '.webp'];
const VIDEO = ['.webm', '.mp4'];
const MEDIA_FIELDS = ['file', 'kind', 'role', 'alt', 'poster', 'sources'];

const canonical = (doc) => JSON.stringify(doc, null, 2) + '\n';
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
const ext = (p) => path.posix.extname(p);
const zipName = (id) => `${id}-data.zip`;
function clean(o) {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

// Every media path data.json names, once each, in order: file, poster, sources.
function namedFiles(data) {
  const out = [];
  for (const m of Array.isArray(data?.media) ? data.media : []) {
    for (const f of [m?.file, m?.poster, ...(Array.isArray(m?.sources) ? m.sources : [])]) {
      if (typeof f === 'string' && !out.includes(f)) out.push(f);
    }
  }
  return out;
}

// What's wrong with a media path, as [code, why], or null. "media/<name>":
// no subfolders, one of the allowed types.
function mediaPathProblem(p) {
  if (typeof p !== 'string' || unsafePath(p) || p.includes('\\')) return ['unsafe-path', 'is an unsafe path'];
  if (!/^media\/[^/]+$/.test(p)) return ['unsafe-path', 'must be media/<file name> (media has no subfolders)'];
  if (![...IMAGE, ...VIDEO].includes(ext(p))) return ['format', `isn't an allowed type (${[...IMAGE, ...VIDEO].join(' ')}, lower case)`];
  return null;
}

// Problems with a data.json document, as "where: what" strings: the schema,
// then what it can't say (types fit their kinds, known-issue ids once).
function dataProblems(data) {
  const out = [];
  for (const p of validate(data, 'data')) out.push(`data.json${p.path === '/' ? '' : p.path}: ${p.message}`);
  (Array.isArray(data?.media) ? data.media : []).forEach((m, i) => {
    const at = `data.json/media/${i}`;
    if (typeof m?.file === 'string') {
      const want = m.kind === 'image' ? IMAGE : m.kind === 'video' ? VIDEO : null;
      if (want && !want.includes(ext(m.file))) out.push(`${at}/file: a${m.kind === 'image' ? 'n image' : ' video'} must be ${want.join(' ')}`);
    }
    if (typeof m?.poster === 'string' && !IMAGE.includes(ext(m.poster))) out.push(`${at}/poster: must be an image (${IMAGE.join(' ')})`);
    if (m?.sources !== undefined && m?.kind !== 'video') out.push(`${at}/sources: only a video has other encodings`);
    (Array.isArray(m?.sources) ? m.sources : []).forEach((s, j) => {
      if (typeof s === 'string' && !VIDEO.includes(ext(s))) out.push(`${at}/sources/${j}: must be a video (${VIDEO.join(' ')})`);
    });
  });
  const ids = new Set();
  (Array.isArray(data?.knownIssues) ? data.knownIssues : []).forEach((k, i) => {
    if (typeof k?.id !== 'string') return;
    if (ids.has(k.id)) out.push(`data.json/knownIssues/${i}/id: id "${k.id}" is used twice`);
    ids.add(k.id);
  });
  return out;
}

// data.json from game.json and known-issues.json: the zip's fields only, in
// the spec's order. tutorial[].controls, controls, install, settings and the
// rest stay in the game repo.
function toData(game, issues, warnings = []) {
  let line = game.line;
  if (typeof line !== 'string' || !line) {
    line = game.tagline;
    warnings.push('line: placeholder from tagline (needs the user\'s line)');
  }
  return clean({
    format: FORMAT,
    id: game.id,
    line,
    firstLaunch: game.firstLaunch,
    needToKnow: game.needToKnow,
    tutorial: Array.isArray(game.tutorial) ? game.tutorial.map((s) => ({ title: s?.title, text: s?.text })) : undefined,
    knownIssues: Array.isArray(issues) ? issues : undefined,
    owners: game.owners,
    credits: game.credits,
    media: Array.isArray(game.media)
      ? game.media.map((m) => clean(Object.fromEntries(MEDIA_FIELDS.map((k) => [k, m?.[k]]))))
      : undefined,
  });
}

// A game repo's data/ folder, checked as the source of a data zip: game.json
// and known-issues.json as section 7 has them, then data.json as it would be,
// then every media file it names (present, a file, of an allowed type).
// Files in data/media that nothing names are left out, with a warning.
function checkSource(dataDir) {
  let game, issues;
  try { ({ game, issues } = readGameData(dataDir)); } catch (e) {
    throw new PackageError('format', `${dataDir} has no readable game.json / known-issues.json (${e.message})`);
  }
  const source = checkGameData(game, issues, { dataDir });
  if (source.length) throw new PackageError('format', `the game data has ${source.length} problem(s):\n  ${source.join('\n  ')}`, source);
  const warnings = [];
  const data = toData(game, issues, warnings);
  const files = namedFiles(data);
  for (const f of files) {
    const bad = mediaPathProblem(f);
    if (bad) throw new PackageError(bad[0], `game.json's media ${f} ${bad[1]}`);
  }
  const problems = dataProblems(data);
  if (problems.length) throw new PackageError('format', `data.json would have ${problems.length} problem(s):\n  ${problems.join('\n  ')}`, problems);
  let total = Buffer.byteLength(canonical(data));
  for (const f of files) {
    const abs = path.join(dataDir, ...f.split('/'));
    let st;
    try { st = fs.lstatSync(abs); } catch { throw new PackageError('missing-file', `game.json names ${f}, but data/${f} doesn't exist`); }
    if (!st.isFile()) throw new PackageError('unsafe-path', `data/${f} isn't a plain file`);
    total += st.size;
  }
  if (total > MAX_SIZE) throw new PackageError('format', `the data zip would hold ${total} bytes, more than the ${MAX_SIZE} allowed`);
  const mediaDir = path.join(dataDir, 'media');
  if (fs.existsSync(mediaDir)) {
    for (const e of fs.readdirSync(mediaDir, { withFileTypes: true })) {
      if (!files.includes(`media/${e.name}`)) warnings.push(`data/media/${e.name}${e.isDirectory() ? '/' : ''} isn't named in game.json's media: left out`);
    }
  }
  return { data, files, warnings };
}

// Makes <outDir>/<id>-data.zip. Every entry's timestamp is ZIP_DATE, never the
// run's date: the same data/ folder gives the same bytes whenever it's packed,
// so a re-run can compare its SHA-256 with the last published zip. opts.date
// ("YYYY-MM-DD", default today, UTC) is only returned, for the index's
// data.date. Read back with every check before it's returned.
function pack(dataDir, outDir, { date = new Date().toISOString().slice(0, 10) } = {}) {
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(String(date))) throw new Error(`pack's date must be YYYY-MM-DD, not "${date}"`);
  const { data, files, warnings } = checkSource(dataDir);
  const out = path.join(outDir, zipName(data.id));
  zip.create(out, [
    { name: DATA, data: canonical(data) },
    ...files.map((f) => ({ name: f, file: path.join(dataDir, ...f.split('/')) })),
  ], { date: ZIP_DATE });
  const bytes = fs.readFileSync(out);
  if (bytes.length > MAX_SIZE) {
    fs.rmSync(out, { force: true });
    throw new PackageError('format', `${zipName(data.id)} is ${bytes.length} bytes, more than the ${MAX_SIZE} allowed`);
  }
  const result = { zip: out, sha256: sha256(bytes), size: bytes.length, date, data, warnings };
  read(out, { sha256: result.sha256, size: result.size, id: data.id });
  return result;
}

// Checks a data zip and returns what's in it. opts: sha256 and size (from the
// index: both checked first, before anything is read), id (data.json's must
// match). The order: size and hash; the entry names (unsafe paths, case
// clashes, folders); data.json (format first, then its fields); exactly the
// files it names, no more, no fewer.
function read(zipPath, opts = {}) {
  const base = path.basename(zipPath);
  let st;
  try { st = fs.statSync(zipPath); } catch { throw new PackageError('not-a-mod', `${base} can't be read`); }
  if (opts.size != null && st.size !== Number(opts.size)) throw new PackageError('hash', `${base} is ${st.size} bytes, not the ${opts.size} listed`);
  if (st.size > MAX_SIZE) throw new PackageError('format', `${base} is ${st.size} bytes, more than the ${MAX_SIZE} allowed`);
  if (opts.sha256 != null) {
    const got = sha256(fs.readFileSync(zipPath));
    if (got !== String(opts.sha256).toUpperCase()) throw new PackageError('hash', `${base}'s SHA-256 is ${got}, not the ${opts.sha256} listed`);
  }

  const names = zip.list(zipPath);
  const seen = new Set();
  for (const n of names) {
    if (unsafePath(n) || n.includes('\\')) throw new PackageError('unsafe-path', `${base} has an unsafe path: ${n}`);
    if (n.endsWith('/')) throw new PackageError('extra-file', `${base} has a folder entry (${n}): a data zip holds only data.json and media files`);
    const key = n.toLowerCase();
    if (seen.has(key)) throw new PackageError('unsafe-path', `${base} has ${n} twice (paths can't differ only in case)`);
    seen.add(key);
  }
  if (!names.includes(DATA)) throw new PackageError('missing-file', `${base} has no ${DATA}`);

  const files = new Map(zip.readEntries(zipPath, { maxTotal: MAX_SIZE }).map((e) => [e.name, e.data]));
  let data;
  try {
    const text = files.get(DATA).toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) throw new Error('it starts with a BOM');
    data = JSON.parse(text);
  } catch (e) { throw new PackageError('format', `${base}'s ${DATA} isn't valid JSON (${e.message})`); }
  if (typeof data?.format === 'number' && data.format > FORMAT) {
    throw new PackageError('format', `${base} is data format ${data.format}; this reader knows format ${FORMAT} (a newer installer is needed)`);
  }
  const problems = dataProblems(data);
  if (problems.length) throw new PackageError('format', `${base}'s ${DATA} has ${problems.length} problem(s):\n  ${problems.join('\n  ')}`, problems);
  if (opts.id != null && data.id !== opts.id) throw new PackageError('format', `${base} is the data for "${data.id}", not "${opts.id}"`);

  const named = namedFiles(data);
  for (const f of named) {
    const bad = mediaPathProblem(f);
    if (bad) throw new PackageError(bad[0], `${DATA}'s media ${f} ${bad[1]}`);
    if (!files.has(f)) throw new PackageError('missing-file', `${DATA} names ${f}, but it isn't in ${base}`);
  }
  const extra = names.filter((n) => n !== DATA && !named.includes(n));
  if (extra.length) throw new PackageError('extra-file', `${base} has file(s) ${DATA} doesn't name: ${extra.join(', ')}`, extra);
  return { data, files };
}

// read(), then writes data.json and the media into dir: a new or empty folder
// (it's created), so nothing from an older zip is left among the files.
function extract(zipPath, dir, opts = {}) {
  const result = read(zipPath, opts);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`${dir} isn't empty: extract a data zip into a new or empty folder`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of result.files) {
    const abs = path.join(dir, ...name.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes);
  }
  return result;
}

module.exports = { pack, read, extract, checkSource, toData, dataProblems, namedFiles, zipName, canonical, FORMAT, MAX_SIZE, ZIP_DATE, IMAGE, VIDEO };
