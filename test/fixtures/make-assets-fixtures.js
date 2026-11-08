'use strict';
// Makes the assets-repo fixtures in test/fixtures/assets/ (docs/SPEC.md
// section 12) and their expected.json (folder -> the problems
// gameAssets.check must report, as [code, path]).
//
//   node test/fixtures/make-assets-fixtures.js [out folder]   (default: assets/)
//
// Every picture is made up here, byte by byte, so nothing comes from a
// camera or an editor: an 8x8 grey JPG and 1x1 PNGs (both decode), and video
// stubs that only have the right first bytes (they don't play).
//   fake-vr/     clean: a hero, a turntable with a poster and an MP4 source, a gallery picture
//   flagged-vr/  the same, but the JPG carries Exif and the PNG a tEXt chunk
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const u16 = (n) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const segment = (marker, body) => Buffer.concat([Buffer.from([0xff, marker]), u16(body.length + 2), body]);

// An 8x8 mid-grey baseline JPG: one block, DC 0, AC end-of-block, with
// one-code Huffman tables. extra: { exif, xmp, iptc } adds that segment.
function jpg(extra = {}) {
  const huff = (cls) => Buffer.concat([Buffer.from([cls]), Buffer.from([0, 1, ...Array(14).fill(0)]), Buffer.from([0])]);
  const parts = [
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from([...Buffer.from('JFIF\0', 'latin1'), 1, 1, 0, 0, 1, 0, 1, 0, 0])),
  ];
  if (extra.exif) {
    // A TIFF header with an empty IFD: Exif in name only, made up.
    parts.push(segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from('MM\0*', 'latin1'), u32(8), u16(0), u32(0)])));
  }
  if (extra.xmp) parts.push(segment(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>', 'latin1')));
  if (extra.iptc) parts.push(segment(0xed, Buffer.from('Photoshop 3.0\0' + '8BIM\x04\x04\0\0\0\0\0\0', 'latin1')));
  parts.push(
    segment(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)])),
    segment(0xc0, Buffer.from([8, 0, 8, 0, 8, 1, 1, 0x11, 0])),
    segment(0xc4, huff(0x00)),
    segment(0xc4, huff(0x10)),
    segment(0xda, Buffer.from([1, 1, 0x00, 0, 63, 0])),
    Buffer.from([0x0f]), // DC "00", EOB "00", padded with 1s
    Buffer.from([0xff, 0xd9]),
  );
  return Buffer.concat(parts);
}

// A 1x1 PNG of one colour, its image data stored (not deflated), so the
// bytes never depend on a zlib build. chunks: [[type, Buffer]] added after IHDR.
function png(rgb = [0x18, 0x1a, 0x25], chunks = []) {
  const chunk = (type, data) => {
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    return Buffer.concat([u32(data.length), td, u32(zlib.crc32(td))]);
  };
  const raw = Buffer.from([0, ...rgb]); // filter 0, one RGB pixel
  let a = 1, b = 0;
  for (const x of raw) { a = (a + x) % 65521; b = (b + a) % 65521; }
  const stored = Buffer.concat([Buffer.from([0x78, 0x01, 0x01]), Buffer.from([raw.length, 0, ~raw.length & 0xff, 0xff]), raw, u32((b << 16) | a)]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', Buffer.concat([u32(1), u32(1), Buffer.from([8, 2, 0, 0, 0])])),
    ...chunks.map(([t, d]) => chunk(t, d)),
    chunk('IDAT', stored),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const tEXt = (keyword, text) => ['tEXt', Buffer.from(`${keyword}\0${text}`, 'latin1')];

// Video stubs: the first bytes only.
const webm = () => Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, ...Buffer.from('webm')]);
const mp4 = () => Buffer.concat([u32(24), Buffer.from('ftypisom', 'latin1'), u32(0x200), Buffer.from('isommp41', 'latin1')]);

const MEDIA = (id) => ({
  format: 1,
  id,
  media: [
    { file: 'hero.jpg', kind: 'image', role: 'hero', alt: 'A grey square standing in for a hero picture.' },
    { file: 'turntable.webm', kind: 'video', role: 'turntable', alt: 'A pretend table, turning.', poster: 'turntable-poster.png', sources: ['turntable.mp4'] },
    { file: 'gallery-1.png', kind: 'image', role: 'gallery', alt: 'A single dark pixel.' },
  ],
});

// A game folder: media.json plus media/<files>. files: name -> Buffer.
function writeGame(dir, doc, files) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'media.json'), JSON.stringify(doc, null, 2) + '\n');
  for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'media', n), b);
}
const cleanFiles = () => ({
  'hero.jpg': jpg(),
  'turntable.webm': webm(),
  'turntable.mp4': mp4(),
  'turntable-poster.png': png([0x18, 0x1a, 0x25]),
  'gallery-1.png': png([0x40, 0x80, 0xc0]),
});

function makeAssetsFixtures(out = path.join(__dirname, 'assets')) {
  fs.mkdirSync(out, { recursive: true });
  writeGame(path.join(out, 'fake-vr'), MEDIA('fake-vr'), cleanFiles());
  writeGame(path.join(out, 'flagged-vr'), MEDIA('flagged-vr'), {
    ...cleanFiles(),
    'hero.jpg': jpg({ exif: true }),
    'gallery-1.png': png([0x40, 0x80, 0xc0], [tEXt('Comment', 'Made up for a test.')]),
  });
  const expected = {
    'fake-vr': [],
    'flagged-vr': [['metadata', 'media/hero.jpg'], ['metadata', 'media/gallery-1.png']],
  };
  fs.writeFileSync(path.join(out, 'expected.json'), JSON.stringify(expected, null, 2) + '\n');
  return expected;
}

// `node --test test/` runs every .js under test/: never rewrite the fixtures then.
if (require.main === module && !process.env.NODE_TEST_CONTEXT) {
  const out = path.resolve(process.argv[2] || path.join(__dirname, 'assets'));
  const expected = makeAssetsFixtures(out);
  console.log(`${Object.keys(expected).length} assets fixture folders -> ${out}`);
}

module.exports = { makeAssetsFixtures, writeGame, cleanFiles, jpg, png, tEXt, webm, mp4, MEDIA };
