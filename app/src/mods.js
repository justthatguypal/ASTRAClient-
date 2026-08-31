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

async function listInstalled(profile, kind = 'mod') {
  const dir = kind === 'shader' ? shadersDirFor(profile) : modsDirFor(profile);
  try {
    const files = await fsp.readdir(dir);
    return kind === 'shader'
      ? files.filter((f) => f.endsWith('.zip') || f.endsWith('.zip.disabled'))
      : files.filter((f) => f.endsWith('.jar') || f.endsWith('.jar.disabled'));
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

  const dir = kind === 'shader' ? shadersDirFor(profile) : modsDirFor(profile);
  await fsp.mkdir(dir, { recursive: true });

  const queue = [projectId];
  const seen = new Set();
  const installed = [];

  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);

    const versions = await projectVersions(id,
      kind === 'shader' ? null : profile.loader,
      profile.mcVersion);
    const version = bestVersion(versions);
    if (!version) {
      if (id === projectId) {
        throw new Error(kind === 'shader'
          ? `No build of this shader for ${profile.mcVersion}.`
          : `No build of this mod for ${profile.loader} ${profile.mcVersion}.`);
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

async function remove(profile, filename) {
  const target = path.join(modsDirFor(profile), path.basename(filename));
  await fsp.rm(target, { force: true });
  return true;
}

/** Flips a jar between active and .disabled without deleting it. */
async function toggle(profile, filename) {
  const dir = modsDirFor(profile);
  const current = path.join(dir, path.basename(filename));
  const disabled = current.endsWith('.disabled');
  const next = disabled ? current.replace(/\.disabled$/, '') : `${current}.disabled`;
  if (!fs.existsSync(current)) throw new Error('That file is no longer there.');
  await fsp.rename(current, next);
  return path.basename(next);
}

module.exports = { search, projectVersions, install, remove, toggle, listInstalled, modsDirFor, shadersDirFor };
