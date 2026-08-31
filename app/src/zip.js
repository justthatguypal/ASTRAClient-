'use strict';

/**
 * A small read-only ZIP reader, enough to pull natives out of library jars and to read
 * a single entry out of a loader installer.
 *
 * Written by hand rather than pulled from npm on purpose: on this machine `npm install`
 * wipes `node_modules/electron/dist`, so every avoided dependency is one less way to
 * break the app. Only the two compression methods that actually appear in jars are
 * supported - stored and deflate.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const ZIP64_EOCD_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;

function findEocd(buffer) {
  // The comment field means the record is not necessarily at a fixed offset.
  const maxComment = 0xffff;
  const start = Math.max(0, buffer.length - maxComment - 22);
  for (let i = buffer.length - 22; i >= start; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error('Not a zip file (no end of central directory record)');
}

function readEntries(buffer) {
  const eocd = findEocd(buffer);
  let count = buffer.readUInt16LE(eocd + 10);
  let directoryOffset = buffer.readUInt32LE(eocd + 16);

  // Jars big enough to need zip64 are rare but real once shaders and mods are involved.
  if (directoryOffset === 0xffffffff || count === 0xffff) {
    for (let i = eocd - 20; i >= 0; i--) {
      if (buffer.readUInt32LE(i) === ZIP64_EOCD_LOCATOR) {
        const zip64Offset = Number(buffer.readBigUInt64LE(i + 8));
        if (buffer.readUInt32LE(zip64Offset) === ZIP64_EOCD) {
          count = Number(buffer.readBigUInt64LE(zip64Offset + 32));
          directoryOffset = Number(buffer.readBigUInt64LE(zip64Offset + 48));
        }
        break;
      }
    }
  }

  const entries = [];
  let cursor = directoryOffset;
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) break;

    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readEntryData(buffer, entry) {
  // The local header repeats the name and extra fields, and its extra length can differ
  // from the central directory's, so it has to be read rather than assumed.
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`Unsupported zip compression method ${entry.method} for ${entry.name}`);
}

async function list(file) {
  const buffer = await fsp.readFile(file);
  return readEntries(buffer).map((e) => e.name);
}

/** Reads one entry out of an archive by exact name. Returns null when absent. */
async function readFile(file, entryName) {
  const buffer = await fsp.readFile(file);
  const entry = readEntries(buffer).find((e) => e.name === entryName);
  if (!entry) return null;
  return readEntryData(buffer, entry);
}

/**
 * Extracts an archive into a directory.
 * `filter(name)` decides what comes out; `exclude` is the version JSON's exclude list.
 */
async function extract(file, destination, filter) {
  const buffer = await fsp.readFile(file);
  const entries = readEntries(buffer);
  await fsp.mkdir(destination, { recursive: true });

  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;
    if (filter && !filter(entry.name)) continue;

    // Never let an archive write outside the directory it was told to fill.
    const target = path.join(destination, entry.name);
    const relative = path.relative(destination, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;

    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, readEntryData(buffer, entry));
  }
}

module.exports = { list, readFile, extract };
