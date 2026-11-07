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
// known issues from known-issues.json, refreshed on every release.
'use strict';
const { validate } = require('./schemas');

const LISTED = ['open-beta', 'stable'];
const canonical = (doc) => JSON.stringify(doc, null, 2) + '\n';
const fail = (msg) => { const e = new Error(msg); e.code = 'index'; throw e; };
const problemsText = (label, ps) => `${label}:\n  ${ps.map((p) => `${p.path}: ${p.message}`).join('\n  ')}`;

// Problems with a whole index: the schema, plus versions listed once and
// known-issue ids used once. [] = fine.
function checkIndex(doc) {
  const problems = validate(doc, 'index');
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
    description: game.tagline,
    releases: [listedEntry({ ...entry, testedBuildIds: entry.testedBuildIds || game.testedBuildIds }, url, notes), ...releases],
    knownIssues: Array.isArray(issues) ? issues : before?.knownIssues,
  });
  const bad = checkIndex(index);
  if (bad.length) fail(problemsText('new index', bad));
  return index;
}

// Promotion (closed-beta never applies here): changes one release's maturity
// and nothing else, so the zip and every other field stay as they were.
function setMaturity(index, version, maturity) {
  if (!LISTED.includes(maturity)) fail(`maturity must be ${LISTED.join(' or ')}`);
  const i = (index.releases || []).findIndex((r) => r.version === version);
  if (i < 0) fail(`version ${version} isn't listed`);
  const next = { ...index, releases: index.releases.map((r, j) => (j === i ? { ...r, maturity } : r)) };
  const bad = checkIndex(next);
  if (bad.length) fail(problemsText('index', bad));
  return next;
}

module.exports = { addRelease, setMaturity, checkIndex, listedEntry, canonical, LISTED };
