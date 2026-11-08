'use strict';
// Makes the data-zip fixtures in test/fixtures/data-zip/ (docs/SPEC.md
// section 11) and their expected.json (file -> "ok" or the error code a
// reader must report, reading with no size or hash given). The website and
// the installer can run them and compare their verdicts.
//
//   node test/fixtures/make-data-fixtures.js [out folder]   (default: data-zip/)
//
// good.zip is source/ packed by the real writer; every other zip is good.zip
// changed in one way, so each fails for exactly one reason. Zips are
// deterministic, so re-running gives the same bytes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zip = require('../../lib/zip');
const dataZip = require('../../lib/datazip');

const SOURCE = path.join(__dirname, 'data-zip', 'source');

// Rewrites a zip with its entries (a Map name -> Buffer) changed by edit.
function rewrap(from, to, edit) {
  const entries = new Map(zip.readEntries(from).map((e) => [e.name, e.data]));
  edit(entries);
  zip.create(to, [...entries].map(([name, data]) => ({ name, data })), { date: dataZip.ZIP_DATE });
}
const editData = (entries, change) => {
  const doc = JSON.parse(entries.get('data.json').toString('utf8'));
  change(doc);
  entries.set('data.json', Buffer.from(dataZip.canonical(doc)));
};
const text = (s) => Buffer.from(`${s}\n`);

function makeDataFixtures(out = path.join(__dirname, 'data-zip')) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-data-fixtures-'));
  const expected = {};
  try {
    const good = dataZip.pack(SOURCE, work, { date: '2026-11-20' }).zip;
    const save = (name, verdict, make) => { make(path.join(out, name)); expected[name] = verdict; };

    save('good.zip', 'ok', (p) => fs.copyFileSync(good, p));
    save('extra-file.zip', 'extra-file', (p) => rewrap(good, p, (e) => e.set('media/extra.png', text('not named in data.json'))));
    save('extra-credits.zip', 'extra-file', (p) => rewrap(good, p, (e) => e.set('credits.json', text('{}'))));
    save('folder-entry.zip', 'extra-file', (p) => rewrap(good, p, (e) => e.set('media/', Buffer.alloc(0))));
    save('subfolder-file.zip', 'extra-file', (p) => rewrap(good, p, (e) => e.set('media/more/hero.jpg', text('in a subfolder'))));
    save('missing-file.zip', 'missing-file', (p) => rewrap(good, p, (e) => e.delete('media/turntable-poster.jpg')));
    save('no-data-json.zip', 'missing-file', (p) => rewrap(good, p, (e) => e.delete('data.json')));
    save('unsafe-path.zip', 'unsafe-path', (p) => rewrap(good, p, (e) => e.set('../outside.jpg', text('escapes the folder'))));
    save('backslash.zip', 'unsafe-path', (p) => rewrap(good, p, (e) => e.set('media\\hero.jpg', text('a backslash'))));
    save('case-clash.zip', 'unsafe-path', (p) => rewrap(good, p, (e) => e.set('media/HERO.jpg', text('the same name on Windows'))));
    save('subfolder-named.zip', 'format', (p) => rewrap(good, p, (e) => {
      e.set('media/more/hero.jpg', e.get('media/hero.jpg'));
      e.delete('media/hero.jpg');
      editData(e, (d) => { d.media[0].file = 'media/more/hero.jpg'; });
    }));
    save('wrong-type.zip', 'format', (p) => rewrap(good, p, (e) => {
      e.set('media/hero.gif', e.get('media/hero.jpg'));
      e.delete('media/hero.jpg');
      editData(e, (d) => { d.media[0].file = 'media/hero.gif'; });
    }));
    save('wrong-kind.zip', 'format', (p) => rewrap(good, p, (e) => editData(e, (d) => { d.media[0].kind = 'video'; })));
    save('no-line.zip', 'format', (p) => rewrap(good, p, (e) => editData(e, (d) => { delete d.line; })));
    save('newer-format.zip', 'format', (p) => rewrap(good, p, (e) => editData(e, (d) => { d.format = 2; })));
    save('bad-json.zip', 'format', (p) => rewrap(good, p, (e) => e.set('data.json', text('{ "format": 1,'))));
    save('not-a-zip.zip', 'not-a-mod', (p) => fs.writeFileSync(p, text('not a zip')));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(out, 'expected.json'), JSON.stringify(expected, null, 2) + '\n');
  return expected;
}

// `node --test test/` runs every .js under test/: never rewrite the fixtures then.
if (require.main === module && !process.env.NODE_TEST_CONTEXT) {
  const out = path.resolve(process.argv[2] || path.join(__dirname, 'data-zip'));
  fs.mkdirSync(out, { recursive: true });
  const expected = makeDataFixtures(out);
  console.log(`${Object.keys(expected).length} data-zip fixtures -> ${out}`);
}

module.exports = { makeDataFixtures, rewrap, SOURCE };
