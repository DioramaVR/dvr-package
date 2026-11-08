# dvr-package

The DioramaVR mod package format, and both ends of it.

- **Spec:** [docs/SPEC.md](docs/SPEC.md): the package zip and its manifest,
  signatures, the game index, the registry, game data, reader behaviour,
  error codes, the game's data zip and the game's media (the index's `assets`).
- **Schemas:** `schemas/*.json` (JSON Schema 2020-12) for the manifest, a
  release entry, the index, the registry, `game.json`, `known-issues.json`,
  `credits.json`, a data zip's `data.json`, and the assets repo's `media.json`.
- **Reader:** check and unpack a package zip (paths, hashes, Ed25519
  signature against `trusted-keys.json`, app version).
- **Writer:** pack a built mod folder into a deterministic, signed zip; write
  licence notices; add a release to an index; edit a registry; make `mod.json`
  from `game.json`; pack a game's data zip (`<id>-data.zip`); check a game's
  media folder (with a metadata check) and list its files in the index.
- **Fixtures:** `test/fixtures/`, sample zips with the verdict any reader must
  reach (`expected.json`).

Node 20 or later, no dependencies. Zips are made and read with the `tar` that
ships with Windows (bsdtar). The data zip is made and read in plain Node, so
it works anywhere Node does (the website builds on Linux).

## Use

As a dependency, pinned to a tag:

```json
"dependencies": { "dvr-package": "github:DioramaVR/dvr-package#v0.1.0" }
```

```js
const { reader, schemas } = require('dvr-package');

// Check and unpack a zip. Throws a PackageError whose .code is one of SPEC section 9.
const { id, version, maturity, dir, manifest } = reader.unpack(zipPath, cacheDir, { appVersion: '0.2.0' });

// Validate a document against a schema: [] when it's valid.
const problems = schemas.validate(doc, 'registry');

// A game's data zip (SPEC section 11): pack data/, read one back with the index's size and hash.
const { dataZip } = require('dvr-package');
const { zip, sha256, size, warnings } = dataZip.pack('data', 'out', { date: '2026-11-20' });
const { data, files } = dataZip.read(zip, { sha256, size, id: 'fake-vr' }); // files: Map name -> Buffer

// A game's media (SPEC section 12): the files a reader downloads, and the check of each one.
const { gameAssets } = require('dvr-package');
for (const f of gameAssets.list(index)) gameAssets.verify(f.name, await download(f.url), index); // throws on a mismatch
```

Command line (`node bin/dvr-<name>.js`, or `npx dvr-<name>` when installed):
`dvr-verify`, `dvr-pack`, `dvr-sign`, `dvr-licenses`, `dvr-index`,
`dvr-registry`, `dvr-data`, `dvr-assets`. Each prints its usage when run without arguments.

Signing reads the private key from the `DVR_SIGNING_KEY` environment variable
only, and checks each new signature against `trusted-keys.json` before writing
it.

## Tests

```
npm test            # node --test
npm run fixtures    # rebuild test/fixtures (byte-identical unless the format changed)
node test/fixtures/make-data-fixtures.js   # rebuild test/fixtures/data-zip
node test/fixtures/make-assets-fixtures.js # rebuild test/fixtures/assets
```

## Licence

MIT, copyright scrire.
