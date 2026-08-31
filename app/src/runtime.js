'use strict';

/**
 * Downloads the exact Java runtime a version asks for, straight from Mojang.
 *
 * This is what makes old versions playable. Every version JSON names a runtime
 * component - 1.8.9 and 1.12.2 want `jre-legacy`, which is Java 8. Running those on a
 * modern JVM fails with
 *
 *     ClassCastException: AppClassLoader cannot be cast to URLClassLoader
 *
 * from launchwrapper, because Java 9 changed the system class loader. No amount of
 * argument tweaking fixes it; the version genuinely needs Java 8. Rather than telling
 * people to go and install an ancient JDK, fetch the same runtime the official launcher
 * uses and keep it beside the game files.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const net = require('./net');
const store = require('./store');

const ALL_RUNTIMES =
  'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';

let indexCache = null;

function platformKey() {
  if (process.platform === 'win32') {
    if (process.arch === 'arm64') return 'windows-arm64';
    return process.arch === 'ia32' ? 'windows-x86' : 'windows-x64';
  }
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  }
  return process.arch === 'ia32' ? 'linux-i386' : 'linux';
}

function runtimesDir() {
  return path.join(store.ROOT, 'runtimes');
}

function componentDir(component) {
  return path.join(runtimesDir(), platformKey(), component);
}

function javaExecutable(component) {
  const dir = componentDir(component);
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  // Mojang nests mac runtimes inside a bundle; everything else is flat.
  const candidates = [
    path.join(dir, 'bin', exe),
    path.join(dir, 'jre.bundle', 'Contents', 'Home', 'bin', exe)
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function isInstalled(component) {
  return fs.existsSync(javaExecutable(component));
}

async function index() {
  if (!indexCache) indexCache = await net.getJson(ALL_RUNTIMES);
  return indexCache;
}

/** Which components this platform can actually get. */
async function available() {
  const all = await index();
  return Object.keys(all[platformKey()] || {});
}

/**
 * Makes sure a runtime component is on disk, downloading it if not.
 * Returns the path to its java executable.
 */
async function ensure(component, onProgress = () => {}) {
  if (isInstalled(component)) return javaExecutable(component);

  const all = await index();
  const platform = all[platformKey()];
  if (!platform || !platform[component] || !platform[component].length) {
    throw new Error(`Mojang has no ${component} runtime for ${platformKey()}.`);
  }

  const entry = platform[component][0];
  onProgress({ stage: 'runtime', message: `Fetching Java (${entry.version.name})` });

  const manifest = await net.getJson(entry.manifest.url);
  const target = componentDir(component);
  await fsp.mkdir(target, { recursive: true });

  const files = [];
  const links = [];

  for (const [relative, info] of Object.entries(manifest.files || {})) {
    const destination = path.join(target, relative);
    if (info.type === 'directory') {
      await fsp.mkdir(destination, { recursive: true });
    } else if (info.type === 'link') {
      links.push({ destination, targetPath: info.target });
    } else if (info.type === 'file' && info.downloads && info.downloads.raw) {
      files.push({
        url: info.downloads.raw.url,
        dest: destination,
        sha1: info.downloads.raw.sha1,
        size: info.downloads.raw.size,
        label: relative,
        executable: Boolean(info.executable)
      });
    }
  }

  onProgress({ stage: 'runtime', message: `Downloading Java ${entry.version.name}`, done: 0, total: files.length });
  await net.downloadAll(files, (done, total, label) => {
    onProgress({ stage: 'runtime', message: label, done, total });
  }, 12);

  // Links are rare on Windows and symlinks need privileges there, so copy instead.
  for (const link of links) {
    try {
      const source = path.resolve(path.dirname(link.destination), link.targetPath);
      await fsp.mkdir(path.dirname(link.destination), { recursive: true });
      if (fs.existsSync(source) && !fs.existsSync(link.destination)) {
        await fsp.copyFile(source, link.destination);
      }
    } catch (_) {
      // A missing link is not worth failing an otherwise complete runtime over.
    }
  }

  if (process.platform !== 'win32') {
    for (const file of files.filter((f) => f.executable)) {
      await fsp.chmod(file.dest, 0o755).catch(() => {});
    }
  }

  const exe = javaExecutable(component);
  if (!fs.existsSync(exe)) {
    throw new Error(`The ${component} runtime downloaded but no java executable was found.`);
  }
  return exe;
}

/** Best guess at a component when a version JSON does not name one. */
function componentForMajor(major) {
  if (major <= 8) return 'jre-legacy';
  if (major <= 16) return 'java-runtime-alpha';
  if (major <= 17) return 'java-runtime-gamma';
  if (major <= 21) return 'java-runtime-delta';
  return 'java-runtime-epsilon';
}

module.exports = { ensure, isInstalled, javaExecutable, available, platformKey, componentForMajor, runtimesDir };
