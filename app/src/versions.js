'use strict';

/**
 * Version lists: vanilla from Mojang, and the loader lists from each project's own
 * metadata service. Everything is cached for the session so flipping around the version
 * selector does not hammer four different APIs.
 */

const { getJson, getText } = require('./net');

const MOJANG_MANIFEST = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';
const FABRIC_META = 'https://meta.fabricmc.net/v2';
const QUILT_META = 'https://meta.quiltmc.org/v3';
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml';
const FORGE_PROMOTIONS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml';

const cache = {};

async function once(key, fn) {
  if (!cache[key]) {
    cache[key] = fn().catch((err) => {
      delete cache[key];
      throw err;
    });
  }
  return cache[key];
}

/** Every vanilla version Mojang still serves, newest first. */
async function vanilla() {
  return once('vanilla', async () => {
    const data = await getJson(MOJANG_MANIFEST);
    return {
      latest: data.latest,
      versions: data.versions.map((v) => ({
        id: v.id,
        type: v.type,
        url: v.url,
        sha1: v.sha1,
        releaseTime: v.releaseTime
      }))
    };
  });
}

async function versionEntry(id) {
  const { versions } = await vanilla();
  const entry = versions.find((v) => v.id === id);
  if (!entry) throw new Error(`Unknown Minecraft version: ${id}`);
  return entry;
}

async function fabricLoaders(mcVersion) {
  return once(`fabric:${mcVersion}`, async () => {
    const data = await getJson(`${FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}`);
    return data.map((entry) => ({
      id: entry.loader.version,
      stable: entry.loader.stable
    }));
  });
}

async function quiltLoaders(mcVersion) {
  return once(`quilt:${mcVersion}`, async () => {
    const data = await getJson(`${QUILT_META}/versions/loader/${encodeURIComponent(mcVersion)}`);
    return data.map((entry) => ({ id: entry.loader.version, stable: !/beta|pre/i.test(entry.loader.version) }));
  });
}

function parseMavenVersions(xml) {
  const out = [];
  const re = /<version>([^<]+)<\/version>/g;
  let match;
  while ((match = re.exec(xml)) !== null) out.push(match[1]);
  return out;
}

/** Newest first. Maven metadata is in publish order, which interleaves branches. */
function byVersionDesc(a, b) {
  const pa = String(a).split(/[.\-+]/);
  const pb = String(b).split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = parseInt(pa[i], 10);
    const nb = parseInt(pb[i], 10);
    if (Number.isNaN(na) && Number.isNaN(nb)) continue;
    if (Number.isNaN(na)) return 1;
    if (Number.isNaN(nb)) return -1;
    if (na !== nb) return nb - na;
  }
  return 0;
}

async function neoforgeLoaders(mcVersion) {
  const all = await once('neoforge', async () => parseMavenVersions(await getText(NEOFORGE_MAVEN)));

  // Two schemes live in the same repository. Old Minecraft numbering drops the leading
  // "1.", so 1.21.11 becomes 21.11.x - note that is 21.11, not 21.1.1. The newer
  // top-level numbering keeps the version as-is and appends a build, so 26.2 -> 26.2.0.x.
  const parts = mcVersion.split('.');
  const prefix = parts[0] === '1' && parts.length >= 2
    ? `${parts[1]}.${parts.length > 2 ? parts[2] : '0'}.`
    : `${mcVersion}.`;

  return all
    .filter((v) => v.startsWith(prefix))
    .sort(byVersionDesc)
    .map((v) => ({ id: v, stable: !/beta|alpha/i.test(v) }));
}

async function forgeLoaders(mcVersion) {
  const all = await once('forge', async () => parseMavenVersions(await getText(FORGE_MAVEN)));
  const prefix = `${mcVersion}-`;
  return all
    .filter((v) => v.startsWith(prefix))
    .map((v) => v.slice(prefix.length))
    .sort(byVersionDesc)
    .map((v) => ({ id: v, full: `${mcVersion}-${v}`, stable: true }));
}

/** Which loaders have anything at all for this Minecraft version. */
async function loadersFor(mcVersion) {
  const result = { vanilla: [{ id: 'vanilla', stable: true }] };

  const settled = await Promise.allSettled([
    fabricLoaders(mcVersion),
    quiltLoaders(mcVersion),
    neoforgeLoaders(mcVersion),
    forgeLoaders(mcVersion)
  ]);

  const names = ['fabric', 'quilt', 'neoforge', 'forge'];
  settled.forEach((outcome, i) => {
    // A loader with no build for this version is normal, not an error worth showing.
    result[names[i]] = outcome.status === 'fulfilled' ? outcome.value : [];
  });
  return result;
}

/** The Fabric/Quilt launch profile, which is a full version JSON with inheritsFrom. */
async function fabricProfile(mcVersion, loaderVersion) {
  return getJson(`${FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`);
}

async function quiltProfile(mcVersion, loaderVersion) {
  return getJson(`${QUILT_META}/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`);
}

function forgeInstallerUrl(mcVersion, loaderVersion) {
  const full = `${mcVersion}-${loaderVersion}`;
  return `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`;
}

function neoforgeInstallerUrl(loaderVersion) {
  return `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`;
}

module.exports = {
  vanilla,
  versionEntry,
  loadersFor,
  fabricLoaders,
  quiltLoaders,
  forgeLoaders,
  neoforgeLoaders,
  fabricProfile,
  quiltProfile,
  forgeInstallerUrl,
  neoforgeInstallerUrl
};
