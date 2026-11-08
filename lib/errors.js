'use strict';
// Every refusal is a PackageError with a .code, so every tool reaches the same
// verdict for a given file (docs/SPEC.md section 9).

// Reader codes: why a package can't be used.
const READER_CODES = [
  'not-a-mod', 'format', 'app-version', 'unsigned', 'signature', 'untrusted-key',
  'unsafe-path', 'extra-file', 'missing-file', 'hash',
];
// Writer-only codes: why a payload can't become a release.
const WRITER_CODES = ['not-release-build', 'core-not-tagged', 'no-licences', 'unity-files', 'private-path', 'metadata'];
const CODES = [...READER_CODES, ...WRITER_CODES];

class PackageError extends Error {
  // details: optional list of problem strings (e.g. every file that failed).
  constructor(code, message, details) {
    super(message);
    if (!CODES.includes(code)) throw new Error(`unknown PackageError code "${code}"`);
    this.name = 'PackageError';
    this.code = code;
    if (details) this.details = details;
  }
}

module.exports = { PackageError, CODES, READER_CODES, WRITER_CODES };
