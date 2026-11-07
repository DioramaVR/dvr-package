# DioramaVR package format: specification

Format version **1**. This document is the one source for the files a
DioramaVR mod release consists of, and for the rules every reader and writer
follows. The JSON schemas in `schemas/` encode the same rules; where they
disagree, this document wins and the schema is a bug.

- [1. Overview](#1-overview)
- [2. Common rules](#2-common-rules)
- [3. Package zip](#3-package-zip)
- [4. Signatures](#4-signatures)
- [5. Game index (`index.json`)](#5-game-index-indexjson)
- [6. Registry (`registry.json`)](#6-registry-registryjson)
- [7. Game data (`game.json`, `known-issues.json`)](#7-game-data-gamejson-known-issuesjson)
- [8. Reader behaviour](#8-reader-behaviour)
- [9. Error codes](#9-error-codes)
- [10. Changing the format](#10-changing-the-format)

## 1. Overview

```
registry.json            every game, its wave and status, where its index is,
  │                      installer versions, announcements          (signed)
  └─ <id>/index.json     one game: every public release with its zip URL,
       │                 SHA-256, maturity and receipt; known issues  (signed)
       └─ <id>-<version>.zip
            dvr-package.json  the manifest: what the zip holds, file hashes
            dvr-package.sig   the manifest's signature
            mod.json, payload/, ...
```

A reader starts from the registry URL it was built with, fetches a game's
index, picks a release, downloads the zip, checks its SHA-256 against the
index, checks the manifest's signature and every file's hash, and only then
installs. Every file a reader acts on is signed.

A release has a **maturity**: `closed-beta`, `open-beta` or `stable`.
Closed-beta zips are handed out privately and loaded from a file; they are
never listed in an index. Open-beta and stable releases are listed. A build
moves through the stages without being rebuilt: promotion changes the index
entry, never the zip.

## 2. Common rules

- **JSON:** UTF-8, no BOM, LF line ends. Files written by tools are canonical:
  `JSON.stringify(doc, null, 2) + "\n"`.
- **Unknown fields are ignored** by readers, so adding an optional field is not
  a format change (see 10).
- **Ids** (`id` of a game, wave, known issue): `[a-z0-9][a-z0-9.-]*`, at most
  64 characters. An id never changes once published.
- **Versions** are plain dotted numbers (`1.3.0`, `2026.11.07`), never
  pre-release forms like `1.3.0-beta.1`: maturity is separate from the version,
  so a promoted build keeps its version. Compared numerically part by part;
  missing parts count as 0.
- **Dates** are `YYYY-MM-DD` (UTC). Timestamps are ISO 8601 UTC.
- **SHA-256** is 64 hex digits, written upper case by tools and compared
  case-insensitively by readers.
- **URLs** are `https`. Plain `http` is accepted only for `localhost` and
  `127.0.0.1` (tests and staging).
- **Text** meant for people (`title`, `text`, `notes`, `description`...) is
  plain text, never HTML or Markdown.

## 3. Package zip

Name: `<id>-<version>.zip`. Contents:

```
dvr-package.json   the manifest (below)
dvr-package.sig    its signature (section 4)
mod.json           how the installer installs the mod
payload/           the files that go into the game folder, laid out as there
<other files>      anything mod.json names (e.g. a video), inside the zip
```

### The manifest, `dvr-package.json`

```json
{
  "format": 1,
  "id": "fake-vr",
  "version": "1.0.0",
  "maturity": "closed-beta",
  "date": "2026-11-20",
  "coreVersion": "0.1.1",
  "appid": 4242,
  "minAppVersion": "0.2.0",
  "loader": { "type": "bepinex6-il2cpp", "version": "6.0.0-be.791" },
  "testedBuildIds": ["123456"],
  "notes": "One line, optional.",
  "source": {
    "commit": "a1b2c3d", "coreRepo": "example/core", "coreCommit": "e4f5a6b", "coreFrom": "tag v0.1.1",
    "actionsCommit": "c7d8e9f", "builtAt": "2026-11-20T10:00:00Z"
  },
  "files": { "mod.json": "<SHA-256>", "payload/BepInEx/plugins/FakeVr/FakeVr.dll": "<SHA-256>" }
}
```

| Field | Required | Meaning |
|---|---|---|
| `format` | yes | `1` |
| `id` | yes | the mod's id; equals `mod.json`'s |
| `version` | yes | plain version (section 2) |
| `maturity` | yes | the maturity the build was **first released as**; it never changes inside the zip (an index is authoritative for listed releases, section 5) |
| `date` | yes | release date |
| `coreVersion` | if the mod uses the shared core | the core version it was built against |
| `appid` | yes | the game's Steam app id; equals `mod.json`'s |
| `minAppVersion` | yes | the oldest installer that can install this zip |
| `loader` | yes | `{type, version}`; `type` equals `mod.json`'s |
| `testedBuildIds` | no | the game's Steam build ids this release was tested on |
| `notes` | no | one line of plain text |
| `knownIssues` | no | the game's known issues at build time, same shape as an index's (section 5). A zip loaded from a file has no index, so a reader shows these; for a listed release, the index's list is newer and wins |
| `source` | yes | the receipt: mod `commit`; for a mod using the core, `coreRepo` (the repository the core was taken from, `owner/name`), `coreCommit` (a commit of that repository) and `coreFrom` (`tag v<coreVersion>` for a release); `actionsCommit` (the release tooling); `builtAt`. Builds of different maturities may take the core from different repositories that carry the same tags, so a release is identified by `coreRepo` plus the tag, not by the commit alone |
| `files` | yes | every file in the zip except `dvr-package.json` and `dvr-package.sig`, forward-slash paths, each with its SHA-256 |

### Rules for the zip

- Paths are relative, forward-slash, with no `..`, `.`, empty segments,
  drive letters, `:`, control characters, `< > " | ? *`, or segments ending in
  a dot or space. No two paths may differ only in case. No links or special
  files.
- `files` lists exactly the files present, no more, no fewer.
- `mod.json`'s `payload` and other named files are paths inside the zip.
- A release zip contains no third-party game or engine files (for Unity games:
  nothing under `BepInEx/unity-libs/`, no `UnityEngine*.dll`, no
  `Assembly-CSharp*`), and it carries licence notices under
  `payload/licenses/`.
- Writers make zips **deterministic**: entries sorted by path and every
  timestamp set to the manifest `date`, so the same input gives the same zip.

## 4. Signatures

- **Algorithm:** Ed25519.
- **Key id:** the first 16 hex digits (lower case) of the SHA-256 of the public
  key's SPKI DER encoding.
- **Signature file:** one JSON line, then LF:
  `{"key":"<key id>","sig":"<base64 of the 64-byte signature>"}`.
- **What is signed:** the exact bytes of the file, as stored or served. Nothing
  is re-serialised before signing or verifying.

| Signed file | Signature file |
|---|---|
| `dvr-package.json` (in the zip) | `dvr-package.sig` (in the zip) |
| `<id>/index.json` | `<id>/index.json.sig` next to it |
| `registry.json` | `registry.json.sig` next to it |

**Trusted keys** are a list (`trusted-keys.json`: `[{ "id", "spki" }]`,
`spki` = base64 DER), so a key can be rotated by shipping readers that trust
both the old and the new key before switching. A reader refuses a file whose
signature is missing, doesn't verify, or names a key it doesn't trust.

## 5. Game index (`index.json`)

One per game, served next to its signature.

```json
{
  "format": 1,
  "id": "fake-vr",
  "name": "Fake Game VR",
  "game": "Fake Game",
  "appid": 4242,
  "description": "Short text for the gallery card.",
  "releases": [
    {
      "version": "1.0.0",
      "maturity": "stable",
      "date": "2026-11-20",
      "coreVersion": "0.1.1",
      "minAppVersion": "0.2.0",
      "testedBuildIds": ["123456"],
      "notes": "One line, optional.",
      "url": "https://example.org/fake-vr-1.0.0.zip",
      "sha256": "<SHA-256 of the zip>",
      "size": 31234567,
      "source": { "commit": "a1b2c3d", "coreRepo": "example/core", "coreCommit": "e4f5a6b", "coreFrom": "tag v0.1.1",
                  "actionsCommit": "c7d8e9f", "builtAt": "2026-11-20T10:00:00Z" }
    }
  ],
  "knownIssues": [
    { "id": "pitch-reset", "title": "Pitch resets after loading a save",
      "text": "Plain text.", "severity": "annoying", "since": "1.0.0", "fixedIn": null }
  ]
}
```

- `id`, `name`, `game`, `appid` match the registry entry.
- A **release entry** carries the manifest's release fields (`version`,
  `maturity`, `date`, `coreVersion`, `minAppVersion`, `testedBuildIds`,
  `notes`, `source`) plus `url`, `sha256` and `size`, which a zip can't hold
  about itself. `version` is unique within the index.
- **`maturity`** here is `open-beta` or `stable` only, and it is authoritative:
  promoting a release edits this field and nothing else. Readers that meet the
  legacy field `channel` treat `stable` as `stable` and `beta` as `open-beta`.
- Writers keep earlier releases; old versions stay installable.
- **`knownIssues`** (optional): `severity` is `minor`, `annoying` or
  `blocking`; `since` and `fixedIn` are mod versions (`fixedIn` null or absent:
  still open). An issue applies to an installed version `v` when
  `since <= v` (or no `since`) and `v < fixedIn` (or no `fixedIn`).

## 6. Registry (`registry.json`)

The one file a reader is built to find. Everything else is reached from it.

```json
{
  "format": 1,
  "app": {
    "latest": "0.2.0",
    "url": "https://example.org/download/",
    "releases": [
      { "version": "0.2.0", "date": "2026-11-20",
        "url": "https://example.org/Setup-0.2.0.exe", "size": 81234567, "sha256": "<SHA-256>" }
    ]
  },
  "announcements": [
    { "id": "maintenance", "from": "2026-12-01", "until": "2026-12-02",
      "title": "Short title", "text": "Plain text.", "link": "https://example.org/",
      "appVersions": "<0.3.0" }
  ],
  "movedTo": null,
  "waves": [
    { "id": "test", "name": "Test wave", "status": "stable" },
    { "id": "1", "name": "Wave 1", "status": "coming" }
  ],
  "games": [
    { "id": "fake-vr", "name": "Fake Game VR", "game": "Fake Game", "appid": 4242,
      "status": "stable", "wave": "test", "index": "https://example.org/fake-vr/index.json" },
    { "id": "other-vr", "name": "Other Game VR", "game": "Other Game", "appid": 4243,
      "status": "coming", "closedBeta": true, "wave": "1" }
  ]
}
```

- **`app`** (optional): `latest` is the newest installer version; a reader
  older than it may say a newer installer exists, linking `url`. `releases`
  lists installer versions newest first, each with `version`, `date`, `url`,
  `size`, `sha256`.
- **`announcements`** (optional): shown while today (UTC) is within `from` and
  `until`, both inclusive. `appVersions` (optional) limits them to some reader
  versions, as one comparison: `<`, `<=`, `>`, `>=` or `=` followed by a
  version. Readers remember dismissed ones by `id`. Plain `text` plus at most
  one `link`.
- **`movedTo`** (optional): a new registry URL. A reader follows it only from a
  registry whose signature verifies, follows at most one hop per start, and
  remembers it from then on.
- **`waves`** (optional): release groups, in display order, each
  `{ id, name, status }`. `name` is display text and may change; `id` doesn't.
  A wave holds any number of games, and games may move between waves.
- **`games`**: `id`, `name`, `game` (the Steam title), `appid` and `status` are
  required; `wave`, `index` and `closedBeta` are optional.
  - `status` is the game's most mature public release: `stable`, `open-beta`,
    or `coming` (nothing public yet). Waves use the same words.
  - `index` is required for `stable` and `open-beta` and absent for `coming`;
    readers fetch nothing for `coming` games.
  - `closedBeta: true` means a closed beta exists; readers show that, never a
    version or a link.
- **Edits** by tools change only their own fields and write the canonical form;
  every change is re-signed.

## 7. Game data (`game.json`, `known-issues.json`)

The per-game source files a release is made from. A writer turns them, with
the game's build configuration, into the zip's `mod.json` and the index.

### `game.json`

```json
{
  "id": "fake-vr", "name": "Fake Game VR", "game": "Fake Game", "appid": 4242,
  "tagline": "One line.", "description": "Plain text.",
  "requirements": ["Plain text."],
  "firstLaunch": "Plain text.",
  "needToKnow": ["Plain text."],
  "controls": [ { "input": "Right trigger", "action": "Click.", "primary": true } ],
  "tutorial": [
    { "title": "Move the table", "text": "Reach out and grab it.",
      "controls": ["Right trigger", { "input": "Right stick", "action": "Step-specific wording." }] }
  ],
  "install": { "exe": "FakeGame.exe", "launchArgs": "-force-d3d11", "steamAppIdFile": true,
               "loaderConfig": { "Logging.Console": { "Enabled": false } } },
  "settings": {
    "shared": { "leftHanded": { "section": "Controls", "key": "LeftHanded" } },
    "options": [ { "id": "desktopView", "label": "Keep the monitor view", "help": "Plain text.",
                   "type": "bool", "default": false, "cfg": { "section": "Graphics", "key": "DesktopView" } } ]
  },
  "testedBuildIds": ["123456"],
  "owners": { "developer": "Fake Studio", "publisher": "Fake Publisher" },
  "credits": [ { "name": "Some Library", "for": "What it does here", "license": "MIT",
                 "url": "https://example.org/", "support": [ { "label": "Sponsor", "url": "https://example.org/" } ],
                 "highlight": true } ],
  "media": [ { "file": "media/hero.jpg", "kind": "image", "role": "hero", "alt": "Plain text." } ]
}
```

- A tutorial step's `controls` names entries of the top-level `controls` by
  `input`; an `{input, action}` object overrides the wording for that step.
  Every named input must exist in `controls`.
- `media[].role`: `hero`, `turntable`, `gallery` or `hover`; an entry without
  a role is a gallery item. Consumers pick media by role, not by position.
- `credits` (optional) lists parts specific to this game; project-wide credits
  live elsewhere. `owners` gives the trademark owners for the disclaimer line.

### `known-issues.json`

`[{ "id", "title", "text", "severity", "since"?, "fixedIn"? }]`, the same shape
as an index's `knownIssues` (section 5). A writer copies it into the index
before signing.

## 8. Reader behaviour

To install a downloaded zip, a reader:

1. checks the zip's size and SHA-256 against the index entry;
2. lists the entries and refuses unsafe paths before extracting anything;
3. extracts into a temporary folder;
4. reads `dvr-package.json`, checks `format`, fields and `minAppVersion`;
5. verifies `dvr-package.sig` against its trusted keys;
6. checks `files` against what's present, and every hash;
7. checks `mod.json` agrees on `id`, `appid` and loader type;
8. only then moves the folder into place.

A failure at any step leaves nothing behind. A zip loaded from a file skips
step 1 and runs the rest. The same checks apply to a closed-beta zip.

## 9. Error codes

Readers report a failure with one of these codes, so every tool agrees on the
verdict for a given file:

| Code | Meaning |
|---|---|
| `not-a-mod` | not a zip, or no `dvr-package.json` |
| `format` | a format newer than the reader knows, or a malformed manifest |
| `app-version` | `minAppVersion` is above the reader's version |
| `unsigned` | no `dvr-package.sig` |
| `signature` | the signature doesn't verify |
| `untrusted-key` | signed by a key the reader doesn't trust |
| `unsafe-path` | a path breaks the rules in section 3 |
| `extra-file` | a file not listed in `files` |
| `missing-file` | a listed file is absent |
| `hash` | a file's SHA-256 doesn't match |

Writers also refuse to produce a release for these reasons:
`not-release-build`, `core-not-tagged`, `no-licences`, `unity-files`,
`private-path` (a payload containing the build machine's home-folder path).

## 10. Changing the format

- New **optional** fields need no version change: readers ignore what they
  don't know.
- A change an older reader would misread raises `format` (in the manifest, the
  index or the registry). A reader that meets a newer format refuses that file
  and says a newer installer is needed.
- A spec change comes first; the schemas, writer, reader and fixtures follow in
  the same release of this package.
