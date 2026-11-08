# Test fixtures

Package zips that any reader of the format can run, with the verdict each must
get in `expected.json` (`"ok"` or an error code from docs/SPEC.md section 9).

The verdicts assume a reader that:
- trusts only the `trusted` key in `test-keys.json`, and
- is version `1.0.0`.

`test-keys.json` holds **test-only** Ed25519 key pairs, private halves
included on purpose. They sign nothing real, they aren't in
`trusted-keys.json`, and no installer trusts them.

`make-fixtures.js` makes every zip with the real writer from a fake mod
(Fake Game, appid 4242, text files standing in for DLLs), then changes each
one in exactly one way:

```
node test/fixtures/make-fixtures.js [out folder]
```

Zips are deterministic, so re-running it gives the same contents. The tests
check that the committed zips match what it makes.

## Data zips (`data-zip/`)

`data-zip/` holds a game's data zip fixtures (docs/SPEC.md section 11), with
their verdicts in `data-zip/expected.json`, for a reader given no size or
hash. `data-zip/source/` is a fake game's `data/` folder (no `controls` or
`description`, a video with a poster and an MP4 source, one media file
nothing names, and a file outside `media/`): `good.zip` is it packed by the
real writer, and every other zip is `good.zip` changed in exactly one way.

```
node test/fixtures/make-data-fixtures.js [out folder]
```

The bytes never depend on the day they're made, so re-running gives the same
zips; the tests check that the committed ones match.

## Game media (`assets/`)

`assets/` holds two game folders as the assets repo has them (docs/SPEC.md
section 12): `media.json` and `media/`. Every picture is made up byte by
byte by `make-assets-fixtures.js`: an 8x8 grey JPG and 1x1 PNGs, which
decode, and video stubs with only the right first bytes, which don't play.
`fake-vr/` is clean; `flagged-vr/` is the same, except that its JPG carries
an (empty) Exif segment and its PNG a `tEXt` chunk. `assets/expected.json`
lists the problems `gameAssets.check` must report for each, as
`[code, path]`.

```
node test/fixtures/make-assets-fixtures.js [out folder]
```
