'use strict';

/**
 * Turning a chosen version into a directory you can actually launch.
 *
 * Handles the vanilla side (client jar, libraries, natives, assets) and the four loaders.
 * Fabric and Quilt publish a ready-made version JSON, so they need nothing but their
 * libraries. Forge and NeoForge have to patch the client jar, so their official installer
 * is run headless - reimplementing their processors would be a losing fight.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const net = require('./net');
const zip = require('./zip');
const store = require('./store');
const versions = require('./versions');
const java = require('./java');
const runtime = require('./runtime');

const OS_NAME = process.platform === 'win32' ? 'windows'
  : process.platform === 'darwin' ? 'osx' : 'linux';
const ARCH = process.arch === 'ia32' ? 'x86' : process.arch === 'arm64' ? 'arm64' : 'x64';

// ---------------------------------------------------------------- rules & paths

function ruleAllows(rules, features = {}) {
  if (!rules || !rules.length) return true;
  let allowed = false;
  for (const rule of rules) {
    let matches = true;
    if (rule.os) {
      if (rule.os.name && rule.os.name !== OS_NAME) matches = false;
      if (rule.os.arch && rule.os.arch !== ARCH) matches = false;
      if (rule.os.version && !new RegExp(rule.os.version).test(os.release())) matches = false;
    }
    if (rule.features) {
      for (const [key, want] of Object.entries(rule.features)) {
        if (Boolean(features[key]) !== Boolean(want)) matches = false;
      }
    }
    if (matches) allowed = rule.action === 'allow';
  }
  return allowed;
}

/**
 * Modern versions list every native variant - natives-windows, natives-windows-arm64
 * and natives-windows-x86 - under the *same* rule, `os.name == windows`, with no arch
 * condition at all. So rules alone happily pull arm64 binaries onto an x64 machine,
 * which is what broke snapshots. The classifier suffix is the only thing that says
 * which architecture a native is for, so it has to be checked separately.
 */
function nativeSuitsThisMachine(name) {
  const parts = String(name).split(':');
  const classifier = parts.length > 3 ? parts[3] : '';
  if (!classifier.startsWith('natives-')) return true;

  const tail = classifier.slice('natives-'.length).split('-');
  const arch = tail.slice(1).join('-');

  if (!arch) return ARCH === 'x64';        // bare natives-windows means 64-bit
  if (arch === 'arm64') return ARCH === 'arm64';
  if (arch === 'x86') return ARCH === 'x86';
  return true;
}

/** `group:artifact:version[:classifier]` -> the path it lives at inside libraries/. */
function mavenPath(name) {
  const [group, artifact, version, classifier] = name.split(':');
  const file = classifier
    ? `${artifact}-${version}-${classifier}.jar`
    : `${artifact}-${version}.jar`;
  return path.join(...group.split('.'), artifact, version, file);
}

function gameRoot() {
  return store.get('gameDir');
}

function versionDir(id) {
  return path.join(gameRoot(), 'versions', id);
}

function librariesDir() {
  return path.join(gameRoot(), 'libraries');
}

function assetsDir() {
  return path.join(gameRoot(), 'assets');
}

function nativesDir(id) {
  return path.join(versionDir(id), 'natives');
}

// ---------------------------------------------------------------- version json

async function readLocalVersion(id) {
  const file = path.join(versionDir(id), `${id}.json`);
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

/** Fetches a vanilla version JSON and caches it on disk the way the official launcher does. */
async function fetchVanillaVersion(id) {
  const local = await readLocalVersion(id);
  if (local) return local;

  const entry = await versions.versionEntry(id);
  const json = await net.getJson(entry.url);
  const file = path.join(versionDir(id), `${id}.json`);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(json, null, 2), 'utf8');
  return json;
}

function mergeVersions(parent, child) {
  const merged = { ...parent, ...child };
  // Child libraries come first: a loader that ships its own copy of a library has to win
  // the classpath, or you get the vanilla class and a very confusing crash.
  merged.libraries = [...(child.libraries || []), ...(parent.libraries || [])];
  merged.mainClass = child.mainClass || parent.mainClass;
  merged.assetIndex = child.assetIndex || parent.assetIndex;
  merged.assets = child.assets || parent.assets;
  merged.downloads = child.downloads || parent.downloads;
  merged.javaVersion = child.javaVersion || parent.javaVersion;
  merged.minecraftArguments = child.minecraftArguments || parent.minecraftArguments;
  merged.arguments = {
    game: [...((parent.arguments && parent.arguments.game) || []),
      ...((child.arguments && child.arguments.game) || [])],
    jvm: [...((parent.arguments && parent.arguments.jvm) || []),
      ...((child.arguments && child.arguments.jvm) || [])]
  };
  delete merged.inheritsFrom;
  return merged;
}

/** Reads a version JSON and folds in whatever it inherits from. */
async function resolveVersion(id, depth = 0) {
  if (depth > 6) throw new Error('Version inheritance is looping');
  let json = await readLocalVersion(id);
  if (!json) json = await fetchVanillaVersion(id);
  if (json.inheritsFrom) {
    const parent = await resolveVersion(json.inheritsFrom, depth + 1);
    json = mergeVersions(parent, json);
  }
  return json;
}

// ---------------------------------------------------------------- libraries

/** Splits a version's libraries into classpath jars and native archives to unpack. */
function collectLibraries(json) {
  const classpath = [];
  const natives = [];
  const seen = new Set();

  for (const lib of json.libraries || []) {
    if (!ruleAllows(lib.rules)) continue;
    if (!nativeSuitsThisMachine(lib.name)) continue;

    const downloads = lib.downloads || {};

    // Legacy natives: a `natives` map naming a classifier per OS.
    if (lib.natives && lib.natives[OS_NAME]) {
      const classifier = lib.natives[OS_NAME].replace('${arch}', ARCH === 'x86' ? '32' : '64');
      const artifact = (downloads.classifiers || {})[classifier];
      if (artifact) {
        natives.push({
          url: artifact.url,
          dest: path.join(librariesDir(), artifact.path || mavenPath(`${lib.name}:${classifier}`)),
          sha1: artifact.sha1,
          size: artifact.size,
          exclude: (lib.extract && lib.extract.exclude) || []
        });
      }
      if (!downloads.artifact) continue;
    }

    const artifact = downloads.artifact;
    if (artifact) {
      const dest = path.join(librariesDir(), artifact.path || mavenPath(lib.name));
      if (seen.has(dest)) continue;
      seen.add(dest);

      const item = { url: artifact.url, dest, sha1: artifact.sha1, size: artifact.size, name: lib.name };
      classpath.push(item);

      // Modern versions list natives as ordinary libraries with a natives-* classifier.
      // They belong on the classpath *and* have to be unpacked.
      if (/:natives-/.test(lib.name) || /natives-/.test(path.basename(dest))) {
        natives.push({ ...item, exclude: (lib.extract && lib.extract.exclude) || [] });
      }
    } else if (lib.url && lib.name) {
      // Loader metadata often gives a bare maven root instead of a full artifact block.
      const relative = mavenPath(lib.name);
      const dest = path.join(librariesDir(), relative);
      if (seen.has(dest)) continue;
      seen.add(dest);
      classpath.push({
        url: lib.url.replace(/\/$/, '') + '/' + relative.split(path.sep).join('/'),
        dest,
        name: lib.name
      });
    }
  }

  return { classpath, natives };
}

async function extractNatives(json, natives, id) {
  const target = nativesDir(id);
  await fsp.rm(target, { recursive: true, force: true });
  await fsp.mkdir(target, { recursive: true });

  for (const native of natives) {
    if (!fs.existsSync(native.dest)) continue;
    const exclude = native.exclude || ['META-INF/'];
    await zip.extract(native.dest, target, (name) => {
      if (name.endsWith('/')) return false;
      if (exclude.some((prefix) => name.startsWith(prefix))) return false;
      // Only actual native binaries, never the class files sitting beside them.
      return /\.(dll|so|dylib|jnilib)$/i.test(name);
    });
  }
  return target;
}

// ---------------------------------------------------------------- assets

async function assetDownloads(json) {
  if (!json.assetIndex) return { items: [], indexId: json.assets || 'legacy' };

  const indexFile = path.join(assetsDir(), 'indexes', `${json.assetIndex.id}.json`);
  await net.download(json.assetIndex.url, indexFile, json.assetIndex.sha1, json.assetIndex.size);
  const index = JSON.parse(await fsp.readFile(indexFile, 'utf8'));

  const items = [];
  for (const [name, object] of Object.entries(index.objects || {})) {
    const hash = object.hash;
    const prefix = hash.slice(0, 2);
    items.push({
      url: `https://resources.download.minecraft.net/${prefix}/${hash}`,
      dest: path.join(assetsDir(), 'objects', prefix, hash),
      sha1: hash,
      size: object.size,
      label: name,
      virtualName: name
    });
  }
  return { items, indexId: json.assetIndex.id, index, virtual: Boolean(index.virtual), mapToResources: Boolean(index.map_to_resources) };
}

/** Pre-1.7 versions read loose files instead of the hashed object store. */
async function materialiseLegacyAssets(json, assetInfo, profileDirectory) {
  if (!assetInfo.index) return;
  if (!assetInfo.virtual && !assetInfo.mapToResources) return;

  const base = assetInfo.mapToResources
    ? path.join(profileDirectory, 'resources')
    : path.join(assetsDir(), 'virtual', assetInfo.indexId);

  for (const [name, object] of Object.entries(assetInfo.index.objects || {})) {
    const source = path.join(assetsDir(), 'objects', object.hash.slice(0, 2), object.hash);
    const target = path.join(base, name);
    if (!fs.existsSync(source)) continue;
    if (fs.existsSync(target)) continue;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(source, target);
  }
}

// ---------------------------------------------------------------- loaders

function loaderVersionId(profile) {
  switch (profile.loader) {
    case 'fabric': return `fabric-loader-${profile.loaderVersion}-${profile.mcVersion}`;
    case 'quilt': return `quilt-loader-${profile.loaderVersion}-${profile.mcVersion}`;
    case 'forge': return `${profile.mcVersion}-forge-${profile.loaderVersion}`;
    case 'neoforge': return `neoforge-${profile.loaderVersion}`;
    default: return profile.mcVersion;
  }
}

/** Fabric and Quilt just hand us a version JSON; write it where the launcher expects. */
async function installFabricLike(profile) {
  const id = loaderVersionId(profile);
  const file = path.join(versionDir(id), `${id}.json`);
  if (fs.existsSync(file)) return id;

  const json = profile.loader === 'quilt'
    ? await versions.quiltProfile(profile.mcVersion, profile.loaderVersion)
    : await versions.fabricProfile(profile.mcVersion, profile.loaderVersion);

  json.id = id;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(json, null, 2), 'utf8');
  return id;
}

/**
 * Runs a loader installer.
 *
 * `spawn` rather than `execFile` on purpose: the Forge installer prints one line per
 * class it copies - tens of thousands of them - and buffering all of that risks the
 * child being killed part way through, which leaves a half-finished install behind.
 * The tail is kept for error messages and the rest is dropped as it arrives.
 */
function runInstaller(javaPath, jar, dir, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(javaPath, ['-jar', jar, '--installClient', dir], { cwd: dir });

    const tail = [];
    const keep = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 40) tail.shift();
        if (onLine) onLine(line);
      }
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('The loader installer took too long and was stopped.'));
    }, 20 * 60 * 1000);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not start the loader installer: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`Loader installer failed:\n${tail.slice(-12).join('\n')}`));
      }
      resolve(tail.join('\n'));
    });
  });
}

/**
 * True when every library a version needs is actually on disk.
 *
 * The reason this exists: Forge writes its version JSON early and only produces the
 * patched Minecraft jar at the very end, so an interrupted install leaves something that
 * looks complete but is missing the one file containing Minecraft.class. Checking only
 * for the JSON meant a broken install could never repair itself - the launcher skipped
 * the installer forever and Java failed with "Could not find net/minecraft/client/Minecraft.class".
 */
async function versionIsComplete(id) {
  const file = path.join(versionDir(id), `${id}.json`);
  if (!fs.existsSync(file)) return false;

  let json;
  try {
    json = await resolveVersion(id);
  } catch (_) {
    return false;
  }

  const { classpath } = collectLibraries(json);
  for (const item of classpath) {
    // Only fault on libraries the installer itself produces locally. Anything with a
    // download URL can still be fetched normally afterwards.
    if (!item.url && !fs.existsSync(item.dest)) return false;
    if (/forge|neoforge/i.test(item.name || '') && /:client|-client\.jar$/.test(item.name || item.dest)
        && !fs.existsSync(item.dest)) {
      return false;
    }
  }
  return true;
}

/**
 * Forge and NeoForge patch the client jar with their own processors, so their official
 * installer does the work. It insists on a launcher_profiles.json being present, which
 * is the one thing that makes it refuse to run in a fresh directory.
 */
async function installForgeLike(profile, onProgress) {
  const id = loaderVersionId(profile);

  // Completeness, not mere presence - see versionIsComplete.
  if (await versionIsComplete(id)) return id;

  if (fs.existsSync(path.join(versionDir(id), `${id}.json`))) {
    onProgress({ stage: 'loader', message: `${profile.loader} is installed but incomplete - repairing it` });
  }

  onProgress({ stage: 'loader', message: `Preparing ${profile.loader} ${profile.loaderVersion}` });

  const root = gameRoot();
  const profilesFile = path.join(root, 'launcher_profiles.json');
  if (!fs.existsSync(profilesFile)) {
    await fsp.mkdir(root, { recursive: true });
    await fsp.writeFile(profilesFile,
      JSON.stringify({ profiles: {}, settings: {}, version: 3 }, null, 2), 'utf8');
  }

  const url = profile.loader === 'forge'
    ? versions.forgeInstallerUrl(profile.mcVersion, profile.loaderVersion)
    : versions.neoforgeInstallerUrl(profile.loaderVersion);

  const jar = path.join(store.ROOT, 'cache', path.basename(url));
  onProgress({ stage: 'loader', message: 'Downloading installer' });
  await net.download(url, jar);

  // The installer runs the version's own processors, so give it a JVM new enough for them.
  const vanillaJson = await resolveVersion(profile.mcVersion);
  const required = (vanillaJson.javaVersion && vanillaJson.javaVersion.majorVersion) || 17;
  const component = (vanillaJson.javaVersion && vanillaJson.javaVersion.component)
    || runtime.componentForMajor(required);

  let javaPath;
  if (store.get('javaPath')) {
    javaPath = (await java.pick(required, store.get('javaPath'))).path;
  } else {
    const installed = await java.scan();
    const exact = installed.find((entry) => entry.major === required);
    javaPath = exact ? exact.path : await runtime.ensure(component, onProgress);
  }

  onProgress({ stage: 'loader', message: `Running the ${profile.loader} installer (this patches the game, give it a minute)` });
  await runInstaller(javaPath, jar, root, (line) => {
    // Patching lines are the slow part, so show them rather than looking frozen.
    if (/^(Patching|Output:|Injecting|Successfully)/.test(line)) {
      onProgress({ stage: 'loader', message: line.slice(0, 90) });
    }
  });

  if (!(await versionIsComplete(id))) {
    throw new Error(`The ${profile.loader} installer finished but did not produce a complete install. `
      + 'Try again, and check there is enough disk space.');
  }

  if (!fs.existsSync(path.join(versionDir(id), `${id}.json`))) {
    // Forge has renamed its output more than once; find whatever it actually wrote.
    const all = await fsp.readdir(path.join(root, 'versions')).catch(() => []);
    const guess = all.find((name) => name.includes(profile.loaderVersion));
    if (guess) return guess;
    throw new Error(`${profile.loader} installed but its version folder could not be found`);
  }
  return id;
}

// ---------------------------------------------------------------- top level

/**
 * Installs everything a profile needs and returns what the launcher has to know.
 * onProgress gets {stage, message, done, total}.
 */
async function install(profile, onProgress = () => {}) {
  const report = (stage, message, done, total) => onProgress({ stage, message, done, total });

  report('version', `Fetching ${profile.mcVersion}`);
  await fetchVanillaVersion(profile.mcVersion);

  // Forge's processors need the untouched client jar on disk before they run.
  const vanillaJson = await resolveVersion(profile.mcVersion);
  if (vanillaJson.downloads && vanillaJson.downloads.client) {
    report('client', 'Downloading the game');
    await net.download(
      vanillaJson.downloads.client.url,
      path.join(versionDir(profile.mcVersion), `${profile.mcVersion}.jar`),
      vanillaJson.downloads.client.sha1,
      vanillaJson.downloads.client.size
    );
  }

  let versionId = profile.mcVersion;
  if (profile.loader === 'fabric' || profile.loader === 'quilt') {
    report('loader', `Installing ${profile.loader} ${profile.loaderVersion}`);
    versionId = await installFabricLike(profile);
  } else if (profile.loader === 'forge' || profile.loader === 'neoforge') {
    versionId = await installForgeLike(profile, onProgress);
  }

  const json = await resolveVersion(versionId);

  if (json.downloads && json.downloads.client) {
    const jar = path.join(versionDir(versionId), `${versionId}.jar`);
    if (!(await net.isValid(jar, json.downloads.client.sha1, json.downloads.client.size))) {
      report('client', 'Downloading the game');
      await net.download(json.downloads.client.url, jar, json.downloads.client.sha1, json.downloads.client.size);
    }
  }

  const { classpath, natives } = collectLibraries(json);
  const libraryItems = [...classpath, ...natives].filter((item) => item.url);
  report('libraries', 'Downloading libraries', 0, libraryItems.length);
  await net.downloadAll(libraryItems,
    (done, total, label) => report('libraries', label, done, total));

  report('natives', 'Unpacking natives');
  await extractNatives(json, natives, versionId);

  const assetInfo = await assetDownloads(json);
  report('assets', 'Downloading assets', 0, assetInfo.items.length);
  await net.downloadAll(assetInfo.items,
    (done, total, label) => report('assets', label, done, total), 16);

  const directory = store.profileDir(profile);
  await fsp.mkdir(path.join(directory, 'mods'), { recursive: true });
  await materialiseLegacyAssets(json, assetInfo, directory);

  report('done', 'Ready');

  return {
    versionId,
    json,
    classpath: classpath.map((c) => c.dest),
    natives: nativesDir(versionId),
    assetIndexId: assetInfo.indexId,
    assetsRoot: assetInfo.mapToResources ? path.join(directory, 'resources') : assetsDir(),
    gameDirectory: directory
  };
}

module.exports = {
  install,
  resolveVersion,
  collectLibraries,
  loaderVersionId,
  ruleAllows,
  versionIsComplete,
  versionDir,
  librariesDir,
  assetsDir,
  gameRoot
};
