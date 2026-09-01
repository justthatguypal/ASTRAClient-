'use strict';

/**
 * Client half of the Astra backend.
 *
 * Lives in the main process rather than the renderer because the backend is usually
 * plain http on localhost, which the page's CSP blocks - and because the session token
 * should never be handed to the page.
 */

const store = require('./store');

/*
 * Where the backend lives.
 *
 * localhost is only right for whoever is running the server, which is nobody who
 * just installed the launcher - on their machine localhost is their machine, and
 * nothing is listening. So the address is looked up rather than baked in:
 *
 *   1. whatever the user typed in Settings, if anything
 *   2. the address discovered last time, remembered so startup is not blocked
 *   3. a pointer file published in the Astra repo
 *   4. localhost, for whoever is hosting
 *
 * The pointer matters because the public address changes - a tunnel hands out a new
 * hostname every restart. Publishing it means the address can move without shipping
 * a new exe to everybody.
 */
const DEFAULT_URL = 'http://localhost:8787';

const POINTER_URL =
  'https://raw.githubusercontent.com/justthatguypal/ASTRAClient-/main/server.json';

let sessionToken = null;
let discovered = null;

function baseUrl() {
  const configured = store.get('serverUrl');
  if (configured) return configured.replace(/\/+$/, '');
  if (discovered) return discovered.replace(/\/+$/, '');

  const remembered = store.get('serverUrlDiscovered');
  if (remembered) return remembered.replace(/\/+$/, '');

  return DEFAULT_URL;
}

/**
 * Asks the repo where the backend is today. Safe to call at startup and safe to
 * fail: the launcher works with the backend switched off, so a pointer that cannot
 * be read just leaves the address as it was.
 */
async function discover() {
  // An address typed by hand is a deliberate choice and is never overridden.
  if (store.get('serverUrl')) return baseUrl();

  try {
    const res = await fetch(POINTER_URL, {
      cache: 'no-store',
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return baseUrl();

    const data = await res.json();
    const url = String(data.url || '').trim();

    // Only https, and only a real host - a pointer is fetched from the network, so
    // it is treated as a suggestion to validate rather than a value to trust.
    if (!/^https:\/\/[\w.-]+(:\d+)?(\/|$)/.test(url)) return baseUrl();

    discovered = url.replace(/\/+$/, '');
    store.set('serverUrlDiscovered', discovered);
    return discovered;
  } catch (_) {
    return baseUrl();
  }
}

function isConfigured() {
  return Boolean(store.get('serverUrl') || DEFAULT_URL);
}

async function request(method, endpoint, body, auth = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && sessionToken) headers.Authorization = `Bearer ${sessionToken}`;

  let res;
  try {
    res = await fetch(`${baseUrl()}${endpoint}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000)
    });
  } catch (err) {
    // The launcher has to work with the backend switched off, so this is a soft
    // failure everywhere it is used.
    //
    // A timeout is reported separately from a refused connection. They look the
    // same here but mean opposite things - one is a server that is not there, the
    // other is a server that is there and wedged - and calling both "unreachable"
    // sends you looking for the wrong problem.
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    const error = new Error(timedOut
      ? `Astra server is not responding (${baseUrl()})`
      : `Astra server unreachable (${baseUrl()})`);
    error.offline = true;
    error.timedOut = timedOut;
    throw error;
  }

  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }

  if (!res.ok) {
    const error = new Error(data.error || `${res.status} from ${endpoint}`);
    error.status = res.status;
    throw error;
  }
  return data;
}

/** Trades the Minecraft token for an Astra session. */
async function login(minecraftToken) {
  const result = await request('POST', '/api/login', { minecraftToken }, false);
  sessionToken = result.token;
  return result.player;
}

function signedIn() {
  return Boolean(sessionToken);
}

function signOut() {
  sessionToken = null;
}

const me = () => request('GET', '/api/me');

const friends = () => request('GET', '/api/friends');
const addFriend = (name) => request('POST', '/api/friends/add', { name });
const acceptFriend = (uuid) => request('POST', '/api/friends/accept', { uuid });
const removeFriend = (uuid) => request('POST', '/api/friends/remove', { uuid });
const setPresence = (presence) => request('POST', '/api/presence', presence);

const servers = () => request('GET', '/api/servers', undefined, false);

const shop = () => request('GET', '/api/shop');
const buy = (itemId) => request('POST', '/api/shop/buy', { itemId });
const equip = (slot, itemId) => request('POST', '/api/cosmetics/equip', { slot, itemId });

const daily = () => request('GET', '/api/daily');
const claimDaily = () => request('POST', '/api/daily/claim');
const challenges = () => request('GET', '/api/challenges');
const reportChallenges = (events) => request('POST', '/api/challenges/progress', { events });
const claimChallenge = (challenge) => request('POST', '/api/challenges/claim', { challenge });

const shareProfile = (profile) => request('POST', '/api/profiles/share', { profile });
const getShared = (code) => request('GET', `/api/profiles/${encodeURIComponent(code)}`, undefined, false);

module.exports = {
  DEFAULT_URL, baseUrl, discover, isConfigured, login, signedIn, signOut, me,
  friends, addFriend, acceptFriend, removeFriend, setPresence,
  servers, shop, buy, equip,
  challenges, reportChallenges, claimChallenge, daily, claimDaily,
  shareProfile, getShared
};
