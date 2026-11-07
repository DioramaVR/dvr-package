// The package format's JSON Schemas (schemas/*.schema.json, draft 2020-12) and a
// small validator for the part of JSON Schema they use, so dvr-package needs
// no dependencies.
//
//   const { validate, check, load, names } = require('./schemas');
//   validate(doc, 'registry')  -> [{ path: '/games/0/index', message }]  (empty = valid)
//   check(doc, 'registry')     -> doc, or throws an Error listing every problem (.problems)
//
// Supported keywords: type, enum, const, required, properties,
// additionalProperties, propertyNames, items, minItems, maxItems, uniqueItems,
// minLength, maxLength, pattern, minimum, maximum, allOf, anyOf, oneOf, not,
// if/then/else, $ref (to "#/$defs/..." or to another schema's file name, with
// an optional "#/$defs/..." after it), $defs. Annotations ($schema, $id,
// $comment, title, description, default, examples) are ignored. A schema that
// uses any other keyword is refused when it loads, so a schema can't silently
// ask for a check that never runs.
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'schemas');
const SUPPORTED = new Set([
  'type', 'enum', 'const', 'required', 'properties', 'additionalProperties', 'propertyNames',
  'items', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum',
  'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', '$ref', '$defs',
  '$schema', '$id', '$comment', 'title', 'description', 'default', 'examples',
]);
// Keywords whose value is a map of name -> schema, or a list of schemas.
const SCHEMA_MAPS = ['properties', '$defs'];
const SCHEMA_LISTS = ['allOf', 'anyOf', 'oneOf'];
const SCHEMA_ONE = ['additionalProperties', 'propertyNames', 'items', 'not', 'if', 'then', 'else'];

// Every schema used anywhere in a schema file must stick to SUPPORTED.
function unsupported(schema, where = '') {
  if (typeof schema === 'boolean') return [];
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [`${where || '/'}: not a schema`];
  const out = [];
  for (const k of Object.keys(schema)) if (!SUPPORTED.has(k)) out.push(`${where || '/'}: keyword "${k}" isn't supported by lib/schemas.js`);
  for (const k of SCHEMA_MAPS) for (const [n, s] of Object.entries(schema[k] || {})) out.push(...unsupported(s, `${where}/${k}/${n}`));
  for (const k of SCHEMA_LISTS) (schema[k] || []).forEach((s, i) => out.push(...unsupported(s, `${where}/${k}/${i}`)));
  for (const k of SCHEMA_ONE) if (k in schema) out.push(...unsupported(schema[k], `${where}/${k}`));
  return out;
}

const cache = new Map();
// A schema by name ("registry") or file name ("registry.schema.json").
function load(name) {
  const file = name.endsWith('.json') ? name : `${name}.schema.json`;
  if (!cache.has(file)) {
    const schema = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
    const bad = unsupported(schema);
    if (bad.length) throw new Error(`schemas/${file}:\n  ${bad.join('\n  ')}`);
    cache.set(file, schema);
  }
  return cache.get(file);
}

// The names validate() and check() take.
function names() {
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.schema.json')).map((f) => f.slice(0, -'.schema.json'.length)).sort();
}

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const isType = (v, t) => t === typeOf(v) || (t === 'number' && typeof v === 'number' && Number.isFinite(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ptr = (p, k) => `${p}/${String(k).replace(/~/g, '~0').replace(/\//g, '~1')}`;

function resolve(ref, root) {
  const [file, frag = ''] = ref.split('#');
  let target = file ? load(file) : root;
  const nextRoot = target;
  for (const part of frag.split('/').filter(Boolean)) {
    target = target?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (target === undefined) throw new Error(`$ref ${ref} doesn't resolve`);
  }
  return { schema: target, root: nextRoot };
}

function walk(v, s, at, root, errs) {
  if (s === true) return;
  if (s === false) { errs.push({ path: at || '/', message: 'is not allowed here' }); return; }
  const err = (message, p = at) => errs.push({ path: p || '/', message });

  if (s.$ref) { const r = resolve(s.$ref, root); walk(v, r.schema, at, r.root, errs); }
  if (s.type) {
    const types = [].concat(s.type);
    if (!types.some((t) => isType(v, t))) { err(`must be ${types.join(' or ')} (is ${typeOf(v)})`); return; }
  }
  if ('const' in s && !same(v, s.const)) err(`must be ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.some((e) => same(v, e))) err(`must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`);

  if (typeof v === 'string') {
    const len = [...v].length;
    if (s.minLength != null && len < s.minLength) err(s.minLength === 1 ? 'must not be empty' : `must be at least ${s.minLength} characters`);
    if (s.maxLength != null && len > s.maxLength) err(`must be at most ${s.maxLength} characters`);
    if (s.pattern && !new RegExp(s.pattern, 'u').test(v)) err(`${JSON.stringify(v)} doesn't match ${s.pattern}`);
  }
  if (typeof v === 'number') {
    if (s.minimum != null && v < s.minimum) err(`must be at least ${s.minimum}`);
    if (s.maximum != null && v > s.maximum) err(`must be at most ${s.maximum}`);
  }
  if (Array.isArray(v)) {
    if (s.minItems != null && v.length < s.minItems) err(s.minItems === 1 ? 'must not be empty' : `needs at least ${s.minItems} items`);
    if (s.maxItems != null && v.length > s.maxItems) err(`may have at most ${s.maxItems} items`);
    if (s.uniqueItems) v.forEach((x, i) => { if (v.findIndex((y) => same(x, y)) !== i) err(`item ${i} repeats an earlier one`); });
    if (s.items !== undefined) v.forEach((x, i) => walk(x, s.items, ptr(at, i), root, errs));
  }
  if (typeOf(v) === 'object') {
    for (const k of s.required || []) if (!(k in v)) err(`needs "${k}"`);
    const props = s.properties || {};
    for (const [k, x] of Object.entries(v)) {
      if (k in props) walk(x, props[k], ptr(at, k), root, errs);
      else if (s.additionalProperties !== undefined) {
        if (s.additionalProperties === false) err(`unknown field "${k}"`, ptr(at, k));
        else walk(x, s.additionalProperties, ptr(at, k), root, errs);
      }
      if (s.propertyNames !== undefined) {
        const sub = [];
        walk(k, s.propertyNames, ptr(at, k), root, sub);
        if (sub.length) err(`name ${JSON.stringify(k)}: ${sub[0].message}`, ptr(at, k));
      }
    }
  }

  for (const sub of s.allOf || []) walk(v, sub, at, root, errs);
  const passes = (sub) => { const e = []; walk(v, sub, at, root, e); return e; };
  if (s.anyOf) {
    const tries = s.anyOf.map(passes);
    if (!tries.some((e) => !e.length)) err(`doesn't match any allowed shape (${tries.map((e) => e[0]?.message).filter(Boolean).join('; ')})`);
  }
  if (s.oneOf) {
    const ok = s.oneOf.map(passes).filter((e) => !e.length).length;
    if (ok !== 1) err(ok ? 'matches more than one allowed shape' : 'doesn\'t match any allowed shape');
  }
  if (s.not !== undefined && !passes(s.not).length) err('is not allowed in this form');
  if (s.if !== undefined) {
    const branch = passes(s.if).length ? s.else : s.then;
    if (branch !== undefined) walk(v, branch, at, root, errs);
  }
}

// Problems with doc against a schema (a name, or a schema object): [] if none.
function validate(doc, schema) {
  const s = typeof schema === 'string' ? load(schema) : schema;
  if (typeof schema !== 'string') { const bad = unsupported(s); if (bad.length) throw new Error(bad.join('\n')); }
  const errs = [];
  walk(doc, s, '', s, errs);
  return errs;
}

// doc if it's valid; otherwise throws, listing every problem.
function check(doc, name, label = name) {
  const problems = validate(doc, name);
  if (problems.length) {
    const e = new Error(`${label}: ${problems.length} problem(s)\n  ${problems.map((p) => `${p.path}: ${p.message}`).join('\n  ')}`);
    e.code = 'schema';
    e.problems = problems;
    throw e;
  }
  return doc;
}

module.exports = { validate, check, load, names, unsupported, SUPPORTED };
