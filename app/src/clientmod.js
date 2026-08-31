'use strict';

/**
 * Keeps the Astra client mod in step with every profile that can run it.
 *
 * The mod is what draws capes, the in-game menu and the rank badge, so it should never
 * be something a player has to install by hand. Before each launch the profile is
 * checked: if its Minecraft version and loader are supported, the bundled jar is copied
 * into that profile's mods folder, and any older Astra jar is removed first so two
 * copies can never fight over the same mod id.
 *
 * Vanilla profiles are skipped - with no loader there is nothing to load a mod.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const store = require('./store');

// Built jars live here, named astra-client-<mcVersion>-<loader>.jar.
const BUNDLED_DIR = path.join(__dirname, '..', 'assets', 'clientmod');

// Only the versions the mod is actually built for. Adding a version here without a
// matching jar just means it is reported as unavailable, not that it breaks.
const SUPPORTED = [
  { mcVersion: '1.21.11', loaders: ['fabric', 'forge', 'neoforge', 'quilt'] },
  { mcVersion: '26.2', loaders: ['fabric', 'forge', 'neoforge', 'quilt'] }
];

const MOD_PREFIX = 'astra-client';

function supportFor(profile) {
  if (!profile) return null;
  return SUPPORTED.find((entry) => entry.mcVersion === profile.mcVersion) || null;
}

/** Whether the mod can go into this profile at all. */
function compatibility(profile) {
  if (!profile) return { ok: false, reason: 'no profile' };
  if (profile.loader === 'vanilla') {
    return { ok: false, reason: 'vanilla profiles cannot load mods' };
  }
  const support = supportFor(profile);
  if (!support) {
    return { ok: false, reason: `the client mod is not built for ${profile.mcVersion}` };
  }
  if (!support.loaders.includes(profile.loader)) {
    return { ok: false, reason: `the client mod does not support ${profile.loader} yet` };
  }
  return { ok: true, jar: jarNameFor(profile) };
}

function jarNameFor(profile) {
  // Fabric and Quilt load the same jar; NeoForge and Forge each get their own.
  const loader = profile.loader === 'quilt' ? 'fabric' : profile.loader;
  return `${MOD_PREFIX}-${profile.mcVersion}-${loader}.jar`;
}

function bundledPath(profile) {
  return path.join(BUNDLED_DIR, jarNameFor(profile));
}

/** Versions we ship a jar for right now, as opposed to ones we intend to. */
function availableBuilds() {
  try {
    return fs.readdirSync(BUNDLED_DIR).filter((file) => file.endsWith('.jar'));
  } catch (_) {
    return [];
  }
}

function modsDir(profile) {
  return path.join(store.profileDir(profile), 'mods');
}

/**
 * Copies the mod in, replacing any older Astra jar.
 * Returns {installed, reason} - never throws, because a launch must not fail over this.
 */
async function ensureInstalled(profile) {
  if (store.get('autoInstallClientMod') === false) {
    return { installed: false, reason: 'turned off in settings' };
  }

  const compatible = compatibility(profile);
  if (!compatible.ok) return { installed: false, reason: compatible.reason };

  const source = bundledPath(profile);
  if (!fs.existsSync(source)) {
    return { installed: false, reason: `no build of the client mod for ${profile.mcVersion} ${profile.loader} yet` };
  }

  const dir = modsDir(profile);
  await fsp.mkdir(dir, { recursive: true });

  const target = path.join(dir, compatible.jar);

  try {
    // Clear out every other Astra jar first. Two copies of the same mod id is an
    // instant crash on Fabric and a silent mess on Forge.
    for (const file of await fsp.readdir(dir)) {
      if (file.startsWith(MOD_PREFIX) && file !== compatible.jar) {
        await fsp.rm(path.join(dir, file), { force: true });
      }
    }

    // Only copy when it differs, so launching does not rewrite the jar every time.
    const [sourceStat, targetStat] = await Promise.all([
      fsp.stat(source),
      fsp.stat(target).catch(() => null)
    ]);
    if (!targetStat || targetStat.size !== sourceStat.size
        || targetStat.mtimeMs < sourceStat.mtimeMs) {
      await fsp.copyFile(source, target);
      return { installed: true, jar: compatible.jar, updated: Boolean(targetStat) };
    }
    return { installed: true, jar: compatible.jar, alreadyCurrent: true };
  } catch (err) {
    return { installed: false, reason: err.message };
  }
}

async function remove(profile) {
  const dir = modsDir(profile);
  try {
    for (const file of await fsp.readdir(dir)) {
      if (file.startsWith(MOD_PREFIX)) await fsp.rm(path.join(dir, file), { force: true });
    }
    return true;
  } catch (_) {
    return false;
  }
}

/** For the UI: which versions the mod targets, and which are actually built. */
function status() {
  const built = availableBuilds();
  return {
    supported: SUPPORTED,
    built,
    ready: built.length > 0,
    directory: BUNDLED_DIR
  };
}

module.exports = { ensureInstalled, remove, compatibility, status, availableBuilds, SUPPORTED };
