#!/usr/bin/env node
'use strict';
// Detached signatures (docs/SPEC.md section 4) for any file: an index.json,
// the registry, or a manifest.
//
//   dvr-sign sign <file> [<sig file>] [--trusted-keys FILE]    key from DVR_SIGNING_KEY
//   dvr-sign verify <file> [<sig file>] [--trusted-keys FILE]
//   dvr-sign keyid                                             the id of DVR_SIGNING_KEY's key
//
// The sig file defaults to <file>.sig. "sign" checks the new signature
// against the trusted keys before writing it, so a wrong key stops a publish.
// The key is never printed.
const path = require('path');
const { parse, die, refuse, trustedFrom } = require('./_cli');
const sign = require('../lib/sign');

const USAGE = 'usage: dvr-sign sign|verify <file> [<sig file>] [--trusted-keys FILE] | dvr-sign keyid';
const o = parse(process.argv.slice(2), ['--trusted-keys'], [], USAGE);
const [cmd, file, sigFile] = o._;
const trustedKeys = trustedFrom(o['trusted-keys']);

try {
  if (cmd === 'keyid' && !file) {
    console.log(sign.signingKeyId());
  } else if (cmd === 'sign' && file) {
    const id = sign.signFile(file, sigFile, { trustedKeys });
    console.log(`signed ${path.basename(file)} with key ${id} -> ${path.basename(sigFile || `${file}.sig`)}`);
  } else if (cmd === 'verify' && file) {
    const id = sign.verifyFile(file, sigFile, { trustedKeys });
    console.log(`${path.basename(file)}: valid (key ${id})`);
  } else die(2, USAGE);
} catch (e) {
  if (/DVR_SIGNING_KEY/.test(e.message) && e.name !== 'PackageError') die(2, `error: ${e.message}`);
  refuse(e);
}
