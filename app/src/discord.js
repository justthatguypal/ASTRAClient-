'use strict';

/**
 * Discord Rich Presence, spoken directly over Discord's local IPC socket.
 *
 * The official library is a dependency and a native build away; the protocol itself is
 * just length-prefixed JSON over a named pipe (`\\?\pipe\discord-ipc-N` on Windows,
 * a unix socket under $XDG_RUNTIME_DIR elsewhere). Discord listens on pipes 0-9, so we
 * try each until one answers.
 *
 * Frame layout: <int32 opcode LE><int32 length LE><utf8 json>
 *   op 0 HANDSHAKE, op 1 FRAME, op 2 CLOSE, op 3 PING, op 4 PONG
 *
 * Everything here fails quietly. Discord not running is the normal case, not an error.
 */

const net = require('net');
const os = require('os');
const path = require('path');

// Public application id for rich presence. Only used to look up the art assets
// registered against it; it grants no access to anything.
const DEFAULT_APP_ID = '1310000000000000000';

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;

let socket = null;
let connected = false;
let currentActivity = null;
let reconnectTimer = null;
let appId = DEFAULT_APP_ID;

function pipePath(index) {
  if (process.platform === 'win32') return `\\\\?\\pipe\\discord-ipc-${index}`;
  const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR
    || process.env.TMP || process.env.TEMP || os.tmpdir();
  return path.join(base, `discord-ipc-${index}`);
}

function encode(op, payload) {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(8);
  header.writeInt32LE(op, 0);
  header.writeInt32LE(json.length, 4);
  return Buffer.concat([header, json]);
}

function tryPipe(index) {
  return new Promise((resolve) => {
    if (index > 9) return resolve(null);

    const candidate = net.createConnection(pipePath(index));
    let settled = false;

    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    candidate.once('connect', () => done(candidate));
    candidate.once('error', () => {
      candidate.destroy();
      done(null);
    });
    setTimeout(() => {
      if (!settled) { candidate.destroy(); done(null); }
    }, 700);
  });
}

async function connect() {
  if (connected || socket) return connected;

  for (let index = 0; index <= 9; index++) {
    const candidate = await tryPipe(index);
    if (!candidate) continue;

    socket = candidate;
    socket.on('error', cleanup);
    socket.on('close', cleanup);
    socket.on('data', () => { /* replies are not needed; presence is fire and forget */ });

    socket.write(encode(OP_HANDSHAKE, { v: 1, client_id: appId }));
    connected = true;

    if (currentActivity) setActivity(currentActivity);
    return true;
  }
  return false;
}

function cleanup() {
  connected = false;
  if (socket) {
    try { socket.destroy(); } catch (_) { /* already gone */ }
    socket = null;
  }
}

function setActivity(activity) {
  currentActivity = activity;
  if (!connected || !socket) return false;

  const payload = {
    cmd: 'SET_ACTIVITY',
    args: {
      pid: process.pid,
      activity: activity === null ? null : {
        details: activity.details,
        state: activity.state,
        timestamps: activity.startedAt ? { start: activity.startedAt } : undefined,
        assets: {
          large_image: activity.largeImage || 'astra',
          large_text: activity.largeText || 'Astra Client',
          small_image: activity.smallImage,
          small_text: activity.smallText
        },
        buttons: activity.buttons
      }
    },
    nonce: String(Date.now())
  };

  try {
    socket.write(encode(OP_FRAME, payload));
    return true;
  } catch (_) {
    cleanup();
    return false;
  }
}

/** Presence for someone sitting in the launcher. */
function idle() {
  return setActivity({
    details: 'In the launcher',
    state: 'Browsing versions',
    startedAt: Math.floor(Date.now() / 1000)
  });
}

/** Presence while a game is running. */
function playing({ version, loader, server }) {
  return setActivity({
    details: server ? `Playing on ${server}` : `Playing ${version}`,
    state: loader && loader !== 'vanilla'
      ? `${loader[0].toUpperCase()}${loader.slice(1)} ${version}`
      : `Minecraft ${version}`,
    startedAt: Math.floor(Date.now() / 1000),
    smallImage: 'astra_small',
    smallText: 'Astra Client'
  });
}

function start(customAppId) {
  if (customAppId) appId = customAppId;
  connect().catch(() => {});
  // Discord may be started after the launcher, so keep trying quietly.
  if (!reconnectTimer) {
    reconnectTimer = setInterval(() => {
      if (!connected) connect().catch(() => {});
    }, 30000);
    if (reconnectTimer.unref) reconnectTimer.unref();
  }
}

function stop() {
  if (reconnectTimer) {
    clearInterval(reconnectTimer);
    reconnectTimer = null;
  }
  if (connected && socket) {
    try { socket.write(encode(OP_CLOSE, {})); } catch (_) { /* closing anyway */ }
  }
  cleanup();
}

function isConnected() {
  return connected;
}

module.exports = { start, stop, setActivity, idle, playing, isConnected, OP_PING };
