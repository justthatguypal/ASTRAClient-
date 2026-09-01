'use strict';

/*
 * Works out why Minecraft died, names the mod responsible, and fixes it.
 *
 * The launcher already sees every line the game prints, so when it exits badly the
 * log is right there. Crashes are not mysterious - loaders announce what went wrong
 * in formats that have barely changed in years - so the job is to read what the game
 * already said, tie it to a jar on disk, and offer the repair.
 *
 * Everything here is conservative on purpose. A wrong guess that disables a mod the
 * player wanted is worse than saying "I am not sure", so a rule only fires when the
 * log is explicit, and a mod is only ever disabled (renamed), never deleted.
 */

const fsp = require('fs/promises');
const path = require('path');

const zip = require('./zip');
const mods = require('./mods');

/* ------------------------------------------------------------------ mod index */

/** Reads a jar's own metadata, so findings can say "Sodium" rather than a filename. */
async function readJarInfo(file) {
  const info = { file: path.basename(file), id: null, name: null, version: null, packages: [] };

  try {
    const fabric = await zip.readFile(file, 'fabric.mod.json');
    if (fabric) {
      // Some mods ship a fabric.mod.json with trailing commas or comments; a bad
      // parse must not take the whole diagnosis down with it.
      const meta = JSON.parse(fabric.toString('utf8'));
      info.id = meta.id || null;
      info.name = meta.name || meta.id || null;
      info.version = meta.version || null;
    }
  } catch (_) { /* not fatal - fall through to the Forge metadata */ }

  if (!info.id) {
    try {
      const toml = await zip.readFile(file, 'META-INF/mods.toml')
        || await zip.readFile(file, 'META-INF/neoforge.mods.toml');
      if (toml) {
        const text = toml.toString('utf8');
        const id = text.match(/modId\s*=\s*["']([^"']+)["']/);
        const name = text.match(/displayName\s*=\s*["']([^"']+)["']/);
        const version = text.match(/version\s*=\s*["']([^"']+)["']/);
        if (id) info.id = id[1];
        if (name) info.name = name[1];
        if (version) info.version = version[1];
      }
    } catch (_) { /* unreadable metadata just means a less specific finding */ }
  }

  // Top level packages, used to blame a jar for a stack trace.
  try {
    const entries = await zip.list(file);
    const seen = new Set();
    for (const entry of entries) {
      if (!entry.endsWith('.class')) continue;
      const parts = entry.split('/');
      if (parts.length < 3) continue;
      seen.add(parts[0] + '.' + parts[1]);
    }
    info.packages = [...seen];
  } catch (_) { /* ignore */ }

  if (!info.name) info.name = info.file.replace(/\.jar(\.disabled)?$/, '');
  return info;
}

/** Every mod in a profile, with the metadata needed to name and blame it. */
async function indexMods(profile) {
  const dir = mods.modsDirFor(profile);
  let files;
  try {
    files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jar'));
  } catch (_) {
    return [];
  }
  return Promise.all(files.map((f) => readJarInfo(path.join(dir, f))));
}

/** The jar a stack trace belongs to, by matching its packages against each jar. */
function blameByPackage(index, log) {
  const frames = log.match(/\bat ([a-z][\w]*(?:\.[\w$]+){2,})/g) || [];
  const counts = new Map();

  for (const frame of frames) {
    const cls = frame.slice(3);
    for (const mod of index) {
      // Minecraft, the loader and the JDK are not mods; only our jars can match.
      if (mod.packages.some((p) => cls.startsWith(p + '.'))) {
        counts.set(mod.file, (counts.get(mod.file) || 0) + 1);
      }
    }
  }

  if (!counts.size) return null;
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return index.find((m) => m.file === top) || null;
}

/** The newest crash report, if the game wrote one in the last few minutes. */
async function readLatestCrashReport(profile) {
  const dir = path.join(require('./store').profileDir(profile), 'crash-reports');
  try {
    const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.txt'));
    if (!files.length) return '';

    const stats = await Promise.all(files.map(async (f) => ({
      file: path.join(dir, f),
      time: (await fsp.stat(path.join(dir, f))).mtimeMs
    })));
    stats.sort((a, b) => b.time - a.time);

    // Anything older than ten minutes belongs to a different session; blaming a
    // mod for last week's crash would be worse than saying nothing.
    if (Date.now() - stats[0].time > 10 * 60 * 1000) return '';
    return await fsp.readFile(stats[0].file, 'utf8');
  } catch (_) {
    return '';
  }
}

/*
 * Turning a missing class into something searchable.
 *
 * "com/terraformersmc/modmenu/api/ModMenuApi" is Mod Menu, and the package says so
 * - the trick is knowing which segment carries the name. The well-known APIs are
 * listed outright; anything else falls back to the last meaningful segment, which
 * is nearly always the project name.
 */
const KNOWN_PACKAGES = [
  ['com.terraformersmc.modmenu', 'modmenu', 'Mod Menu'],
  ['me.shedaniel.clothconfig', 'cloth-config', 'Cloth Config API'],
  ['me.shedaniel.autoconfig', 'cloth-config', 'Cloth Config API'],
  ['dev.architectury', 'architectury-api', 'Architectury API'],
  ['mezz.jei', 'jei', 'Just Enough Items'],
  ['software.bernie.geckolib', 'geckolib', 'GeckoLib'],
  ['top.theillusivec4.curios', 'curios', 'Curios API'],
  ['net.fabricmc.fabric.api', 'fabric-api', 'Fabric API'],
  ['com.simibubi.create', 'create', 'Create'],
  ['net.minecraftforge.energy', 'forge', 'Forge']
];

const GENERIC_SEGMENTS = new Set([
  'com', 'net', 'org', 'io', 'dev', 'me', 'xyz', 'eu', 'fr', 'de', 'gg', 'top',
  'api', 'impl', 'client', 'common', 'core', 'mixin', 'mixins', 'util', 'utils',
  'lib', 'mod', 'mods', 'fabric', 'forge', 'neoforge', 'quilt', 'internal'
]);

function projectFromClass(className) {
  const dotted = className.replace(/\//g, '.');

  for (const [prefix, slug, name] of KNOWN_PACKAGES) {
    if (dotted.startsWith(prefix)) return { slug, name };
  }

  const parts = dotted.split('.')
    // The class itself is the capitalised tail; only packages name the project.
    .filter((p, i, all) => i < all.length - 1 || !/^[A-Z]/.test(p))
    .filter((p) => p && !GENERIC_SEGMENTS.has(p.toLowerCase()));

  if (!parts.length) return null;

  /*
   * Packages read as vendor-then-project, so the project is the second segment:
   * "terraformersmc.modmenu" is Mod Menu, "siphalor.amecs.key_modifiers" is Amecs.
   * Taking the deepest segment instead picks a subpackage - key_modifiers is not a
   * mod, and searching for it finds nothing.
   */
  const guess = parts.length > 1 ? parts[1] : parts[0];
  return { slug: guess.toLowerCase(), name: guess };
}

/* ------------------------------------------------------------------ rules */

const FIX = {
  DISABLE: 'disable',
  INSTALL: 'install',
  REPLACE: 'replace',
  MEMORY: 'memory'
};

/**
 * Reads the log and returns findings, most confident first.
 * Each finding may carry a fix the launcher can apply on its own.
 */
async function diagnose(profile, logText) {
  // The renderer keeps the log as the lines it received, so accept either form.
  const piped = Array.isArray(logText) ? logText.join('\n') : String(logText || '');

  // Minecraft writes the real stack trace to crash-reports/, and only some of it
  // reaches the pipe we buffer - latest.log does not carry it at all. So the report
  // it just wrote is folded in, and it is usually the only thing with the answer.
  const report = await readLatestCrashReport(profile);
  const log = piped + '\n' + report;

  /*
   * Where to look for the *cause*, as opposed to anything that merely went wrong.
   *
   * Mods probe for optional classes all the time, and a failed probe prints a WARN
   * that reads exactly like a fatal error:
   *
   *   [main/WARN]: Error loading class: de/siphalor/amecs/key_modifiers/impl/...
   *     (java.lang.ClassNotFoundException: ...)
   *
   * Searching the whole log finds that first and blames a mod that is working fine.
   * The crash report is authoritative, so prefer it, and drop the probe lines.
   */
  const causeText = (report || piped)
    .split('\n')
    .filter((line) => !/Error loading class:|\/WARN\]/.test(line))
    .join('\n');
  const index = await indexMods(profile);
  const byId = new Map(index.filter((m) => m.id).map((m) => [m.id.toLowerCase(), m]));
  const findings = [];

  /* --- a mod asks for something that is not installed ------------------ */

  // Fabric: "Mod 'X' (x) requires any version of fabric-api, which is missing!"
  const fabricDeps = [...log.matchAll(
    /Mod '([^']+)' \(([\w.-]+)\)[^\n]*?requires ([^\n]*?) of ([\w.-]+), which is missing!/g)];

  for (const match of fabricDeps) {
    const askerName = match[1];
    const askerId = match[2];
    const range = match[3];
    const missingId = match[4];

    // A missing "minecraft" is a wrong-version mod, not a missing dependency.
    if (missingId === 'minecraft' || missingId === 'java') {
      findings.push({
        severity: 'error',
        title: askerName + ' does not support this Minecraft version',
        detail: askerName + ' needs ' + range + ' of ' + missingId + ', but this profile is '
          + profile.mcVersion + '. Astra can fetch the build that matches, or turn it off.',
        mod: byId.get(askerId.toLowerCase()) || null,
        fix: { type: FIX.REPLACE, modId: askerId, name: askerName }
      });
      continue;
    }

    findings.push({
      severity: 'error',
      title: askerName + ' needs ' + missingId + ', which is not installed',
      detail: askerName + ' requires ' + range + ' of ' + missingId + '. Astra can download it.',
      mod: byId.get(askerId.toLowerCase()) || null,
      fix: { type: FIX.INSTALL, modId: missingId, name: missingId, range: range }
    });
  }

  // Forge / NeoForge print a table of unmet requirements.
  const forgeDeps = [...log.matchAll(
    /Mod ID: '([\w.-]+)', Requested by: '([\w.-]+)', Expected range: '([^']*)', Actual version: '\[MISSING\]'/g)];

  for (const match of forgeDeps) {
    const missingId = match[1];
    const askerId = match[2];
    const range = match[3];
    const asker = byId.get(askerId.toLowerCase());
    findings.push({
      severity: 'error',
      title: (asker ? asker.name : askerId) + ' needs ' + missingId + ', which is not installed',
      detail: 'Expected ' + (range || 'any version') + '. Astra can download it.',
      mod: asker || null,
      fix: { type: FIX.INSTALL, modId: missingId, name: missingId, range: range }
    });
  }

  /* --- a specific mod threw ------------------------------------------- */

  // Mixin failures name the mod's own config file, which is the mod id.
  const mixin = log.match(/Mixin apply failed ([\w.-]+)\.mixins\.json/)
    || log.match(/Mixin \[([\w.-]+)\.mixins\.json/);
  if (mixin) {
    const mod = byId.get(mixin[1].toLowerCase());
    findings.push({
      severity: 'error',
      title: (mod ? mod.name : mixin[1]) + ' failed to patch the game',
      detail: 'This usually means the mod was built for a different Minecraft version, '
        + 'or it clashes with another mod. Astra can fetch the matching build, or turn it off.',
      mod: mod || null,
      // Even with no jar matched, the mod id alone is enough to fetch the right build.
      fix: { type: FIX.REPLACE, modId: mixin[1], name: mod ? mod.name : mixin[1],
        file: mod ? mod.file : null }
    });
  }

  /*
   * Fabric entrypoint failure. This is the most common modded crash there is, and
   * the message names the mod outright - but in prose, not in a stack frame, so
   * package-blaming never sees it.
   *
   * Nearly always it is a soft dependency the mod uses but does not declare, so
   * the loader lets the game start and the class is missing at runtime. The class
   * that could not be found says what to install.
   */
  const entrypoint = log.match(
    /Could not execute entrypoint stage '[^']*' due to errors, provided by '([\w.-]+)'/);
  const missingClass = causeText.match(
    /(?:NoClassDefFoundError|ClassNotFoundException): ([\w./$]+)/);

  if (entrypoint) {
    const culprit = byId.get(entrypoint[1].toLowerCase());
    const culpritName = culprit ? culprit.name : entrypoint[1];
    const wanted = missingClass ? projectFromClass(missingClass[1]) : null;

    if (wanted) {
      findings.push({
        severity: 'error',
        title: culpritName + ' needs ' + wanted.name + ', which is not installed',
        detail: culpritName + ' tried to use ' + wanted.name + ' while starting and it '
          + 'was not there. It is an optional dependency, so the loader let the game '
          + 'start anyway. Astra can download it.',
        mod: culprit || null,
        fix: { type: FIX.INSTALL, modId: wanted.slug, name: wanted.name }
      });

      // Not everything is on Modrinth. Offer the way out that always works, so a
      // dependency Astra cannot fetch is never a dead end.
      if (culprit) {
        findings.push({
          severity: 'warn',
          title: 'Or play without ' + culpritName,
          detail: 'If ' + wanted.name + ' cannot be downloaded - some mods are only '
            + 'on CurseForge - turning ' + culpritName + ' off will let the game start.',
          mod: culprit,
          fix: { type: FIX.DISABLE, file: culprit.file, name: culprit.name }
        });
      }
    } else {
      findings.push({
        severity: 'error',
        title: culpritName + ' crashed while starting',
        detail: 'The game stopped inside this mod before it finished loading. '
          + 'Turning it off will let you start.',
        mod: culprit || null,
        fix: culprit
          ? { type: FIX.DISABLE, file: culprit.file, name: culprit.name }
          : null
      });
    }
  } else if (missingClass) {
    // A missing class with no entrypoint line: still worth naming what is absent.
    const wanted = projectFromClass(missingClass[1]);
    if (wanted) {
      findings.push({
        severity: 'error',
        title: wanted.name + ' is missing',
        detail: 'A mod tried to use ' + wanted.name + ' and it was not installed. '
          + 'Astra can download it.',
        mod: null,
        fix: { type: FIX.INSTALL, modId: wanted.slug, name: wanted.name }
      });
    }
  }

  // Forge names the offending mod outright when a mod event blows up.
  const forgeMod = log.match(/Caught exception during event[^\n]*from mod ([\w.-]+)/);
  if (forgeMod) {
    const mod = byId.get(forgeMod[1].toLowerCase());
    if (mod) {
      findings.push({
        severity: 'error',
        title: mod.name + ' crashed while starting',
        detail: 'The game stopped inside this mod. Turning it off will let you start.',
        mod: mod,
        fix: { type: FIX.DISABLE, file: mod.file, name: mod.name }
      });
    }
  }

  /* --- the JVM itself -------------------------------------------------- */

  if (/java\.lang\.OutOfMemoryError/.test(log)) {
    findings.push({
      severity: 'error',
      title: 'Minecraft ran out of memory',
      detail: 'The game needed more RAM than the profile allows. Astra can raise it.',
      mod: null,
      fix: { type: FIX.MEMORY, direction: 'up' }
    });
  }

  if (/Could not reserve enough space for object heap/.test(log)) {
    findings.push({
      severity: 'error',
      title: 'Java could not start with this much memory',
      detail: 'The profile asks for more RAM than this machine will hand to Java. '
        + 'Astra can lower it to something that starts.',
      mod: null,
      fix: { type: FIX.MEMORY, direction: 'down' }
    });
  }

  const classVersion = log.match(
    /UnsupportedClassVersionError[\s\S]{0,200}?class file version (\d+)\.0[\s\S]{0,160}?up to (\d+)\.0/);
  if (classVersion) {
    const needed = Number(classVersion[1]) - 44;
    const have = Number(classVersion[2]) - 44;
    findings.push({
      severity: 'error',
      title: 'Something here needs Java ' + needed,
      detail: 'A file was built for Java ' + needed + ', but the game started on Java '
        + have + '. Set the Java version in Settings, or remove the mod that is too new '
        + 'for this Minecraft version.',
      mod: null,
      fix: null
    });
  }

  /* --- nothing matched: fall back to blaming the stack trace ----------- */

  if (!findings.length) {
    const culprit = blameByPackage(index, log);
    if (culprit) {
      findings.push({
        severity: 'warn',
        title: culprit.name + ' appears in the crash',
        detail: 'Astra could not identify the exact fault, but the game stopped inside '
          + 'this mod. Turning it off is the usual fix.',
        mod: culprit,
        fix: { type: FIX.DISABLE, file: culprit.file, name: culprit.name }
      });
    }
  }

  // The same mod can trip several rules; keep one finding per headline.
  const seen = new Set();
  return findings.filter((f) => {
    if (seen.has(f.title)) return false;
    seen.add(f.title);
    return true;
  });
}

/* ------------------------------------------------------------------ fixing */

/** Finds a mod on Modrinth from a mod id, then from its name. */
async function findProject(profile, modId, name) {
  const tryTerm = async (term) => {
    const result = await mods.search({
      query: term,
      loader: profile.loader,
      gameVersion: profile.mcVersion,
      limit: 5
    });
    const wanted = String(modId || term).toLowerCase();
    // Prefer an exact slug match; Modrinth slugs and mod ids usually agree.
    return result.hits.find((h) => h.slug.toLowerCase() === wanted)
      || result.hits.find((h) => h.title.toLowerCase() === String(name || '').toLowerCase())
      || result.hits[0]
      || null;
  };

  if (modId) {
    const byId = await tryTerm(modId);
    if (byId) return byId;
  }
  if (name) {
    const byName = await tryTerm(name);
    if (byName) return byName;
  }
  return null;
}

/**
 * Applies one fix. Returns what happened, in words the user can read.
 * Nothing here deletes a mod - disabling renames the jar, so it can come back.
 */
async function applyFix(profile, fix, settings, onProgress) {
  const progress = onProgress || (() => {});
  if (!fix) throw new Error('There is nothing to fix here.');

  if (fix.type === FIX.DISABLE) {
    await mods.toggle(profile, fix.file, 'mod');
    return { message: 'Turned off ' + fix.name + '. It is still on disk if you want it back.' };
  }

  if (fix.type === FIX.INSTALL) {
    progress({ title: 'Looking for ' + fix.name });
    const project = await findProject(profile, fix.modId, fix.name);
    if (!project) {
      throw new Error('Could not find ' + fix.name + ' for ' + profile.loader + ' '
        + profile.mcVersion + ' on Modrinth. It may need installing by hand.');
    }
    await mods.install(profile, project.id, progress, 'mod');
    return { message: 'Installed ' + project.title + '.' };
  }

  if (fix.type === FIX.REPLACE) {
    progress({ title: 'Looking for a ' + profile.mcVersion + ' build of ' + fix.name });
    const project = await findProject(profile, fix.modId, fix.name);
    if (!project) {
      throw new Error('No ' + profile.loader + ' ' + profile.mcVersion + ' build of '
        + fix.name + ' exists on Modrinth. Turning it off is the only fix.');
    }

    // Take the old jar out of the way first, or both versions load and clash.
    if (fix.file) {
      await mods.remove(profile, fix.file, 'mod').catch(() => {});
    }
    await mods.install(profile, project.id, progress, 'mod');
    return { message: 'Replaced ' + fix.name + ' with the ' + profile.mcVersion + ' build.' };
  }

  if (fix.type === FIX.MEMORY) {
    const current = Number(settings && settings.memoryMb) || 4096;
    const next = fix.direction === 'up'
      ? Math.min(current * 2, 16384)
      : Math.max(Math.floor(current / 2), 1024);
    return {
      message: 'Memory set to ' + (next / 1024).toFixed(1) + ' GB.',
      settings: { memoryMb: next }
    };
  }

  throw new Error('Astra does not know how to apply "' + fix.type + '".');
}

/* ------------------------------------------------------------------ pre-flight */

/**
 * Checks a profile's mods before launching, rather than after a crash.
 *
 * A jar states which loader and Minecraft versions it supports, so a mod that cannot
 * possibly work here is catchable without running the game at all.
 */
async function checkProfile(profile) {
  if (!profile || profile.loader === 'vanilla') return [];

  const index = await indexMods(profile);
  const problems = [];

  for (const mod of index) {
    const file = path.join(mods.modsDirFor(profile), mod.file);
    let supported = null;
    let loaderOk = true;
    let known = false;

    try {
      const fabric = await zip.readFile(file, 'fabric.mod.json');
      if (fabric) {
        known = true;
        loaderOk = profile.loader === 'fabric' || profile.loader === 'quilt';
        const meta = JSON.parse(fabric.toString('utf8'));
        const need = meta.depends && meta.depends.minecraft;
        if (need) supported = Array.isArray(need) ? need.join(' or ') : String(need);
      } else {
        const toml = await zip.readFile(file, 'META-INF/mods.toml')
          || await zip.readFile(file, 'META-INF/neoforge.mods.toml');
        if (toml) {
          known = true;
          loaderOk = profile.loader === 'forge' || profile.loader === 'neoforge';
        }
      }
    } catch (_) {
      continue;
    }

    if (!known) continue;

    if (!loaderOk) {
      problems.push({
        severity: 'error',
        title: mod.name + ' is not a ' + profile.loader + ' mod',
        detail: 'This jar is for a different mod loader, so ' + profile.loader
          + ' will not load it. Astra can fetch the right build.',
        mod: mod,
        fix: { type: FIX.REPLACE, modId: mod.id, name: mod.name, file: mod.file }
      });
      continue;
    }

    // Ranges here are Maven-style. Only a plain single version is judged, because a
    // half-understood range ("[1.20,1.21)") would produce false alarms.
    if (supported && /^[\d.]+$/.test(supported) && supported !== profile.mcVersion) {
      problems.push({
        severity: 'warn',
        title: mod.name + ' is built for Minecraft ' + supported,
        detail: 'This profile is ' + profile.mcVersion + '. Astra can fetch the matching build.',
        mod: mod,
        fix: { type: FIX.REPLACE, modId: mod.id, name: mod.name, file: mod.file }
      });
    }
  }

  return problems;
}

module.exports = { diagnose, applyFix, checkProfile, indexMods, FIX };
