'use strict';

/** Download helpers: verified, resumable-by-skipping, and parallel but not rude about it. */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'AstraClient/1.0' } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'AstraClient/1.0' } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

function sha1OfFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/** True when the file is already there and matches, so we can skip the download. */
async function isValid(file, sha1, size) {
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile() || stat.size === 0) return false;
    if (size && stat.size !== size) return false;
    if (!sha1) return true;
    return (await sha1OfFile(file)) === sha1.toLowerCase();
  } catch (_) {
    return false;
  }
}

async function download(url, dest, sha1, size, attempt = 0) {
  if (await isValid(dest, sha1, size)) return false;

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const temp = `${dest}.part`;

  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'AstraClient/1.0' } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(temp));

    if (sha1) {
      const actual = await sha1OfFile(temp);
      if (actual !== sha1.toLowerCase()) throw new Error(`checksum mismatch for ${path.basename(dest)}`);
    }
    await fsp.rm(dest, { force: true });
    await fsp.rename(temp, dest);
    return true;
  } catch (err) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    // Mojang's CDN drops connections often enough that one retry is worth more than
    // a clear error message.
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      return download(url, dest, sha1, size, attempt + 1);
    }
    throw new Error(`Failed to download ${url}: ${err.message}`);
  }
}

/**
 * Runs a list of {url, dest, sha1, size} downloads with a fixed worker count.
 * onProgress gets (done, total, label) after every item.
 */
async function downloadAll(items, onProgress, concurrency = 12) {
  const total = items.length;
  let done = 0;
  let failed = null;
  let cursor = 0;

  async function worker() {
    while (cursor < items.length && !failed) {
      const item = items[cursor++];
      try {
        await download(item.url, item.dest, item.sha1, item.size);
      } catch (err) {
        failed = err;
        return;
      }
      done++;
      if (onProgress) onProgress(done, total, item.label || path.basename(item.dest));
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, worker);
  await Promise.all(workers);
  if (failed) throw failed;
}

module.exports = { getJson, getText, download, downloadAll, isValid, sha1OfFile };
