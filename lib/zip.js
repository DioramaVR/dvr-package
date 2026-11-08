'use strict';
// Zips. Listing and extracting use Windows' own tar.exe (bsdtar), so there's
// no dependency. Creating is done here in plain Node instead: tar.exe can't
// fix timestamps, and it stores each file's own times, so the same input
// would give a different zip every time. create() writes entries sorted by
// name, every timestamp the given date, no extra fields: the same input and
// the same Node build give the same bytes. (zlib's output can differ between
// zlib builds, so compare zips made by the same toolchain.)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { PackageError } = require('./errors');

function tarExe() {
  return process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
}

// Entry names in a zip, as stored (directories end in "/"), read from its
// central directory. (tar.exe's own listing prints names in the console's
// code page, which garbles non-ASCII names; the checks need the real ones.)
// Names flagged UTF-8 decode as UTF-8, others as Latin-1. zip64 isn't
// supported: package zips are far below its limits.
function list(zipPath) {
  const notZip = () => new PackageError('not-a-mod', `${path.basename(zipPath)} isn't a zip file, or it's damaged`);
  let buf;
  try { buf = fs.readFileSync(zipPath); } catch { throw notZip(); }
  // The end-of-central-directory record: in the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw notZip();
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || p === 0xffffffff || p + cdSize > eocd) throw notZip();
  const names = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw notZip();
    const flags = buf.readUInt16LE(p + 8);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const raw = buf.subarray(p + 46, p + 46 + nameLen);
    // tar.exe extracts by the local headers, so each must name the same file
    // as the central directory that was checked.
    const local = buf.readUInt32LE(p + 42);
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw notZip();
    const localLen = buf.readUInt16LE(local + 26);
    if (!buf.subarray(local + 30, local + 30 + localLen).equals(raw)) {
      throw new PackageError('unsafe-path', `${path.basename(zipPath)} names a file differently in two places: ${raw.toString('latin1')}`);
    }
    names.push(raw.toString(flags & 0x0800 ? 'utf8' : 'latin1'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

// Every entry's bytes, read here rather than by tar.exe: [{ name, data }] in
// zip order (stored or deflated entries; names from the central directory,
// checked against the local headers by list()). For tools and tests that look
// inside a zip, including bad ones; installing still goes through extract().
// opts.maxTotal (bytes): refuse, before inflating anything, a zip whose files
// add up to more, and check every entry's size and CRC-32 (the data zip,
// which is read this way, never unpacked by tar).
function readEntries(zipPath, { maxTotal } = {}) {
  const names = list(zipPath);
  const buf = fs.readFileSync(zipPath);
  const out = [];
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const damaged = (name, why) => new PackageError('not-a-mod', `${path.basename(zipPath)} is damaged: ${name} ${why}`);
  let p = buf.readUInt32LE(eocd + 16);
  if (maxTotal != null) {
    let total = 0;
    for (let i = 0, q = p; i < names.length; i++) {
      total += buf.readUInt32LE(q + 24);
      q += 46 + buf.readUInt16LE(q + 28) + buf.readUInt16LE(q + 30) + buf.readUInt16LE(q + 32);
    }
    if (total > maxTotal) throw new PackageError('format', `${path.basename(zipPath)} unpacks to ${total} bytes, more than the ${maxTotal} allowed`);
  }
  for (const name of names) {
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const local = buf.readUInt32LE(p + 42);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + csize > buf.length) throw damaged(name, 'runs past the end of the file');
    const body = buf.subarray(start, start + csize);
    if (method !== 0 && method !== 8) throw new PackageError('not-a-mod', `${name}: unsupported zip method ${method}`);
    let data;
    try {
      data = method === 8 ? zlib.inflateRawSync(body, maxTotal != null ? { maxOutputLength: Math.max(1, usize) } : {}) : Buffer.from(body);
    } catch { throw damaged(name, "can't be inflated"); }
    if (maxTotal != null && (data.length !== usize || (zlib.crc32(data) >>> 0) !== crc)) throw damaged(name, "doesn't match its size or CRC-32");
    out.push({ name, data });
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

// Extracts everything into dir (which must exist). Check list() first.
function extract(zip, dir) {
  try {
    execFileSync(tarExe(), ['-x', '-f', zip, '-C', dir], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new PackageError('not-a-mod', `${path.basename(zip)} can't be unpacked: it isn't a zip file, or it's damaged`);
  }
}

// Extracts one entry's bytes (e.g. the manifest) without unpacking the rest.
function readEntry(zip, name) {
  try {
    return execFileSync(tarExe(), ['-x', '-O', '-f', zip, name], { windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
}

// MS-DOS date/time of "YYYY-MM-DD" at 00:00:00.
function dosDateTime(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  if (!(y >= 1980 && y <= 2107 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) throw new Error(`zip date must be YYYY-MM-DD from 1980 on, not "${date}"`);
  return { time: 0, date: ((y - 1980) << 9) | (m << 5) | d };
}

// Writes a zip of entries [{ name, file } | { name, data }] (names with
// forward slashes; written exactly as given, so tests can make bad zips).
// opts.date: "YYYY-MM-DD" for every timestamp (required).
function create(zipPath, entries, { date } = {}) {
  const dt = dosDateTime(date);
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (sorted.length > 0xffff) throw new Error('too many files for a zip without zip64');
  for (let i = 1; i < sorted.length; i++) if (sorted[i].name === sorted[i - 1].name) throw new Error(`${sorted[i].name} is in the zip twice`);
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  const tmp = `${zipPath}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  const central = [];
  let offset = 0;
  const put = (buf) => { fs.writeSync(fd, buf); offset += buf.length; };
  try {
    for (const e of sorted) {
      const data = e.data !== undefined ? Buffer.from(e.data) : fs.readFileSync(e.file);
      const name = Buffer.from(e.name, 'utf8');
      const deflated = zlib.deflateRawSync(data, { level: 9 });
      const method = deflated.length < data.length ? 8 : 0;
      const body = method === 8 ? deflated : data;
      if (data.length >= 0xffffffff || offset >= 0xffffffff) throw new Error('zip too large without zip64');
      const crc = zlib.crc32(data) >>> 0;
      const flags = /[^\x00-\x7f]/.test(e.name) ? 0x0800 : 0; // UTF-8 names
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(flags, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(dt.time, 10);
      local.writeUInt16LE(dt.date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      const cen = Buffer.alloc(46);
      cen.writeUInt32LE(0x02014b50, 0);
      cen.writeUInt16LE(20, 4); // made by: MS-DOS, zip 2.0
      cen.writeUInt16LE(20, 6);
      cen.writeUInt16LE(flags, 8);
      cen.writeUInt16LE(method, 10);
      cen.writeUInt16LE(dt.time, 12);
      cen.writeUInt16LE(dt.date, 14);
      cen.writeUInt32LE(crc, 16);
      cen.writeUInt32LE(body.length, 20);
      cen.writeUInt32LE(data.length, 24);
      cen.writeUInt16LE(name.length, 28);
      cen.writeUInt32LE(offset, 42);
      central.push(cen, name);
      put(local); put(name); put(body);
    }
    const cd = Buffer.concat(central);
    const cdOffset = offset;
    put(cd);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(sorted.length, 8);
    end.writeUInt16LE(sorted.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(cdOffset, 16);
    put(end);
    fs.closeSync(fd);
    fs.renameSync(tmp, zipPath);
  } catch (e) {
    try { fs.closeSync(fd); } catch { }
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return zipPath;
}

module.exports = { tarExe, list, readEntries, extract, readEntry, create };
