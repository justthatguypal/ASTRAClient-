'use strict';

/**
 * Microsoft -> Xbox Live -> XSTS -> Minecraft sign in.
 *
 * This uses the Microsoft Account (not Azure AD) client id that the official launcher
 * family uses, which means it works with no registration or setup from the user. The
 * trap worth remembering: `00000000402b5328` only exists on `login.live.com`. Asking
 * `login.microsoftonline.com` about it answers `unauthorized_client`, which reads like a
 * dead client id rather than the wrong endpoint.
 *
 * A Live ticket goes to Xbox Live as a bare RpsTicket. Only Azure AD tokens take the
 * `d=` prefix. Getting that backwards fails with a bare 400.
 */

const { BrowserWindow, session } = require('electron');

const CLIENT_ID = '00000000402b5328';
const SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL';
const REDIRECT = 'https://login.live.com/oauth20_desktop.srf';
const AUTHORIZE = 'https://login.live.com/oauth20_authorize.srf';
const TOKEN = 'https://login.live.com/oauth20_token.srf';

const XBL_AUTH = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_AUTH = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MC_LOGIN = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MC_PROFILE = 'https://api.minecraftservices.com/minecraft/profile';
const MC_ENTITLEMENTS = 'https://api.minecraftservices.com/entitlements/mcstore';

/** Opens the Microsoft login window and resolves with an OAuth code. */
function getAuthCode(parent) {
  return new Promise((resolve, reject) => {
    const url = `${AUTHORIZE}?client_id=${CLIENT_ID}`
      + `&response_type=code`
      + `&redirect_uri=${encodeURIComponent(REDIRECT)}`
      + `&scope=${encodeURIComponent(SCOPE)}`
      + `&prompt=select_account`;

    // Its own partition, so signing out really signs out and a second account can be
    // added without inheriting the first one's cookies.
    const authSession = session.fromPartition('persist:astra-auth');

    const win = new BrowserWindow({
      parent,
      modal: true,
      width: 520,
      height: 720,
      autoHideMenuBar: true,
      title: 'Sign in to Microsoft',
      backgroundColor: '#0E0E10',
      webPreferences: {
        session: authSession,
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    let settled = false;
    const finish = (err, code) => {
      if (settled) return;
      settled = true;
      try { win.destroy(); } catch (_) { /* already gone */ }
      err ? reject(err) : resolve(code);
    };

    const inspect = (target) => {
      if (!target || !target.startsWith(REDIRECT)) return;
      let parsed;
      try { parsed = new URL(target); } catch (_) { return; }
      const code = parsed.searchParams.get('code');
      const error = parsed.searchParams.get('error');
      if (code) finish(null, code);
      else if (error) finish(new Error(parsed.searchParams.get('error_description') || error));
    };

    win.webContents.on('will-redirect', (_e, target) => inspect(target));
    win.webContents.on('will-navigate', (_e, target) => inspect(target));
    win.on('closed', () => {
      if (!settled) {
        settled = true;
        reject(new Error('Sign in window was closed'));
      }
    });

    win.loadURL(url);
  });
}

async function postForm(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString()
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function postJson(url, body, token) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${url} -> ${res.status} ${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return JSON.parse(text);
}

function exchangeCode(code) {
  return postForm(TOKEN, {
    client_id: CLIENT_ID,
    code,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT
  });
}

function refresh(refreshToken) {
  return postForm(TOKEN, {
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    redirect_uri: REDIRECT
  });
}

/** Live ticket -> XBL token. Bare ticket, no `d=` prefix: this is not an Azure AD token. */
async function xboxLive(accessToken) {
  const data = await postJson(XBL_AUTH, {
    Properties: {
      AuthMethod: 'RPS',
      SiteName: 'user.auth.xboxlive.com',
      RpsTicket: accessToken
    },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT'
  });
  return { token: data.Token, uhs: data.DisplayClaims.xui[0].uhs };
}

async function xsts(xblToken) {
  try {
    const data = await postJson(XSTS_AUTH, {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT'
    });
    return data.Token;
  } catch (err) {
    // XSTS uses these to explain *why* an account cannot play, and the raw status is
    // useless to the person reading it.
    const known = {
      2148916233: 'This Microsoft account has no Xbox profile. Sign in at xbox.com once to create one.',
      2148916235: 'Xbox Live is not available in this account\'s country or region.',
      2148916236: 'This account needs adult verification before it can use Xbox Live.',
      2148916237: 'This account needs adult verification before it can use Xbox Live.',
      2148916238: 'This is a child account. It has to be added to a family by an adult before it can play.'
    };
    let code = null;
    try { code = JSON.parse(err.body || '{}').XErr; } catch (_) { /* not json */ }
    throw new Error(known[code] || err.message);
  }
}

async function minecraftToken(uhs, xstsToken) {
  const data = await postJson(MC_LOGIN, { identityToken: `XBL3.0 x=${uhs};${xstsToken}` });
  return data.access_token;
}

async function ownsMinecraft(mcToken) {
  const res = await fetch(MC_ENTITLEMENTS, { headers: { Authorization: `Bearer ${mcToken}` } });
  if (!res.ok) return false;
  const data = await res.json();
  return Array.isArray(data.items) && data.items.length > 0;
}

async function getProfile(mcToken) {
  const res = await fetch(MC_PROFILE, { headers: { Authorization: `Bearer ${mcToken}` } });
  if (res.status === 404) {
    throw new Error('This account owns Minecraft but has no profile yet. Set a username in the official launcher first.');
  }
  if (!res.ok) throw new Error(`Profile lookup failed (${res.status})`);
  return res.json();
}

/** Everything from a Live token pair through to a playable session. */
async function completeLogin(tokens) {
  const { token: xblToken, uhs } = await xboxLive(tokens.access_token);
  const xstsToken = await xsts(xblToken);
  const mcToken = await minecraftToken(uhs, xstsToken);

  if (!(await ownsMinecraft(mcToken))) {
    throw new Error('This Microsoft account does not own Minecraft: Java Edition.');
  }
  const profile = await getProfile(mcToken);

  return {
    id: profile.id,
    name: profile.name,
    skins: profile.skins || [],
    accessToken: mcToken,
    refreshToken: tokens.refresh_token,
    // Refresh a few minutes early so a launch never starts with a dead token.
    expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000 - 300000
  };
}

async function signIn(parentWindow) {
  const code = await getAuthCode(parentWindow);
  const tokens = await exchangeCode(code);
  return completeLogin(tokens);
}

async function refreshAccount(account) {
  const tokens = await refresh(account.refreshToken);
  return completeLogin(tokens);
}

/** Returns a session that is definitely valid right now, refreshing if it has to. */
async function ensureValid(account) {
  if (account && account.expiresAt && Date.now() < account.expiresAt) return account;
  return refreshAccount(account);
}

async function signOut() {
  const authSession = session.fromPartition('persist:astra-auth');
  await authSession.clearStorageData();
}

module.exports = { signIn, refreshAccount, ensureValid, signOut };
