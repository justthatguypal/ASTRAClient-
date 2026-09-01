'use strict';

/**
 * FPS and system tuning.
 *
 * Two halves: JVM flags, which decide how much time the game loses to garbage
 * collection, and Minecraft's own `options.txt`, which decides how much work the GPU is
 * asked to do. Both are written per profile, so a "max FPS" setup does not wreck a
 * profile you keep for screenshots.
 *
 * There is no ping spoofing here. Faking latency deceives the server and the people you
 * are playing against; measuring it honestly is what `ping` below does.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const net = require('net');

// Shenandoah/G1 tuning of the kind the performance-modding community settled on. The
// large young generation is what stops the periodic stutter in a heavily modded world.
const PRESETS = {
  balanced: {
    label: 'Balanced',
    jvm: '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200'
      + ' -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch'
      + ' -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M'
      + ' -XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4'
      + ' -XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90'
      + ' -XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32'
      + ' -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1',
    options: { renderDistance: 12, simulationDistance: 10, maxFps: 260, graphicsMode: 1,
      particles: 0, entityShadows: true, enableVsync: false, biomeBlendRadius: 2 }
  },
  fps: {
    label: 'Max FPS',
    jvm: '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=130'
      + ' -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch'
      + ' -XX:G1NewSizePercent=40 -XX:G1MaxNewSizePercent=50 -XX:G1HeapRegionSize=16M'
      + ' -XX:G1ReservePercent=15 -XX:InitiatingHeapOccupancyPercent=20'
      + ' -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1 -XX:SurvivorRatio=32'
      + ' -Dsun.rmi.dgc.server.gcInterval=2147483646',
    options: { renderDistance: 6, simulationDistance: 5, maxFps: 260, graphicsMode: 0,
      particles: 2, entityShadows: false, enableVsync: false, biomeBlendRadius: 0,
      ao: false, mipmapLevels: 0, entityDistanceScaling: 0.5 }
  },
  quality: {
    label: 'Quality',
    jvm: '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200'
      + ' -XX:+UnlockExperimentalVMOptions -XX:+AlwaysPreTouch -XX:G1NewSizePercent=30'
      + ' -XX:G1HeapRegionSize=8M -XX:+PerfDisableSharedMem',
    options: { renderDistance: 20, simulationDistance: 12, maxFps: 120, graphicsMode: 2,
      particles: 0, entityShadows: true, enableVsync: true, biomeBlendRadius: 4,
      ao: true, mipmapLevels: 4, entityDistanceScaling: 1.0 }
  },
  turbo: {
    label: 'Turbo',
    jvm: '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=100'
      + ' -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch'
      + ' -XX:G1NewSizePercent=40 -XX:G1MaxNewSizePercent=50 -XX:G1HeapRegionSize=16M'
      + ' -XX:G1ReservePercent=15 -XX:InitiatingHeapOccupancyPercent=20'
      + ' -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1 -XX:SurvivorRatio=32'
      // Bigger JIT code cache and tiered compilation settled early: Minecraft is a
      // long-running process, so paying compile cost up front beats re-JITing later.
      + ' -XX:+SegmentedCodeCache -XX:ReservedCodeCacheSize=512M'
      + ' -XX:NonNMethodCodeHeapSize=12M -XX:ProfiledCodeHeapSize=256M'
      + ' -XX:NonProfiledCodeHeapSize=244M -XX:+UseFastUnorderedTimeStamps'
      + ' -XX:+UseVectorCmov -XX:+UseCriticalJavaThreadPriority'
      + ' -Dsun.rmi.dgc.server.gcInterval=2147483646 -Djava.awt.headless=false',
    options: { renderDistance: 5, simulationDistance: 5, maxFps: 260, graphicsMode: 0,
      particles: 2, entityShadows: false, enableVsync: false, biomeBlendRadius: 0,
      ao: false, mipmapLevels: 0, entityDistanceScaling: 0.5, fancyGraphics: false,
      renderClouds: 'false', screenEffectScale: 0.0, fovEffectScale: 0.0,
      darknessEffectScale: 0.0, glintSpeed: 0.0, glintStrength: 0.0,
      bobView: false, showSubtitles: false }
  },
  potato: {
    label: 'Potato PC',
    jvm: '-XX:+UseSerialGC -XX:MaxGCPauseMillis=200 -XX:+PerfDisableSharedMem',
    options: { renderDistance: 4, simulationDistance: 4, maxFps: 60, graphicsMode: 0,
      particles: 2, entityShadows: false, enableVsync: false, biomeBlendRadius: 0,
      ao: false, mipmapLevels: 0, entityDistanceScaling: 0.5, fancyGraphics: false }
  }
};

// options.txt uses its own key names, several of which do not match the settings UI.
const OPTION_KEYS = {
  renderDistance: 'renderDistance',
  simulationDistance: 'simulationDistance',
  maxFps: 'maxFps',
  graphicsMode: 'graphicsMode',
  particles: 'particles',
  entityShadows: 'entityShadows',
  enableVsync: 'enableVsync',
  biomeBlendRadius: 'biomeBlendRadius',
  ao: 'ao',
  mipmapLevels: 'mipmapLevels',
  entityDistanceScaling: 'entityDistanceScaling',
  fancyGraphics: 'fancyGraphics',
  // Cheap wins the presets could not reach before: clouds are a full transparent
  // pass, and the screen-effect scales drive per-frame post-processing.
  renderClouds: 'renderClouds',
  screenEffectScale: 'screenEffectScale',
  fovEffectScale: 'fovEffectScale',
  darknessEffectScale: 'darknessEffectScale',
  glintSpeed: 'glintSpeed',
  glintStrength: 'glintStrength',
  bobView: 'bobView',
  showSubtitles: 'showSubtitles',
  prioritizeChunkUpdates: 'prioritizeChunkUpdates'
};

/*
 * The mods that actually move the needle.
 *
 * Every JVM flag in this file put together is worth a few frames; Sodium alone is
 * routinely worth double. So the strongest thing the launcher can do for framerate
 * is install the right rendering and memory mods for the profile - which it already
 * knows how to do.
 *
 * Listed per loader because the Fabric originals have different Forge ports, and
 * skipped silently when a build for that exact version does not exist yet.
 */
const PERFORMANCE_MODS = {
  fabric: ['sodium', 'lithium', 'ferrite-core', 'immediatelyfast', 'entityculling',
    'moreculling', 'dynamic-fps', 'modernfix', 'c2me-fabric'],
  quilt: ['sodium', 'lithium', 'ferrite-core', 'immediatelyfast', 'entityculling',
    'moreculling', 'dynamic-fps', 'modernfix'],
  forge: ['embeddium', 'canary', 'ferrite-core', 'modernfix', 'entityculling',
    'immediatelyfast', 'moreculling', 'dynamic-fps'],
  neoforge: ['embeddium', 'canary', 'ferrite-core', 'modernfix', 'entityculling',
    'immediatelyfast', 'dynamic-fps']
};

/**
 * Installs every performance mod that has a build for this profile.
 * Returns what went in and what had nothing available, so the UI can be honest
 * rather than claiming it installed things it did not.
 */
async function installMods(profile, onProgress = () => {}) {
  const mods = require('./mods');
  if (!profile) throw new Error('Pick a profile first.');
  if (profile.loader === 'vanilla') {
    throw new Error('This profile is vanilla. Performance mods need Fabric, Forge, Quilt or NeoForge.');
  }

  const wanted = PERFORMANCE_MODS[profile.loader] || [];
  const installed = [];
  const unavailable = [];

  for (let i = 0; i < wanted.length; i++) {
    const slug = wanted[i];
    onProgress({ title: `Looking for ${slug}`, done: i, total: wanted.length });

    try {
      const found = await mods.search({
        query: slug, loader: profile.loader, gameVersion: profile.mcVersion, limit: 5
      });
      const project = found.hits.find((h) => h.slug.toLowerCase() === slug);
      if (!project) { unavailable.push(slug); continue; }

      onProgress({ title: `Installing ${project.title}`, done: i, total: wanted.length });
      await mods.install(profile, project.id, () => {}, 'mod');
      installed.push(project.title);
    } catch (_) {
      // One mod refusing to install is not a reason to abandon the rest.
      unavailable.push(slug);
    }
  }

  onProgress({ title: 'Done', done: wanted.length, total: wanted.length });
  return { installed, unavailable };
}

function presets() {
  return Object.entries(PRESETS).map(([id, preset]) => ({
    id,
    label: preset.label,
    jvm: preset.jvm,
    options: preset.options
  }));
}

function jvmFor(presetId) {
  const preset = PRESETS[presetId] || PRESETS.balanced;
  return preset.jvm;
}

/**
 * Rewrites options.txt in place, touching only the keys the preset cares about so
 * everything else the player set by hand survives.
 */
async function applyOptions(gameDirectory, presetId) {
  const preset = PRESETS[presetId];
  if (!preset) return { written: false, reason: 'unknown preset' };

  const file = path.join(gameDirectory, 'options.txt');
  let lines = [];
  try {
    lines = (await fsp.readFile(file, 'utf8')).split(/\r?\n/);
  } catch (_) {
    // No options.txt yet - the game writes one on first run. Create a partial file;
    // Minecraft fills in everything missing.
    lines = [];
  }

  const wanted = new Map();
  for (const [key, value] of Object.entries(preset.options)) {
    const realKey = OPTION_KEYS[key];
    if (realKey) wanted.set(realKey, String(value));
  }

  const seen = new Set();
  const updated = lines.map((line) => {
    const index = line.indexOf(':');
    if (index === -1) return line;
    const key = line.slice(0, index);
    if (!wanted.has(key)) return line;
    seen.add(key);
    return `${key}:${wanted.get(key)}`;
  });

  for (const [key, value] of wanted) {
    if (!seen.has(key)) updated.push(`${key}:${value}`);
  }

  await fsp.mkdir(gameDirectory, { recursive: true });
  await fsp.writeFile(file, updated.filter((l, i) => l !== '' || i < updated.length - 1).join('\n'), 'utf8');
  return { written: true, keys: [...wanted.keys()] };
}

/** Windows process priority classes for `wmic`/`start`. */
const PRIORITY = { normal: 32, above: 32768, high: 128 };

function priorityValue(name) {
  return PRIORITY[name] || PRIORITY.normal;
}

/**
 * Honest latency measurement: how long a TCP connection to the server's port takes.
 * Three tries, best of, because the first is always the slowest.
 */
function ping(address, attempts = 3) {
  const [host, portText] = String(address).split(':');
  const port = Number(portText) || 25565;

  const once = () => new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(3000);
    socket.once('connect', () => finish(Date.now() - started));
    socket.once('timeout', () => finish(null));
    socket.once('error', () => finish(null));
    socket.connect(port, host);
  });

  return (async () => {
    let best = null;
    for (let i = 0; i < attempts; i++) {
      const result = await once();
      if (result !== null && (best === null || result < best)) best = result;
    }
    return { address, ms: best, reachable: best !== null };
  })();
}

module.exports = {
  installMods, presets, jvmFor, applyOptions, ping, priorityValue, PRESETS };
