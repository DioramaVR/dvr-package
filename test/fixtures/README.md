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
