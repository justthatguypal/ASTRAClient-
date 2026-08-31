'use strict';

/** Everything that has to survive a restart: settings, the signed-in account, profiles. */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(os.homedir(), 'AppData', 'Roaming', '.astraclient');
const CONFIG = path.join(ROOT, 'config.json');

const DEFAULTS = {
  gameDir: path.join(ROOT, 'game'),
  javaPath: '',
  memoryMb: 4096,
  jvmArgs: '-XX:+UseG1GC -XX:+UnlockExperimentalVMOptions -XX:G1NewSizePercent=20 -XX:MaxGCPauseMillis=50',
  width: 1280,
  height: 720,
  fullscreen: false,
  closeOnLaunch: false,
  showSnapshots: false,
  musicEnabled: true,
  musicVolume: 0.35,
  backgroundEnabled: true,
  account: null,
  lastProfile: null,
  profiles: [],
  friends: [],
  serverUrl: 'http://localhost:8787',
  background: 'bg1.jpg',
  seasonalThemes: true,
  perfPreset: 'balanced',
  processPriority: 'normal',
  writeGameOptions: false,
  discordEnabled: true,
  serverList: [],
  updateRepo: null,
  autoInstallClientMod: true
};

let cache = null;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function load() {
  if (cache) return cache;
  ensureDir(ROOT);
  let data = {};
  try {
    if (fs.existsSync(CONFIG)) data = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch (_) {
    // A corrupt config must never stop the launcher opening; defaults win.
  }
  cache = { ...DEFAULTS, ...data };
  healPaths(cache);
  ensureDir(cache.gameDir);
  return cache;
}

/**
 * Repairs settings holding absolute paths into a data folder that no longer exists.
 *
 * `gameDir` is stored absolute, so renaming the app's data folder leaves it pointing at
 * the old one. The launcher then writes versions into one folder and looks for them in
 * another, and installs appear to vanish. Anything under a previous root gets moved onto
 * the current one.
 */
function healPaths(config) {
  const OLD_ROOTS = ['.lunaclient'];
  const current = ROOT;

  if (typeof config.gameDir !== 'string' || !config.gameDir) {
    config.gameDir = path.join(current, 'game');
    return;
  }

  const stale = OLD_ROOTS.some((old) => config.gameDir.includes(`${path.sep}${old}${path.sep}`));
  if (!stale) return;

  const relative = path.basename(config.gameDir) || 'game';
  config.gameDir = path.join(current, relative);
  save();
}

function save() {
  if (!cache) return;
  ensureDir(ROOT);
  fs.writeFileSync(CONFIG, JSON.stringify(cache, null, 2), 'utf8');
}

function get(key) {
  return load()[key];
}

function set(key, value) {
  load()[key] = value;
  save();
}

function patch(values) {
  Object.assign(load(), values);
  save();
}

/** A named launch configuration: a version plus a loader plus its own mods folder. */
function upsertProfile(profile) {
  const config = load();
  const index = config.profiles.findIndex((p) => p.id === profile.id);
  if (index >= 0) config.profiles[index] = profile;
  else config.profiles.push(profile);
  save();
  return profile;
}

function removeProfile(id) {
  const config = load();
  config.profiles = config.profiles.filter((p) => p.id !== id);
  if (config.lastProfile === id) config.lastProfile = null;
  save();
}

function profileDir(profile) {
  // Modded profiles get their own directory so two loaders never share a mods folder.
  if (!profile || profile.loader === 'vanilla') return get('gameDir');
  return path.join(get('gameDir'), 'profiles', profile.id);
}

module.exports = {
  ROOT,
  DEFAULTS,
  load,
  save,
  get,
  set,
  patch,
  upsertProfile,
  removeProfile,
  profileDir,
  ensureDir
};
