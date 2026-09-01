'use strict';

/** Builds the java command line for a resolved install and starts the game. */

const path = require('path');
const { spawn } = require('child_process');

const store = require('./store');
const java = require('./java');
const auth = require('./auth');
const installer = require('./installer');
const runtime = require('./runtime');
const clientmod = require('./clientmod');

const SEPARATOR = process.platform === 'win32' ? ';' : ':';

function fillTemplate(value, vars) {
  return value.replace(/\$\{([^}]+)\}/g, (whole, key) => (key in vars ? vars[key] : whole));
}

/** Flattens the modern arguments array, honouring each entry's rules. */
function expandArguments(list, vars, features) {
  const out = [];
  for (const entry of list || []) {
    if (typeof entry === 'string') {
      out.push(fillTemplate(entry, vars));
      continue;
    }
    if (!entry || !installer.ruleAllows(entry.rules, features)) continue;
    const value = Array.isArray(entry.value) ? entry.value : [entry.value];
    for (const item of value) out.push(fillTemplate(String(item), vars));
  }
  return out;
}

function buildCommand(install, account, settings) {
  const { json, classpath, natives, versionId, gameDirectory, assetsRoot, assetIndexId } = install;

  // The version's own jar goes last so loader-patched classes take precedence.
  const jars = [...classpath, path.join(installer.versionDir(versionId), `${versionId}.jar`)];
  const uniqueJars = [...new Set(jars)];

  const features = {
    is_demo_user: false,
    has_custom_resolution: Boolean(settings.width && settings.height),
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: false,
    is_quick_play_realms: false
  };

  const vars = {
    auth_player_name: account.name,
    version_name: versionId,
    game_directory: gameDirectory,
    assets_root: assetsRoot,
    game_assets: assetsRoot,
    assets_index_name: assetIndexId,
    auth_uuid: account.id,
    auth_access_token: account.accessToken,
    auth_session: `token:${account.accessToken}:${account.id}`,
    clientid: '',
    auth_xuid: '',
    user_type: 'msa',
    user_properties: '{}',
    version_type: json.type || 'release',
    natives_directory: natives,
    launcher_name: 'AstraClient',
    launcher_version: '1.0.0',
    classpath: uniqueJars.join(SEPARATOR),
    classpath_separator: SEPARATOR,
    library_directory: installer.librariesDir(),
    resolution_width: String(settings.width || 1280),
    resolution_height: String(settings.height || 720)
  };

  const memory = Math.max(1024, parseInt(settings.memoryMb, 10) || 4096);
  const args = [`-Xmx${memory}M`, `-Xms${Math.min(1024, memory)}M`];

  if (settings.jvmArgs) {
    args.push(...String(settings.jvmArgs).split(/\s+/).filter(Boolean));
  }

  if (json.arguments && json.arguments.jvm) {
    args.push(...expandArguments(json.arguments.jvm, vars, features));
  } else {
    // Pre-1.13 has no jvm argument list; these are what the old launcher always passed.
    args.push(`-Djava.library.path=${natives}`);
    args.push('-cp', vars.classpath);
  }

  if (json.logging && json.logging.client && json.logging.client.argument) {
    // Skipped on purpose: the log4j config file makes the game log XML, which is
    // useless in our console view and adds a download for no benefit.
  }

  args.push(json.mainClass);

  if (json.arguments && json.arguments.game) {
    args.push(...expandArguments(json.arguments.game, vars, features));
  } else if (json.minecraftArguments) {
    args.push(...json.minecraftArguments.split(/\s+/).map((a) => fillTemplate(a, vars)));
  }

  if (features.has_custom_resolution && !args.includes('--width')) {
    args.push('--width', vars.resolution_width, '--height', vars.resolution_height);
  }
  if (settings.fullscreen && !args.includes('--fullscreen')) {
    args.push('--fullscreen');
  }

  return args;
}

/**
 * Picks a JVM that can actually run this version.
 *
 * An explicit path in settings always wins. Otherwise, if a matching major version is
 * already on the machine we use it; if not we fetch the exact runtime Mojang ships for
 * that version. That last step is what makes 1.8 and 1.12 work - they need Java 8, and
 * nobody has Java 8 lying around any more.
 */
async function resolveJava(json, settings, onEvent) {
  const required = (json.javaVersion && json.javaVersion.majorVersion) || 8;
  const component = (json.javaVersion && json.javaVersion.component)
    || runtime.componentForMajor(required);

  if (settings.javaPath) {
    const picked = await java.pick(required, settings.javaPath);
    return { ...picked, source: 'your setting' };
  }

  if (runtime.isInstalled(component)) {
    return { path: runtime.javaExecutable(component), major: required, source: component };
  }

  // Anything already on the machine, but only an exact major match - a newer JVM is
  // exactly what breaks the old versions this is here to fix.
  const installed = await java.scan();
  const exact = installed.find((entry) => entry.major === required);
  if (exact) return { ...exact, source: 'installed' };

  onEvent({ type: 'status', message: `This version needs Java ${required}. Downloading it once.` });
  const exe = await runtime.ensure(component, (progress) => onEvent({ type: 'progress', ...progress }));
  return { path: exe, major: required, source: component };
}

/**
 * Installs if needed, then starts the game.
 * onEvent gets progress objects, log lines, and finally exit.
 */
async function launch(profile, onEvent = () => {}) {
  const settings = store.load();

  let account = settings.account;
  if (!account) throw new Error('Sign in with your Microsoft account first.');

  onEvent({ type: 'status', message: 'Checking your session' });
  account = await auth.ensureValid(account);
  store.set('account', account);

  const install = await installer.install(profile, (progress) => {
    onEvent({ type: 'progress', ...progress });
  });

  // Drop the Astra client mod in before launching, so cosmetics and the in-game menu
  // are there without anyone installing anything.
  const modResult = await clientmod.ensureInstalled(profile);
  if (modResult.installed && !modResult.alreadyCurrent) {
    onEvent({ type: 'status', message: `Installed the Astra client mod (${modResult.jar})` });
  }

  const jvm = await resolveJava(install.json, settings, onEvent);
  onEvent({ type: 'status', message: `Starting with Java ${jvm.major} (${jvm.source})` });

  const args = buildCommand(install, account, settings);

  const child = spawn(jvm.path, args, {
    cwd: install.gameDirectory,
    detached: false,
    windowsHide: false
  });

  const send = (channel) => (chunk) => {
    String(chunk).split(/\r?\n/).filter(Boolean)
      .forEach((line) => onEvent({ type: 'log', channel, line }));
  };
  child.stdout.on('data', send('out'));
  child.stderr.on('data', send('err'));

  child.on('error', (err) => onEvent({ type: 'error', message: err.message }));
  child.on('close', (code) => onEvent({ type: 'exit', code }));

  onEvent({ type: 'started', pid: child.pid, versionId: install.versionId });
  return child;
}

module.exports = { launch, buildCommand };
