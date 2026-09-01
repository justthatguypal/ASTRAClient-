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

/*
 * Application id for rich presence. Only used to look up the art assets registered
 * against it; it grants no access to anything.
 *
 * The built-in value is a placeholder, and Discord answers a handshake using it with
 * {"code":4000,"message":"Invalid Client ID"} and hangs up - so presence can never
 * appear until a real id is set. Make one at https://discord.com/developers
 * (New Application, then copy the Application ID) and paste it into Settings.
 */
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
let lastError = null;

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

/*
 * Connects and waits for Discord to answer the handshake.
 *
 * The reply used to be ignored, which made every failure look like a success:
 * Discord rejects a bad client id with op 2 and closes the pipe, and the launcher
 * carried on believing it was connected. Reading the reply is what lets the setting
 * say "Invalid application id" instead of the untrue "Discord is not running".
 */
async function connect() {
  if (connected || socket) return connected;
  lastError = null;
  let reachedDiscord = false;

  for (let index = 0; index <= 9; index++) {
    const candidate = await tryPipe(index);
    if (!candidate) continue;
    reachedDiscord = true;

    const accepted = await new Promise((resolve) => {
      let settled = false;
      const finish = (ok, error) => {
        if (settled) return;
        settled = true;
        lastError = error || null;
        resolve(ok);
      };

      candidate.on('data', (buf) => {
        if (buf.length < 8) return;
        const op = buf.readInt32LE(0);
        const length = buf.readInt32LE(4);
        let body = {};
        try { body = JSON.parse(buf.slice(8, 8 + length).toString('utf8')); } catch (_) { /* ignore */ }

        // op 2 is CLOSE - Discord refusing us, and it says why.
        if (op === OP_CLOSE) return finish(false, body.message || 'Discord refused the connection');
        finish(true, null);
      });

      candidate.once('error', () => finish(false, 'The connection to Discord failed'));
      candidate.once('close', () => finish(false, 'Discord closed the connection'));
      candidate.write(encode(OP_HANDSHAKE, { v: 1, client_id: appId }));

      // Discord answers immediately; a silent pipe is not Discord.
      setTimeout(() => finish(false, 'Discord did not answer'), 3000);
    });

    if (!accepted) {
      try { candidate.destroy(); } catch (_) { /* already gone */ }
      continue;
    }

    socket = candidate;
    socket.on('error', cleanup);
    socket.on('close', cleanup);
    connected = true;

    if (currentActivity) setActivity(currentActivity);
    return true;
  }

  /*
   * A pipe that opened and then went quiet is still a failure, and with the
   * placeholder id it is the expected one: Discord answers the first bad handshake
   * with "Invalid Client ID" and simply stops replying to the ones after it. Saying
   * "Discord did not answer" would send someone looking at Discord, which is fine.
   */
  if (reachedDiscord && appId === DEFAULT_APP_ID) {
    lastError = 'No Discord application id set - presence cannot work without one';
  } else if (!lastError) {
    lastError = 'Discord is not running';
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

async function start(customAppId) {
  if (customAppId) appId = customAppId;
  const ok = await connect().catch(() => false);
  // Discord may be started after the launcher, so keep trying quietly.
  if (!reconnectTimer) {
    reconnectTimer = setInterval(() => {
      if (!connected) connect().catch(() => {});
    }, 30000);
    if (reconnectTimer.unref) reconnectTimer.unref();
  }
  return ok;
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

/** Connected, and if not, the actual reason - which is rarely "not running". */
function status() {
  return { connected, error: connected ? null : lastError, appId };
}

module.exports = {
  start, stop, setActivity, idle, playing, isConnected, status, OP_PING
};
