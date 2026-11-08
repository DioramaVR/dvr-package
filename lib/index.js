'use strict';
// dvr-package: the DioramaVR mod package format (docs/SPEC.md) and both ends
// of it. Each part loads when it's first used.
const lazy = (file) => ({ enumerable: true, get: () => require(file) });

const api = { FORMAT: 1 };
Object.defineProperties(api, {
  reader: lazy('./reader'),
  writer: lazy('./writer'),
  sign: lazy('./sign'),
  licenses: lazy('./licenses'),
  privacy: lazy('./privacy'),
  version: lazy('./version'),
  zip: lazy('./zip'),
  errors: lazy('./errors'),
  index: lazy('./index-writer'),
  registry: lazy('./registry'),
  modJson: lazy('./modjson'),
  schemas: lazy('./schemas'),
  dataZip: lazy('./datazip'),
  gameAssets: lazy('./game-assets'),
});
// The error class itself, for `instanceof`.
Object.defineProperty(api, 'PackageError', { enumerable: true, get: () => require('./errors').PackageError });

module.exports = api;
