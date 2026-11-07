# dvr-package

The DioramaVR mod package format, and both ends of it.

- **Spec:** [docs/SPEC.md](docs/SPEC.md): the package zip and its manifest,
  signatures, the game index, the registry, game data, reader behaviour and
  error codes.
- **Schemas:** `schemas/*.json` (JSON Schema 2020-12) for the manifest, a
  release entry, the index, the registry, `game.json` and `known-issues.json`.
- **Reader:** check and unpack a package zip (paths, hashes, Ed25519
  signature against `trusted-keys.json`, app version).
- **Writer:** pack a built mod folder into a deterministic, signed zip; write
  licence notices; add a release to an index; edit a registry; make `mod.json`
  from `game.json`.
- **Fixtures:** `test/fixtures/`, sample zips with the verdict any reader must
  reach (`expected.json`).

Node 20 or later, no dependencies. Zips are made and read with the `tar` that
ships with Windows (bsdtar).

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
```

Command line (`node bin/dvr-<name>.js`, or `npx dvr-<name>` when installed):
`dvr-verify`, `dvr-pack`, `dvr-sign`, `dvr-licenses`, `dvr-index`,
`dvr-registry`. Each prints its usage when run without arguments.

Signing reads the private key from the `DVR_SIGNING_KEY` environment variable
only, and checks each new signature against `trusted-keys.json` before writing
it.

## Tests

```
npm test            # node --test
npm run fixtures    # rebuild test/fixtures (byte-identical unless the format changed)
```

## Licence

MIT, copyright scrire.
