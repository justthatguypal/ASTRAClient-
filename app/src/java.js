'use strict';

/**
 * Finding a JVM that can actually run the chosen version.
 *
 * Every Minecraft version JSON since 1.17 states the major Java version it needs, and
 * running 1.20.5+ on Java 17 fails with a class-file-version error that tells the player
 * nothing. So we scan for every JVM on the machine, read its real version, and pick one
 * that satisfies the requirement rather than trusting whatever is on PATH.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const IS_WINDOWS = process.platform === 'win32';
const EXE = IS_WINDOWS ? 'java.exe' : 'java';

function candidateRoots() {
  const home = os.homedir();
  const roots = [];

  if (process.env.JAVA_HOME) roots.push(process.env.JAVA_HOME);

  // The official launcher's own runtimes - almost always present and always correct
  // for the version being launched.
  roots.push(path.join(home, 'AppData', 'Roaming', '.minecraft', 'runtime'));
  roots.push(path.join(home, 'curseforge', 'minecraft', 'Install', 'runtime'));
  roots.push(path.join(process.env.LOCALAPPDATA || '', 'Packages'));

  // This machine keeps a JDK here; other tools in this project already rely on it.
  roots.push(path.join(home, 'AppData', 'Roaming', 'squidservers', 'java'));

  roots.push('C:\\Program Files\\Java');
  roots.push('C:\\Program Files\\Eclipse Adoptium');
  roots.push('C:\\Program Files\\Microsoft\\jdk');
  roots.push('C:\\Program Files (x86)\\Java');
  roots.push(path.join(home, '.jdks'));

  return roots.filter(Boolean).filter((p) => {
    try { return fs.existsSync(p); } catch (_) { return false; }
  });
}

/** Walks a directory a few levels deep looking for bin/java. */
function findExecutables(root, depth = 0, out = []) {
  if (depth > 4 || out.length > 60) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return out;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    if (entry.name === 'bin') {
      const exe = path.join(dir, EXE);
      try { if (fs.existsSync(exe)) out.push(exe); } catch (_) { /* unreadable */ }
      continue;
    }
    findExecutables(dir, depth + 1, out);
  }
  return out;
}

function probe(exe) {
  return new Promise((resolve) => {
    execFile(exe, ['-version'], { timeout: 8000 }, (err, _stdout, stderr) => {
      if (err) return resolve(null);
      // `java -version` writes to stderr, and reports either 1.8.0_x or 17.0.x.
      const text = String(stderr || '');
      const match = text.match(/version "(\d+)(?:\.(\d+))?[^"]*"/);
      if (!match) return resolve(null);
      const first = parseInt(match[1], 10);
      const second = match[2] ? parseInt(match[2], 10) : 0;
      const major = first === 1 ? second : first;
      resolve({ path: exe, major, is64: /64-Bit/.test(text) });
    });
  });
}

let cached = null;

async function scan(force = false) {
  if (cached && !force) return cached;

  const found = new Set();
  for (const root of candidateRoots()) {
    for (const exe of findExecutables(root)) found.add(exe);
  }
  if (IS_WINDOWS) found.add('java.exe');
  else found.add('java');

  const probes = await Promise.all([...found].map(probe));
  const seen = new Map();
  for (const result of probes) {
    if (!result) continue;
    // One entry per major version, preferring 64-bit.
    const existing = seen.get(result.major);
    if (!existing || (result.is64 && !existing.is64)) seen.set(result.major, result);
  }
  cached = [...seen.values()].sort((a, b) => b.major - a.major);
  return cached;
}

/**
 * Picks a JVM for a version that needs at least `required`. Prefers an exact match,
 * because Forge in particular is fussy about running on a newer JVM than it expects.
 */
async function pick(required, override) {
  if (override) {
    const probed = await probe(override);
    if (probed) return probed;
    throw new Error(`The Java path in settings does not work: ${override}`);
  }

  const all = await scan();
  if (!all.length) {
    throw new Error('No Java installation found. Install Java ' + (required || 17)
      + ' or set a Java path in Settings.');
  }
  const need = required || 8;

  const exact = all.find((j) => j.major === need);
  if (exact) return exact;

  const newer = all.filter((j) => j.major >= need).sort((a, b) => a.major - b.major)[0];
  if (newer) return newer;

  throw new Error(`This version needs Java ${need}, but the newest one found is `
    + `Java ${all[0].major}. Install Java ${need} or set a path in Settings.`);
}

module.exports = { scan, pick, probe };
