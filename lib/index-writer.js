// A game's index.json (docs/SPEC.md section 5): add a released zip, promote a
// release, and check a whole index. Earlier releases are always kept as they
// were, so old versions stay installable.
//
//   const ix = require('./index-writer');
//   const next = ix.addRelease({ game, issues, prev, entry, url, notes });
//   fs.writeFileSync(file, ix.canonical(next));
//
// entry is pack's release entry (<id>-<version>.release.json: version,
// maturity, date, coreVersion, minAppVersion, testedBuildIds, notes, source,
// sha256, size); url is where the zip was published. The game's facts
// (id, name, game, appid, description = tagline) come from game.json and the
// known issues from known-issues.json, refreshed on every release. The data
// field (the game's data zip, section 11) is carried forward by addRelease and
// setMaturity, and changed only by setData. The assets list (the game's media,
// section 12) is carried forward by addRelease, setMaturity and setData, and
// changed only by setAssets.
'use strict';
const { validate } = require('./schemas');

const LISTED = ['open-beta', 'stable'];
const canonical = (doc) => JSON.stringify(doc, null, 2) + '\n';
const fail = (msg) => { const e = new Error(msg); e.code = 'index'; throw e; };
const problemsText = (label, ps) => `${label}:\n  ${ps.map((p) => `${p.path}: ${p.message}`).join('\n  ')}`;

// Problems with a whole index: the schema, plus versions listed once,
// known-issue ids used once, and the assets list's own rules (section 12).
// [] = fine.
function checkIndex(doc) {
  const problems = validate(doc, 'index');
  if (doc && typeof doc === 'object' && doc.assets !== undefined) problems.push(...require('./game-assets').assetsProblems(doc.assets));
  const seen = new Set();
  (Array.isArray(doc?.releases) ? doc.releases : []).forEach((r, i) => {
    if (typeof r?.version !== 'string') return;
    if (seen.has(r.version)) problems.push({ path: `/releases/${i}/version`, message: `version ${r.version} is listed twice` });
    seen.add(r.version);
  });
  const ids = new Set();
  (Array.isArray(doc?.knownIssues) ? doc.knownIssues : []).forEach((k, i) => {
    if (typeof k?.id !== 'string') return;
    if (ids.has(k.id)) problems.push({ path: `/knownIssues/${i}/id`, message: `id "${k.id}" is used twice` });
    ids.add(k.id);
  });
  return problems;
}

// The source receipt in the spec's field order, dropping what's absent.
function sourceOf(s) {
  if (!s) return undefined;
  const { commit, coreRepo, coreCommit, coreFrom, actionsCommit, builtAt, ...rest } = s;
  return clean({ commit, coreRepo, coreCommit, coreFrom, actionsCommit, builtAt, ...rest });
}
function clean(o) {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

// A release entry as listed: the manifest's release fields, then url, sha256, size, source.
function listedEntry(entry, url, notes) {
  const n = notes || entry.notes;
  return clean({
    version: entry.version,
    maturity: entry.maturity,
    date: entry.date,
    coreVersion: entry.coreVersion,
    minAppVersion: entry.minAppVersion,
    testedBuildIds: entry.testedBuildIds,
    notes: n || undefined,
    url,
    sha256: entry.sha256,
    size: entry.size,
    source: sourceOf(entry.source),
  });
}

// The next index: this release first, then the earlier ones unchanged.
// prev may be {} (or null) for a game's first release. Closed-beta releases
// are never listed. Stops if the version is already there, or if anything
// would make the result invalid.
function addRelease({ game, issues, prev, entry, url, notes }) {
  if (!game?.id) fail('game.json has no id');
  if (!LISTED.includes(entry?.maturity)) fail(`maturity ${entry?.maturity} is never listed in an index (only ${LISTED.join(' or ')})`);
  const entryProblems = validate({ ...entry, url }, 'release-entry');
  if (entryProblems.length) fail(problemsText('release entry', entryProblems));
  const before = prev && Object.keys(prev).length ? prev : null;
  if (before) {
    if (before.id !== game.id) fail(`the previous index is for "${before.id}", not "${game.id}"`);
    const bad = checkIndex(before);
    if (bad.length) fail(problemsText('previous index', bad));
  }
  const releases = before?.releases || [];
  if (releases.some((r) => r.version === entry.version)) fail(`version ${entry.version} is already listed`);

  const index = clean({
    format: 1,
    id: game.id,
    name: game.name,
    game: game.game,
    appid: game.appid,
    description: game.line || game.tagline,
    releases: [listedEntry({ ...entry, testedBuildIds: entry.testedBuildIds || game.testedBuildIds }, url, notes), ...releases],
    knownIssues: Array.isArray(issues) ? issues : before?.knownIssues,
    // The game's data zip (section 11) isn't part of a release: kept as it was.
    data: before?.data,
    // Nor is the game's media (section 12).
    assets: before?.assets,
  });
  const bad = checkIndex(index);
  if (bad.length) fail(problemsText('new index', bad));
  return index;
}

// Promotion (closed-beta never applies here): changes one release's maturity
// and nothing else, so the zip, the data field and every other field stay as
// they were (the assets list too).
function setMaturity(index, version, maturity) {
  if (!LISTED.includes(maturity)) fail(`maturity must be ${LISTED.join(' or ')}`);
  const i = (index.releases || []).findIndex((r) => r.version === version);
  if (i < 0) fail(`version ${version} isn't listed`);
  const next = { ...index, releases: index.releases.map((r, j) => (j === i ? { ...r, maturity } : r)) };
  const bad = checkIndex(next);
  if (bad.length) fail(problemsText('index', bad));
  return next;
}

// A new data zip (section 11): sets data to { url, sha256, size, date }.
// knownIssues (optional, an array) replaces the top-level knownIssues, which
// publish-data keeps equal to the zip's until installers read the zip.
// Nothing else changes; the releases and the assets list stay as they were.
function setData(index, data, knownIssues) {
  if (!data || typeof data !== 'object') fail('setData needs { url, sha256, size, date }');
  if (knownIssues !== undefined && !Array.isArray(knownIssues)) fail('setData: knownIssues must be a list');
  if (!index || typeof index !== 'object' || !Array.isArray(index.releases)) fail('setData needs an index with its releases');
  const next = { ...index, ...(knownIssues !== undefined ? { knownIssues } : {}), data: { url: data.url, sha256: data.sha256, size: data.size, date: data.date } };
  const bad = checkIndex(next);
  if (bad.length) fail(problemsText('index', bad));
  return next;
}

// A new assets list (section 12): sets assets to { release, date, files,
// media } (gameAssets.build's), checked by checkIndex. Nothing else changes.
function setAssets(index, assets) {
  if (!assets || typeof assets !== 'object' || Array.isArray(assets)) fail('setAssets needs { release, date, files, media }');
  if (!index || typeof index !== 'object' || !Array.isArray(index.releases)) fail('setAssets needs an index with its releases');
  const { release, date, files, media } = assets;
  const next = { ...index, assets: { release, date, files, media } };
  const bad = checkIndex(next);
  if (bad.length) fail(problemsText('index', bad));
  return next;
}

module.exports = { addRelease, setMaturity, setData, setAssets, checkIndex, listedEntry, canonical, LISTED };
