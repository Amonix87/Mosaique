'use strict';
const nodemailer = require('nodemailer');
const { getSetting, setSetting, currentPublicUrl } = require('./settings');

// La configuration enregistrée depuis Réglages (admin) est prioritaire ; les variables
// d'environnement du docker-compose.yml restent un repli pour les installations existantes qui
// les utilisaient déjà, ou pour ceux qui préfèrent cette méthode.
function currentConfig() {
  const host = getSetting('smtp_host') ?? process.env.SMTP_HOST ?? '';
  const port = Number(getSetting('smtp_port') ?? process.env.SMTP_PORT) || 587;
  const user = getSetting('smtp_user') ?? process.env.SMTP_USER ?? '';
  const pass = getSetting('smtp_pass') ?? process.env.SMTP_PASS ?? '';
  const from = getSetting('smtp_from') ?? process.env.SMTP_FROM ?? user ?? 'mosaique@localhost';
  const secureSetting = getSetting('smtp_secure');
  const secure = secureSetting !== null ? secureSetting === 'true' : (process.env.SMTP_SECURE === '1' || process.env.SMTP_SECURE === 'true');
  return { host, port, user, pass, from: from || user || 'mosaique@localhost', secure };
}

function configured() { return !!currentConfig().host; }

// Réglage courant tel qu'à afficher dans l'interface (sans le mot de passe, jamais renvoyé au client).
function publicConfig() {
  const c = currentConfig();
  return { host: c.host, port: c.port, user: c.user, from: c.from, secure: c.secure, has_password: !!c.pass, configured: !!c.host };
}

function saveConfig({ host, port, user, pass, from, secure }) {
  setSetting('smtp_host', host !== undefined ? String(host).trim() : null);
  if (port !== undefined) setSetting('smtp_port', Number(port) || 587);
  if (user !== undefined) setSetting('smtp_user', String(user).trim());
  if (pass !== undefined && pass !== '') setSetting('smtp_pass', pass); // champ laissé vide = mot de passe inchangé
  if (from !== undefined) setSetting('smtp_from', String(from).trim());
  if (secure !== undefined) setSetting('smtp_secure', secure ? 'true' : 'false');
}

function clearConfig() {
  for (const k of ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from', 'smtp_secure']) setSetting(k, null);
}

function getTransporter() {
  const cfg = currentConfig();
  if (!cfg.host) return null;
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
}

// N'échoue jamais bruyamment : un souci d'envoi ne doit jamais faire planter une requête API.
// L'erreur est journalisée côté serveur pour diagnostic (voir `docker compose logs`).
async function sendMail({ to, subject, text }) {
  const t = getTransporter();
  if (!t) return { ok: false, error: "Aucun serveur SMTP n'est configuré." };
  try {
    await t.sendMail({ from: currentConfig().from, to, subject, text });
    return { ok: true };
  } catch (err) {
    console.error('Envoi e-mail échoué :', err.message);
    return { ok: false, error: err.message };
  }
}

function link(hash) {
  const base = currentPublicUrl();
  return base ? `${base}/${hash || ''}` : null;
}

module.exports = { configured, publicConfig, saveConfig, clearConfig, sendMail, link, publicUrl: currentPublicUrl };
