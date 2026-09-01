'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const store = require('./src/store');
const auth = require('./src/auth');
const versions = require('./src/versions');
const launcher = require('./src/launcher');
const java = require('./src/java');
const installer = require('./src/installer');
const mods = require('./src/mods');
const artwork = require('./src/artwork');
const updater = require('./src/updater');
const api = require('./src/api');
const discord = require('./src/discord');
const cosmetics = require('./src/cosmetics');
const performance = require('./src/performance');
const clientmod = require('./src/clientmod');
const doctor = require('./src/doctor');
const modpacks = require('./src/modpacks');

let mainWindow = null;
let running = null;

// Swap in any completed update before the app is really underway. This is the only
// moment nothing holds those files open, and it is why an update is a restart rather
// than a reinstall.
let appliedUpdate = null;
try {
  appliedUpdate = updater.applyStaged(__dirname, app.isPackaged);
} catch (err) {
  console.error('update swap failed:', err.message);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1060,
    minHeight: 680,
    show: false,
    frame: false,
    backgroundColor: '#0E0E10',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The background video and theme track are local files loaded by the page.
      webSecurity: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  if (store.get('discordEnabled')) {
    discord.start(store.get('discordAppId') || undefined);
    setTimeout(() => discord.idle(), 1500);
  }

  // Anything that is not the app itself opens in the real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  createWindow();

  // Find out where the backend is today. Deliberately not awaited: the window
  // should not wait on the network, and everything that talks to the backend
  // already copes with it being unavailable.
  api.discover().catch(() => {});

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------- window chrome

ipcMain.handle('window:minimize', () => mainWindow && mainWindow.minimize());
ipcMain.handle('window:maximize', () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return mainWindow.isMaximized();
});
ipcMain.handle('window:close', () => mainWindow && mainWindow.close());
ipcMain.handle('shell:open', (_e, url) => shell.openExternal(url));
ipcMain.handle('shell:openPath', (_e, target) => shell.openPath(target));

// ---------------------------------------------------------------- settings

ipcMain.handle('settings:get', () => {
  const config = store.load();
  // The account object carries live tokens; the renderer only needs the identity.
  return {
    ...config,
    account: config.account
      ? { id: config.account.id, name: config.account.name, skins: config.account.skins }
      : null
  };
});

ipcMain.handle('settings:set', (_e, values) => {
  const safe = { ...values };
  delete safe.account;
  delete safe.profiles;
  store.patch(safe);
  return true;
});

ipcMain.handle('settings:pickFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('settings:pickJava', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: process.platform === 'win32'
      ? [{ name: 'Java', extensions: ['exe'] }]
      : [{ name: 'All files', extensions: ['*'] }]
  });
  return result.canceled ? null : result.filePaths[0];
});

// ---------------------------------------------------------------- account

ipcMain.handle('auth:signIn', async () => {
  const account = await auth.signIn(mainWindow);
  store.set('account', account);
  return { id: account.id, name: account.name, skins: account.skins };
});

ipcMain.handle('auth:signOut', async () => {
  await auth.signOut();
  store.set('account', null);
  return true;
});

// ---------------------------------------------------------------- versions

ipcMain.handle('versions:list', async () => versions.vanilla());
ipcMain.handle('versions:loaders', async (_e, mcVersion) => versions.loadersFor(mcVersion));
ipcMain.handle('java:scan', async () => java.scan(true));
ipcMain.handle('artwork:images', (_e, ids) => artwork.imagesFor(ids));
ipcMain.handle('artwork:news', (_e, limit) => artwork.news(limit));

// ---------------------------------------------------------------- updates

ipcMain.handle('update:check', () => updater.check(__dirname));
ipcMain.handle('update:repo', (_e, config) => (config ? updater.setRepo(config) : updater.repoConfig()));
ipcMain.handle('update:applied', () => appliedUpdate);
ipcMain.handle('update:version', () => updater.currentVersion());

ipcMain.handle('update:download', async (_e, info) => {
  await updater.download(info, (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:progress', progress);
    }
  });
  return true;
});

/*
 * A full update, without leaving the launcher.
 *
 * The installer cannot replace files that are open, so the launcher starts it and
 * then quits: NSIS waits for the process to go, installs, and relaunches. From the
 * player's side it is one button and the app reappearing on the new version.
 */
ipcMain.handle('update:fullInstall', async (_e, info) => {
  // The delta path reports progress as a count of files; this one is one big file,
  // so it is sent as a label instead of pretending 96 million bytes are 96 million
  // files.
  const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);
  let lastSent = 0;

  const exe = await updater.downloadInstaller(info, ({ done, total }) => {
    // Throttled: a write callback per chunk would flood the renderer.
    if (done - lastSent < 1024 * 1024 && done !== total) return;
    lastSent = done;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:progress', {
        label: total ? `installer ${mb(done)} MB of ${mb(total)} MB` : `installer ${mb(done)} MB`
      });
    }
  });

  const started = shell.openPath(exe);
  const error = await started;
  if (error) throw new Error(`Could not start the installer: ${error}`);

  // Give the installer a moment to take hold before releasing the files it needs.
  setTimeout(() => app.exit(0), 1500);
  return true;
});

ipcMain.handle('update:restart', () => {
  app.relaunch();
  app.exit(0);
});

// ---------------------------------------------------------------- profiles

ipcMain.handle('profiles:list', () => store.get('profiles'));

ipcMain.handle('profiles:save', (_e, profile) => {
  if (!profile.id) {
    profile.id = `${profile.loader}-${profile.mcVersion}-${Date.now().toString(36)}`;
  }
  if (!profile.name) {
    profile.name = profile.loader === 'vanilla'
      ? `Minecraft ${profile.mcVersion}`
      : `${profile.loader[0].toUpperCase()}${profile.loader.slice(1)} ${profile.mcVersion}`;
  }
  store.upsertProfile(profile);
  store.set('lastProfile', profile.id);
  return profile;
});

ipcMain.handle('profiles:delete', (_e, id) => {
  store.removeProfile(id);
  return true;
});

ipcMain.handle('profiles:openFolder', (_e, id) => {
  const profile = store.get('profiles').find((p) => p.id === id);
  const dir = store.profileDir(profile);
  fs.mkdirSync(dir, { recursive: true });
  return shell.openPath(dir);
});

// ---------------------------------------------------------------- launching

ipcMain.handle('launch:start', async (_e, profileId) => {
  if (running && !running.killed) throw new Error('Minecraft is already running.');

  const profile = store.get('profiles').find((p) => p.id === profileId);
  if (!profile) throw new Error('That profile no longer exists.');

  store.set('lastProfile', profile.id);

  const send = (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('launch:event', payload);
  };

  try {
    running = await launcher.launch(profile, (event) => {
      if (event.type === 'exit') {
        running = null;
        if (store.get('discordEnabled')) discord.idle();
      }
      send(event);
    });
  } catch (err) {
    running = null;
    send({ type: 'error', message: err.message });
    throw err;
  }

  if (store.get('discordEnabled')) {
    discord.playing({ version: profile.mcVersion, loader: profile.loader });
  }

  if (store.get('closeOnLaunch')) {
    setTimeout(() => mainWindow && mainWindow.minimize(), 3000);
  }
  return true;
});

ipcMain.handle('launch:stop', () => {
  if (running && !running.killed) {
    running.kill();
    running = null;
    return true;
  }
  return false;
});

ipcMain.handle('launch:running', () => Boolean(running && !running.killed));
ipcMain.handle('paths:root', () => ({ root: store.ROOT, game: installer.gameRoot() }));

// ---------------------------------------------------------------- mods

function profileById(id) {
  return store.get('profiles').find((p) => p.id === id) || null;
}

/* ------------------------------------------------------------------ doctor */

ipcMain.handle('doctor:diagnose', (_e, profileId, log) =>
  doctor.diagnose(profileById(profileId), log));

ipcMain.handle('doctor:check', (_e, profileId) =>
  doctor.checkProfile(profileById(profileId)));

ipcMain.handle('doctor:fix', async (_e, profileId, fix) => {
  const profile = profileById(profileId);
  const result = await doctor.applyFix(profile, fix, store.load(), (progress) => {
    if (mainWindow) mainWindow.webContents.send('mods:progress', progress);
  });

  // A memory fix is a settings change; the doctor reports it rather than
  // reaching into the store itself, so every write still goes through here.
  if (result.settings) store.patch(result.settings);
  return result;
});

ipcMain.handle('mods:search', (_e, options) => mods.search(options));
ipcMain.handle('mods:featured', (_e, options) => mods.featured(options));

ipcMain.handle('modpacks:search', (_e, options) => modpacks.search(options));
ipcMain.handle('modpacks:featured', (_e, options) => modpacks.featured(options));

ipcMain.handle('modpacks:install', async (_e, projectId) => {
  const profile = await modpacks.install(projectId, (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mods:progress', progress);
    }
  });
  store.set('lastProfile', profile.id);
  return profile;
});

ipcMain.handle('mods:install', async (_e, profileId, projectId) => {
  const profile = profileById(profileId);
  const result = await mods.install(profile, projectId, (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mods:progress', { projectId, ...progress });
    }
  });
  return result;
});

ipcMain.handle('mods:installed', (_e, profileId, kind) => mods.listInstalled(profileById(profileId), kind));

// Shader packs go through the same Modrinth plumbing, just a different project type
// and a different folder.
ipcMain.handle('shaders:search', (_e, options) =>
  mods.search({ ...options, projectType: 'shader', loader: null }));

ipcMain.handle('shaders:install', async (_e, profileId, projectId) => {
  const profile = profileById(profileId);
  return mods.install(profile, projectId, (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mods:progress', { projectId, ...progress });
    }
  }, 'shader');
});

ipcMain.handle('packs:search', (_e, options) =>
  mods.search({ ...options, projectType: 'resourcepack', loader: null }));

ipcMain.handle('packs:install', async (_e, profileId, projectId) => {
  const profile = profileById(profileId);
  return mods.install(profile, projectId, (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mods:progress', { projectId, ...progress });
    }
  }, 'resourcepack');
});

ipcMain.handle('packs:folder', (_e, profileId) => {
  const dir = mods.resourcePacksDirFor(profileById(profileId));
  fs.mkdirSync(dir, { recursive: true });
  return shell.openPath(dir);
});

ipcMain.handle('shaders:folder', (_e, profileId) => {
  const dir = mods.shadersDirFor(profileById(profileId));
  fs.mkdirSync(dir, { recursive: true });
  return shell.openPath(dir);
});

// ---------------------------------------------------------------- astra backend

ipcMain.handle('api:connect', async () => {
  const account = store.get('account');
  if (!account) throw new Error('Sign in to Minecraft first.');
  const fresh = await auth.ensureValid(account);
  store.set('account', fresh);
  return api.login(fresh.accessToken);
});

ipcMain.handle('api:state', () => ({
  signedIn: api.signedIn(),
  url: api.baseUrl()
}));

const forward = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => fn(...args));

forward('api:me', () => api.me());
forward('api:friends', () => api.friends());
forward('api:friendAdd', (name) => api.addFriend(name));
forward('api:friendAccept', (uuid) => api.acceptFriend(uuid));
forward('api:friendRemove', (uuid) => api.removeFriend(uuid));
forward('api:presence', (presence) => api.setPresence(presence));
forward('api:servers', () => api.servers());
forward('api:shop', () => api.shop());
forward('api:buy', (itemId) => api.buy(itemId));
forward('api:equip', (slot, itemId) => api.equip(slot, itemId));
forward('api:challenges', () => api.challenges());
forward('api:daily', () => api.daily());
forward('api:dailyClaim', () => api.claimDaily());
forward('api:claim', (challenge) => api.claimChallenge(challenge));
forward('api:share', (profile) => api.shareProfile(profile));
forward('api:shared', (code) => api.getShared(code));

// ---------------------------------------------------------------- cosmetics

ipcMain.handle('cosmetics:list', () => cosmetics.list());

// ---------------------------------------------------------------- discord

ipcMain.handle('discord:set', async (_e, enabled) => {
  store.set('discordEnabled', Boolean(enabled));
  if (!enabled) {
    discord.stop();
    return discord.status();
  }

  // Awaited: start() used to be fire-and-forget, so this returned "not connected"
  // every time simply because the handshake had not finished yet.
  await discord.start(store.get('discordAppId') || undefined);
  discord.idle();
  return discord.status();
});

ipcMain.handle('discord:state', () => discord.status());

ipcMain.handle('discord:appId', async (_e, id) => {
  store.set('discordAppId', String(id || '').trim() || null);
  discord.stop();
  if (store.get('discordEnabled')) {
    await discord.start(store.get('discordAppId') || undefined);
    discord.idle();
  }
  return discord.status();
});

// ---------------------------------------------------------------- performance

ipcMain.handle('clientmod:status', () => clientmod.status());
ipcMain.handle('clientmod:check', (_e, profileId) =>
  clientmod.compatibility(profileById(profileId)));

ipcMain.handle('perf:presets', () => performance.presets());

ipcMain.handle('perf:installMods', (_e, profileId) =>
  performance.installMods(profileById(profileId), (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mods:progress', progress);
    }
  }));
ipcMain.handle('perf:ping', (_e, address) => performance.ping(address));
ipcMain.handle('mods:remove', (_e, profileId, filename, kind) =>
  mods.remove(profileById(profileId), filename, kind));
ipcMain.handle('mods:toggle', (_e, profileId, filename, kind) =>
  mods.toggle(profileById(profileId), filename, kind));
