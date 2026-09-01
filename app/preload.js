'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** The only surface the page gets. Nothing here hands out a raw ipcRenderer. */
contextBridge.exposeInMainWorld('astra', {
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close')
  },
  shell: {
    open: (url) => ipcRenderer.invoke('shell:open', url),
    openPath: (target) => ipcRenderer.invoke('shell:openPath', target)
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (values) => ipcRenderer.invoke('settings:set', values),
    pickFolder: () => ipcRenderer.invoke('settings:pickFolder'),
    pickJava: () => ipcRenderer.invoke('settings:pickJava')
  },
  auth: {
    signIn: () => ipcRenderer.invoke('auth:signIn'),
    signOut: () => ipcRenderer.invoke('auth:signOut')
  },
  versions: {
    list: () => ipcRenderer.invoke('versions:list'),
    loaders: (mcVersion) => ipcRenderer.invoke('versions:loaders', mcVersion)
  },
  java: {
    scan: () => ipcRenderer.invoke('java:scan')
  },
  artwork: {
    images: (ids) => ipcRenderer.invoke('artwork:images', ids),
    news: (limit) => ipcRenderer.invoke('artwork:news', limit)
  },
  profiles: {
    list: () => ipcRenderer.invoke('profiles:list'),
    save: (profile) => ipcRenderer.invoke('profiles:save', profile),
    remove: (id) => ipcRenderer.invoke('profiles:delete', id),
    openFolder: (id) => ipcRenderer.invoke('profiles:openFolder', id)
  },
  launch: {
    start: (profileId) => ipcRenderer.invoke('launch:start', profileId),
    stop: () => ipcRenderer.invoke('launch:stop'),
    isRunning: () => ipcRenderer.invoke('launch:running'),
    onEvent: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('launch:event', listener);
      return () => ipcRenderer.removeListener('launch:event', listener);
    }
  },
  doctor: {
    diagnose: (profileId, log) => ipcRenderer.invoke('doctor:diagnose', profileId, log),
    check: (profileId) => ipcRenderer.invoke('doctor:check', profileId),
    fix: (profileId, fix) => ipcRenderer.invoke('doctor:fix', profileId, fix)
  },

  mods: {
    search: (options) => ipcRenderer.invoke('mods:search', options),
    featured: (options) => ipcRenderer.invoke('mods:featured', options),
    install: (profileId, projectId) => ipcRenderer.invoke('mods:install', profileId, projectId),
    installed: (profileId) => ipcRenderer.invoke('mods:installed', profileId),
    remove: (profileId, filename, kind) => ipcRenderer.invoke('mods:remove', profileId, filename, kind),
    toggle: (profileId, filename, kind) => ipcRenderer.invoke('mods:toggle', profileId, filename, kind),
    onProgress: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('mods:progress', listener);
      return () => ipcRenderer.removeListener('mods:progress', listener);
    }
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    download: (info) => ipcRenderer.invoke('update:download', info),
    fullInstall: (info) => ipcRenderer.invoke('update:fullInstall', info),
    restart: () => ipcRenderer.invoke('update:restart'),
    repo: (config) => ipcRenderer.invoke('update:repo', config),
    applied: () => ipcRenderer.invoke('update:applied'),
    version: () => ipcRenderer.invoke('update:version'),
    onProgress: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('update:progress', listener);
      return () => ipcRenderer.removeListener('update:progress', listener);
    }
  },
  packs: {
    search: (options) => ipcRenderer.invoke('packs:search', options),
    install: (profileId, projectId) => ipcRenderer.invoke('packs:install', profileId, projectId),
    installed: (profileId) => ipcRenderer.invoke('mods:installed', profileId, 'resourcepack'),
    folder: (profileId) => ipcRenderer.invoke('packs:folder', profileId)
  },
  shaders: {
    search: (options) => ipcRenderer.invoke('shaders:search', options),
    install: (profileId, projectId) => ipcRenderer.invoke('shaders:install', profileId, projectId),
    installed: (profileId) => ipcRenderer.invoke('mods:installed', profileId, 'shader'),
    folder: (profileId) => ipcRenderer.invoke('shaders:folder', profileId)
  },
  api: {
    connect: () => ipcRenderer.invoke('api:connect'),
    state: () => ipcRenderer.invoke('api:state'),
    me: () => ipcRenderer.invoke('api:me'),
    friends: () => ipcRenderer.invoke('api:friends'),
    friendAdd: (name) => ipcRenderer.invoke('api:friendAdd', name),
    friendAccept: (uuid) => ipcRenderer.invoke('api:friendAccept', uuid),
    friendRemove: (uuid) => ipcRenderer.invoke('api:friendRemove', uuid),
    presence: (presence) => ipcRenderer.invoke('api:presence', presence),
    servers: () => ipcRenderer.invoke('api:servers'),
    shop: () => ipcRenderer.invoke('api:shop'),
    buy: (itemId) => ipcRenderer.invoke('api:buy', itemId),
    equip: (slot, itemId) => ipcRenderer.invoke('api:equip', slot, itemId),
    challenges: () => ipcRenderer.invoke('api:challenges'),
    daily: () => ipcRenderer.invoke('api:daily'),
    dailyClaim: () => ipcRenderer.invoke('api:dailyClaim'),
    claim: (challenge) => ipcRenderer.invoke('api:claim', challenge),
    share: (profile) => ipcRenderer.invoke('api:share', profile),
    shared: (code) => ipcRenderer.invoke('api:shared', code)
  },
  cosmetics: {
    list: () => ipcRenderer.invoke('cosmetics:list')
  },
  discord: {
    set: (enabled) => ipcRenderer.invoke('discord:set', enabled),
    state: () => ipcRenderer.invoke('discord:state'),
    appId: (id) => ipcRenderer.invoke('discord:appId', id)
  },
  clientmod: {
    status: () => ipcRenderer.invoke('clientmod:status'),
    check: (profileId) => ipcRenderer.invoke('clientmod:check', profileId)
  },
  perf: {
    presets: () => ipcRenderer.invoke('perf:presets'),
    ping: (address) => ipcRenderer.invoke('perf:ping', address)
  },
  paths: {
    root: () => ipcRenderer.invoke('paths:root')
  }
});
