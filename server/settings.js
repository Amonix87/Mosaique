'use strict';
const { db } = require('./db');

function getSetting(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? r.value : null;
}
function setSetting(key, value) {
  if (value === null || value === undefined) { db.prepare('DELETE FROM settings WHERE key=?').run(key); return; }
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}

// Adresse publique de l'instance : modifiable depuis Réglages (admin), avec repli sur la variable
// d'environnement PUBLIC_URL pour les installations qui la définissent déjà côté docker-compose.yml.
function currentPublicUrl() {
  const v = getSetting('public_url') ?? process.env.PUBLIC_URL ?? '';
  return String(v).trim().replace(/\/$/, '');
}
function publicUrlInfo() {
  const fromDb = getSetting('public_url');
  const url = currentPublicUrl();
  return { url: url || null, source: fromDb ? 'app' : (url ? 'env' : null) };
}
function savePublicUrl(url) {
  const v = String(url || '').trim().replace(/\/$/, '');
  if (v && !/^https?:\/\/.+/.test(v)) throw Object.assign(new Error('Adresse invalide : elle doit commencer par http:// ou https://'), { status: 400 });
  setSetting('public_url', v || null);
}

module.exports = { getSetting, setSetting, currentPublicUrl, publicUrlInfo, savePublicUrl };
