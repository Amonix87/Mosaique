'use strict';
// Connexion par OpenID Connect (Authelia, Authentik, Keycloak, Zitadel... tout fournisseur conforme).
//
// Facultatif : tout est désactivé tant que OIDC_ISSUER, OIDC_CLIENT_ID (et en général OIDC_CLIENT_SECRET)
// ne sont pas définis. Flux « authorization code » avec PKCE (S256), `state` et `nonce`, sans dépendance
// externe. Ce module ne touche ni à la base ni aux sessions : il parle uniquement au fournisseur et
// rend l'identité vérifiée ; server/index.js décide à quel compte Mosaïque elle correspond.
const crypto = require('crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const rand = (n = 32) => b64u(crypto.randomBytes(n));

function config() {
  const issuer = String(process.env.OIDC_ISSUER || '').trim().replace(/\/$/, '');
  const clientId = String(process.env.OIDC_CLIENT_ID || '').trim();
  if (!issuer || !clientId) return null;
  const off = (v) => ['0', 'false', 'non', 'no', 'off'].includes(String(v || '').trim().toLowerCase());
  return {
    issuer,
    clientId,
    clientSecret: String(process.env.OIDC_CLIENT_SECRET || ''),
    scopes: String(process.env.OIDC_SCOPES || 'openid profile email').trim(),
    name: String(process.env.OIDC_NAME || 'Authelia').trim().slice(0, 40) || 'Authelia',
    redirectUri: String(process.env.OIDC_REDIRECT_URI || '').trim(),
    passwordLogin: !off(process.env.OIDC_PASSWORD_LOGIN),
  };
}
const enabled = () => !!config();

// Ce que l'écran de connexion a besoin de savoir (rien de secret).
function publicInfo() {
  const c = config();
  return c ? { name: c.name, password_login: c.passwordLogin } : null;
}

class OidcError extends Error {
  constructor(code, detail) { super(detail || code); this.code = code; }
}

// L'identité est reçue directement du fournisseur, sur une connexion TLS que nous avons ouverte nous-mêmes :
// la spécification (OIDC Core §3.1.3.7) autorise alors à se passer de la vérification de la signature du
// jeton. Cette garantie ne vaut que si la connexion est chiffrée : on refuse donc un fournisseur en http://,
// sauf sur la machine elle-même (essais en local).
function checkTransport(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { throw new OidcError('provider', `URL invalide : ${urlStr}`); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new OidcError('provider', `Le fournisseur doit être en https:// (reçu ${u.protocol}//${u.hostname})`);
  return u;
}

async function fetchJson(url, opts = {}) {
  let res;
  try { res = await fetch(url, { ...opts, signal: AbortSignal.timeout(10000) }); }
  catch (e) { throw new OidcError('provider', `Fournisseur injoignable (${url}) : ${e.message}`); }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* corps non JSON */ }
  if (!res.ok) throw new OidcError('provider', `HTTP ${res.status} sur ${url} : ${(json && (json.error_description || json.error)) || text.slice(0, 200)}`);
  if (!json) throw new OidcError('provider', `Réponse non JSON de ${url}`);
  return json;
}

let discoveryCache = null; // { at, issuer, doc }
async function discover(c) {
  if (discoveryCache && discoveryCache.issuer === c.issuer && Date.now() - discoveryCache.at < 3600000) return discoveryCache.doc;
  checkTransport(c.issuer);
  const doc = await fetchJson(`${c.issuer}/.well-known/openid-configuration`);
  if (String(doc.issuer || '').replace(/\/$/, '') !== c.issuer) throw new OidcError('provider', `L'émetteur annoncé (${doc.issuer}) ne correspond pas à OIDC_ISSUER (${c.issuer})`);
  for (const k of ['authorization_endpoint', 'token_endpoint']) {
    if (!doc[k]) throw new OidcError('provider', `Découverte incomplète : ${k} manquant`);
    checkTransport(doc[k]);
  }
  if (doc.userinfo_endpoint) checkTransport(doc.userinfo_endpoint);
  discoveryCache = { at: Date.now(), issuer: c.issuer, doc };
  return doc;
}

// Connexions en cours (entre la redirection vers le fournisseur et son retour) : en mémoire, 10 minutes.
// Un redémarrage du serveur interrompt simplement une connexion à peine commencée.
const pending = new Map();
const TTL = 10 * 60000;
function prune() { const now = Date.now(); for (const [k, v] of pending) if (now - v.at > TTL) pending.delete(k); }

// Début de la connexion : renvoie l'adresse du fournisseur vers laquelle rediriger le navigateur, et le `state`
// (que l'appelant dépose aussi dans un cookie, pour lier ce retour à CE navigateur).
async function begin(redirectUri) {
  const c = config();
  if (!c) throw new OidcError('disabled');
  const doc = await discover(c);
  prune();
  const state = rand();
  const nonce = rand();
  const verifier = rand(48);
  pending.set(state, { at: Date.now(), nonce, verifier, redirectUri });
  const u = new URL(doc.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', c.clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', c.scopes);
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  u.searchParams.set('code_challenge', b64u(crypto.createHash('sha256').update(verifier).digest()));
  u.searchParams.set('code_challenge_method', 'S256');
  return { url: u.toString(), state };
}

function decodeJwtPayload(jwt) {
  const parts = String(jwt || '').split('.');
  if (parts.length < 2) throw new OidcError('token', 'jeton d\'identité mal formé');
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); }
  catch { throw new OidcError('token', 'jeton d\'identité illisible'); }
}

// Retour du fournisseur : vérifie, échange le code, et rend { sub, email, email_verified, name }.
async function finish(query, cookieState) {
  const c = config();
  if (!c) throw new OidcError('disabled');
  const state = String(query.state || '');
  const entry = state && pending.get(state);
  if (entry) pending.delete(state); // à usage unique, quoi qu'il arrive ensuite
  if (!entry || Date.now() - entry.at > TTL) throw new OidcError('expired', 'connexion inconnue ou expirée');
  if (!cookieState || cookieState !== state) throw new OidcError('state', 'ce retour ne vient pas du navigateur qui a commencé la connexion');
  if (query.error) throw new OidcError('denied', `${query.error}${query.error_description ? ' — ' + query.error_description : ''}`);
  if (!query.code) throw new OidcError('provider', 'code d\'autorisation absent');

  const doc = await discover(c);
  const methods = doc.token_endpoint_auth_methods_supported;
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: String(query.code), redirect_uri: entry.redirectUri, code_verifier: entry.verifier });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (!c.clientSecret) body.set('client_id', c.clientId); // client public : PKCE seul
  else if (Array.isArray(methods) && !methods.includes('client_secret_basic') && methods.includes('client_secret_post')) { body.set('client_id', c.clientId); body.set('client_secret', c.clientSecret); }
  else headers.Authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(c.clientId)}:${encodeURIComponent(c.clientSecret)}`).toString('base64');
  const tok = await fetchJson(doc.token_endpoint, { method: 'POST', headers, body });
  if (!tok.id_token) throw new OidcError('token', 'le fournisseur n\'a pas renvoyé de jeton d\'identité (scope openid manquant ?)');

  const claims = decodeJwtPayload(tok.id_token);
  if (String(claims.iss || '').replace(/\/$/, '') !== String(doc.issuer).replace(/\/$/, '')) throw new OidcError('token', `émetteur inattendu : ${claims.iss}`);
  const aud = [].concat(claims.aud || []);
  if (!aud.includes(c.clientId)) throw new OidcError('token', 'jeton destiné à une autre application');
  if (aud.length > 1 && claims.azp && claims.azp !== c.clientId) throw new OidcError('token', 'azp inattendu');
  if (!(Number(claims.exp) > Date.now() / 1000 - 60)) throw new OidcError('token', 'jeton expiré');
  if (claims.nonce !== entry.nonce) throw new OidcError('token', 'nonce incorrect');
  if (!claims.sub) throw new OidcError('token', 'sub absent');

  // Adresse e-mail et nom : le jeton d'identité ne les porte pas toujours (Authelia les met dans userinfo).
  let info = {};
  if (doc.userinfo_endpoint && tok.access_token) {
    info = await fetchJson(doc.userinfo_endpoint, { headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json' } });
    if (info.sub !== claims.sub) throw new OidcError('token', 'userinfo : sub différent du jeton d\'identité');
  }
  const pick = (k) => (info[k] !== undefined ? info[k] : claims[k]);
  const ev = pick('email_verified');
  return {
    sub: String(claims.sub),
    issuer: c.issuer,
    email: pick('email') ? String(pick('email')).trim() : '',
    email_verified: ev === true || ev === 'true' ? true : (ev === false || ev === 'false' ? false : null),
    name: pick('name') || pick('preferred_username') || '',
  };
}

module.exports = { config, enabled, publicInfo, begin, finish, OidcError };
