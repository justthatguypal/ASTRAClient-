'use strict';

/**
 * The mod browser, backed by Modrinth's public API.
 *
 * Modrinth asks for a real User-Agent and will throttle anonymous traffic that does not
 * send one, so every request here goes through `api()`. Installs resolve required
 * dependencies too - installing a Fabric mod without Fabric API is the single most
 * common way for a modded profile to fail on the first launch.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const net = require('./net');
const store = require('./store');

const BASE = 'https://api.modrinth.com/v2';
const AGENT = 'AstraClient/1.0 (Minecraft launcher)';

async function api(endpoint) {
  const res = await fetch(`${BASE}${endpoint}`, { headers: { 'User-Agent': AGENT } });
  if (res.status === 429) throw new Error('Modrinth is rate limiting us. Wait a few seconds.');
  if (!res.ok) throw new Error(`Modrinth ${res.status} on ${endpoint.split('?')[0]}`);
  return res.json();
}

/** Modrinth files loaders under `categories`, same namespace as themes and tags. */
function facetsFor({ loader, gameVersion, category, projectType }) {
  const facets = [[`project_type:${projectType || 'mod'}`]];
  if (loader && loader !== 'vanilla') facets.push([`categories:${loader}`]);
  if (gameVersion) facets.push([`versions:${gameVersion}`]);
  if (category) facets.push([`categories:${category}`]);
  return encodeURIComponent(JSON.stringify(facets));
}

async function search({ query = '', loader, gameVersion, category, sort = 'relevance',
  limit = 30, offset = 0, projectType = 'mod' } = {}) {
  // Horror is not a Modrinth tag, so it is answered by searching rather than faceting.
  if (category === 'horror' && projectType === 'mod') {
    return searchHorror({ query, loader, gameVersion, sort, limit, offset });
  }

  const params = new URLSearchParams({
    query,
    limit: String(limit),
    offset: String(offset),
    index: sort
  });
  const url = `/search?${params.toString()}&facets=${facetsFor({ loader, gameVersion, category, projectType })}`;
  const data = await api(url);

  return {
    total: data.total_hits,
    offset: data.offset,
    hits: (data.hits || []).map((hit) => ({
      id: hit.project_id,
      slug: hit.slug,
      title: hit.title,
      description: hit.description,
      author: hit.author,
      downloads: hit.downloads,
      follows: hit.follows,
      icon: hit.icon_url,
      categories: (hit.categories || []).filter((c) => !LOADERS.includes(c)),
      versions: hit.versions,
      updated: hit.date_modified
    }))
  };
}

const LOADERS = ['fabric', 'forge', 'neoforge', 'quilt', 'liteloader', 'modloader', 'rift'];

/* ------------------------------------------------------------------ horror
 *
 * Modrinth has no "horror" category - its tags are adventure, magic, cursed and
 * so on, and "cursed" means joke mods, not scary ones. So the Horror tab is built
 * by searching rather than filtering: fan out across the terms horror mods
 * actually use, merge, and rank by downloads.
 *
 * Only Modrinth is queried. It hosts the mods, moderates uploads and scans files,
 * which is the whole reason the launcher uses it. The sites that come up when you
 * search for scary Minecraft mods are overwhelmingly re-uploaders, and a re-hosted
 * jar is the single most common way people get a trojan into their game - so
 * nothing here downloads from them.
 */

/*
 * Named mods people actually mean by "scary". Each carries the distinctive word its
 * title should contain, because searching a phrase matches prose too: "the mimic"
 * happily returns a client mod describing itself as mimicking other launchers.
 */
const HORROR_NAMED = [
  { term: 'cave dweller', match: 'dweller' },
  { term: 'dweller', match: 'dweller' },
  { term: 'from the fog', match: 'fog' },
  { term: 'man from the fog', match: 'fog' },
  { term: 'siren head', match: 'siren' },
  { term: 'the mimic', match: 'mimic' },
  { term: 'herobrine', match: 'herobrine' },
  { term: 'midnight lurker', match: 'lurker' },
  { term: 'sculk horde', match: 'sculk' },
  { term: 'backrooms', match: 'backrooms' },
  { term: 'slender', match: 'slender' },
  { term: 'goatman', match: 'goatman' }
];

// Broad terms. These pull in unrelated projects, so their hits must look horror-ish.
const HORROR_BROAD = [
  'horror', 'scary', 'spooky', 'creepy', 'haunted',
  'nightmare', 'jumpscare', 'eldritch', 'monster'
];

/*
 * Deliberately missing: "monster", which is just Minecraft's word for any hostile
 * mob ("they spawn and disappear like monsters" is not a horror mod), and "cursed",
 * which is Modrinth's tag for joke mods rather than frightening ones.
 */
const HORROR_WORDS = [
  'horror', 'scary', 'scare', 'spooky', 'creepy', 'creep', 'haunt', 'ghost',
  'nightmare', 'fear', 'terror', 'dread', 'eerie', 'sinister',
  'demon', 'macabre', 'jumpscare', 'lurk', 'stalker', 'dweller',
  'paranorm', 'occult', 'eldritch', 'sanity', 'insanity', 'gore', 'undead',
  'phantom', 'wraith', 'siren', 'slender', 'backrooms', 'liminal',
  'unsettl', 'disturb', 'apparition', 'poltergeist', 'stalk'
];

function looksHorror(hit) {
  const haystack = `${hit.title} ${hit.description} ${(hit.categories || []).join(' ')}`
    .toLowerCase();
  return HORROR_WORDS.some((word) => haystack.includes(word));
}

/*
 * The merged pool is cached because the grid pages with an offset. Rebuilding a
 * 21-request fan-out every time the user scrolls would be both slow and rude to
 * Modrinth; the filters that matter are all in the key.
 */
let horrorCache = { key: null, hits: [] };

async function searchHorrorPool({ loader, gameVersion, query, sort }) {
  const key = JSON.stringify([loader, gameVersion, query, sort]);
  if (horrorCache.key === key) return horrorCache.hits;

  const run = (term, match) => search({
    // A term the user typed narrows the topic; on its own it is the whole search.
    query: query ? `${query} ${term}` : term,
    loader,
    gameVersion,
    sort: 'relevance',
    limit: 30,
    projectType: 'mod'
  }).then((r) => r.hits.map((hit) => ({ hit, match })));

  const batches = await Promise.allSettled([
    ...HORROR_NAMED.map((n) => run(n.term, n.match)),
    ...HORROR_BROAD.map((t) => run(t, null))
  ]);

  // A term that fails is one term, not a failed search - keep whatever came back.
  // A hit stays if it is plainly the named mod, or if it reads as horror at all.
  const seen = new Map();
  for (const batch of batches) {
    if (batch.status !== 'fulfilled') continue;
    for (const { hit, match } of batch.value) {
      const named = match && hit.title.toLowerCase().includes(match);
      if (!named && !looksHorror(hit)) continue;
      if (!seen.has(hit.id)) seen.set(hit.id, hit);
    }
  }

  const hits = [...seen.values()];
  hits.sort((a, b) => (sort === 'newest'
    ? new Date(b.updated) - new Date(a.updated)
    : b.downloads - a.downloads));

  horrorCache = { key, hits };
  return hits;
}

async function searchHorror(options) {
  const { offset = 0, limit = 30 } = options;
  const hits = await searchHorrorPool(options);
  return { total: hits.length, offset, hits: hits.slice(offset, offset + limit) };
}


/** Versions of one project that fit a given loader and Minecraft version. */
async function projectVersions(projectId, loader, gameVersion) {
  const params = [];
  if (loader && loader !== 'vanilla') params.push(`loaders=${encodeURIComponent(JSON.stringify([loader]))}`);
  if (gameVersion) params.push(`game_versions=${encodeURIComponent(JSON.stringify([gameVersion]))}`);
  const query = params.length ? `?${params.join('&')}` : '';
  return api(`/project/${projectId}/version${query}`);
}

function pickFile(version) {
  const files = version.files || [];
  return files.find((f) => f.primary) || files[0] || null;
}

/** Newest release first, falling back to betas only if that is all there is. */
function bestVersion(versions) {
  if (!versions.length) return null;
  const release = versions.filter((v) => v.version_type === 'release');
  const pool = release.length ? release : versions;
  return pool.slice().sort((a, b) => new Date(b.date_published) - new Date(a.date_published))[0];
}

function modsDirFor(profile) {
  return path.join(store.profileDir(profile), 'mods');
}

/** Shader packs live in their own folder and are loaded by Iris/OptiFine, not the loader. */
function shadersDirFor(profile) {
  return path.join(store.profileDir(profile), 'shaderpacks');
}

function resourcePacksDirFor(profile) {
  return path.join(store.profileDir(profile), 'resourcepacks');
}

/** Neither shaders nor resource packs care which loader a profile uses. */
function folderFor(profile, kind) {
  if (kind === 'shader') return shadersDirFor(profile);
  if (kind === 'resourcepack') return resourcePacksDirFor(profile);
  return modsDirFor(profile);
}

async function listInstalled(profile, kind = 'mod') {
  const dir = folderFor(profile, kind);
  try {
    const files = await fsp.readdir(dir);
    // Mods are jars; shaders and resource packs are zips.
    return kind === 'mod'
      ? files.filter((f) => f.endsWith('.jar') || f.endsWith('.jar.disabled'))
      : files.filter((f) => f.endsWith('.zip') || f.endsWith('.zip.disabled'));
  } catch (_) {
    return [];
  }
}

/**
 * Installs a project and everything it requires.
 * onProgress gets ({title, done, total}).
 */
async function install(profile, projectId, onProgress = () => {}, kind = 'mod') {
  if (!profile) throw new Error('Pick a profile first.');
  if (kind === 'mod' && profile.loader === 'vanilla') {
    throw new Error('This profile is vanilla. Make a Fabric, Forge, Quilt or NeoForge profile to use mods.');
  }

  const dir = folderFor(profile, kind);
  await fsp.mkdir(dir, { recursive: true });

  const queue = [projectId];
  const seen = new Set();
  const installed = [];

  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);

    const versions = await projectVersions(id,
      kind === 'mod' ? profile.loader : null,
      profile.mcVersion);
    const version = bestVersion(versions);
    if (!version) {
      if (id === projectId) {
        const what = kind === 'shader' ? 'shader' : kind === 'resourcepack' ? 'resource pack' : 'mod';
        throw new Error(kind === 'mod'
          ? `No build of this mod for ${profile.loader} ${profile.mcVersion}.`
          : `No build of this ${what} for ${profile.mcVersion}.`);
      }
      // A missing optional-ish dependency should not sink the whole install.
      continue;
    }

    const file = pickFile(version);
    if (!file) continue;

    onProgress({ title: file.filename, done: installed.length, total: seen.size });
    const dest = path.join(dir, file.filename);
    await net.download(file.url, dest, (file.hashes && file.hashes.sha1) || null, file.size);
    installed.push({ id, filename: file.filename, version: version.version_number });

    for (const dep of version.dependencies || []) {
      if (dep.dependency_type === 'required' && dep.project_id) queue.push(dep.project_id);
    }
  }

  return installed;
}

async function remove(profile, filename, kind = 'mod') {
  const target = path.join(folderFor(profile, kind), path.basename(filename));
  await fsp.rm(target, { force: true });
  return true;
}

/** Flips a file between active and .disabled without deleting it. */
async function toggle(profile, filename, kind = 'mod') {
  const dir = folderFor(profile, kind);
  const current = path.join(dir, path.basename(filename));
  const disabled = current.endsWith('.disabled');
  const next = disabled ? current.replace(/\.disabled$/, '') : `${current}.disabled`;
  if (!fs.existsSync(current)) throw new Error('That file is no longer there.');
  await fsp.rename(current, next);
  return path.basename(next);
}

module.exports = { search, projectVersions, install, remove, toggle, listInstalled,
  modsDirFor, shadersDirFor, resourcePacksDirFor, folderFor };
