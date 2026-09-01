'use strict';

/** Download helpers: verified, resumable-by-skipping, and parallel but not rude about it. */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable, Transform } = require('stream');

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

/** No data for this long means the connection is dead, not slow. */
const STALL_MS = 30000;

/** Passes bytes through untouched, failing the stream if they stop arriving. */
function stallGuard(ms, message, onChunk) {
  let timer = null;
  const arm = (stream) => {
    clearTimeout(timer);
    timer = setTimeout(() => stream.destroy(new Error(message)), ms);
  };

  return new Transform({
    transform(chunk, _enc, next) {
      arm(this);
      if (onChunk) onChunk(chunk);
      next(null, chunk);
    },
    flush(next) {
      clearTimeout(timer);
      next();
    }
  });
}

async function download(url, dest, sha1, size, attempt = 0, onBytes = null) {
  if (await isValid(dest, sha1, size)) return false;

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const temp = `${dest}.part`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'AstraClient/1.0' },
      signal: AbortSignal.timeout(45000)
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

    /*
     * Abort a download that stops sending, rather than one that is merely slow.
     *
     * There was no timeout here at all, so a connection that stalled mid-transfer
     * hung forever and the whole update sat there looking frozen. A cap on total
     * time would be wrong - it would punish slow connections on a big file - so the
     * clock is on the *gap between chunks* and resets every time data arrives.
     */
    const expected = Number(res.headers.get('content-length')) || size || 0;
    let received = 0;

    await pipeline(
      Readable.fromWeb(res.body),
      stallGuard(STALL_MS, `${path.basename(dest)} stopped responding`, (chunk) => {
        if (!onBytes) return;
        received += chunk.length;
        onBytes(received, expected);
      }),
      fs.createWriteStream(temp)
    );

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
      return download(url, dest, sha1, size, attempt + 1, onBytes);
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
      const label = item.label || path.basename(item.dest);
      try {
        await download(item.url, item.dest, item.sha1, item.size, 0, (got, expected) => {
          // Only worth reporting for files big enough to sit on for a while.
          if (onProgress && expected > 1024 * 1024) {
            onProgress(done, total, label, { got, expected });
          }
        });
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
