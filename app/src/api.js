'use strict';

/**
 * Client half of the Astra backend.
 *
 * Lives in the main process rather than the renderer because the backend is usually
 * plain http on localhost, which the page's CSP blocks - and because the session token
 * should never be handed to the page.
 */

const store = require('./store');

const DEFAULT_URL = 'http://localhost:8787';

let sessionToken = null;

function baseUrl() {
  return (store.get('serverUrl') || DEFAULT_URL).replace(/\/+$/, '');
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
    const error = new Error(`Astra server unreachable (${baseUrl()})`);
    error.offline = true;
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
  DEFAULT_URL, baseUrl, isConfigured, login, signedIn, signOut, me,
  friends, addFriend, acceptFriend, removeFriend, setPresence,
  servers, shop, buy, equip,
  challenges, reportChallenges, claimChallenge, daily, claimDaily,
  shareProfile, getShared
};
