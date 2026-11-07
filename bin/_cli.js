'use strict';
// Shared bits of the dvr-* command lines: argument parsing and exit codes.
// Exit 0 = done / valid, 1 = refused (prints "<code>: <message>"), 2 = usage.
const fs = require('fs');

// valued: options that take a value; the rest are flags.
function parse(argv, valued, flags, usage) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valued.includes(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) die(2, `${a} needs a value\n${usage}`);
      o[a.slice(2)] = v;
    } else if (flags.includes(a)) o[a.slice(2)] = true;
    else if (a.startsWith('--')) die(2, `unknown option ${a}\n${usage}`);
    else o._.push(a);
  }
  return o;
}

function die(code, msg) {
  console.error(msg);
  process.exit(code);
}

// A refusal: a PackageError prints its code and every detail.
function refuse(e) {
  if (e && e.code && e.name === 'PackageError') {
    console.error(`${e.code}: ${e.message}`);
    for (const d of e.details || []) if (!e.message.includes(d)) console.error(`  ${d}`);
    process.exit(1);
  }
  die(1, `error: ${e && e.message ? e.message : e}`);
}

// --trusted-keys FILE (tests, key rotation checks): the list from that file.
const trustedFrom = (file) => (file ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined);

module.exports = { parse, die, refuse, trustedFrom };
