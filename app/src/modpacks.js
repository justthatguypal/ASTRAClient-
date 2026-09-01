'use strict';

/*
 * Modrinth modpacks: finding them, and installing one into a profile of its own.
 *
 * A .mrpack is a zip holding `modrinth.index.json` - the Minecraft version, the
 * loader, and a list of files with their hashes and download URLs - plus an
 * `overrides/` folder whose contents are copied into the instance as-is (configs,
 * resource packs, whatever the author shipped directly).
 *
 * Installing one therefore means: read the index, make a profile matching the
 * version and loader it asks for, fetch every file to its stated path, then lay the
 * overrides on top. The loader itself is installed by the normal launch path, so
 * nothing here duplicates that.
 */

const fsp = require('fs/promises');
const path = require('path');

const zip = require('./zip');
const net = require('./net');
const store = require('./store');
const mods = require('./mods');

const API = 'https://api.modrinth.com/v2';

async function api(endpoint) {
  const res = await fetch(`${API}${endpoint}`, {
    headers: { 'User-Agent': 'AstraClient/1.0' }
  });
  if (!res.ok) throw new Error(`Modrinth ${res.status} for ${endpoint}`);
  return res.json();
}

/* ------------------------------------------------------------------ search */

/** Modpacks, filtered the same way the mod browser filters mods. */
async function search({ query = '', gameVersion, sort = 'relevance',
  limit = 30, offset = 0 } = {}) {
  const facets = [['project_type:modpack']];
  if (gameVersion) facets.push([`versions:${gameVersion}`]);

  const params = new URLSearchParams({
    query, limit: String(limit), offset: String(offset), index: sort
  });
  const data = await api(
    `/search?${params.toString()}&facets=${encodeURIComponent(JSON.stringify(facets))}`);

  return {
    total: data.total_hits,
    hits: (data.hits || []).map((hit) => ({
      id: hit.project_id,
      slug: hit.slug,
      title: hit.title,
      description: hit.description,
      author: hit.author,
      downloads: hit.downloads,
      follows: hit.follows,
      icon: hit.icon_url,
      categories: hit.categories || [],
      versions: hit.versions,
      updated: hit.date_modified
    }))
  };
}

/* ---------------------------------------------------------------- featured */

/*
 * Three modpacks a week, picked the same way the mod version was: from the week
 * number, so everyone sees the same three and they rotate with nothing stored.
 */
function weekNumber(date = new Date()) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const days = Math.floor((date.getTime() - start) / 86400000);
  return date.getUTCFullYear() * 53 + Math.floor(days / 7);
}

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

let featuredCache = { key: null, hits: [] };

async function featured({ gameVersion, count = 3 } = {}) {
  const week = weekNumber();
  const key = JSON.stringify([week, gameVersion, count]);
  if (featuredCache.key === key) return featuredCache.hits;

  const result = await search({ gameVersion, sort: 'follows', limit: 100 });
  const pool = result.hits.filter((hit) => hit.downloads > 1000);
  if (!pool.length) return [];

  const random = seeded(week * 2654435761);
  const order = pool.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  const hits = order.slice(0, count);
  featuredCache = { key, hits };
  return hits;
}

/* ----------------------------------------------------------------- install */

/** Maps the index's dependency keys onto the loaders the launcher knows. */
const LOADER_KEYS = {
  'fabric-loader': 'fabric',
  'quilt-loader': 'quilt',
  forge: 'forge',
  neoforge: 'neoforge'
};

function readDependencies(index) {
  const deps = index.dependencies || {};
  const mcVersion = deps.minecraft;
  if (!mcVersion) throw new Error('That modpack does not say which Minecraft version it needs.');

  for (const [key, loader] of Object.entries(LOADER_KEYS)) {
    if (deps[key]) return { mcVersion, loader, loaderVersion: String(deps[key]) };
  }
  return { mcVersion, loader: 'vanilla', loaderVersion: '' };
}

/**
 * Installs a modpack into a brand new profile.
 *
 * A new profile every time, deliberately: packs pin exact mod versions, and
 * dropping one on top of an existing mods folder is how you get two versions of
 * the same mod and a crash nobody can explain.
 */
async function install(projectId, onProgress = () => {}) {
  const report = (title, done, total) => onProgress({ title, done, total });

  report('Finding the newest build');
  const versions = await api(`/project/${projectId}/version`);
  if (!versions.length) throw new Error('That modpack has no published files.');

  const version = versions[0];
  const file = (version.files || []).find((f) => f.primary) || (version.files || [])[0];
  if (!file) throw new Error('That modpack build has no file to download.');

  // Fetch the pack itself into the shared cache rather than a profile - it is a
  // transient archive, not part of any instance.
  const cacheDir = path.join(store.ROOT, 'cache', 'modpacks');
  await fsp.mkdir(cacheDir, { recursive: true });
  const packFile = path.join(cacheDir, path.basename(file.filename || 'pack.mrpack'));

  report(`Downloading ${version.name}`);
  await net.download(file.url, packFile, file.hashes && file.hashes.sha1, file.size);

  report('Reading the pack');
  const indexRaw = await zip.readFile(packFile, 'modrinth.index.json');
  if (!indexRaw) throw new Error('That file is not a Modrinth modpack.');
  const index = JSON.parse(indexRaw.toString('utf8'));

  const { mcVersion, loader, loaderVersion } = readDependencies(index);

  const profile = store.upsertProfile({
    id: `pack-${projectId}-${Date.now().toString(36)}`,
    name: index.name || 'Modpack',
    mcVersion,
    loader,
    loaderVersion,
    fromModpack: { projectId, versionId: version.id, packVersion: index.versionId || '' }
  });

  const root = store.profileDir(profile);
  await fsp.mkdir(root, { recursive: true });

  /* Every file the index lists, at the path the index gives it. */
  const wanted = (index.files || []).filter((entry) => {
    // Some packs mark files as optional for the client or server side.
    const env = entry.env || {};
    return env.client !== 'unsupported';
  });

  let done = 0;
  for (const entry of wanted) {
    // Paths come from a downloaded archive, so a "../" in one would write outside
    // the profile. Resolve and refuse anything that escapes.
    const target = path.resolve(root, entry.path);
    if (!target.startsWith(path.resolve(root))) {
      throw new Error(`The modpack tried to write outside its folder: ${entry.path}`);
    }

    const url = (entry.downloads || [])[0];
    if (url) {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await net.download(url, target, entry.hashes && entry.hashes.sha1, entry.fileSize);
    }
    done++;
    report(`Downloading ${index.name || 'the pack'}`, done, wanted.length);
  }

  /* The author's own files, laid over the top. */
  report('Applying the pack files');
  await zip.extract(packFile, root, (name) => name.startsWith('overrides/'));
  await zip.extract(packFile, root, (name) => name.startsWith('client-overrides/'));

  // extract keeps the archive's folder names, so the two override roots have to be
  // flattened into the instance itself.
  for (const dir of ['overrides', 'client-overrides']) {
    const from = path.join(root, dir);
    try {
      await fsp.access(from);
      await copyOver(from, root);
      await fsp.rm(from, { recursive: true, force: true });
    } catch (_) { /* the pack simply had none */ }
  }

  report('Done', wanted.length, wanted.length);
  return profile;
}

async function copyOver(from, to) {
  for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await fsp.mkdir(dest, { recursive: true });
      await copyOver(source, dest);
    } else {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(source, dest);
    }
  }
}

module.exports = { search, featured, install };
