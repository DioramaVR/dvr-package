'use strict';
// Detached Ed25519 signatures (docs/SPEC.md section 4): dvr-package.json in a
// zip, a game's index.json, the registry.
//
// The signature file is one JSON line, {"key":"<key id>","sig":"<base64>"},
// then LF; the signature is over the file's exact bytes. Key id: the first 16
// hex (lower case) of SHA-256 over the public key's SPKI DER.
//
// The private key comes from the environment only (DVR_SIGNING_KEY: PKCS8,
// PEM or base64 DER). It is never printed, logged or written anywhere.
// Trusted keys: trusted-keys.json next to this package, or a list a caller
// passes (tests); there is no environment bypass.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PackageError } = require('./errors');

const TRUSTED_FILE = path.join(__dirname, '..', 'trusted-keys.json');

const keyId = (spkiDer) => crypto.createHash('sha256').update(spkiDer).digest('hex').slice(0, 16);
const publicDer = (key) => crypto.createPublicKey(key).export({ format: 'der', type: 'spki' });

// [{ id, spki }] (or { keys: [...] }, the older file shape) -> Map(id -> KeyObject).
// Each id must match its own key, so a typo can't trust the wrong key.
function trustedKeys(list) {
  if (list instanceof Map) return list;
  if (list === undefined) list = JSON.parse(fs.readFileSync(TRUSTED_FILE, 'utf8'));
  if (list && !Array.isArray(list) && Array.isArray(list.keys)) list = list.keys;
  if (!Array.isArray(list)) throw new Error('trusted keys must be a list of { id, spki }');
  const m = new Map();
  for (const k of list) {
    const der = Buffer.from(String(k.spki), 'base64');
    if (keyId(der) !== k.id) throw new Error(`trusted key ${k.id} doesn't match its own key`);
    const pub = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (pub.asymmetricKeyType !== 'ed25519') throw new Error(`trusted key ${k.id} isn't Ed25519`);
    m.set(k.id, pub);
  }
  return m;
}

// The private key from a PKCS8 string (PEM or base64 DER).
function parsePrivateKey(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('DVR_SIGNING_KEY is not set');
  let key;
  try {
    key = text.includes('-----BEGIN')
      ? crypto.createPrivateKey(text)
      : crypto.createPrivateKey({ key: Buffer.from(text, 'base64'), format: 'der', type: 'pkcs8' });
  } catch {
    throw new Error('DVR_SIGNING_KEY is not a PKCS8 private key (PEM or base64 DER)');
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('DVR_SIGNING_KEY is not an Ed25519 key');
  return key;
}

const hasKey = () => !!String(process.env.DVR_SIGNING_KEY || '').trim();
const privateKey = () => parsePrivateKey(process.env.DVR_SIGNING_KEY);

// The id of DVR_SIGNING_KEY's key.
const signingKeyId = () => keyId(publicDer(privateKey()));

// Checks a signature line over bytes. Returns { ok: true, key } or
// { ok: false, code: 'signature' | 'untrusted-key', message }.
function check(bytes, sigText, trusted) {
  const keys = trustedKeys(trusted);
  let s;
  try { s = JSON.parse(String(sigText)); } catch { return { ok: false, code: 'signature', message: 'the signature file is not JSON' }; }
  if (!s || typeof s.key !== 'string' || typeof s.sig !== 'string') return { ok: false, code: 'signature', message: 'the signature file needs key and sig' };
  const pub = keys.get(s.key);
  if (!pub) return { ok: false, code: 'untrusted-key', message: `signed with key ${s.key}, which isn't trusted` };
  let good = false;
  try { good = crypto.verify(null, Buffer.from(bytes), pub, Buffer.from(s.sig, 'base64')); } catch { good = false; }
  return good ? { ok: true, key: s.key } : { ok: false, code: 'signature', message: "the signature doesn't match" };
}

// Throws PackageError('signature' | 'untrusted-key') unless sigText is a valid
// signature of bytes by a trusted key. Returns the key id.
function verify(bytes, sigText, trusted) {
  const r = check(bytes, sigText, trusted);
  if (!r.ok) throw new PackageError(r.code, r.message);
  return r.key;
}

// The signature line (with its LF) for bytes, made with DVR_SIGNING_KEY.
// It's checked against the trusted keys before it's returned, so a wrong key
// in the secret stops a publish instead of shipping files nobody can verify.
function signBytes(bytes, { trustedKeys: trusted } = {}) {
  const key = privateKey();
  const id = keyId(publicDer(key));
  const line = JSON.stringify({ key: id, sig: crypto.sign(null, Buffer.from(bytes), key).toString('base64') }) + '\n';
  const r = check(bytes, line, trusted);
  if (!r.ok) throw new PackageError(r.code, `not signing: ${r.message} (is DVR_SIGNING_KEY the right key?)`);
  return line;
}

// Signs a file into <file>.sig (or sigFile). Returns the key id.
function signFile(file, sigFile = `${file}.sig`, opts = {}) {
  const line = signBytes(fs.readFileSync(file), opts);
  fs.writeFileSync(sigFile, line);
  return JSON.parse(line).key;
}

// Verifies <file> against <file>.sig (or sigFile). Returns the key id.
function verifyFile(file, sigFile = `${file}.sig`, { trustedKeys: trusted } = {}) {
  if (!fs.existsSync(sigFile)) throw new PackageError('unsigned', `${path.basename(file)} has no signature (${path.basename(sigFile)})`);
  return verify(fs.readFileSync(file), fs.readFileSync(sigFile, 'utf8'), trusted);
}

module.exports = {
  TRUSTED_FILE, keyId, trustedKeys, parsePrivateKey, hasKey, signingKeyId,
  check, verify, signBytes, signFile, verifyFile,
};
