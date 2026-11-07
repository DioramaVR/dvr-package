#!/usr/bin/env node
'use strict';
// Writes the licence notices into a payload (lib/licenses.js).
//
//   dvr-licenses <payload folder> --data <licenses folder> [--version X.Y.Z] [--pin] [--allow-unity-libs]
//
// --data is always given: the game's licenses/ folder from the same commit as
// the build. --allow-unity-libs is for the installer's bundled builds only.
const fs = require('fs');
const { parse, die, refuse } = require('./_cli');
const licenses = require('../lib/licenses');

const USAGE = 'usage: dvr-licenses <payload folder> --data <licenses folder> [--version X.Y.Z] [--pin] [--allow-unity-libs]';
const o = parse(process.argv.slice(2), ['--data', '--version'], ['--pin', '--allow-unity-libs'], USAGE);
if (o._.length !== 1 || !o.data || !fs.existsSync(o._[0])) die(2, USAGE);
try {
  const r = licenses.writeNotices(o._[0], { data: o.data, version: o.version, pin: !!o.pin, allowUnityLibs: !!o['allow-unity-libs'] });
  for (const w of r.warnings) console.log(`warning: ${w}`);
  if (o.pin) console.log(`pinned ${r.pinned} files`);
  console.log(`licences: ${r.components} components, ${r.files} files covered`);
} catch (e) { refuse(e); }
