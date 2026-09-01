'use strict';

/**
 * In-app updates, hosted on GitHub, without re-downloading the whole launcher.
 *
 * The insight that makes this worth doing: the Electron runtime is ~260 MB and almost
 * never changes, while the actual app - main.js, src/, renderer/ - is about a megabyte
 * and changes constantly. So the manifest hashes every app file and the updater fetches
 * only the ones that differ. A normal update is a few hundred KB instead of an 80 MB
 * reinstall.
 *
 * A full reinstall is only required when the Electron major version itself moves, and
 * the manifest says so explicitly rather than leaving people on a broken mix.
 *
 * Files are staged under %APPDATA%/.astraclient/updates/<version>/ and the completion
 * marker is written LAST, so an interrupted download is never applied. The swap happens
 * at startup, before anything has been required, which is the only moment nothing holds
 * those files open.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const net = require('./net');
const store = require('./store');

const DEFAULT_REPO = { owner: 'justthatguypal', repo: 'ASTRAClient-', branch: 'main' };
const UPDATES_DIR = path.join(store.ROOT, 'updates');
const MARKER = '.complete.json';

function repoConfig() {
  const configured = store.get('updateRepo');
  return { ...DEFAULT_REPO, ...(configured || {}) };
}

function manifestUrl() {
  const { owner, repo, branch } = repoConfig();
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/update.json`;
}

/*
 * Fetching the manifest without getting yesterday's answer.
 *
 * raw.githubusercontent.com sits behind a CDN that caches for minutes AND ignores
 * the query string, so the usual `?t=<now>` trick does nothing - it returns
 * x-cache: HIT and a stale version, and the launcher decides it is up to date when
 * an update was published moments ago.
 *
 * The API's contents endpoint is not cached that way and answers with the current
 * file. It is rate limited (60/hour per address, and one check per launch is well
 * inside that), so raw is kept as the fallback for when that runs out.
 */
async function fetchManifest() {
  const { owner, repo, branch } = repoConfig();
  const apiUrl =
    `https://api.github.com/repos/${owner}/${repo}/contents/update.json?ref=${branch}`;

  try {
    const res = await fetch(apiUrl, {
      headers: { 'User-Agent': 'AstraClient/1.0', Accept: 'application/vnd.github.raw' },
      signal: AbortSignal.timeout(10000)
    });
    if (res.ok) return JSON.parse(await res.text());

    // 404 means nothing published; say so rather than falling back and reporting
    // a confusing network error from the second attempt.
    if (res.status === 404) throw new Error(`GET ${apiUrl} -> 404`);
  } catch (err) {
    if (/-> 404/.test(err.message)) throw err;
    // Rate limited or offline - try raw before giving up.
  }

  return net.getJson(`${manifestUrl()}?t=${Date.now()}`);
}

function isConfigured() {
  return Boolean(repoConfig().owner);
}

function currentVersion() {
  try {
    return require('../package.json').version;
  } catch (_) {
    return '0.0.0';
  }
}

function electronMajor() {
  return parseInt(String(process.versions.electron || '0').split('.')[0], 10) || 0;
}

/** Semver-ish compare, enough for a.b.c with optional suffixes. */
function isNewer(candidate, current) {
  const parse = (v) => String(v).split(/[.\-+]/).map((p) => (Number.isNaN(Number(p)) ? p : Number(p)));
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] === undefined ? 0 : a[i];
    const y = b[i] === undefined ? 0 : b[i];
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x > y;
    return String(x) > String(y);
  }
  return false;
}

/**
 * Asks GitHub what the newest build is.
 * Returns {available, version, notes, needsFullInstall, files, downloads}.
 */
async function check(appDir) {
  if (!isConfigured()) {
    return { available: false, reason: 'no-repo', current: currentVersion() };
  }

  let manifest;
  try {
    manifest = await fetchManifest();
  } catch (err) {
    // A 404 is the ordinary "nothing has been published to this repo yet" case and
    // should not be reported as a network failure - that sent the last debug session
    // looking for a connection problem that did not exist.
    const notFound = /-> 404/.test(err.message);
    return {
      available: false,
      reason: notFound ? 'not-published' : 'unreachable',
      error: err.message,
      repo: `${repoConfig().owner}/${repoConfig().repo}`,
      current: currentVersion()
    };
  }

  const current = currentVersion();
  if (!manifest.version || !isNewer(manifest.version, current)) {
    return { available: false, reason: 'up-to-date', current, latest: manifest.version };
  }

  const needsFullInstall = Boolean(manifest.electronMajor)
    && manifest.electronMajor !== electronMajor();

  let changed = [];
  if (!needsFullInstall && Array.isArray(manifest.files)) {
    changed = await changedFiles(manifest.files, appDir);
  }

  return {
    available: true,
    current,
    version: manifest.version,
    notes: manifest.notes || '',
    needsFullInstall,
    files: changed,
    bytes: changed.reduce((total, file) => total + (file.size || 0), 0),
    downloads: manifest.downloads || {}
  };
}

/** Only the files whose hash differs from what is on disk. */
async function changedFiles(files, appDir) {
  const out = [];
  for (const file of files) {
    if (!file.path || !file.url) continue;
    const target = path.join(appDir, file.path);
    if (await net.isValid(target, file.sha1, file.size)) continue;
    out.push(file);
  }
  return out;
}

/** Downloads the changed files into a staging folder and marks it complete. */
async function download(info, onProgress = () => {}) {
  if (!info || !info.available || info.needsFullInstall) {
    throw new Error('There is nothing that can be applied automatically.');
  }

  const staging = path.join(UPDATES_DIR, info.version);
  await fsp.rm(staging, { recursive: true, force: true });
  await fsp.mkdir(staging, { recursive: true });

  const items = info.files.map((file) => ({
    url: file.url,
    dest: path.join(staging, file.path),
    sha1: file.sha1,
    size: file.size,
    label: file.path
  }));

  await net.downloadAll(items, (done, total, label) => onProgress({ done, total, label }), 6);

  // Written last on purpose: its presence is what makes the staged copy applicable.
  await fsp.writeFile(path.join(staging, MARKER), JSON.stringify({
    version: info.version,
    files: info.files.map((f) => f.path),
    stagedAt: new Date().toISOString()
  }, null, 2), 'utf8');

  return staging;
}

/*
 * Fetches the setup exe so a full update never sends anyone to a web page.
 *
 * A delta cannot cross an Electron major version - the runtime itself has to be
 * replaced - so those updates need the real installer. Opening a browser for it
 * meant leaving the launcher, finding the download, and running it by hand; this
 * downloads it here, with progress, ready to run.
 */
async function downloadInstaller(info, onProgress = () => {}) {
  const url = info && info.downloads && info.downloads.setup;
  if (!url) throw new Error('This update has no installer published yet.');

  const dest = path.join(UPDATES_DIR, `AstraClientSetup-v${info.version}.exe`);
  await fsp.mkdir(UPDATES_DIR, { recursive: true });

  const res = await fetch(url, { headers: { 'User-Agent': 'AstraClient/1.0' } });
  if (!res.ok) throw new Error(`Could not download the installer (${res.status}).`);

  const total = Number(res.headers.get('content-length') || 0);
  const temp = `${dest}.part`;
  const out = fs.createWriteStream(temp);
  let done = 0;

  for await (const chunk of res.body) {
    done += chunk.length;
    if (!out.write(Buffer.from(chunk))) {
      await new Promise((resolve) => out.once('drain', resolve));
    }
    onProgress({ done, total });
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));

  // A truncated exe still runs and fails confusingly, so a short read is caught here.
  if (total && done !== total) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw new Error('The installer download was incomplete. Try again.');
  }

  await fsp.rm(dest, { force: true }).catch(() => {});
  await fsp.rename(temp, dest);
  return dest;
}

function listStaged() {
  try {
    return fs.readdirSync(UPDATES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => fs.existsSync(path.join(UPDATES_DIR, name, MARKER)));
  } catch (_) {
    return [];
  }
}

function copyTree(from, to, skip) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip && skip(entry.name)) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(target, { recursive: true });
      copyTree(source, target, skip);
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
  }
}

/**
 * Applies any completed staged update. Call this at the very top of startup, before
 * anything else is required - that is the one moment none of these files are held open.
 * Returns the version applied, or null.
 */
function applyStaged(appDir, packaged) {
  // In a dev checkout appDir is the source tree. Overwriting it with a release build
  // would quietly destroy work in progress.
  if (!packaged) return null;

  const staged = listStaged().filter((version) => isNewer(version, currentVersion()));
  if (!staged.length) return null;

  staged.sort((a, b) => (isNewer(a, b) ? 1 : -1));
  const newest = staged[staged.length - 1];
  const staging = path.join(UPDATES_DIR, newest);

  try {
    copyTree(staging, appDir, (name) => name === MARKER);
  } catch (err) {
    // A failed swap must not brick the launcher; leave the old copy running.
    console.error('Could not apply the staged update:', err.message);
    return null;
  }

  fs.rmSync(staging, { recursive: true, force: true });
  for (const old of listStaged()) {
    if (!isNewer(old, newest)) {
      fs.rmSync(path.join(UPDATES_DIR, old), { recursive: true, force: true });
    }
  }
  return newest;
}

function setRepo(config) {
  store.set('updateRepo', { ...repoConfig(), ...config });
  return repoConfig();
}

module.exports = {
  downloadInstaller,
  check,
  download,
  applyStaged,
  listStaged,
  setRepo,
  repoConfig,
  isConfigured,
  currentVersion,
  manifestUrl,
  UPDATES_DIR
};
