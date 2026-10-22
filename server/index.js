'use strict';
// Charge un éventuel fichier .env (facultatif ; les variables déjà définies dans l'environnement priment).
try {
  const fs0 = require('fs');
  const path0 = require('path');
  const envPath = path0.join(__dirname, '..', '.env');
  if (fs0.existsSync(envPath)) {
    for (const line of fs0.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
} catch { /* pas grave : .env est facultatif */ }

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const archiver = require('archiver');
const { db, DATA_DIR, MEDIA_DIR } = require('./db');
const { loadHolidays, startAutoRefresh } = require('./holidays');
const mailer = require('./mailer');
const push = require('./push');
const addonManager = require('./addon-manager');

// Catégories utilisées à la fois pour la liste de courses et les ingrédients de recette, afin que
// le planificateur de repas puisse regrouper les articles générés de la même façon que ceux ajoutés à la main.
const GROCERY_CATEGORIES = ['Fruits & légumes', 'Viande & poisson', 'Crémerie & œufs', 'Épicerie', 'Boulangerie', 'Surgelés', 'Boissons', 'Hygiène & entretien', 'Autre'];

// Catégories d'événements ; celles qui ont un équivalent budgétaire y rangent la dépense créée
// quand un prix est renseigné (voir createExpenseForEvent).
const EVENT_CATEGORIES = ['Rendez-vous', 'Santé', 'École', 'Activité', 'Famille', 'Autre'];
const EXPENSE_CATEGORY_FOR_EVENT = { 'Santé': 'Santé', 'École': 'École', 'Activité': 'Activités', 'Famille': 'Loisirs' };
const EXPENSE_REPEATS = ['weekly', 'monthly', 'quarterly', 'yearly'];
const EVENT_PRICE_REPEAT_MSG = "Un prix ne peut être associé qu'à un événement qui ne se répète pas (pour un paiement régulier, utilisez une dépense récurrente dans Budget).";
const appUrl = require('./settings');

const app = express();
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.disable('x-powered-by');

/* ───────────────────────── Utilitaires ───────────────────────── */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);
const pad = (n) => String(n).padStart(2, '0');
const parseD = (s) => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };
const fmtD = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const addDays = (s, n) => fmtD(parseD(s) + n * 86400000);
const validDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && fmtD(parseD(s)) === s;
const validDateTime = (s) => typeof s === 'string' && (validDate(s) || (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) && validDate(s.slice(0, 10)) && +s.slice(11, 13) < 24 && +s.slice(14) < 60));
const nowLocal = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randToken = (n = 32) => crypto.randomBytes(n).toString('base64url');
const HEX = /^#[0-9a-fA-F]{6}$/;

function addMonths(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const total = (m - 1) + n;
  const ny = y + Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${pad(nm + 1)}-${pad(Math.min(d, last))}`;
}

function getSetting(key, def = null) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? r.value : def;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}

const myCircles = (uid) => db.prepare('SELECT circle_id FROM circle_members WHERE user_id=?').all(uid).map((r) => r.circle_id);
function requireMember(user, circleId) {
  const cid = Number(circleId);
  if (!Number.isInteger(cid) || !myCircles(user.id).includes(cid)) throw new HttpError(403, "Vous n'avez pas accès à ce cercle.");
  return cid;
}
const placeholders = (arr) => (arr.length ? arr.map(() => '?').join(',') : 'NULL');
const userExists = (id) => !!db.prepare('SELECT 1 FROM users WHERE id=?').get(id);
const childExists = (id) => !!db.prepare('SELECT 1 FROM children WHERE id=?').get(id);
const parseJ = (s, def) => { try { return JSON.parse(s); } catch { return def; } };

// Un enfant sans parents désignés reste visible par tout le cercle (comportement historique).
// Dès que des parents sont désignés, seuls eux (et les administrateurs) voient les données de cet enfant.
// Lecture : administrateurs, parents désignés, et lecteurs (ex. le·la compagnon·ne d'un parent) —
// ou tout le monde si l'enfant n'a aucun parent désigné (comportement par défaut, non restreint).
function canSeeChild(user, childId) {
  const c = db.prepare('SELECT parent_ids, viewer_ids FROM children WHERE id=?').get(childId);
  if (!c) return false;
  if (user.is_admin) return true;
  const pids = parseJ(c.parent_ids, []);
  if (pids.length === 0) return true;
  return pids.includes(user.id) || parseJ(c.viewer_ids, []).includes(user.id);
}
// Écriture (créer/modifier un événement, la garde, un contact pour cet enfant) : administrateurs et
// parents désignés uniquement — un·e lecteur·rice voit mais ne modifie jamais.
function canEditChild(user, childId) {
  const c = db.prepare('SELECT parent_ids FROM children WHERE id=?').get(childId);
  if (!c) return false;
  if (user.is_admin) return true;
  const pids = parseJ(c.parent_ids, []);
  return pids.length === 0 || pids.includes(user.id);
}
function childVisible(user, child) {
  if (user.is_admin) return true;
  const pids = parseJ(child.parent_ids, []);
  if (pids.length === 0) return true;
  return pids.includes(user.id) || parseJ(child.viewer_ids, []).includes(user.id);
}
// childIdsJson : la colonne child_ids telle que stockée (chaîne JSON) — utilisable côté filtre et validation.
function visibleForChildren(user, childIdsJson) {
  const ids = parseJ(childIdsJson, []);
  return ids.length === 0 || ids.every((id) => canSeeChild(user, id));
}
function editableForChildren(user, childIdsJson) {
  const ids = parseJ(childIdsJson, []);
  return ids.length === 0 || ids.every((id) => canEditChild(user, id));
}

/* ───────────────────────── Temps réel (SSE) ───────────────────────── */
const streams = new Map(); // userId -> Set(res)
function emitTo(userIds, payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const id of new Set(userIds)) {
    const set = streams.get(id);
    if (set) for (const res of set) res.write(data);
  }
}
function circleMemberIds(circleId) {
  return db.prepare('SELECT user_id FROM circle_members WHERE circle_id=?').all(circleId).map((r) => r.user_id);
}
function notify(userIds, { kind, title, body = null, link = null }, exceptId = null) {
  const base = [...new Set(userIds)];
  // Le/la conjoint·e d'une personne notifiée l'est aussi automatiquement (réglage personnel de
  // chacun, dans Mon compte) — pratique pour qu'un beau-parent qui vit avec le responsable soit au
  // courant sans avoir à faire partie du même cercle.
  const partners = base.length
    ? db.prepare(`SELECT partner_id FROM users WHERE id IN (${placeholders(base)}) AND partner_id IS NOT NULL`).all(...base).map((r) => r.partner_id)
    : [];
  const targets = [...new Set([...base, ...partners])].filter((id) => id !== exceptId);
  const ins = db.prepare('INSERT INTO notifications(user_id,kind,title,body,link) VALUES(?,?,?,?,?)');
  for (const id of targets) ins.run(id, kind, title, body, link);
  emitTo(targets, { type: 'notify', kind, title });
  if (mailer.configured() && targets.length) {
    const rows = db.prepare(`SELECT id,name,email FROM users WHERE email_notify=1 AND id IN (${placeholders(targets)})`).all(...targets);
    for (const u of rows) {
      const url = mailer.link(link ? `#${link.replace(/^#/, '')}` : '');
      const text = [body, url ? `Voir dans Mosaïque : ${url}` : null].filter(Boolean).join('\n\n');
      mailer.sendMail({ to: u.email, subject: `Mosaïque — ${title}`, text: text || title });
    }
  }
  for (const id of targets) push.sendPush(id, { title: `Mosaïque — ${title}`, body, link: link || '/' }).catch(() => {});
}

/* ───────────────────────── Authentification ───────────────────────── */
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function startSession(req, res, userId) {
  const token = randToken();
  const expires = Date.now() + 30 * 86400000;
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(sha(token), userId, expires);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `mq_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure ? '; Secure' : ''}`);
}
function authenticate(req, _res, next) {
  const tok = parseCookies(req).mq_session;
  if (tok) {
    const row = db.prepare('SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?').get(sha(tok));
    if (row && row.expires_at > Date.now()) req.user = row;
  }
  next();
}
const requireAuth = (req, _res, next) => (req.user ? next() : next(new HttpError(401, 'Connexion requise.')));
const requireAdmin = (req, _res, next) => (req.user && req.user.is_admin ? next() : next(new HttpError(403, 'Réservé aux administrateurs.')));

const attempts = new Map();
function rateLimit(req) {
  const key = req.ip;
  const now = Date.now();
  const a = (attempts.get(key) || []).filter((t) => now - t < 15 * 60000);
  if (a.length >= 10) throw new HttpError(429, 'Trop de tentatives. Réessayez dans quelques minutes.');
  a.push(now);
  attempts.set(key, a);
}
const clearAttempts = (req) => attempts.delete(req.ip);

/* ───────────────────────── Middlewares globaux ───────────────────────── */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(authenticate);
// Protection CSRF : les requêtes qui modifient des données doivent porter un en-tête personnalisé.
app.use('/api', (req, _res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-requested-with'] !== 'mosaique') {
    return next(new HttpError(403, 'Requête refusée.'));
  }
  next();
});

const api = express.Router();
app.use('/api', api);

/* ───────────────────────── État, installation, connexion ───────────────────────── */
function meState(u) {
  const users = db.prepare('SELECT id,name,email,color,is_admin,claimed FROM users ORDER BY name').all()
    .map((x) => ({ id: x.id, name: x.name, color: x.color, is_admin: !!x.is_admin, claimed: !!x.claimed, ...(u.is_admin ? { email: x.email } : {}) }));
  const members = db.prepare('SELECT circle_id,user_id FROM circle_members').all();
  const mine = new Set(members.filter((m) => m.user_id === u.id).map((m) => m.circle_id));
  let circles = db.prepare('SELECT * FROM circles ORDER BY id').all().map((c) => ({
    ...c, member_ids: members.filter((m) => m.circle_id === c.id).map((m) => m.user_id), mine: mine.has(c.id),
  }));
  if (!u.is_admin) circles = circles.filter((c) => c.mine);
  const children = db.prepare('SELECT * FROM children ORDER BY id').all()
    .filter((c) => childVisible(u, c))
    .map((c) => ({ ...c, parent_ids: parseJ(c.parent_ids, []), viewer_ids: parseJ(c.viewer_ids, []), shared_custody: !!c.shared_custody }));
  const unread = db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read=0').get(u.id).n;
  return {
    user: { id: u.id, name: u.name, email: u.email, color: u.color, is_admin: !!u.is_admin, ical_token: u.ical_token, email_notify: !!u.email_notify, homework_recap: !!u.homework_recap, partner_id: u.partner_id ?? null, app_installed: !!u.app_installed_at },
    users, circles, children, unread,
    settings: {
      family_name: getSetting('family_name', 'Ma famille'),
      fil_familial: getSetting('fil_familial', 'false') === 'true',
      messages_enabled: getSetting('messages_enabled', 'true') === 'true',
      courses_enabled: getSetting('courses_enabled', 'true') === 'true',
      pronote_enabled: getSetting('pronote_enabled', 'false') === 'true',
      recipes_enabled: getSetting('recipes_enabled', 'false') === 'true',
      recap_hour: Number(getSetting('recap_hour', '18')),
      reservation_recap_hour: Number(getSetting('reservation_recap_hour', '19')),
      holiday_notice_weeks: Number(getSetting('holiday_notice_weeks', '3')),
      smtp_configured: mailer.configured(),
      public_url: mailer.publicUrl(),
      vapid_public_key: push.publicKey,
    },
  };
}

api.get('/state', (req, res) => {
  const n = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  res.json({ setup_needed: n === 0 });
});

api.post('/setup', (req, res) => {
  if (db.prepare('SELECT COUNT(*) n FROM users').get().n > 0) throw new HttpError(403, "L'installation est déjà faite.");
  const { family_name, name, email, password } = req.body || {};
  if (!name || !email || !password || String(password).length < 8) throw bad('Nom, e-mail et mot de passe (8 caractères minimum) sont requis.');
  const hash = bcrypt.hashSync(String(password), 11);
  const tx = db.transaction(() => {
    const r = db.prepare('INSERT INTO users(name,email,pass_hash,color,is_admin,ical_token) VALUES(?,?,?,?,1,?)')
      .run(String(name).trim().slice(0, 80), String(email).trim(), hash, '#2C3E9F', randToken(24));
    setSetting('family_name', String(family_name || 'Ma famille').trim().slice(0, 80));
    const c = db.prepare('INSERT INTO circles(name,color) VALUES(?,?)').run('Famille', '#17A2A2');
    db.prepare('INSERT INTO circle_members(circle_id,user_id) VALUES(?,?)').run(c.lastInsertRowid, r.lastInsertRowid);
    return r.lastInsertRowid;
  });
  const uid = tx();
  startSession(req, res, uid);
  res.json({ ok: true });
});

api.post('/login', (req, res) => {
  rateLimit(req);
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(email || '').trim());
  const ok = bcrypt.compareSync(String(password || ''), u ? u.pass_hash : '$2a$11$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi');
  if (!u || !ok) throw new HttpError(401, 'E-mail ou mot de passe incorrect.');
  if (!u.claimed) throw new HttpError(401, "Ce compte n'a pas encore été activé : utilisez le lien d'invitation reçu.");
  clearAttempts(req);
  startSession(req, res, u.id);
  res.json({ ok: true });
});

api.post('/logout', (req, res) => {
  const tok = parseCookies(req).mq_session;
  if (tok) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(tok));
  res.setHeader('Set-Cookie', 'mq_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

api.get('/invites/:token', (req, res) => {
  const inv = db.prepare('SELECT name,expires_at,user_id FROM invites WHERE token=?').get(req.params.token);
  if (!inv || !inv.user_id || inv.expires_at < Date.now()) throw new HttpError(404, 'Invitation invalide ou expirée.');
  res.json({ name: inv.name });
});

api.post('/invites/:token/accept', (req, res) => {
  const inv = db.prepare('SELECT * FROM invites WHERE token=?').get(req.params.token);
  if (!inv || !inv.user_id || inv.expires_at < Date.now()) throw new HttpError(404, 'Invitation invalide ou expirée.');
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(inv.user_id);
  if (!user || user.claimed) throw new HttpError(404, 'Invitation invalide ou expirée.');
  const { email, password } = req.body || {};
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) throw bad('E-mail invalide.');
  if (!password || String(password).length < 8) throw bad('Mot de passe : 8 caractères minimum.');
  if (db.prepare('SELECT 1 FROM users WHERE email=? AND id!=?').get(String(email).trim(), user.id)) throw bad('Cet e-mail est déjà utilisé.');
  db.transaction(() => {
    db.prepare('UPDATE users SET email=?, pass_hash=?, claimed=1 WHERE id=?').run(String(email).trim(), bcrypt.hashSync(String(password), 11), user.id);
    db.prepare('DELETE FROM invites WHERE token=?').run(inv.token);
  })();
  startSession(req, res, user.id);
  res.json({ ok: true });
});

/* Tout ce qui suit exige une session valide */
api.use(requireAuth);

api.get('/me', (req, res) => res.json(meState(req.user)));

// L'application vient d'être vue tourner « installée » (écran d'accueil) sur l'un des appareils de cette
// personne : on le retient pour ne plus lui proposer de l'installer dans son navigateur. C'est un repère par
// PERSONNE et non par appareil : un navigateur ne peut pas savoir, depuis un onglet, si l'application est
// installée ailleurs — c'est l'application installée elle-même qui le signale.
api.post('/me/installed', (req, res) => {
  db.prepare('UPDATE users SET app_installed_at=datetime(\'now\') WHERE id=? AND app_installed_at IS NULL').run(req.user.id);
  res.json({ ok: true });
});

api.put('/me', (req, res) => {
  const { name, color, current_password, new_password, email_notify, homework_recap, partner_id } = req.body || {};
  if (name !== undefined) {
    if (!String(name).trim()) throw bad('Le nom ne peut pas être vide.');
    db.prepare('UPDATE users SET name=? WHERE id=?').run(String(name).trim().slice(0, 80), req.user.id);
  }
  if (color !== undefined) {
    if (!HEX.test(color)) throw bad('Couleur invalide.');
    db.prepare('UPDATE users SET color=? WHERE id=?').run(color, req.user.id);
  }
  if (email_notify !== undefined) {
    db.prepare('UPDATE users SET email_notify=? WHERE id=?').run(email_notify ? 1 : 0, req.user.id);
  }
  if (homework_recap !== undefined) {
    db.prepare('UPDATE users SET homework_recap=? WHERE id=?').run(homework_recap ? 1 : 0, req.user.id);
  }
  if (partner_id !== undefined) {
    const pid = partner_id === null || partner_id === '' ? null : Number(partner_id);
    if (pid !== null) {
      if (pid === req.user.id) throw bad('Vous ne pouvez pas vous désigner vous-même.');
      if (!userExists(pid)) throw bad('Personne introuvable.');
    }
    db.prepare('UPDATE users SET partner_id=? WHERE id=?').run(pid, req.user.id);
  }
  if (new_password) {
    if (String(new_password).length < 8) throw bad('Mot de passe : 8 caractères minimum.');
    if (!bcrypt.compareSync(String(current_password || ''), req.user.pass_hash)) throw bad('Mot de passe actuel incorrect.');
    db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(bcrypt.hashSync(String(new_password), 11), req.user.id);
  }
  res.json({ ok: true });
});

// Force immédiatement les vérifications habituellement faites en tâche de fond (rappels
// d'événements et de tâches, récap École) : utile pour vérifier une configuration sans attendre.
api.post('/admin/run-checks', requireAdmin, (req, res) => { tick(); res.json({ ok: true }); });

// Sauvegarde manuelle : une archive .zip avec une copie cohérente de la base (via l'API de backup
// de SQLite, sûre même pendant des écritures en cours) et tous les fichiers envoyés (documents,
// photos du fil familial...). Pas de dépendance au contenu exact de DATA_DIR : si sa structure
// change un jour, cette route n'a pas besoin d'être mise à jour, seuls UPLOAD_DIR et la base le sont.
api.get('/admin/backup', requireAdmin, async (req, res, next) => {
  const tmpDbPath = path.join(os.tmpdir(), `mosaique-backup-${crypto.randomUUID()}.db`);
  try {
    await db.backup(tmpDbPath);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="mosaique-sauvegarde-${stamp}.zip"`);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('warning', (err) => console.error('[backup] avertissement', err));
    archive.on('error', (err) => { try { res.destroy(err); } catch { /* déjà fermée */ } });
    archive.pipe(res);
    archive.file(tmpDbPath, { name: 'mosaique.db' });
    if (fs.existsSync(UPLOAD_DIR)) archive.directory(UPLOAD_DIR, 'uploads');
    await archive.finalize();
  } catch (err) {
    next(err);
  } finally {
    fs.unlink(tmpDbPath, () => {});
  }
});

api.get('/settings/public-url', requireAdmin, (req, res) => {
  res.json(appUrl.publicUrlInfo());
});

api.put('/settings/public-url', requireAdmin, (req, res) => {
  try { appUrl.savePublicUrl((req.body || {}).url); } catch (e) { throw new HttpError(e.status || 400, e.message); }
  res.json(appUrl.publicUrlInfo());
});

api.delete('/settings/public-url', requireAdmin, (req, res) => {
  appUrl.savePublicUrl(null);
  res.json(appUrl.publicUrlInfo());
});

api.get('/settings/smtp', requireAdmin, (req, res) => {
  res.json(mailer.publicConfig());
});

api.put('/settings/smtp', requireAdmin, (req, res) => {
  const { host, port, user, pass, from, secure } = req.body || {};
  if (host !== undefined && !String(host).trim()) throw bad('Adresse du serveur requise.');
  if (port !== undefined && (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535)) throw bad('Port invalide.');
  mailer.saveConfig({ host, port, user, pass, from, secure });
  res.json(mailer.publicConfig());
});

api.delete('/settings/smtp', requireAdmin, (req, res) => {
  mailer.clearConfig();
  res.json(mailer.publicConfig());
});

api.post('/me/test-email', async (req, res) => {
  if (!mailer.configured()) throw bad("Aucun serveur SMTP n'est configuré sur ce serveur.");
  const r = await mailer.sendMail({ to: req.user.email, subject: 'Mosaïque — e-mail de test', text: `Bonjour ${req.user.name},\n\nSi vous lisez ce message, les notifications par e-mail sont correctement configurées sur votre espace Mosaïque.` });
  if (!r.ok) throw new HttpError(502, `Échec de l'envoi : ${r.error}`);
  res.json({ ok: true });
});

api.post('/push/subscribe', (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) throw bad('Abonnement incomplet.');
  db.prepare(`INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth) VALUES(?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth`)
    .run(req.user.id, String(endpoint).slice(0, 500), String(keys.p256dh).slice(0, 200), String(keys.auth).slice(0, 200));
  res.json({ ok: true });
});

api.post('/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) db.prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?').run(String(endpoint), req.user.id);
  res.json({ ok: true });
});

api.post('/push/test', async (req, res) => {
  const n = db.prepare('SELECT COUNT(*) n FROM push_subscriptions WHERE user_id=?').get(req.user.id).n;
  if (!n) throw bad("Aucun appareil abonné aux notifications push pour votre compte.");
  const r = await push.sendPush(req.user.id, { title: 'Mosaïque — notification de test', body: 'Si vous voyez ceci, les notifications push fonctionnent.', link: '/' });
  if (r.errors.length) {
    const e = r.errors[0];
    const detail = [e.status ? `code ${e.status}` : null, e.message, e.body ? `— ${String(e.body).slice(0, 200)}` : null].filter(Boolean).join(' ');
    throw new HttpError(502, `Échec de l'envoi vers ${r.errors.length}/${r.total} appareil(s) : ${detail}`);
  }
  res.json({ ok: true, sent: r.sent });
});

api.post('/me/ical-token', (req, res) => {
  const t = randToken(24);
  db.prepare('UPDATE users SET ical_token=? WHERE id=?').run(t, req.user.id);
  res.json({ ical_token: t });
});

/* ── Administration : réglages, membres, cercles, enfants ── */
api.put('/settings', requireAdmin, (req, res) => {
  const { family_name, fil_familial, messages_enabled, courses_enabled, pronote_enabled, recap_hour, recipes_enabled, reservation_recap_hour, holiday_notice_weeks } = req.body || {};
  if (family_name !== undefined) setSetting('family_name', String(family_name).trim().slice(0, 80) || 'Ma famille');
  if (fil_familial !== undefined) setSetting('fil_familial', fil_familial ? 'true' : 'false');
  if (messages_enabled !== undefined) setSetting('messages_enabled', messages_enabled ? 'true' : 'false');
  if (courses_enabled !== undefined) setSetting('courses_enabled', courses_enabled ? 'true' : 'false');
  if (pronote_enabled !== undefined) setSetting('pronote_enabled', pronote_enabled ? 'true' : 'false');
  if (recipes_enabled !== undefined) setSetting('recipes_enabled', recipes_enabled ? 'true' : 'false');
  if (recap_hour !== undefined) {
    const h = Number(recap_hour);
    if (!Number.isInteger(h) || h < 0 || h > 23) throw bad('Heure invalide.');
    setSetting('recap_hour', String(h));
  }
  // Rappel du jeudi soir (réservations périscolaires de la semaine suivante) : heure d'envoi.
  if (reservation_recap_hour !== undefined) {
    const h = Number(reservation_recap_hour);
    if (!Number.isInteger(h) || h < 0 || h > 23) throw bad('Heure invalide.');
    setSetting('reservation_recap_hour', String(h));
  }
  // Notification « vacances réservables » : combien de semaines avant le début des prochaines
  // vacances on estime que les réservations ouvrent (le portail ne permet pas de le savoir avec
  // certitude sans tenter une vraie réservation — voir server/addons/README.md).
  if (holiday_notice_weeks !== undefined) {
    const w = Number(holiday_notice_weeks);
    if (!Number.isInteger(w) || w < 1 || w > 12) throw bad('Nombre de semaines invalide.');
    setSetting('holiday_notice_weeks', String(w));
  }
  res.json({ ok: true });
});

api.post('/invites', requireAdmin, (req, res) => {
  const { name, is_admin, circle_ids, color } = req.body || {};
  if (!name || !String(name).trim()) throw bad('Le prénom est requis.');
  const ids = (Array.isArray(circle_ids) ? circle_ids : []).map(Number).filter(Number.isInteger);
  const finalName = String(name).trim().slice(0, 80);
  const finalColor = HEX.test(color || '') ? color : '#2A3EB1';
  const token = randToken(24);
  const tx = db.transaction(() => {
    // Compte créé tout de suite (email provisoire, mot de passe inutilisable) : la personne est
    // immédiatement utilisable partout (cercles, garde, tâches...) avant même d'avoir cliqué le lien.
    const placeholderEmail = `invite+${randToken(10).toLowerCase()}@mosaique.local`;
    const placeholderHash = bcrypt.hashSync(randToken(24), 11);
    const u = db.prepare('INSERT INTO users(name,email,pass_hash,color,is_admin,ical_token,claimed) VALUES(?,?,?,?,?,?,0)')
      .run(finalName, placeholderEmail, placeholderHash, finalColor, is_admin ? 1 : 0, randToken(24));
    for (const cid of ids) {
      if (db.prepare('SELECT 1 FROM circles WHERE id=?').get(cid)) db.prepare('INSERT OR IGNORE INTO circle_members(circle_id,user_id) VALUES(?,?)').run(cid, u.lastInsertRowid);
    }
    db.prepare('INSERT INTO invites(token,name,user_id,expires_at) VALUES(?,?,?,?)').run(token, finalName, u.lastInsertRowid, Date.now() + 7 * 86400000);
    return u.lastInsertRowid;
  });
  const userId = tx();
  res.json({ token, user_id: userId });
});

api.post('/users/:id/reinvite', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) throw new HttpError(404, 'Introuvable.');
  if (u.claimed) throw bad('Ce membre a déjà activé son compte.');
  const token = randToken(24);
  db.transaction(() => {
    db.prepare('DELETE FROM invites WHERE user_id=?').run(id);
    db.prepare('INSERT INTO invites(token,name,user_id,expires_at) VALUES(?,?,?,?)').run(token, u.name, id, Date.now() + 7 * 86400000);
  })();
  res.json({ token });
});

api.delete('/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) throw bad('Vous ne pouvez pas supprimer votre propre compte.');
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  res.json({ ok: true });
});

api.put('/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!target) throw new HttpError(404, 'Introuvable.');
  if (target.claimed) throw bad('Ce membre a activé son compte : seule la personne concernée peut modifier ces informations, depuis Réglages.');
  const { name, color } = req.body || {};
  if (name !== undefined) {
    if (!String(name).trim()) throw bad('Le prénom est requis.');
    db.prepare('UPDATE users SET name=? WHERE id=?').run(String(name).trim().slice(0, 80), id);
  }
  if (color !== undefined) {
    if (!HEX.test(color)) throw bad('Couleur invalide.');
    db.prepare('UPDATE users SET color=? WHERE id=?').run(color, id);
  }
  res.json({ ok: true });
});

api.put('/users/:id/password', requireAdmin, (req, res) => {
  const { password } = req.body || {};
  if (!password || String(password).length < 8) throw bad('Mot de passe : 8 caractères minimum.');
  const r = db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(bcrypt.hashSync(String(password), 11), Number(req.params.id));
  if (!r.changes) throw new HttpError(404, 'Utilisateur introuvable.');
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(Number(req.params.id));
  res.json({ ok: true });
});

api.put('/users/:id/admin', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) throw bad('Vous ne pouvez pas modifier votre propre rôle.');
  db.prepare('UPDATE users SET is_admin=? WHERE id=?').run(req.body && req.body.is_admin ? 1 : 0, id);
  res.json({ ok: true });
});

api.post('/circles', requireAdmin, (req, res) => {
  const { name, color, member_ids } = req.body || {};
  if (!name || !String(name).trim()) throw bad('Le nom du cercle est requis.');
  const tx = db.transaction(() => {
    const r = db.prepare('INSERT INTO circles(name,color) VALUES(?,?)').run(String(name).trim().slice(0, 60), HEX.test(color || '') ? color : '#17A2A2');
    for (const u of (member_ids || []).map(Number)) if (userExists(u)) db.prepare('INSERT OR IGNORE INTO circle_members VALUES(?,?)').run(r.lastInsertRowid, u);
    return r.lastInsertRowid;
  });
  res.json({ id: tx() });
});

api.put('/circles/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const { name, color, member_ids } = req.body || {};
  const tx = db.transaction(() => {
    if (name !== undefined) db.prepare('UPDATE circles SET name=? WHERE id=?').run(String(name).trim().slice(0, 60), id);
    if (color !== undefined && HEX.test(color)) db.prepare('UPDATE circles SET color=? WHERE id=?').run(color, id);
    if (Array.isArray(member_ids)) {
      db.prepare('DELETE FROM circle_members WHERE circle_id=?').run(id);
      for (const u of member_ids.map(Number)) if (userExists(u)) db.prepare('INSERT OR IGNORE INTO circle_members VALUES(?,?)').run(id, u);
    }
  });
  tx();
  res.json({ ok: true });
});

api.delete('/circles/:id', requireAdmin, (req, res) => {
  if (db.prepare('SELECT COUNT(*) n FROM circles').get().n <= 1) throw bad('Il faut conserver au moins un cercle.');
  const id = Number(req.params.id);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM circles WHERE id=?').run(id);
    // Les contacts n'ont pas de clé étrangère sur circle_id (ils peuvent être dans plusieurs cercles) :
    // on retire ce cercle de leur liste à la main, et on ne supprime le contact que s'il n'en reste aucun.
    for (const row of db.prepare('SELECT id, circle_ids FROM contacts').all()) {
      const remaining = parseJ(row.circle_ids, []).filter((cid) => cid !== id);
      if (!remaining.length) db.prepare('DELETE FROM contacts WHERE id=?').run(row.id);
      else db.prepare('UPDATE contacts SET circle_ids=? WHERE id=?').run(JSON.stringify(remaining), row.id);
    }
  });
  tx();
  res.json({ ok: true });
});

function validateParentIds(arr) {
  if (!Array.isArray(arr)) throw bad('Liste de parents invalide.');
  const ids = [...new Set(arr.map(Number).filter(Number.isInteger))];
  if (!ids.every(userExists)) throw bad('Un des parents désignés est introuvable.');
  return ids;
}

function colorTakenByAnotherChild(color, exceptId) {
  const row = db.prepare('SELECT id FROM children WHERE color=? COLLATE NOCASE AND id!=?').get(color, exceptId || -1);
  return !!row;
}

const validTime = (s) => /^\d{2}:\d{2}$/.test(s) && +s.slice(0, 2) < 24 && +s.slice(3) < 60;
const BLOOD_TYPES = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

api.post('/children', (req, res) => {
  const { name, color, birthdate, parent_ids, viewer_ids, zone, shared_custody, handover_location, handover_time, blood_type, allergies, doctor_name, doctor_phone } = req.body || {};
  if (!name || !String(name).trim()) throw bad('Le prénom est requis.');
  if (birthdate && !validDate(birthdate)) throw bad('Date de naissance invalide.');
  if (handover_time && !validTime(handover_time)) throw bad('Heure de transition invalide.');
  if (blood_type && !BLOOD_TYPES.includes(blood_type)) throw bad('Groupe sanguin invalide.');
  const finalColor = HEX.test(color || '') ? color : '#E4572E';
  if (colorTakenByAnotherChild(finalColor, null)) throw bad('Cette couleur est déjà utilisée par un autre enfant.');
  const finalZone = ['A', 'B', 'C'].includes(zone) ? zone : 'B';
  const finalShared = shared_custody === undefined ? 1 : (shared_custody ? 1 : 0);
  let pids = []; let vids = [];
  if (parent_ids !== undefined || viewer_ids !== undefined) {
    if (!req.user.is_admin) throw new HttpError(403, "Seul un administrateur peut désigner les parents ou lecteurs d'un enfant.");
    if (parent_ids !== undefined) pids = validateParentIds(parent_ids);
    if (viewer_ids !== undefined) vids = validateParentIds(viewer_ids);
  }
  const r = db.prepare('INSERT INTO children(name,color,birthdate,parent_ids,viewer_ids,zone,shared_custody,handover_location,handover_time,blood_type,allergies,doctor_name,doctor_phone) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(String(name).trim().slice(0, 60), finalColor, birthdate || null, JSON.stringify(pids), JSON.stringify(vids), finalZone, finalShared,
      handover_location ? String(handover_location).trim().slice(0, 200) : null, handover_time || null,
      blood_type || null, allergies ? String(allergies).trim().slice(0, 1000) : null,
      doctor_name ? String(doctor_name).trim().slice(0, 200) : null, doctor_phone ? String(doctor_phone).trim().slice(0, 50) : null);
  res.json({ id: r.lastInsertRowid });
});
api.put('/children/:id', (req, res) => {
  const { name, color, birthdate, parent_ids, viewer_ids, zone, shared_custody, handover_location, handover_time, blood_type, allergies, doctor_name, doctor_phone } = req.body || {};
  const id = Number(req.params.id);
  if (name !== undefined) db.prepare('UPDATE children SET name=? WHERE id=?').run(String(name).trim().slice(0, 60), id);
  if (color !== undefined && HEX.test(color)) {
    if (colorTakenByAnotherChild(color, id)) throw bad('Cette couleur est déjà utilisée par un autre enfant.');
    db.prepare('UPDATE children SET color=? WHERE id=?').run(color, id);
  }
  if (birthdate !== undefined) {
    if (birthdate && !validDate(birthdate)) throw bad('Date de naissance invalide.');
    db.prepare('UPDATE children SET birthdate=? WHERE id=?').run(birthdate || null, id);
  }
  if (zone !== undefined) {
    if (!['A', 'B', 'C'].includes(zone)) throw bad('Zone scolaire invalide.');
    db.prepare('UPDATE children SET zone=? WHERE id=?').run(zone, id);
  }
  if (shared_custody !== undefined) {
    db.prepare('UPDATE children SET shared_custody=? WHERE id=?').run(shared_custody ? 1 : 0, id);
  }
  if (handover_location !== undefined) {
    db.prepare('UPDATE children SET handover_location=? WHERE id=?').run(handover_location ? String(handover_location).trim().slice(0, 200) : null, id);
  }
  if (handover_time !== undefined) {
    if (handover_time && !validTime(handover_time)) throw bad('Heure de transition invalide.');
    db.prepare('UPDATE children SET handover_time=? WHERE id=?').run(handover_time || null, id);
  }
  if (parent_ids !== undefined) {
    if (!req.user.is_admin) throw new HttpError(403, "Seul un administrateur peut désigner les parents d'un enfant.");
    db.prepare('UPDATE children SET parent_ids=? WHERE id=?').run(JSON.stringify(validateParentIds(parent_ids)), id);
  }
  if (viewer_ids !== undefined) {
    if (!req.user.is_admin) throw new HttpError(403, "Seul un administrateur peut désigner les lecteurs d'un enfant.");
    db.prepare('UPDATE children SET viewer_ids=? WHERE id=?').run(JSON.stringify(validateParentIds(viewer_ids)), id);
  }
  if (blood_type !== undefined) {
    if (blood_type && !BLOOD_TYPES.includes(blood_type)) throw bad('Groupe sanguin invalide.');
    db.prepare('UPDATE children SET blood_type=? WHERE id=?').run(blood_type || null, id);
  }
  if (allergies !== undefined) {
    db.prepare('UPDATE children SET allergies=? WHERE id=?').run(allergies ? String(allergies).trim().slice(0, 1000) : null, id);
  }
  if (doctor_name !== undefined) {
    db.prepare('UPDATE children SET doctor_name=? WHERE id=?').run(doctor_name ? String(doctor_name).trim().slice(0, 200) : null, id);
  }
  if (doctor_phone !== undefined) {
    db.prepare('UPDATE children SET doctor_phone=? WHERE id=?').run(doctor_phone ? String(doctor_phone).trim().slice(0, 50) : null, id);
  }
  res.json({ ok: true });
});
api.delete('/children/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM children WHERE id=?').run(Number(req.params.id));
  res.json({ ok: true });
});

/* ───────────────────────── Ressources par cercle (CRUD générique) ───────────────────────── */
function coerce(type, v, label) {
  const optional = type.endsWith('?');
  const t = optional ? type.slice(0, -1) : type;
  const empty = v === undefined || v === null || v === '';
  if (empty) {
    if (optional) return null;
    if (t === 'b') return 0;
    if (t === 'ids') return '[]';
    if (t === 'ingredients') return '[]';
    if (t === 'rep') return 'none';
    if (t === 'ownermode') return 'manual';
    throw bad(`Champ requis : ${label}.`);
  }
  switch (t) {
    case 's': { const s = String(v).trim(); if (!s) { if (optional) return null; throw bad(`Champ requis : ${label}.`); } return s.slice(0, 500); }
    case 'text': return String(v).trim().slice(0, 4000);
    case 'i': { const n = Number(v); if (!Number.isInteger(n)) throw bad(`Valeur invalide : ${label}.`); return n; }
    case 'f': { const n = Number(v); if (!Number.isFinite(n)) throw bad(`Valeur invalide : ${label}.`); return n; }
    case 'b': return v ? 1 : 0;
    case 'd': if (!validDate(v)) throw bad(`Date invalide : ${label}.`); return v;
    case 'dt': if (!validDateTime(v)) throw bad(`Date invalide : ${label}.`); return v;
    case 'cents': { const n = Number(v); if (!Number.isInteger(n) || n <= 0 || n > 100000000) throw bad('Montant invalide.'); return n; }
    case 'rep': if (!['none', 'daily', 'weekly', 'monthly', 'yearly'].includes(v)) throw bad('Répétition invalide.'); return v;
    case 'exprep': if (!EXPENSE_REPEATS.includes(v)) throw bad('Fréquence invalide.'); return v;
    case 'ownermode': { const om = v || 'manual'; if (!['manual', 'auto'].includes(om)) throw bad('Mode de responsable invalide.'); return om; }
    case 'ids': {
      if (!Array.isArray(v)) throw bad(`Valeur invalide : ${label}.`);
      return JSON.stringify(v.map(Number).filter(Number.isInteger));
    }
    case 'split': {
      if (typeof v !== 'object' || Array.isArray(v)) throw bad('Répartition invalide.');
      let total = 0;
      for (const [uid, pct] of Object.entries(v)) {
        if (!userExists(Number(uid)) || typeof pct !== 'number' || pct < 0) throw bad('Répartition invalide.');
        total += pct;
      }
      if (Math.abs(total - 100) > 0.01 || !Object.keys(v).length) throw bad('La répartition doit totaliser 100 %.');
      return JSON.stringify(v);
    }
    case 'ingredients': {
      if (!Array.isArray(v)) throw bad('Liste d\'ingrédients invalide.');
      const list = v.map((ing) => ({
        name: String((ing && ing.name) || '').trim().slice(0, 100),
        amount: ing && ing.amount !== undefined && ing.amount !== null && ing.amount !== '' ? Number(ing.amount) : null,
        unit: ing && ing.unit ? String(ing.unit).trim().slice(0, 20) : null,
        category: (ing && ing.category && GROCERY_CATEGORIES.includes(ing.category)) ? ing.category : 'Autre',
      })).filter((ing) => ing.name);
      return JSON.stringify(list);
    }
    default: throw new Error('type inconnu ' + t);
  }
}

function mountResource(name, table, spec, hooks = {}) {
  const cols = Object.keys(spec);
  const decode = hooks.decode || ((r) => r);

  api.get(`/${name}`, (req, res) => {
    const circles = myCircles(req.user.id);
    let rows = db.prepare(`SELECT * FROM ${table} WHERE circle_id IN (${placeholders(circles)}) ${hooks.order || 'ORDER BY id DESC'}`).all(...circles);
    if (hooks.filter) rows = hooks.filter(rows, req);
    res.json(rows.map(decode));
  });

  api.post(`/${name}`, (req, res) => {
    const b = req.body || {};
    const circleId = requireMember(req.user, b.circle_id);
    const values = cols.map((c) => coerce(spec[c], b[c], c));
    if (hooks.validate) hooks.validate({ circle_id: circleId, ...Object.fromEntries(cols.map((c, i) => [c, values[i]])) }, req);
    const r = db.prepare(`INSERT INTO ${table}(circle_id,${cols.join(',')},created_by) VALUES(?,${cols.map(() => '?').join(',')},?)`)
      .run(circleId, ...values, req.user.id);
    const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(r.lastInsertRowid);
    if (hooks.afterCreate) hooks.afterCreate(row, req);
    emitTo(circleMemberIds(circleId), { type: 'refresh', what: name });
    res.json(decode(row));
  });

  api.put(`/${name}/:id`, (req, res) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(Number(req.params.id));
    if (!row) throw new HttpError(404, 'Introuvable.');
    requireMember(req.user, row.circle_id);
    const b = req.body || {};
    const sets = []; const vals = [];
    for (const c of cols) {
      if (b[c] !== undefined) { sets.push(`${c}=?`); vals.push(coerce(spec[c], b[c], c)); }
    }
    if (b.circle_id !== undefined && Number(b.circle_id) !== row.circle_id) {
      sets.push('circle_id=?'); vals.push(requireMember(req.user, b.circle_id));
    }
    if (hooks.beforeUpdate) hooks.beforeUpdate(row, b, sets, vals, req);
    if (sets.length) db.prepare(`UPDATE ${table} SET ${sets.join(',')} WHERE id=?`).run(...vals, row.id);
    const updated = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(row.id);
    if (hooks.afterUpdate) hooks.afterUpdate(row, updated, req);
    emitTo(circleMemberIds(updated.circle_id), { type: 'refresh', what: name });
    res.json(decode(updated));
  });

  api.delete(`/${name}/:id`, (req, res, next) => {
    if (req.params.id === 'done') return next();
    const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(Number(req.params.id));
    if (!row) throw new HttpError(404, 'Introuvable.');
    requireMember(req.user, row.circle_id);
    if (hooks.beforeDelete) hooks.beforeDelete(row, req);
    db.prepare(`DELETE FROM ${table} WHERE id=?`).run(row.id);
    emitTo(circleMemberIds(row.circle_id), { type: 'refresh', what: name });
    res.json({ ok: true });
  });
}

/* ───────────────────────── Aides communes budget / événements ───────────────────────── */
// Répartition en pourcentages, égale entre les personnes données, dont le total fait exactement 100.
function equalSplit(ids) {
  const n = ids.length; const base = Math.floor(1000 / n); const out = {};
  ids.forEach((id, i) => { out[id] = (i === n - 1 ? 1000 - base * (n - 1) : base) / 10; });
  return out;
}
// Règle commune aux dépenses ponctuelles, récurrentes et issues d'un événement : si l'enfant
// concerné a des parents désignés, eux seuls se partagent la dépense (un beau-parent peut avoir
// payé et être remboursé sans faire partie du partage). Sans parent désigné, tout le cercle reste éligible.
function assertSplitAllowed(childId, split) {
  if (childId === null || childId === undefined) return;
  const child = db.prepare('SELECT * FROM children WHERE id=?').get(childId);
  if (!child) throw bad('Enfant introuvable.');
  const parentIds = parseJ(child.parent_ids, []);
  if (parentIds.length && !Object.keys(split).map(Number).every((id) => parentIds.includes(id))) {
    throw bad('Seuls les parents désignés de cet enfant peuvent faire partie de la répartition.');
  }
}
// Seule la personne qui a créé une dépense (ou un remboursement...) peut la modifier ou la supprimer.
// Exception de secours : un administrateur, si le créateur n'existe plus (ou n'est pas connu).
function canModifyOwn(user, row) {
  return row.created_by === user.id || (!!user.is_admin && (row.created_by == null || !userExists(row.created_by)));
}
const ownOnly = (what) => new HttpError(403, `Seule la personne qui a créé ${what} peut la modifier ou la supprimer.`);
function dropExpenseDocument(row) {
  if (!row.document_id) return;
  const doc = db.prepare('SELECT * FROM documents WHERE id=?').get(row.document_id);
  if (doc) { db.prepare('DELETE FROM documents WHERE id=?').run(doc.id); rmFile(doc.stored_name); }
}

// Prix d'un événement → dépense dans Budget. Les personnes qui se la partagent : les parents désignés
// du premier enfant concerné s'il en a, sinon tout le cercle. Celui qui renseigne le prix est le payeur
// par défaut ; le partage et le payeur restent modifiables ensuite depuis Budget (par ce même créateur).
function participantsForEvent(ev) {
  const members = circleMemberIds(ev.circle_id);
  const childId = parseJ(ev.child_ids, [])[0];
  const child = childId ? db.prepare('SELECT * FROM children WHERE id=?').get(childId) : null;
  const parents = child ? parseJ(child.parent_ids, []).filter((id) => members.includes(id)) : [];
  return parents.length ? parents : members;
}
function createExpenseForEvent(ev, userId) {
  const childId = parseJ(ev.child_ids, [])[0] ?? null;
  const payer = ev.price_paid_by ?? userId; // le payeur est choisi dans le formulaire ; à défaut, celui qui saisit le prix
  db.prepare('INSERT INTO expenses(circle_id,title,amount_cents,category,date,paid_by,split,child_id,event_id,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(ev.circle_id, ev.title, ev.price_cents, EXPENSE_CATEGORY_FOR_EVENT[ev.category] || 'Autre', ev.starts_at.slice(0, 10), payer,
      JSON.stringify(equalSplit(participantsForEvent(ev))), childId, ev.id, userId);
  if (ev.price_paid_by == null) db.prepare('UPDATE events SET price_paid_by=? WHERE id=?').run(payer, ev.id);
}
function syncEventExpense(before, after, userId) {
  const linked = db.prepare('SELECT * FROM expenses WHERE event_id=?').get(after.id);
  if (after.price_cents === null) {
    if (linked) { dropExpenseDocument(linked); db.prepare('DELETE FROM expenses WHERE id=?').run(linked.id); }
    if (after.price_paid_by !== null) db.prepare('UPDATE events SET price_paid_by=NULL WHERE id=?').run(after.id);
  } else if (!linked) {
    createExpenseForEvent(after, userId);
  } else {
    // On ne répercute que ce qui a réellement changé sur l'événement, pour ne pas écraser ce qui a
    // été ajusté à la main dans Budget (payeur, partage, catégorie...).
    const sets = []; const vals = [];
    const push = (col, val) => { sets.push(`${col}=?`); vals.push(val); };
    if (before.price_cents !== after.price_cents) push('amount_cents', after.price_cents);
    if (after.price_paid_by !== null && before.price_paid_by !== after.price_paid_by) push('paid_by', after.price_paid_by);
    if (before.title !== after.title) push('title', after.title);
    if (before.starts_at.slice(0, 10) !== after.starts_at.slice(0, 10)) push('date', after.starts_at.slice(0, 10));
    if (before.category !== after.category) push('category', EXPENSE_CATEGORY_FOR_EVENT[after.category] || 'Autre');
    if ((parseJ(before.child_ids, [])[0] ?? null) !== (parseJ(after.child_ids, [])[0] ?? null)) {
      push('child_id', parseJ(after.child_ids, [])[0] ?? null);
      push('split', JSON.stringify(equalSplit(participantsForEvent(after))));
    }
    if (sets.length) db.prepare(`UPDATE expenses SET ${sets.join(',')} WHERE id=?`).run(...vals, linked.id);
  }
  emitTo(circleMemberIds(after.circle_id), { type: 'refresh', what: 'expenses' });
}

// Facture périscolaire (reçue par addon, voir applyAddonResult) → dépense partagée dans Budget,
// une fois attribuée à la personne qui l'a payée. Partage égal entre tout le cercle. Si la facture a
// été rattachée à un enfant (child_id — utile dès qu'on en suit plusieurs), la dépense créée reprend
// le même enfant. Tant que ce n'est pas fait, la facture reste « en attente » (voir
// /invoices/:id/assign) et n'entre pas dans les comptes.
function createExpenseForInvoice(inv, payerId, date, userId) {
  const members = circleMemberIds(inv.circle_id);
  const r = db.prepare('INSERT INTO expenses(circle_id,title,amount_cents,category,date,paid_by,split,child_id,created_by) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(inv.circle_id, `${inv.label} — ${inv.number}`, inv.amount_cents, 'Cantine', date, payerId, JSON.stringify(equalSplit(members)), inv.child_id || null, userId);
  db.prepare('UPDATE invoices SET assigned_to=?, expense_id=? WHERE id=?').run(payerId, r.lastInsertRowid, inv.id);
  emitTo(members, { type: 'refresh', what: 'expenses' });
  return r.lastInsertRowid;
}

// Qui doit être prévenu pour un événement donné : le responsable désigné (manuel, ou déterminé par
// la garde du jour en mode auto) plus, s'ils sont différents, les personnes chargées du dépôt et/ou
// de la récupération (covoiturage, SOS ponctuel) ; sans responsable identifiable, tout le cercle.
// Utilisé à la création, à la modification et pour les rappels, afin que ces trois cas restent cohérents.
function eventNotifyTargets(row) {
  let ownerId = row.owner_id;
  if (row.owner_mode === 'auto') {
    const childIds = parseJ(row.child_ids, []);
    if (childIds.length) {
      const night = db.prepare('SELECT parent_id FROM custody_nights WHERE child_id=? AND date=?').get(childIds[0], row.starts_at.slice(0, 10));
      ownerId = night ? night.parent_id : null;
    }
  }
  const extra = [row.dropoff_by, row.pickup_by].filter(Boolean);
  return (ownerId || extra.length) ? [...new Set([ownerId, ...extra].filter(Boolean))] : circleMemberIds(row.circle_id);
}

/* Événements */
mountResource('events', 'events', {
  title: 's', starts_at: 'dt', ends_at: 'dt?', all_day: 'b', location: 's?', location_lat: 'f?', location_lon: 'f?', notes: 'text?',
  owner_id: 'i?', owner_mode: 'ownermode', child_ids: 'ids', repeat: 'rep', repeat_until: 'd?', reminder_minutes: 'i?',
  category: 's?', price_cents: 'cents?', price_paid_by: 'i?', dropoff_by: 'i?', pickup_by: 'i?',
}, {
  order: 'ORDER BY starts_at',
  decode: (r) => ({ ...r, child_ids: parseJ(r.child_ids, []) }),
  filter: (rows, req) => rows.filter((r) => visibleForChildren(req.user, r.child_ids)),
  beforeUpdate: (row, b, sets, vals, req) => {
    if (!editableForChildren(req.user, row.child_ids)) throw new HttpError(403, "Vous n'avez qu'un accès en lecture à un des enfants de cet événement.");
    // Le lieu a été retapé à la main sans reprendre de suggestion : les anciennes coordonnées ne
    // correspondent plus forcément, mieux vaut les oublier plutôt que garder un itinéraire erroné.
    if (b.location !== undefined && b.location_lat === undefined) { sets.push('location_lat=?', 'location_lon=?'); vals.push(null, null); }
    if (b.child_ids !== undefined) {
      const ids = Array.isArray(b.child_ids) ? b.child_ids.map(Number).filter(Number.isInteger) : [];
      if (!ids.every((id) => canEditChild(req.user, id))) throw new HttpError(403, "Vous n'avez qu'un accès en lecture à un des enfants sélectionnés.");
    }
    // La date/heure, la répétition ou le délai de rappel ont changé : on oublie les rappels déjà
    // envoyés pour laisser le nouveau réglage s'appliquer normalement (plutôt que rester bloqué,
    // ou au contraire renvoyer aussitôt un rappel pour un horaire déjà passé).
    if (b.starts_at !== undefined || b.repeat !== undefined || b.reminder_minutes !== undefined) {
      db.prepare('DELETE FROM event_reminders_sent WHERE event_id=?').run(row.id);
    }
    // Catégorie et prix : le prix crée/alimente une dépense dans Budget, donc seul le créateur de
    // l'événement peut le poser, le changer ou le retirer (comme pour toute dépense).
    if (b.category !== undefined && b.category !== null && b.category !== '' && !EVENT_CATEGORIES.includes(b.category)) throw bad('Catégorie invalide.');
    const nextPrice = b.price_cents !== undefined ? ((b.price_cents === null || b.price_cents === '') ? null : Number(b.price_cents)) : row.price_cents;
    const nextPayer = b.price_paid_by !== undefined ? ((b.price_paid_by === null || b.price_paid_by === '') ? null : Number(b.price_paid_by)) : row.price_paid_by;
    if (nextPayer !== null && !circleMemberIds(row.circle_id).includes(nextPayer)) throw bad('Le payeur doit faire partie du cercle.');
    if ((nextPrice !== row.price_cents || nextPayer !== row.price_paid_by) && !canModifyOwn(req.user, row)) throw new HttpError(403, "Seule la personne qui a créé cet événement peut modifier son prix ou son payeur.");
    if (nextPrice !== null && (b.repeat !== undefined ? b.repeat : row.repeat) !== 'none') throw bad(EVENT_PRICE_REPEAT_MSG);
    // Dépôt/récupération par quelqu'un d'autre que le responsable habituel (ex. : covoiturage, SOS
    // ponctuel) : la personne désignée doit tout de même faire partie du cercle de l'événement.
    const nextDropoff = b.dropoff_by !== undefined ? ((b.dropoff_by === null || b.dropoff_by === '') ? null : Number(b.dropoff_by)) : row.dropoff_by;
    const nextPickup = b.pickup_by !== undefined ? ((b.pickup_by === null || b.pickup_by === '') ? null : Number(b.pickup_by)) : row.pickup_by;
    if (nextDropoff !== null && !circleMemberIds(row.circle_id).includes(nextDropoff)) throw bad('La personne qui amène doit faire partie du cercle.');
    if (nextPickup !== null && !circleMemberIds(row.circle_id).includes(nextPickup)) throw bad('La personne qui récupère doit faire partie du cercle.');
  },
  afterUpdate: (before, after, req) => {
    syncEventExpense(before, after, req.user.id);
    // Seuls les changements qui concernent vraiment « qui doit s'en occuper » notifient : les autres
    // champs (notes, catégorie, prix...) n'intéressent pas forcément tout le monde à chaque retouche.
    const RELEVANT = ['starts_at', 'location', 'all_day', 'owner_id', 'owner_mode', 'dropoff_by', 'pickup_by'];
    if (RELEVANT.some((k) => before[k] !== after[k])) {
      notify(eventNotifyTargets(after), {
        kind: 'event', title: `Événement modifié : ${after.title}`, body: after.starts_at.replace('T', ' à '), link: '#/agenda',
      }, req.user.id);
    }
  },
  beforeDelete: (row, req) => {
    if (!editableForChildren(req.user, row.child_ids)) throw new HttpError(403, "Vous n'avez qu'un accès en lecture à un des enfants de cet événement.");
  },
  validate: (v, req) => {
    if (v.ends_at && v.ends_at < v.starts_at) throw bad("La fin doit être après le début.");
    if (!editableForChildren(req.user, v.child_ids)) throw new HttpError(403, "Vous n'avez qu'un accès en lecture à un des enfants sélectionnés.");
    if (v.reminder_minutes !== null && (v.reminder_minutes < 0 || v.reminder_minutes > 43200)) throw bad('Délai de rappel invalide.');
    if (v.category !== null && !EVENT_CATEGORIES.includes(v.category)) throw bad('Catégorie invalide.');
    if (v.price_cents !== null && v.repeat !== 'none') throw bad(EVENT_PRICE_REPEAT_MSG);
    if (v.price_paid_by !== null && !circleMemberIds(Number((req.body || {}).circle_id)).includes(v.price_paid_by)) throw bad('Le payeur doit faire partie du cercle.');
    if (v.dropoff_by !== null && !circleMemberIds(v.circle_id).includes(v.dropoff_by)) throw bad('La personne qui amène doit faire partie du cercle.');
    if (v.pickup_by !== null && !circleMemberIds(v.circle_id).includes(v.pickup_by)) throw bad('La personne qui récupère doit faire partie du cercle.');
  },
  afterCreate: (row, req) => {
    if (row.price_cents) syncEventExpense({ ...row, price_cents: null }, row, req.user.id);
    notify(eventNotifyTargets(row), {
      kind: 'event', title: `Nouvel événement : ${row.title}`, body: row.starts_at.replace('T', ' à '), link: '#/agenda',
    }, req.user.id);
  },
});

// Supprime uniquement une occurrence d'un événement récurrent (l'ajoute à sa liste de dates
// exclues), sans toucher au reste de la série. Pour un événement non récurrent, autant utiliser
// la suppression normale (DELETE /events/:id).
api.post('/events/:id/exclude', (req, res) => {
  const row = db.prepare('SELECT * FROM events WHERE id=?').get(Number(req.params.id));
  if (!row) throw new HttpError(404, 'Introuvable.');
  requireMember(req.user, row.circle_id);
  if (!editableForChildren(req.user, row.child_ids)) throw new HttpError(403, "Vous n'avez qu'un accès en lecture à un des enfants de cet événement.");
  if (row.repeat === 'none') throw bad("Cet événement ne se répète pas : supprimez-le directement.");
  const date = (req.body || {}).date;
  if (!validDate(date)) throw bad('Date invalide.');
  const exdates = parseJ(row.exdates, []);
  if (!exdates.includes(date)) exdates.push(date);
  db.prepare('UPDATE events SET exdates=? WHERE id=?').run(JSON.stringify(exdates), row.id);
  emitTo(circleMemberIds(row.circle_id), { type: 'refresh', what: 'events' });
  res.json({ ok: true });
});

// Supprime cette occurrence et toutes celles qui suivent (mais garde les occurrences passées),
// en arrêtant simplement la série la veille de la date donnée. Si cette date est celle de la
// toute première occurrence, cela revient à supprimer l'événement entier.
api.post('/events/:id/truncate', (req, res) => {
  const row = db.prepare('SELECT * FROM events WHERE id=?').get(Number(req.params.id));
  if (!row) throw new HttpError(404, 'Introuvable.');
  requireMember(req.user, row.circle_id);
  if (!editableForChildren(req.user, row.child_ids)) throw new HttpError(403, "Vous n'avez qu'un accès en lecture à un des enfants de cet événement.");
  if (row.repeat === 'none') throw bad("Cet événement ne se répète pas : supprimez-le directement.");
  const date = (req.body || {}).date;
  if (!validDate(date)) throw bad('Date invalide.');
  const startDate = row.starts_at.slice(0, 10);
  if (date <= startDate) {
    db.prepare('DELETE FROM events WHERE id=?').run(row.id);
  } else {
    db.prepare('UPDATE events SET repeat_until=? WHERE id=?').run(addDays(date, -1), row.id);
  }
  emitTo(circleMemberIds(row.circle_id), { type: 'refresh', what: 'events' });
  res.json({ ok: true });
});

// Liste des événements avec répétitions dépliées sur une période
function expandEvents(rows, from, to, custodyMap) {
  const out = [];
  for (const e of rows) {
    const startDate = e.starts_at.slice(0, 10);
    const endDate = (e.ends_at || e.starts_at).slice(0, 10);
    const span = Math.max(0, Math.round((parseD(endDate) - parseD(startDate)) / 86400000));
    const startTime = e.starts_at.length > 10 ? e.starts_at.slice(10) : '';
    const endTime = e.ends_at && e.ends_at.length > 10 ? e.ends_at.slice(10) : '';
    const childIds = parseJ(e.child_ids, []);
    const exdates = parseJ(e.exdates, []);
    const push = (d) => {
      if (exdates.includes(d)) return; // occurrence supprimée individuellement
      const ed = addDays(d, span);
      if (ed < from || d > to) return;
      // Responsable automatique : celui qui a la garde ce jour-là (d'après le premier enfant concerné).
      const ownerId = e.owner_mode === 'auto'
        ? (childIds.length && custodyMap ? (custodyMap[`${d}|${childIds[0]}`] ?? null) : null)
        : e.owner_id;
      out.push({ ...e, child_ids: childIds, occ_date: d, starts_at: d + startTime, ends_at: e.ends_at ? ed + endTime : null, recurring: e.repeat !== 'none', owner_id: ownerId });
    };
    if (e.repeat === 'none') { push(startDate); continue; }
    const until = e.repeat_until && e.repeat_until < to ? e.repeat_until : to;
    for (let i = 0; i < 5000; i++) {
      const d = e.repeat === 'daily' ? addDays(startDate, i)
        : e.repeat === 'weekly' ? addDays(startDate, 7 * i)
          : e.repeat === 'monthly' ? addMonths(startDate, i) : addMonths(startDate, 12 * i);
      if (d > until) break;
      push(d);
    }
  }
  return out.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}

api.get('/events/range', (req, res) => {
  const { from, to } = req.query;
  if (!validDate(from) || !validDate(to)) throw bad('Période invalide.');
  if (parseD(to) - parseD(from) > 400 * 86400000) throw bad('Période trop longue.');
  const circles = myCircles(req.user.id);
  const rows = db.prepare(`SELECT * FROM events WHERE circle_id IN (${placeholders(circles)})`).all(...circles)
    .filter((r) => visibleForChildren(req.user, r.child_ids));
  const needsCustody = rows.some((r) => r.owner_mode === 'auto');
  let custodyMap;
  if (needsCustody) {
    custodyMap = {};
    for (const n of db.prepare('SELECT date, child_id, parent_id FROM custody_nights WHERE date>=? AND date<=?').all(from, to)) {
      custodyMap[`${n.date}|${n.child_id}`] = n.parent_id;
    }
  }
  res.json(expandEvents(rows, from, to, custodyMap));
});

// Recherche dans tout l'agenda, passé comme à venir : titre, lieu, notes, catégorie, responsable et
// enfants concernés. Chaque mot saisi doit se retrouver (sans tenir compte des accents ni de la casse).
// Une série récurrente n'apparaît qu'une fois, avec sa prochaine occurrence (à défaut, la dernière).
const foldText = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
api.get('/events/search', (req, res) => {
  const words = foldText(String(req.query.q || '').trim().slice(0, 100)).split(/\s+/).filter(Boolean);
  if (!words.length || words.join('').length < 2) return res.json([]);
  const circles = myCircles(req.user.id);
  const users = Object.fromEntries(db.prepare('SELECT id,name FROM users').all().map((u) => [u.id, u.name]));
  const kids = Object.fromEntries(db.prepare('SELECT id,name FROM children').all().map((c) => [c.id, c.name]));
  const today = nowLocal().slice(0, 10);
  const found = [];
  for (const r of db.prepare(`SELECT * FROM events WHERE circle_id IN (${placeholders(circles)})`).all(...circles)) {
    if (!visibleForChildren(req.user, r.child_ids)) continue;
    const hay = foldText([r.title, r.location, r.notes, r.category, users[r.owner_id], ...parseJ(r.child_ids, []).map((id) => kids[id])].join(' '));
    if (!words.every((w) => hay.includes(w))) continue;
    const upcoming = expandEvents([r], today, addDays(today, 730))[0];
    const occ = upcoming || expandEvents([r], r.starts_at.slice(0, 10), today).pop();
    if (occ) found.push({ ...occ, past: !upcoming });
  }
  // Responsable automatique : suit la garde du jour de l'occurrence retenue.
  for (const o of found) {
    if (o.owner_mode !== 'auto' || !o.child_ids.length) continue;
    const night = db.prepare('SELECT parent_id FROM custody_nights WHERE child_id=? AND date=?').get(o.child_ids[0], o.occ_date);
    o.owner_id = night ? night.parent_id : null;
  }
  const up = found.filter((o) => !o.past).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const past = found.filter((o) => o.past).sort((a, b) => b.starts_at.localeCompare(a.starts_at));
  res.json([...up, ...past].slice(0, 200));
});

/* Tâches */
mountResource('tasks', 'tasks', { title: 's', due: 'dt?', assignee_id: 'i?', done: 'b', remind_at: 'dt?' }, {
  order: "ORDER BY done, COALESCE(due,'9999'), id DESC",
  afterCreate: (row, req) => {
    if (row.assignee_id && row.assignee_id !== req.user.id) {
      notify([row.assignee_id], { kind: 'task', title: `Tâche pour vous : ${row.title}`, body: row.due ? `À faire pour le ${row.due.replace('T', ' à ')}` : null, link: '#/taches' });
    }
  },
  beforeUpdate: (row, b, sets, vals) => {
    if (b.done !== undefined) { sets.push('done_at=?'); vals.push(b.done ? nowLocal() : null); }
    if (b.remind_at !== undefined) { sets.push('reminded=0'); }
  },
  afterUpdate: (before, after, req) => {
    if (after.assignee_id && after.assignee_id !== before.assignee_id && after.assignee_id !== req.user.id) {
      notify([after.assignee_id], { kind: 'task', title: `Tâche pour vous : ${after.title}`, link: '#/taches' });
    }
  },
});

/* Courses */
mountResource('shopping', 'shopping_items', { list: 's', label: 's', qty: 's?', category: 's?', done: 'b' }, { order: 'ORDER BY done, id DESC' });

/* ───────────────────────── Planificateur de repas ───────────────────────── */
const MEAL_SLOTS = ['dejeuner', 'diner'];

api.get('/meal-plans', (req, res) => {
  const circles = myCircles(req.user.id);
  const { from, to } = req.query;
  const withRange = validDate(from) && validDate(to);
  const rows = db.prepare(`SELECT * FROM meal_plans WHERE circle_id IN (${placeholders(circles)}) ${withRange ? 'AND date BETWEEN ? AND ?' : ''} ORDER BY date, slot`)
    .all(...circles, ...(withRange ? [from, to] : []));
  res.json(rows);
});

// Une seule route « upsert » plutôt que POST+PUT séparés : assigner un repas à un jour/créneau qui
// en a déjà un remplace simplement l'ancien (INSERT ... ON CONFLICT sur circle_id+date+slot).
api.put('/meal-plans', (req, res) => {
  const { circle_id, date, slot, recipe_id, title, servings, notes } = req.body || {};
  const circleId = requireMember(req.user, circle_id);
  if (!validDate(date)) throw bad('Date invalide.');
  const slotVal = MEAL_SLOTS.includes(slot) ? slot : 'diner';
  if (recipe_id) {
    const recipe = db.prepare('SELECT * FROM recipes WHERE id=? AND circle_id=?').get(Number(recipe_id), circleId);
    if (!recipe) throw bad('Recette introuvable dans ce cercle.');
  }
  const srv = (servings !== undefined && servings !== null && servings !== '') ? Number(servings) : null;
  if (srv !== null && (!Number.isInteger(srv) || srv < 1 || srv > 100)) throw bad('Nombre de portions invalide.');
  db.prepare(`INSERT INTO meal_plans(circle_id,date,slot,recipe_id,title,servings,notes,created_by) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(circle_id,date,slot) DO UPDATE SET recipe_id=excluded.recipe_id, title=excluded.title, servings=excluded.servings, notes=excluded.notes`)
    .run(circleId, date, slotVal, recipe_id ? Number(recipe_id) : null, title ? String(title).trim().slice(0, 200) : null, srv, notes ? String(notes).trim().slice(0, 500) : null, req.user.id);
  const row = db.prepare('SELECT * FROM meal_plans WHERE circle_id=? AND date=? AND slot=?').get(circleId, date, slotVal);
  emitTo(circleMemberIds(circleId), { type: 'refresh', what: 'meal-plans' });
  res.json(row);
});

api.delete('/meal-plans/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM meal_plans WHERE id=?').get(Number(req.params.id));
  if (!row) throw new HttpError(404, 'Introuvable.');
  requireMember(req.user, row.circle_id);
  db.prepare('DELETE FROM meal_plans WHERE id=?').run(row.id);
  emitTo(circleMemberIds(row.circle_id), { type: 'refresh', what: 'meal-plans' });
  res.json({ ok: true });
});

// Additionne les ingrédients de toutes les recettes planifiées sur la période (mis à l'échelle
// selon le nombre de portions prévu ce jour-là) et les ajoute à la liste de courses, groupés par
// catégorie. Les repas sans recette liée (juste un titre libre, ex. « Restes ») sont ignorés :
// rien à agréger pour eux.
api.post('/meal-plans/shopping-list', (req, res) => {
  const { circle_id, from, to } = req.body || {};
  const circleId = requireMember(req.user, circle_id);
  if (!validDate(from) || !validDate(to)) throw bad('Dates invalides.');
  const plans = db.prepare('SELECT * FROM meal_plans WHERE circle_id=? AND date BETWEEN ? AND ? AND recipe_id IS NOT NULL').all(circleId, from, to);
  const agg = {};
  let meals = 0;
  for (const p of plans) {
    const recipe = db.prepare('SELECT * FROM recipes WHERE id=?').get(p.recipe_id);
    if (!recipe) continue;
    const ingredients = parseJ(recipe.ingredients_json, []);
    if (!ingredients.length) continue;
    const scale = p.servings ? (p.servings / (recipe.servings || 4)) : 1;
    for (const ing of ingredients) {
      const key = `${ing.name.toLowerCase()}|${ing.unit || ''}`;
      if (!agg[key]) agg[key] = { name: ing.name, unit: ing.unit, category: ing.category, amount: 0, hasAmount: false };
      if (ing.amount !== null) { agg[key].amount += ing.amount * scale; agg[key].hasAmount = true; }
    }
    meals++;
  }
  const items = Object.values(agg);
  const ins = db.prepare('INSERT INTO shopping_items(circle_id,list,label,qty,category,created_by) VALUES(?,?,?,?,?,?)');
  for (const it of items) {
    const qty = it.hasAmount ? `${Math.round(it.amount * 100) / 100}${it.unit ? ' ' + it.unit : ''}` : null;
    ins.run(circleId, 'Courses', it.name, qty, it.category, req.user.id);
  }
  if (items.length) emitTo(circleMemberIds(circleId), { type: 'refresh', what: 'shopping' });
  res.json({ added: items.length, meals });
});

api.delete('/shopping/done', (req, res) => {
  const cid = requireMember(req.user, req.query.circle_id);
  const list = String(req.query.list || 'Courses');
  db.prepare('DELETE FROM shopping_items WHERE circle_id=? AND list=? AND done=1').run(cid, list);
  emitTo(circleMemberIds(cid), { type: 'refresh', what: 'shopping' });
  res.json({ ok: true });
});

/* Contacts : peuvent appartenir à plusieurs cercles à la fois (ex. un médecin partagé entre la
   famille au complet et le cercle des coparents), donc pas de mountResource générique ici. */
function sanitizeContact(b) {
  const name = String((b && b.name) || '').trim();
  if (!name) throw bad('Le nom est requis.');
  const trim = (v, max) => (v ? String(v).trim().slice(0, max) : null);
  return {
    name: name.slice(0, 500),
    category: trim(b.category, 500),
    phone: trim(b.phone, 500),
    email: trim(b.email, 500),
    address: trim(b.address, 500),
    notes: trim(b.notes, 4000),
  };
}
function sanitizeCircleIds(ids, user) {
  if (!Array.isArray(ids)) throw bad('Sélectionnez au moins un cercle.');
  const uniq = [...new Set(ids.map(Number).filter(Number.isInteger))];
  if (!uniq.length) throw bad('Sélectionnez au moins un cercle.');
  const mine = myCircles(user.id);
  if (!uniq.every((id) => mine.includes(id))) throw new HttpError(403, "Vous n'avez pas accès à un des cercles sélectionnés.");
  return uniq;
}
function sanitizeContactChild(childId, user) {
  if (childId === null || childId === undefined || childId === '') return null;
  const id = Number(childId);
  if (!Number.isInteger(id) || !childExists(id)) throw bad('Enfant introuvable.');
  if (!canEditChild(user, id)) throw new HttpError(403, "Vous n'avez qu'un accès en lecture à cet enfant.");
  return id;
}
const decodeContact = (r) => ({ ...r, circle_ids: parseJ(r.circle_ids, []) });

api.get('/contacts', (req, res) => {
  const mine = myCircles(req.user.id);
  const rows = db.prepare('SELECT * FROM contacts ORDER BY name COLLATE NOCASE').all()
    .map(decodeContact)
    .filter((r) => r.circle_ids.some((id) => mine.includes(id)))
    .filter((r) => !r.child_id || canSeeChild(req.user, r.child_id));
  res.json(rows);
});

api.post('/contacts', (req, res) => {
  const b = req.body || {};
  const circleIds = sanitizeCircleIds(b.circle_ids, req.user);
  const childId = sanitizeContactChild(b.child_id, req.user);
  const c = sanitizeContact(b);
  const r = db.prepare('INSERT INTO contacts(circle_ids,name,category,phone,email,address,notes,child_id,favorite,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(JSON.stringify(circleIds), c.name, c.category, c.phone, c.email, c.address, c.notes, childId, b.favorite ? 1 : 0, req.user.id);
  const row = db.prepare('SELECT * FROM contacts WHERE id=?').get(r.lastInsertRowid);
  emitTo(circleIds.flatMap(circleMemberIds), { type: 'refresh', what: 'contacts' });
  res.json(decodeContact(row));
});

api.put('/contacts/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM contacts WHERE id=?').get(Number(req.params.id));
  if (!row) throw new HttpError(404, 'Introuvable.');
  const existingIds = parseJ(row.circle_ids, []);
  const mine = myCircles(req.user.id);
  if (!existingIds.some((id) => mine.includes(id))) throw new HttpError(403, "Vous n'avez pas accès à ce contact.");
  if (row.child_id && !canEditChild(req.user, row.child_id)) throw new HttpError(403, "Vous n'avez qu'un accès en lecture à cet enfant.");
  const b = req.body || {};
  const circleIds = b.circle_ids !== undefined ? sanitizeCircleIds(b.circle_ids, req.user) : existingIds;
  const childId = b.child_id !== undefined ? sanitizeContactChild(b.child_id, req.user) : row.child_id;
  const sets = ['circle_ids=?']; const vals = [JSON.stringify(circleIds)];
  if (b.child_id !== undefined) { sets.push('child_id=?'); vals.push(childId); }
  if (b.favorite !== undefined) { sets.push('favorite=?'); vals.push(b.favorite ? 1 : 0); }
  if (b.name !== undefined || b.category !== undefined || b.phone !== undefined || b.email !== undefined || b.address !== undefined || b.notes !== undefined) {
    const c = sanitizeContact({ name: b.name !== undefined ? b.name : row.name, category: b.category !== undefined ? b.category : row.category,
      phone: b.phone !== undefined ? b.phone : row.phone, email: b.email !== undefined ? b.email : row.email,
      address: b.address !== undefined ? b.address : row.address, notes: b.notes !== undefined ? b.notes : row.notes });
    sets.push('name=?', 'category=?', 'phone=?', 'email=?', 'address=?', 'notes=?');
    vals.push(c.name, c.category, c.phone, c.email, c.address, c.notes);
  }
  db.prepare(`UPDATE contacts SET ${sets.join(',')} WHERE id=?`).run(...vals, row.id);
  const updated = db.prepare('SELECT * FROM contacts WHERE id=?').get(row.id);
  emitTo([...new Set([...existingIds, ...circleIds])].flatMap(circleMemberIds), { type: 'refresh', what: 'contacts' });
  res.json(decodeContact(updated));
});

api.delete('/contacts/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM contacts WHERE id=?').get(Number(req.params.id));
  if (!row) throw new HttpError(404, 'Introuvable.');
  const existingIds = parseJ(row.circle_ids, []);
  const mine = myCircles(req.user.id);
  if (!existingIds.some((id) => mine.includes(id))) throw new HttpError(403, "Vous n'avez pas accès à ce contact.");
  if (row.child_id && !canEditChild(req.user, row.child_id)) throw new HttpError(403, "Vous n'avez qu'un accès en lecture à cet enfant.");
  db.prepare('DELETE FROM contacts WHERE id=?').run(row.id);
  emitTo(existingIds.flatMap(circleMemberIds), { type: 'refresh', what: 'contacts' });
  res.json({ ok: true });
});

/* ───────────────────────── École : devoirs et mots (Pronote ou autre source externe) ─────────────────────────
   Ces données n'appartiennent à aucun cercle : leur visibilité suit uniquement les parents/lecteurs
   désignés sur l'enfant concerné (comme la garde). Elles arrivent via le point d'entrée /import/:token
   (voir plus bas), alimenté typiquement par une automatisation Home Assistant. */
api.get('/homework', (req, res) => {
  const rows = db.prepare("SELECT * FROM homework ORDER BY done, COALESCE(due_date,'9999-99-99'), id DESC").all()
    .filter((r) => canSeeChild(req.user, r.child_id));
  res.json(rows);
});
api.put('/homework/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM homework WHERE id=?').get(Number(req.params.id));
  if (!row) throw new HttpError(404, 'Introuvable.');
  if (!canEditChild(req.user, row.child_id)) throw new HttpError(403, "Vous n'avez qu'un accès en lecture à cet enfant.");
  const { done } = req.body || {};
  if (done !== undefined) db.prepare("UPDATE homework SET done=?, updated_at=datetime('now') WHERE id=?").run(done ? 1 : 0, row.id);
  res.json({ ok: true });
});
api.delete('/homework/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM homework WHERE id=?').get(Number(req.params.id));
  if (!row) throw new HttpError(404, 'Introuvable.');
  if (!canEditChild(req.user, row.child_id)) throw new HttpError(403, "Vous n'avez qu'un accès en lecture à cet enfant.");
  db.prepare('DELETE FROM homework WHERE id=?').run(row.id);
  res.json({ ok: true });
});

api.get('/notes', (req, res) => {
  const rows = db.prepare("SELECT * FROM school_notes ORDER BY COALESCE(date,'9999-99-99') DESC, id DESC").all()
    .filter((r) => canSeeChild(req.user, r.child_id));
  res.json(rows);
});
api.put('/notes/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM school_notes WHERE id=?').get(Number(req.params.id));
  if (!row) throw new HttpError(404, 'Introuvable.');
  if (!canSeeChild(req.user, row.child_id)) throw new HttpError(404, 'Introuvable.');
  const { read } = req.body || {};
  if (read !== undefined) db.prepare('UPDATE school_notes SET read=? WHERE id=?').run(read ? 1 : 0, row.id);
  res.json({ ok: true });
});
api.delete('/notes/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM school_notes WHERE id=?').get(Number(req.params.id));
  if (!row) throw new HttpError(404, 'Introuvable.');
  if (!canEditChild(req.user, row.child_id)) throw new HttpError(403, "Vous n'avez qu'un accès en lecture à cet enfant.");
  db.prepare('DELETE FROM school_notes WHERE id=?').run(row.id);
  res.json({ ok: true });
});

// Réservations périscolaires (garderie, cantine, ALSH...) : même principe que les devoirs/mots
// ci-dessus (visibilité par enfant, reçues via /import/:token, jamais saisies à la main).
api.get('/reservations', (req, res) => {
  const rows = db.prepare("SELECT * FROM school_reservations ORDER BY date, COALESCE(start_time,''), id").all()
    .filter((r) => canSeeChild(req.user, r.child_id));
  res.json(rows);
});
api.delete('/reservations/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM school_reservations WHERE id=?').get(Number(req.params.id));
  if (!row) throw new HttpError(404, 'Introuvable.');
  if (!canEditChild(req.user, row.child_id)) throw new HttpError(403, "Vous n'avez qu'un accès en lecture à cet enfant.");
  db.prepare('DELETE FROM school_reservations WHERE id=?').run(row.id);
  res.json({ ok: true });
});

// Factures périscolaires : rattachées à un cercle, et depuis peu, facultativement, à un enfant
// (child_id — utile dès qu'on en suit plusieurs). Une facture qu'aucun cercle n'a pu être deviné à
// l'import (plusieurs cercles sans indication suffisante) reste sans cercle plutôt que d'être perdue
// — seuls les administrateurs la voient et peuvent l'attribuer (voir /invoices/:id/attribute).
api.get('/invoices', (req, res) => {
  const circles = myCircles(req.user.id);
  const clauses = []; const params = [];
  if (circles.length) { clauses.push(`circle_id IN (${placeholders(circles)})`); params.push(...circles); }
  if (req.user.is_admin) clauses.push('circle_id IS NULL');
  if (!clauses.length) return res.json([]);
  res.json(db.prepare(`SELECT * FROM invoices WHERE ${clauses.join(' OR ')} ORDER BY date DESC, id DESC`).all(...params));
});
api.delete('/invoices/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM invoices WHERE id=?').get(Number(req.params.id));
  if (!row) throw new HttpError(404, 'Introuvable.');
  if (!req.user.is_admin) requireMember(req.user, row.circle_id);
  if (row.expense_id) db.prepare('DELETE FROM expenses WHERE id=?').run(row.expense_id);
  db.prepare('DELETE FROM invoices WHERE id=?').run(row.id);
  res.json({ ok: true });
});
// Attribue (ou corrige) le cercle et/ou l'enfant concerné par une facture. Changer le cercle est
// réservé aux administrateurs (ça déplace la facture d'un budget à un autre, potentiellement vers un
// cercle dont on n'est pas soi-même membre) ; dire à quel enfant elle correspond, en revanche, est
// ouvert à tout membre du cercle déjà attribué — comme le reste de la facture.
api.put('/invoices/:id/attribute', (req, res) => {
  const row = db.prepare('SELECT * FROM invoices WHERE id=?').get(Number(req.params.id));
  if (!row) throw new HttpError(404, 'Introuvable.');
  const b = req.body || {};
  let circleId = row.circle_id;
  if (b.circle_id !== undefined) {
    if (!req.user.is_admin) throw new HttpError(403, 'Seul un administrateur peut attribuer le cercle d\'une facture.');
    if (b.circle_id === null) circleId = null;
    else {
      const c = db.prepare('SELECT * FROM circles WHERE id=?').get(Number(b.circle_id));
      if (!c) throw bad('Cercle introuvable.');
      circleId = c.id;
    }
  } else {
    requireMember(req.user, row.circle_id);
  }
  let childId = row.child_id;
  if (b.child_id !== undefined) {
    if (b.child_id === null) childId = null;
    else {
      if (!childExists(Number(b.child_id))) throw bad('Enfant introuvable.');
      childId = Number(b.child_id);
    }
  }
  db.prepare("UPDATE invoices SET circle_id=?, child_id=?, updated_at=datetime('now') WHERE id=?").run(circleId, childId, row.id);
  if (circleId) emitTo(circleMemberIds(circleId), { type: 'refresh', what: 'invoices' });
  res.json(db.prepare('SELECT * FROM invoices WHERE id=?').get(row.id));
});
// Attribution d'une facture en attente : à quelqu'un qui va la payer (paid=false, reste en attente,
// réattribuable), ou qui l'a déjà payée (paid=true, crée la dépense partagée correspondante — voir
// createExpenseForInvoice). Une fois payée, elle quitte « en attente » ; pour l'annuler, on
// supprime la dépense dans Budget, ce qui (grâce à expense_id ON DELETE SET NULL) redonne
// automatiquement la facture en attente — toujours attribuée à la même personne, juste non payée.
api.put('/invoices/:id/assign', (req, res) => {
  const row = db.prepare('SELECT * FROM invoices WHERE id=?').get(Number(req.params.id));
  if (!row) throw new HttpError(404, 'Introuvable.');
  requireMember(req.user, row.circle_id);
  if (row.expense_id) throw new HttpError(400, 'Cette facture est déjà payée : pour revenir en arrière, supprimez la dépense correspondante dans Budget.');
  const b = req.body || {};
  const payerId = Number(b.assigned_to);
  if (!circleMemberIds(row.circle_id).includes(payerId)) throw bad('Le payeur doit faire partie du cercle.');
  if (b.paid) {
    const date = validDate(b.date) ? b.date : nowLocal().slice(0, 10);
    createExpenseForInvoice(row, payerId, date, req.user.id);
  } else {
    db.prepare('UPDATE invoices SET assigned_to=? WHERE id=?').run(payerId, row.id);
    emitTo(circleMemberIds(row.circle_id), { type: 'refresh', what: 'invoices' });
  }
  res.json(db.prepare('SELECT * FROM invoices WHERE id=?').get(row.id));
});

api.get('/settings/integration-token', requireAdmin, (req, res) => {
  res.json({ token: getSetting('integration_token', null) });
});
api.post('/settings/integration-token', requireAdmin, (req, res) => {
  const token = randToken(32);
  setSetting('integration_token', token);
  res.json({ token });
});

// Addons de réservation périscolaire (server/addons/*.js) : configuration et déclenchement manuel
// depuis Réglages → Administration. Les identifiants ne sont jamais renvoyés en clair (voir
// addon-manager.js) ; la synchronisation automatique périodique est gérée par maybeSyncAddons(), appelée depuis tick().
api.get('/addons', requireAdmin, (req, res) => res.json(addonManager.list()));
api.put('/addons/:id', requireAdmin, (req, res) => {
  try { res.json(addonManager.saveConfig(req.params.id, req.body || {})); }
  catch (e) { throw new HttpError(e.status || 400, e.message); }
});
api.post('/addons/:id/sync', requireAdmin, async (req, res, next) => {
  try { res.json({ ok: true, ...(await runAddonSync(req.params.id)) }); }
  catch (e) { addonManager.recordSyncError(req.params.id, e.message); next(e instanceof HttpError ? e : new HttpError(502, e.message)); }
});

/* Dépenses partagées */
mountResource('expenses', 'expenses', { title: 's', amount_cents: 'cents', category: 's?', date: 'd', paid_by: 'i', split: 'split', child_id: 'i?' }, {
  order: 'ORDER BY date DESC, id DESC',
  decode: (r) => ({ ...r, split: parseJ(r.split, {}) }),
  validate: (v) => assertSplitAllowed(v.child_id, parseJ(v.split, {})),
  beforeUpdate: (row, b, sets, vals, req) => {
    if (!canModifyOwn(req.user, row)) throw ownOnly('cette dépense');
    const rawChild = b.child_id !== undefined ? b.child_id : row.child_id;
    const childId = (rawChild === null || rawChild === '') ? null : Number(rawChild);
    assertSplitAllowed(childId, b.split !== undefined ? b.split : parseJ(row.split, {}));
  },
  afterUpdate: (before, after, req) => {
    // Une dépense issue d'un événement garde son prix synchronisé avec lui.
    if (after.event_id) db.prepare('UPDATE events SET price_cents=?, price_paid_by=? WHERE id=?').run(after.amount_cents, after.paid_by, after.event_id);
    notify(circleMemberIds(after.circle_id), {
      kind: 'expense', title: `Dépense modifiée : ${after.title}`, body: `${(after.amount_cents / 100).toFixed(2).replace('.', ',')} €`, link: '#/budget',
    }, req.user.id);
  },
  beforeDelete: (row, req) => {
    if (!canModifyOwn(req.user, row)) throw ownOnly('cette dépense');
    dropExpenseDocument(row);
    if (row.event_id) db.prepare('UPDATE events SET price_cents=NULL, price_paid_by=NULL WHERE id=?').run(row.event_id);
  },
  afterCreate: (row, req) => notify(circleMemberIds(row.circle_id), {
    kind: 'expense', title: `Dépense ajoutée : ${row.title}`, body: `${(row.amount_cents / 100).toFixed(2).replace('.', ',')} €`, link: '#/budget',
  }, req.user.id),
});

/* Dépenses récurrentes : un modèle qui crée une vraie dépense à chaque échéance (les soldes, les
   statistiques et l'historique ne voient donc que de banales dépenses). Modifier le modèle ne change
   que les échéances à venir ; supprimer le modèle conserve celles déjà créées. */
function recurringDate(t, i) {
  if (t.repeat === 'weekly') return addDays(t.start_date, 7 * i);
  return addMonths(t.start_date, (t.repeat === 'monthly' ? 1 : t.repeat === 'quarterly' ? 3 : 12) * i);
}
function generateRecurringExpenses() {
  const today = nowLocal().slice(0, 10);
  const touched = new Set();
  const ins = db.prepare('INSERT INTO expenses(circle_id,title,amount_cents,category,date,paid_by,split,child_id,recurring_id,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)');
  for (const t of db.prepare('SELECT * FROM recurring_expenses').all()) {
    let i = t.generated; let made = 0;
    while (made < 400) { // garde-fou : rattrapage limité si le serveur est resté longtemps éteint
      const d = recurringDate(t, i);
      if (d > today || (t.repeat_until && d > t.repeat_until)) break;
      ins.run(t.circle_id, t.title, t.amount_cents, t.category, d, t.paid_by, t.split, t.child_id, t.id, t.created_by);
      i++; made++; touched.add(t.circle_id);
      // Seule l'échéance du jour notifie ; un rattrapage d'échéances passées reste silencieux.
      if (d === today) notify(circleMemberIds(t.circle_id), { kind: 'expense', title: `Dépense récurrente : ${t.title}`, body: `${(t.amount_cents / 100).toFixed(2).replace('.', ',')} €`, link: '#/budget' });
    }
    if (made) db.prepare('UPDATE recurring_expenses SET generated=? WHERE id=?').run(i, t.id);
  }
  for (const cid of touched) emitTo(circleMemberIds(cid), { type: 'refresh', what: 'expenses' });
}
mountResource('recurring-expenses', 'recurring_expenses', {
  title: 's', amount_cents: 'cents', category: 's?', paid_by: 'i', split: 'split', child_id: 'i?', repeat: 'exprep', start_date: 'd', repeat_until: 'd?',
}, {
  order: 'ORDER BY title COLLATE NOCASE',
  // next_date : prochaine échéance à venir (null si la série est terminée), pour l'afficher telle quelle.
  decode: (r) => {
    const next = recurringDate(r, r.generated);
    return { ...r, split: parseJ(r.split, {}), next_date: (r.repeat_until && next > r.repeat_until) ? null : next };
  },
  validate: (v) => {
    assertSplitAllowed(v.child_id, parseJ(v.split, {}));
    if (v.repeat_until && v.repeat_until < v.start_date) throw bad('La date de fin doit être après le début.');
  },
  beforeUpdate: (row, b, sets, vals, req) => {
    if (!canModifyOwn(req.user, row)) throw ownOnly('cette dépense récurrente');
    if ((b.start_date !== undefined && b.start_date !== row.start_date) || (b.repeat !== undefined && b.repeat !== row.repeat)) {
      throw bad('Le début et la fréquence ne se modifient pas : supprimez cette dépense récurrente et créez-en une nouvelle.');
    }
    const rawChild = b.child_id !== undefined ? b.child_id : row.child_id;
    assertSplitAllowed((rawChild === null || rawChild === '') ? null : Number(rawChild), b.split !== undefined ? b.split : parseJ(row.split, {}));
    const until = b.repeat_until !== undefined ? b.repeat_until : row.repeat_until;
    if (until && until < row.start_date) throw bad('La date de fin doit être après le début.');
  },
  beforeDelete: (row, req) => { if (!canModifyOwn(req.user, row)) throw ownOnly('cette dépense récurrente'); },
  afterCreate: () => generateRecurringExpenses(),
  afterUpdate: () => generateRecurringExpenses(), // une date de fin repoussée peut rendre des échéances dues
});

function computeShares(amount, split) {
  const ids = Object.keys(split);
  let sum = 0;
  const out = {};
  ids.forEach((id, i) => {
    const s = i === ids.length - 1 ? amount - sum : Math.round((amount * split[id]) / 100);
    out[id] = s; sum += s;
  });
  return out;
}

function computeBalances(circleId) {
  const bal = {};
  const add = (u, v) => { bal[u] = (bal[u] || 0) + v; };
  for (const e of db.prepare('SELECT * FROM expenses WHERE circle_id=?').all(circleId)) {
    add(e.paid_by, e.amount_cents);
    for (const [u, s] of Object.entries(computeShares(e.amount_cents, parseJ(e.split, {})))) add(Number(u), -s);
  }
  for (const s of db.prepare('SELECT * FROM settlements WHERE circle_id=?').all(circleId)) {
    add(s.from_user, s.amount_cents);
    add(s.to_user, -s.amount_cents);
  }
  const debtors = []; const creditors = [];
  for (const [u, v] of Object.entries(bal)) {
    if (v < 0) debtors.push([Number(u), -v]); else if (v > 0) creditors.push([Number(u), v]);
  }
  debtors.sort((a, b) => b[1] - a[1]); creditors.sort((a, b) => b[1] - a[1]);
  const transfers = [];
  let i = 0; let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const m = Math.min(debtors[i][1], creditors[j][1]);
    transfers.push({ from: debtors[i][0], to: creditors[j][0], amount_cents: m });
    debtors[i][1] -= m; creditors[j][1] -= m;
    if (!debtors[i][1]) i++;
    if (!creditors[j][1]) j++;
  }
  return { balances: bal, transfers };
}

api.get('/expenses/summary', (req, res) => {
  const cid = requireMember(req.user, req.query.circle_id);
  // Période du détail par catégorie : un mois (?month=AAAA-MM, par défaut le mois courant), une année
  // (?year=AAAA) ou toute la période (?all=1). Les soldes, eux, portent toujours sur l'ensemble.
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : nowLocal().slice(0, 7);
  let scope = 'substr(date,1,7)=?'; let arg = [month]; let period = { kind: 'month', value: month };
  if (/^\d{4}$/.test(req.query.year || '')) { scope = 'substr(date,1,4)=?'; arg = [req.query.year]; period = { kind: 'year', value: req.query.year }; }
  else if (req.query.all === '1') { scope = '1=1'; arg = []; period = { kind: 'all', value: null }; }
  const cats = db.prepare(`SELECT COALESCE(category,'Autre') category, SUM(amount_cents) total FROM expenses
    WHERE circle_id=? AND ${scope} GROUP BY COALESCE(category,'Autre') ORDER BY total DESC`).all(cid, ...arg);
  const settlements = db.prepare('SELECT * FROM settlements WHERE circle_id=? ORDER BY date DESC, id DESC').all(cid);
  res.json({ ...computeBalances(cid), categories: cats, month, period, settlements });
});

// Une « ligne de remboursement » : X a rendu Y euros à Z (montant libre, donc éventuellement partiel).
// Il suffit d'être l'une des deux personnes concernées (ou administrateur) pour l'enregistrer.
api.post('/settlements', (req, res) => {
  const { circle_id, from_user, to_user, amount_cents, note, date } = req.body || {};
  const cid = requireMember(req.user, circle_id);
  const amt = coerce('cents', amount_cents, 'montant');
  const from = Number(from_user); const to = Number(to_user);
  const members = circleMemberIds(cid);
  if (!members.includes(from) || !members.includes(to) || from === to) throw bad('Participants invalides.');
  if (!req.user.is_admin && req.user.id !== from && req.user.id !== to) throw new HttpError(403, "Vous ne pouvez enregistrer qu'un remboursement qui vous concerne.");
  const d = date || nowLocal().slice(0, 10);
  if (!validDate(d)) throw bad('Date invalide.');
  db.prepare('INSERT INTO settlements(circle_id,from_user,to_user,amount_cents,date,note,created_by) VALUES(?,?,?,?,?,?,?)')
    .run(cid, from, to, amt, d, note ? String(note).trim().slice(0, 200) : null, req.user.id);
  notify([from, to], { kind: 'expense', title: 'Remboursement enregistré', body: `${(amt / 100).toFixed(2).replace('.', ',')} €`, link: '#/budget' }, req.user.id);
  emitTo(circleMemberIds(cid), { type: 'refresh', what: 'expenses' });
  res.json({ ok: true });
});
api.delete('/settlements/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM settlements WHERE id=?').get(Number(req.params.id));
  if (!s) throw new HttpError(404, 'Introuvable.');
  requireMember(req.user, s.circle_id);
  if (!canModifyOwn(req.user, s)) throw ownOnly('ce remboursement');
  db.prepare('DELETE FROM settlements WHERE id=?').run(s.id);
  emitTo(circleMemberIds(s.circle_id), { type: 'refresh', what: 'expenses' });
  res.json({ ok: true });
});

/* ───────────────────────── Documents (fichiers) ───────────────────────── */
const uploadDoc = multer({ dest: UPLOAD_DIR, limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
const uploadImg = multer({
  dest: MEDIA_DIR,
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, /^image\/(jpeg|png|gif|webp)$/.test(file.mimetype)),
});
const fixName = (n) => Buffer.from(n, 'latin1').toString('utf8').replace(/[\\/\r\n"]/g, '_').slice(0, 200);
const rmFile = (name) => fs.unlink(path.join(UPLOAD_DIR, name), () => {});
const rmMediaFile = (name) => fs.unlink(path.join(MEDIA_DIR, name), () => {});

function sniffImage(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(12);
  fs.readSync(fd, buf, 0, 12, 0);
  fs.closeSync(fd);
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.slice(0, 3).toString() === 'GIF') return 'image/gif';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}
function isPdf(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(5);
  fs.readSync(fd, buf, 0, 5, 0);
  fs.closeSync(fd);
  return buf.toString() === '%PDF-';
}
const uploadInvoice = multer({ dest: UPLOAD_DIR, limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

api.post('/expenses/:id/invoice', uploadInvoice.single('file'), (req, res) => {
  const f = req.file;
  try {
    const row = db.prepare('SELECT * FROM expenses WHERE id=?').get(Number(req.params.id));
    if (!row) throw new HttpError(404, 'Introuvable.');
    requireMember(req.user, row.circle_id);
    if (!canModifyOwn(req.user, row)) throw ownOnly('cette dépense');
    if (!f) throw bad('Aucun fichier reçu.');
    if (!isPdf(f.path)) throw bad('Seuls les fichiers PDF sont acceptés pour une facture.');
    const tx = db.transaction(() => {
      if (row.document_id) {
        const old = db.prepare('SELECT * FROM documents WHERE id=?').get(row.document_id);
        if (old) { db.prepare('DELETE FROM documents WHERE id=?').run(old.id); rmFile(old.stored_name); }
      }
      const filename = fixName(f.originalname);
      const doc = db.prepare('INSERT INTO documents(circle_id,title,category,filename,stored_name,mime,size,created_by) VALUES(?,?,?,?,?,?,?,?)')
        .run(row.circle_id, `Facture — ${row.title}`, 'Facture', filename, f.filename, 'application/pdf', f.size, req.user.id);
      db.prepare('UPDATE expenses SET document_id=? WHERE id=?').run(doc.lastInsertRowid, row.id);
      return doc.lastInsertRowid;
    });
    const documentId = tx();
    emitTo(circleMemberIds(row.circle_id), { type: 'refresh', what: 'expenses' });
    emitTo(circleMemberIds(row.circle_id), { type: 'refresh', what: 'documents' });
    res.json({ document_id: documentId });
  } catch (e) { if (f) rmFile(f.filename); throw e; }
});

api.delete('/expenses/:id/invoice', (req, res) => {
  const row = db.prepare('SELECT * FROM expenses WHERE id=?').get(Number(req.params.id));
  if (!row) throw new HttpError(404, 'Introuvable.');
  requireMember(req.user, row.circle_id);
  if (!canModifyOwn(req.user, row)) throw ownOnly('cette dépense');
  if (row.document_id) {
    const doc = db.prepare('SELECT * FROM documents WHERE id=?').get(row.document_id);
    if (doc) { db.prepare('DELETE FROM documents WHERE id=?').run(doc.id); rmFile(doc.stored_name); }
    db.prepare('UPDATE expenses SET document_id=NULL WHERE id=?').run(row.id);
  }
  emitTo(circleMemberIds(row.circle_id), { type: 'refresh', what: 'expenses' });
  res.json({ ok: true });
});

api.get('/documents', (req, res) => {
  const circles = myCircles(req.user.id);
  res.json(db.prepare(`SELECT id,circle_id,title,category,filename,mime,size,created_by,created_at FROM documents
    WHERE circle_id IN (${placeholders(circles)}) ORDER BY id DESC`).all(...circles));
});

api.post('/documents', uploadDoc.single('file'), (req, res) => {
  const f = req.file;
  try {
    if (!f) throw bad('Aucun fichier reçu.');
    const cid = requireMember(req.user, req.body.circle_id);
    const filename = fixName(f.originalname);
    const title = String(req.body.title || '').trim().slice(0, 200) || filename;
    const r = db.prepare('INSERT INTO documents(circle_id,title,category,filename,stored_name,mime,size,created_by) VALUES(?,?,?,?,?,?,?,?)')
      .run(cid, title, String(req.body.category || '').trim().slice(0, 60) || null, filename, f.filename, f.mimetype, f.size, req.user.id);
    emitTo(circleMemberIds(cid), { type: 'refresh', what: 'documents' });
    notify(circleMemberIds(cid), { kind: 'document', title: `Nouveau document : ${title}`, link: '#/documents' }, req.user.id);
    res.json({ id: r.lastInsertRowid });
  } catch (e) { if (f) rmFile(f.filename); throw e; }
});

api.put('/documents/:id', (req, res) => {
  const d = db.prepare('SELECT * FROM documents WHERE id=?').get(Number(req.params.id));
  if (!d) throw new HttpError(404, 'Introuvable.');
  requireMember(req.user, d.circle_id);
  const { title, category, circle_id } = req.body || {};
  if (title !== undefined && String(title).trim()) db.prepare('UPDATE documents SET title=? WHERE id=?').run(String(title).trim().slice(0, 200), d.id);
  if (category !== undefined) db.prepare('UPDATE documents SET category=? WHERE id=?').run(String(category).trim().slice(0, 60) || null, d.id);
  if (circle_id !== undefined) db.prepare('UPDATE documents SET circle_id=? WHERE id=?').run(requireMember(req.user, circle_id), d.id);
  res.json({ ok: true });
});

api.get('/documents/:id/file', (req, res) => {
  const d = db.prepare('SELECT * FROM documents WHERE id=?').get(Number(req.params.id));
  if (!d) throw new HttpError(404, 'Introuvable.');
  requireMember(req.user, d.circle_id);
  const file = path.join(UPLOAD_DIR, d.stored_name);
  // ?inline=1 : affichage direct (PDF, images) sans téléchargement. Le type est reconnu d'après le
  // CONTENU du fichier — le type annoncé au dépôt n'est pas fiable — et seuls les PDF et images
  // matricielles sont concernés (jamais SVG/HTML, qui pourraient exécuter des scripts). Tout autre
  // fichier, ou un fichier qui ne correspond pas à son extension, repart en téléchargement.
  const shown = req.query.inline ? previewType(file) : null;
  if (shown) {
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(d.filename)}`);
    res.setHeader('Content-Type', shown);
    // L'application affiche cet aperçu dans son propre cadre : on lève, pour cette seule réponse,
    // l'interdiction générale d'incrustation (aucune autre origine ne peut l'incruster).
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  } else {
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(d.filename)}`);
    res.setHeader('Content-Type', 'application/octet-stream');
  }
  res.sendFile(file);
});
function previewType(file) {
  try { return isPdf(file) ? 'application/pdf' : sniffImage(file); } catch { return null; }
}

api.delete('/documents/:id', (req, res) => {
  const d = db.prepare('SELECT * FROM documents WHERE id=?').get(Number(req.params.id));
  if (!d) throw new HttpError(404, 'Introuvable.');
  requireMember(req.user, d.circle_id);
  if (d.created_by !== req.user.id && !req.user.is_admin) throw new HttpError(403, "Seul l'auteur ou un administrateur peut supprimer ce document.");
  db.prepare('DELETE FROM documents WHERE id=?').run(d.id);
  rmFile(d.stored_name);
  res.json({ ok: true });
});

/* ───────────────────────── Fil familial & chat ───────────────────────── */
api.get('/posts', (req, res) => {
  const circles = myCircles(req.user.id);
  const before = Number(req.query.before) || 1e12;
  res.json(db.prepare(`SELECT id,circle_id,body,photo_mime IS NOT NULL AS has_photo,created_by,created_at FROM posts
    WHERE circle_id IN (${placeholders(circles)}) AND id<? ORDER BY id DESC LIMIT 30`).all(...circles, before));
});

api.post('/posts', uploadImg.single('photo'), (req, res) => {
  const f = req.file;
  try {
    const cid = requireMember(req.user, req.body.circle_id);
    const body = String(req.body.body || '').trim().slice(0, 4000);
    let mime = null;
    if (f) { mime = sniffImage(path.join(MEDIA_DIR, f.filename)); if (!mime) throw bad("Ce fichier n'est pas une image valide."); }
    if (!body && !f) throw bad('Écrivez un message ou ajoutez une photo.');
    db.prepare('INSERT INTO posts(circle_id,body,photo_name,photo_mime,created_by) VALUES(?,?,?,?,?)')
      .run(cid, body || null, f ? f.filename : null, mime, req.user.id);
    notify(circleMemberIds(cid), { kind: 'post', title: `${req.user.name} a partagé ${f ? 'une photo' : 'une nouvelle'}`, body: body.slice(0, 80), link: '#/fil' }, req.user.id);
    emitTo(circleMemberIds(cid), { type: 'refresh', what: 'posts' });
    res.json({ ok: true });
  } catch (e) { if (f) rmMediaFile(f.filename); throw e; }
});

api.get('/posts/:id/photo', (req, res) => {
  const p = db.prepare('SELECT * FROM posts WHERE id=?').get(Number(req.params.id));
  if (!p || !p.photo_name) throw new HttpError(404, 'Introuvable.');
  requireMember(req.user, p.circle_id);
  res.setHeader('Content-Type', p.photo_mime);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(path.join(MEDIA_DIR, p.photo_name));
});

api.delete('/posts/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM posts WHERE id=?').get(Number(req.params.id));
  if (!p) throw new HttpError(404, 'Introuvable.');
  requireMember(req.user, p.circle_id);
  if (p.created_by !== req.user.id && !req.user.is_admin) throw new HttpError(403, "Seul l'auteur ou un administrateur peut supprimer ce message.");
  db.prepare('DELETE FROM posts WHERE id=?').run(p.id);
  if (p.photo_name) rmMediaFile(p.photo_name);
  emitTo(circleMemberIds(p.circle_id), { type: 'refresh', what: 'posts' });
  res.json({ ok: true });
});

api.get('/messages', (req, res) => {
  const cid = requireMember(req.user, req.query.circle_id);
  const rows = db.prepare('SELECT * FROM messages WHERE circle_id=? ORDER BY id DESC LIMIT 100').all(cid);
  res.json(rows.reverse());
});
api.post('/messages', (req, res) => {
  const cid = requireMember(req.user, (req.body || {}).circle_id);
  const body = String((req.body || {}).body || '').trim().slice(0, 2000);
  if (!body) throw bad('Message vide.');
  const r = db.prepare('INSERT INTO messages(circle_id,body,created_by) VALUES(?,?,?)').run(cid, body, req.user.id);
  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(r.lastInsertRowid);
  emitTo(circleMemberIds(cid), { type: 'chat', message: msg });
  res.json(msg);
});

/* ───────────────────────── Notifications & flux temps réel ───────────────────────── */
api.get('/notifications', (req, res) => {
  res.json(db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50').all(req.user.id));
});
api.post('/notifications/read', (req, res) => {
  db.prepare('UPDATE notifications SET read=1 WHERE user_id=?').run(req.user.id);
  res.json({ ok: true });
});

api.get('/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 4000\n\n');
  if (!streams.has(req.user.id)) streams.set(req.user.id, new Set());
  streams.get(req.user.id).add(res);
  const hb = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(hb);
    const set = streams.get(req.user.id);
    if (set) { set.delete(res); if (!set.size) streams.delete(req.user.id); }
  });
});

/* ───────────────────────── Garde alternée ───────────────────────── */
api.get('/custody', (req, res) => {
  const { from, to } = req.query;
  if (!validDate(from) || !validDate(to)) throw bad('Période invalide.');
  if (parseD(to) - parseD(from) > 400 * 86400000) throw bad('Période trop longue.');
  const rows = db.prepare('SELECT date,child_id,parent_id FROM custody_nights WHERE date>=? AND date<=?').all(from, to);
  res.json(rows.filter((n) => canSeeChild(req.user, n.child_id)));
});

function setNights(dates, childIds, parentId) {
  const up = db.prepare('INSERT INTO custody_nights(date,child_id,parent_id) VALUES(?,?,?) ON CONFLICT(date,child_id) DO UPDATE SET parent_id=excluded.parent_id');
  const del = db.prepare('DELETE FROM custody_nights WHERE date=? AND child_id=?');
  db.transaction(() => {
    for (const d of dates) for (const c of childIds) (parentId ? up.run(d, c, parentId) : del.run(d, c));
  })();
}
function datesBetween(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
function checkChildren(ids, req) {
  if (!Array.isArray(ids) || !ids.length) throw bad('Choisissez au moins un enfant.');
  const list = ids.map(Number);
  if (!list.every(childExists)) throw bad('Enfant introuvable.');
  if (req && !list.every((id) => canEditChild(req.user, id))) throw new HttpError(403, "Vous n'avez qu'un accès en lecture à un des enfants sélectionnés.");
  return list;
}
// Un enfant sans parent désigné reste ouvert (n'importe qui peut lui être attribué, comme avant).
// Dès qu'au moins un parent est désigné, seuls eux peuvent se voir attribuer sa garde.
function isDesignatedParent(childId, userId) {
  const c = db.prepare('SELECT parent_ids FROM children WHERE id=?').get(childId);
  if (!c) return false;
  const pids = parseJ(c.parent_ids, []);
  return pids.length === 0 || pids.includes(userId);
}
function checkCustodyParent(childIds, userId) {
  if (userId !== null && !childIds.every((id) => isDesignatedParent(id, userId))) {
    throw bad("Cette personne n'est pas désignée comme parent d'un des enfants sélectionnés.");
  }
}

api.put('/custody', (req, res) => {
  const { date_from, date_to, child_ids, parent_id } = req.body || {};
  if (!validDate(date_from) || !validDate(date_to) || date_to < date_from) throw bad('Dates invalides.');
  const dates = datesBetween(date_from, date_to);
  if (dates.length > 400) throw bad('Période trop longue.');
  const kids = checkChildren(child_ids, req);
  if (parent_id !== null && parent_id !== undefined && !userExists(Number(parent_id))) throw bad('Parent introuvable.');
  if (parent_id !== null && parent_id !== undefined) checkCustodyParent(kids, Number(parent_id));
  setNights(dates, kids, parent_id ? Number(parent_id) : null);
  emitTo(db.prepare('SELECT id FROM users').all().map((u) => u.id), { type: 'refresh', what: 'custody' });
  res.json({ ok: true });
});

// Numéro de semaine ISO 8601 (semaines du lundi au dimanche, semaine 1 = celle contenant le premier jeudi de l'année).
function isoWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dayNum = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  return 1 + Math.round((dt - firstThursday) / (7 * 86400000));
}

const PATTERNS = {
  alternate_weeks: 'AAAAAAABBBBBBB',
  two_two_three: 'AABBAAABBAABBB',
  two_two_five_five: 'AABBAAAAABBBBB',
  weekends: 'BBAAAAAAAAAAAA',
};

api.post('/custody/generate', (req, res) => {
  const { pattern, sequence, child_ids, parent_a, parent_b, start, end, parent_a_weeks } = req.body || {};
  if (!validDate(start) || !validDate(end) || end < start) throw bad('Dates invalides.');
  const dates = datesBetween(start, end);
  if (dates.length > 800) throw bad('Période trop longue (800 jours maximum).');
  const kids = checkChildren(child_ids, req);
  const a = Number(parent_a); const b = Number(parent_b);
  if (!userExists(a) || !userExists(b) || a === b) throw bad('Choisissez deux parents différents.');
  checkCustodyParent(kids, a); checkCustodyParent(kids, b);
  let seq;
  if (pattern === 'halves') {
    const half = Math.ceil(dates.length / 2);
    seq = null;
    setNights(dates.slice(0, half), kids, a);
    setNights(dates.slice(half), kids, b);
  } else if (pattern === 'even_odd_weeks') {
    seq = null;
    const aIsEven = parent_a_weeks !== 'odd';
    setNights(dates.filter((d) => (isoWeek(d) % 2 === 0) === aIsEven), kids, a);
    setNights(dates.filter((d) => (isoWeek(d) % 2 === 0) !== aIsEven), kids, b);
  } else if (pattern === 'custom') {
    if (!/^[ABab]{1,60}$/.test(sequence || '')) throw bad('Séquence invalide : utilisez uniquement A et B (60 nuits maximum).');
    seq = sequence.toUpperCase();
  } else if (PATTERNS[pattern]) seq = PATTERNS[pattern];
  else throw bad('Modèle inconnu.');
  if (seq) {
    setNights(dates.filter((_, i) => seq[i % seq.length] === 'A'), kids, a);
    setNights(dates.filter((_, i) => seq[i % seq.length] === 'B'), kids, b);
  }
  emitTo(db.prepare('SELECT id FROM users').all().map((u) => u.id), { type: 'refresh', what: 'custody' });
  res.json({ nights: dates.length * kids.length });
});

function custodyStatsFor(user, like) {
  const out = {};
  for (const r of db.prepare('SELECT child_id,parent_id,COUNT(*) n FROM custody_nights WHERE date LIKE ? GROUP BY child_id,parent_id').all(like)) {
    if (!canSeeChild(user, r.child_id)) continue;
    (out[r.child_id] ||= {})[r.parent_id] = r.n;
  }
  return out;
}

api.get('/custody/stats', (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : nowLocal().slice(0, 7);
  const year = month.slice(0, 4);
  res.json({ month: custodyStatsFor(req.user, month + '-%'), year: custodyStatsFor(req.user, year + '-%') });
});

// Détail complet pour le popup de répartition : les 12 mois d'une année, et toutes les années
// pour lesquelles il existe au moins une nuit enregistrée (peu importe l'ancienneté).
api.get('/custody/stats/detail', (req, res) => {
  const year = /^\d{4}$/.test(req.query.year || '') ? req.query.year : nowLocal().slice(0, 4);
  const months = {};
  for (let m = 1; m <= 12; m++) {
    const key = `${year}-${String(m).padStart(2, '0')}`;
    months[key] = custodyStatsFor(req.user, key + '-%');
  }
  const years = {};
  for (const r of db.prepare("SELECT DISTINCT substr(date,1,4) y FROM custody_nights ORDER BY y").all()) {
    years[r.y] = custodyStatsFor(req.user, r.y + '-%');
  }
  res.json({ year, months, years });
});

/* Demandes d'échange de garde */
api.get('/swaps', (req, res) => {
  const rows = db.prepare('SELECT * FROM swap_requests WHERE requester_id=? OR recipient_id=? ORDER BY id DESC LIMIT 40').all(req.user.id, req.user.id);
  res.json(rows.map((r) => ({ ...r, child_ids: parseJ(r.child_ids, []) })));
});

api.post('/swaps', (req, res) => {
  const { recipient_id, child_ids, date_from, date_to, new_parent_id, message, location, time } = req.body || {};
  const rid = Number(recipient_id);
  if (!userExists(rid) || rid === req.user.id) throw bad('Destinataire invalide.');
  if (!validDate(date_from) || !validDate(date_to) || date_to < date_from) throw bad('Dates invalides.');
  if (time && !validTime(time)) throw bad('Heure invalide.');
  const kids = checkChildren(child_ids, req);
  const np = Number(new_parent_id);
  if (np !== req.user.id && np !== rid) throw bad('Le parent concerné doit être vous ou le destinataire.');
  checkCustodyParent(kids, np);
  const r = db.prepare('INSERT INTO swap_requests(requester_id,recipient_id,child_ids,date_from,date_to,new_parent_id,message,location,time) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(req.user.id, rid, JSON.stringify(kids), date_from, date_to, np, message ? String(message).trim().slice(0, 500) : null,
      location ? String(location).trim().slice(0, 200) : null, time || null);
  const detail = [location ? `Lieu : ${location}` : null, time ? `Heure : ${time}` : null].filter(Boolean).join(' · ');
  notify([rid], { kind: 'swap', title: `${req.user.name} demande un échange de garde`, body: `Du ${date_from} au ${date_to}${detail ? ' — ' + detail : ''}`, link: '#/garde' });
  emitTo([req.user.id, rid], { type: 'refresh', what: 'swaps' });
  res.json({ id: r.lastInsertRowid });
});

api.post('/swaps/:id/answer', (req, res) => {
  const s = db.prepare('SELECT * FROM swap_requests WHERE id=?').get(Number(req.params.id));
  if (!s || s.recipient_id !== req.user.id) throw new HttpError(404, 'Demande introuvable.');
  const accept = !!(req.body || {}).accept;
  const r = db.prepare("UPDATE swap_requests SET status=?, answered_at=datetime('now') WHERE id=? AND status='pending'").run(accept ? 'accepted' : 'declined', s.id);
  if (!r.changes) throw new HttpError(409, 'Cette demande a déjà été traitée.');
  if (accept) setNights(datesBetween(s.date_from, s.date_to), parseJ(s.child_ids, []).filter(childExists), s.new_parent_id);
  notify([s.requester_id], { kind: 'swap', title: `${req.user.name} a ${accept ? 'accepté' : 'refusé'} votre demande d'échange`, body: `Du ${s.date_from} au ${s.date_to}`, link: '#/garde' });
  emitTo(db.prepare('SELECT id FROM users').all().map((u) => u.id), { type: 'refresh', what: 'custody' });
  res.json({ ok: true });
});

api.post('/swaps/:id/cancel', (req, res) => {
  const s = db.prepare('SELECT * FROM swap_requests WHERE id=?').get(Number(req.params.id));
  if (!s || s.requester_id !== req.user.id) throw new HttpError(404, 'Demande introuvable.');
  const r = db.prepare("UPDATE swap_requests SET status='cancelled', answered_at=datetime('now') WHERE id=? AND status='pending'").run(s.id);
  if (!r.changes) throw new HttpError(409, 'Cette demande a déjà été traitée.');
  emitTo([s.requester_id, s.recipient_id], { type: 'refresh', what: 'swaps' });
  res.json({ ok: true });
});

/* ───────────────────────── SOS remplacement ───────────────────────── */
api.get('/sos', (req, res) => {
  const circles = myCircles(req.user.id);
  res.json(db.prepare(`SELECT * FROM sos WHERE circle_id IN (${placeholders(circles)})
    AND (status='open' OR created_at > datetime('now','-3 days')) ORDER BY id DESC`).all(...circles));
});

api.post('/sos', (req, res) => {
  const b = req.body || {};
  const cid = requireMember(req.user, b.circle_id);
  const title = coerce('s', b.title, 'titre');
  const r = db.prepare('INSERT INTO sos(circle_id,event_id,title,note,requested_by) VALUES(?,?,?,?,?)')
    .run(cid, Number.isInteger(b.event_id) ? b.event_id : null, title, b.note ? String(b.note).trim().slice(0, 500) : null, req.user.id);
  notify(circleMemberIds(cid), { kind: 'sos', title: `SOS remplacement : ${title}`, body: `${req.user.name} cherche quelqu'un`, link: '#/' }, req.user.id);
  emitTo(circleMemberIds(cid), { type: 'refresh', what: 'sos' });
  res.json({ id: r.lastInsertRowid });
});

api.post('/sos/:id/take', (req, res) => {
  const s = db.prepare('SELECT * FROM sos WHERE id=?').get(Number(req.params.id));
  if (!s) throw new HttpError(404, 'Introuvable.');
  requireMember(req.user, s.circle_id);
  if (s.requested_by === req.user.id) throw bad('Vous ne pouvez pas répondre à votre propre demande.');
  // Le premier qui accepte gagne : la mise à jour n'aboutit que si la demande est encore ouverte.
  const r = db.prepare("UPDATE sos SET status='taken', taken_by=?, taken_at=datetime('now') WHERE id=? AND status='open'").run(req.user.id, s.id);
  if (!r.changes) throw new HttpError(409, "Quelqu'un a déjà pris cette demande.");
  notify([s.requested_by], { kind: 'sos', title: `${req.user.name} vous remplace`, body: s.title, link: '#/' });
  emitTo(circleMemberIds(s.circle_id), { type: 'refresh', what: 'sos' });
  res.json({ ok: true });
});

api.post('/sos/:id/cancel', (req, res) => {
  const s = db.prepare('SELECT * FROM sos WHERE id=?').get(Number(req.params.id));
  if (!s || s.requested_by !== req.user.id) throw new HttpError(404, 'Introuvable.');
  db.prepare("UPDATE sos SET status='cancelled' WHERE id=? AND status='open'").run(s.id);
  emitTo(circleMemberIds(s.circle_id), { type: 'refresh', what: 'sos' });
  res.json({ ok: true });
});

/* ───────────────────────── Vacances scolaires ───────────────────────── */
/* ───────────────────────── Aide à la saisie d'adresse (OpenStreetMap Nominatim) ─────────────────────────
   Relayé par le serveur (plutôt qu'appelé directement depuis le navigateur) pour respecter l'usage
   raisonnable demandé par Nominatim (User-Agent identifiable, un seul appel à la fois) et ne pas avoir
   à autoriser un domaine externe dans la politique de sécurité du contenu de l'application. */
let geocodeInFlight = Promise.resolve();
// Construit une adresse courte au format postal habituel (« 12 rue de la Santé, 75013 Paris »)
// à partir du détail structuré renvoyé par Nominatim, plutôt que sa hiérarchie administrative
// complète (« ..., Quartier de la Santé, 13e Arrondissement, ..., France métropolitaine, ... ») —
// bien plus fiable une fois collée dans Waze, Google Maps ou Apple Plans.
function shortAddress(d) {
  const a = d.address || {};
  const street = [a.house_number, a.road || a.pedestrian || a.footway].filter(Boolean).join(' ');
  const city = a.city || a.town || a.village || a.municipality || a.suburb;
  const line2 = [a.postcode, city].filter(Boolean).join(' ');
  const short = [street, line2].filter(Boolean).join(', ');
  return short || d.display_name;
}

api.get('/geocode', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 200);
  if (q.length < 3) return res.json([]);
  const base = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org/search';
  const run = geocodeInFlight.then(async () => {
    const url = `${base}?format=jsonv2&addressdetails=1&limit=5&accept-language=fr&q=${encodeURIComponent(q)}`;
    const r = await fetch(url, { headers: { 'User-Agent': process.env.NOMINATIM_USER_AGENT || 'Mosaique-App-Familial-Self-Hosted/1.0' } });
    if (!r.ok) throw new Error('geocode http ' + r.status);
    const data = await r.json();
    return data.map((d) => ({ label: shortAddress(d), display_name: d.display_name, lat: d.lat, lon: d.lon }));
  });
  geocodeInFlight = run.catch(() => {}); // ne bloque pas les requêtes suivantes si celle-ci échoue
  // Une liste vide veut dire « aucun résultat » pour l'utilisateur : un vrai échec du service (mal
  // configuré, injoignable...) doit rester distinguable de ce cas, sinon impossible à diagnostiquer.
  try { res.json(await run); } catch (e) { console.error('geocode', e.message); throw new HttpError(502, "Service de recherche d'adresse indisponible."); }
});

api.get('/holidays', (req, res) => {
  const zone = ['A', 'B', 'C'].includes(req.query.zone) ? req.query.zone : 'B';
  res.json({ zone, periods: loadHolidays().filter((p) => p.zones.includes(zone)) });
});

/* Gestionnaire d'erreurs de l'API */
/* ───────────────────────── Recettes (optionnel) ───────────────────────── */
mountResource('recipes', 'recipes', {
  title: 's', description: 'text?', ingredients: 'text?', ingredients_json: 'ingredients', servings: 'i?', instructions: 'text?', rating_global: 'i?',
}, {
  order: 'ORDER BY title COLLATE NOCASE',
  decode: (r) => ({ ...r, child_ratings: parseJ(r.child_ratings, {}), ingredients_json: parseJ(r.ingredients_json, []) }),
  validate: (v) => {
    if (v.rating_global !== null && (v.rating_global < 1 || v.rating_global > 5)) throw bad('La note doit être comprise entre 1 et 5.');
    if (v.servings !== null && (v.servings < 1 || v.servings > 100)) throw bad('Le nombre de portions doit être compris entre 1 et 100.');
  },
  beforeUpdate: (row, b) => {
    if (b.rating_global !== undefined && b.rating_global !== null && (b.rating_global < 1 || b.rating_global > 5)) throw bad('La note doit être comprise entre 1 et 5.');
    if (b.servings !== undefined && b.servings !== null && (b.servings < 1 || b.servings > 100)) throw bad('Le nombre de portions doit être compris entre 1 et 100.');
  },
});

api.put('/recipes/:id/child-rating', (req, res) => {
  const row = db.prepare('SELECT * FROM recipes WHERE id=?').get(Number(req.params.id));
  if (!row) throw new HttpError(404, 'Introuvable.');
  requireMember(req.user, row.circle_id);
  const { child_id, rating } = req.body || {};
  if (!childExists(Number(child_id))) throw bad('Enfant introuvable.');
  const ratings = parseJ(row.child_ratings, {});
  if (rating === null || rating === undefined) delete ratings[child_id];
  else {
    const n = Number(rating);
    if (!Number.isInteger(n) || n < 1 || n > 5) throw bad('La note doit être comprise entre 1 et 5.');
    ratings[child_id] = n;
  }
  db.prepare('UPDATE recipes SET child_ratings=? WHERE id=?').run(JSON.stringify(ratings), row.id);
  emitTo(circleMemberIds(row.circle_id), { type: 'refresh', what: 'recipes' });
  res.json({ ok: true });
});

api.use((req, res) => res.status(404).json({ error: 'Route inconnue.' }));
api.use((err, _req, res, _next) => {
  if (!(err instanceof HttpError)) {
    if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Fichier trop volumineux.' : 'Envoi de fichier impossible.' });
    console.error(err);
    return res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
  res.status(err.status).json({ error: err.message });
});

/* ───────────────────────── Agenda iCal (abonnement) ───────────────────────── */
const icsEsc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsDate = (s) => s.slice(0, 10).replace(/-/g, '');
const icsDT = (s) => `${icsDate(s)}T${s.slice(11, 13)}${s.slice(14, 16)}00`;
const fold = (line) => { const out = []; let l = line; while (l.length > 73) { out.push(l.slice(0, 73)); l = ' ' + l.slice(73); } out.push(l); return out.join('\r\n'); };

app.get('/ical/:token', (req, res) => {
  const token = req.params.token.replace(/\.ics$/, '');
  const u = db.prepare('SELECT * FROM users WHERE ical_token=?').get(token);
  if (!u) return res.status(404).send('Introuvable');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Mosaique//FR', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${icsEsc(getSetting('family_name', 'Mosaïque'))}`];
  const circles = myCircles(u.id);
  const evs = db.prepare(`SELECT * FROM events WHERE circle_id IN (${placeholders(circles)})`).all(...circles);
  for (const e of evs) {
    L.push('BEGIN:VEVENT', `UID:ev-${e.id}@mosaique`, `DTSTAMP:${stamp}`, `SUMMARY:${icsEsc(e.title)}`);
    const allDay = e.all_day || e.starts_at.length === 10;
    if (allDay) {
      L.push(`DTSTART;VALUE=DATE:${icsDate(e.starts_at)}`, `DTEND;VALUE=DATE:${icsDate(addDays((e.ends_at || e.starts_at).slice(0, 10), 1))}`);
    } else {
      L.push(`DTSTART:${icsDT(e.starts_at)}`, `DTEND:${icsDT(e.ends_at && e.ends_at.length > 10 ? e.ends_at : e.starts_at)}`);
    }
    if (e.location) L.push(`LOCATION:${icsEsc(e.location)}`);
    if (e.notes) L.push(`DESCRIPTION:${icsEsc(e.notes)}`);
    if (e.repeat !== 'none') {
      const freq = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY' }[e.repeat];
      L.push(`RRULE:FREQ=${freq}${e.repeat_until ? `;UNTIL=${icsDate(addDays(e.repeat_until, 1))}` : ''}`);
    }
    L.push('END:VEVENT');
  }
  // Nuits de garde regroupées par périodes consécutives
  const today = nowLocal().slice(0, 10);
  const nights = db.prepare('SELECT * FROM custody_nights WHERE date>=? ORDER BY child_id,date').all(addDays(today, -30));
  const kids = Object.fromEntries(db.prepare('SELECT id,name FROM children').all().map((c) => [c.id, c.name]));
  const names = Object.fromEntries(db.prepare('SELECT id,name FROM users').all().map((x) => [x.id, x.name]));
  let cur = null;
  const flush = () => {
    if (!cur) return;
    L.push('BEGIN:VEVENT', `UID:garde-${cur.child}-${cur.start}@mosaique`, `DTSTAMP:${stamp}`,
      `SUMMARY:${icsEsc(`${kids[cur.child]} chez ${names[cur.parent]}`)}`,
      `DTSTART;VALUE=DATE:${icsDate(cur.start)}`, `DTEND;VALUE=DATE:${icsDate(addDays(cur.end, 1))}`, 'TRANSP:TRANSPARENT', 'END:VEVENT');
  };
  for (const n of nights) {
    if (cur && cur.child === n.child_id && cur.parent === n.parent_id && addDays(cur.end, 1) === n.date) cur.end = n.date;
    else { flush(); cur = { child: n.child_id, parent: n.parent_id, start: n.date, end: n.date }; }
  }
  flush();
  L.push('END:VCALENDAR');
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.send(L.map(fold).join('\r\n') + '\r\n');
});

/* ───────────────────────── Présence (Home Assistant, etc.) ───────────────────────── */
// Utilise le même jeton personnel que l'abonnement iCal. Pour chaque enfant visible par
// la personne qui interroge, indique si la nuit d'aujourd'hui lui est attribuée (« home »)
// et, à titre indicatif, le nom du parent concerné. « home » vaut null si rien n'est renseigné
// pour aujourd'hui (mieux vaut ne pas déclencher une automatisation que se tromper).
app.get('/presence/:token', (req, res) => {
  const token = req.params.token.replace(/\.json$/, '');
  const u = db.prepare('SELECT * FROM users WHERE ical_token=?').get(token);
  if (!u) return res.status(404).json({ error: 'Jeton invalide.' });
  const date = nowLocal().slice(0, 10);
  const children = db.prepare('SELECT * FROM children ORDER BY id').all()
    .filter((c) => childVisible(u, c))
    .map((c) => {
      const night = db.prepare('SELECT parent_id FROM custody_nights WHERE date=? AND child_id=?').get(date, c.id);
      const withUser = night ? db.prepare('SELECT name FROM users WHERE id=?').get(night.parent_id) : null;
      return { id: c.id, name: c.name, home: night ? night.parent_id === u.id : null, with: withUser ? withUser.name : null };
    });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.json({ family: getSetting('family_name', 'Ma famille'), as: u.name, date, children });
});


/* ───────────────────────── École : réception des devoirs et mots (Pronote via Home Assistant, etc.) ─────────────────────────
   Jeton unique à toute la famille (Réglages → intégration École), distinct des jetons personnels ci-dessus :
   écrire des devoirs/mots est une action plus sensible que les lire, donc réservée à un jeton que seul un
   administrateur peut générer. Voir le README pour un exemple concret avec Home Assistant. */
function matchChildByName(name) {
  if (!name) return null;
  const n = String(name).trim().toLowerCase();
  return db.prepare('SELECT * FROM children').all().find((c) => c.name.toLowerCase() === n) || null;
}
function resolveImportChild(item) {
  if (item && item.child_id !== undefined) return db.prepare('SELECT * FROM children WHERE id=?').get(Number(item.child_id)) || null;
  return matchChildByName(item && item.child);
}
function upsertHomework(childId, item) {
  const title = item && String(item.title || '').trim().slice(0, 200);
  if (!title) return { ok: false, error: 'Titre requis.' };
  const src = (item.source && String(item.source).slice(0, 40)) || 'pronote';
  const subject = item.subject ? String(item.subject).trim().slice(0, 80) : null;
  const description = item.description ? String(item.description).trim().slice(0, 4000) : null;
  const due = item.due_date && validDate(item.due_date) ? item.due_date : null;
  const extId = item.external_id ? String(item.external_id).slice(0, 200) : null;
  if (extId) {
    const existing = db.prepare('SELECT id FROM homework WHERE child_id=? AND source=? AND external_id=?').get(childId, src, extId);
    if (existing) {
      db.prepare("UPDATE homework SET subject=?, title=?, description=?, due_date=?, updated_at=datetime('now') WHERE id=?")
        .run(subject, title, description, due, existing.id);
      return { ok: true, id: existing.id, updated: true };
    }
  }
  const r = db.prepare('INSERT INTO homework(child_id,subject,title,description,due_date,source,external_id) VALUES(?,?,?,?,?,?,?)')
    .run(childId, subject, title, description, due, src, extId);
  return { ok: true, id: r.lastInsertRowid, updated: false };
}
function upsertNote(childId, item) {
  const title = item && String(item.title || '').trim().slice(0, 200);
  if (!title) return { ok: false, error: 'Titre requis.' };
  const src = (item.source && String(item.source).slice(0, 40)) || 'pronote';
  const body = item.body ? String(item.body).trim().slice(0, 4000) : null;
  const date = item.date && validDate(item.date) ? item.date : nowLocal().slice(0, 10);
  const extId = item.external_id ? String(item.external_id).slice(0, 200) : null;
  if (extId) {
    const existing = db.prepare('SELECT id FROM school_notes WHERE child_id=? AND source=? AND external_id=?').get(childId, src, extId);
    if (existing) return { ok: true, id: existing.id, updated: true };
  }
  const r = db.prepare('INSERT INTO school_notes(child_id,title,body,date,source,external_id) VALUES(?,?,?,?,?,?)')
    .run(childId, title, body, date, src, extId);
  return { ok: true, id: r.lastInsertRowid, updated: false };
}
// Une facture n'est pas liée à un enfant mais à un cercle : par nom (comme pour un enfant), par id,
// ou — cas le plus courant, une seule famille — le cercle unique du système s'il n'y en a qu'un.
function resolveImportCircle(item) {
  if (item && item.circle_id !== undefined) return db.prepare('SELECT * FROM circles WHERE id=?').get(Number(item.circle_id)) || null;
  if (item && item.circle) {
    const n = String(item.circle).trim().toLowerCase();
    return db.prepare('SELECT * FROM circles').all().find((c) => c.name.toLowerCase() === n) || null;
  }
  const all = db.prepare('SELECT * FROM circles').all();
  return all.length === 1 ? all[0] : null;
}
function upsertReservation(childId, item) {
  const title = item && String(item.title || '').trim().slice(0, 200);
  if (!title) return { ok: false, error: 'Titre requis.' };
  if (!item.date || !validDate(item.date)) return { ok: false, error: 'Date invalide.' };
  const src = (item.source && String(item.source).slice(0, 40)) || 'eportail';
  const startTime = item.start_time && validTime(item.start_time) ? item.start_time : null;
  const endTime = item.end_time && validTime(item.end_time) ? item.end_time : null;
  const status = item.status ? String(item.status).trim().slice(0, 80) : null;
  const extId = item.external_id ? String(item.external_id).slice(0, 200) : null;
  if (extId) {
    const existing = db.prepare('SELECT id FROM school_reservations WHERE child_id=? AND source=? AND external_id=?').get(childId, src, extId);
    if (existing) {
      db.prepare("UPDATE school_reservations SET title=?, date=?, start_time=?, end_time=?, status=?, updated_at=datetime('now') WHERE id=?")
        .run(title, item.date, startTime, endTime, status, existing.id);
      return { ok: true, id: existing.id, updated: true };
    }
  }
  const r = db.prepare('INSERT INTO school_reservations(child_id,title,date,start_time,end_time,status,source,external_id) VALUES(?,?,?,?,?,?,?,?)')
    .run(childId, title, item.date, startTime, endTime, status, src, extId);
  return { ok: true, id: r.lastInsertRowid, updated: false };
}
// circleId peut être null (cercle pas deviné à l'import — plusieurs cercles, aucune indication
// suffisante) : la facture est quand même enregistrée, « en attente d'attribution » (voir
// GET /invoices et PUT /invoices/:id/attribute), plutôt que perdue silencieusement comme avant.
// childId est facultatif (utile dès qu'on suit plusieurs enfants) et peut rester null aussi.
function upsertInvoice(circleId, childId, item) {
  const label = item && String(item.label || '').trim().slice(0, 200);
  if (!label) return { ok: false, error: 'Libellé requis.' };
  if (!item.date || !validDate(item.date)) return { ok: false, error: 'Date invalide.' };
  const number = item.number ? String(item.number).trim().slice(0, 80) : '';
  if (!number) return { ok: false, error: 'Numéro requis.' };
  // Montant accepté en euros (ex. 134.20, comme affiché sur le portail) ou directement en centimes.
  const amountCents = item.amount_cents !== undefined ? Number(item.amount_cents) : Math.round(Number(item.amount) * 100);
  if (!Number.isInteger(amountCents) || amountCents <= 0) return { ok: false, error: 'Montant invalide.' };
  const src = (item.source && String(item.source).slice(0, 40)) || 'eportail';
  const due = item.due_date && validDate(item.due_date) ? item.due_date : null;
  const status = item.status ? String(item.status).trim().slice(0, 80) : null;
  const extId = item.external_id ? String(item.external_id).slice(0, 200) : null;
  if (extId) {
    const existing = circleId == null
      ? db.prepare('SELECT id FROM invoices WHERE circle_id IS NULL AND source=? AND external_id=?').get(src, extId)
      : db.prepare('SELECT id FROM invoices WHERE circle_id=? AND source=? AND external_id=?').get(circleId, src, extId);
    if (existing) {
      db.prepare("UPDATE invoices SET label=?, number=?, date=?, due_date=?, amount_cents=?, status=?, updated_at=datetime('now') WHERE id=?")
        .run(label, number, item.date, due, amountCents, status, existing.id);
      return { ok: true, id: existing.id, updated: true };
    }
  }
  const r = db.prepare('INSERT INTO invoices(circle_id,child_id,label,number,date,due_date,amount_cents,status,source,external_id) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(circleId, childId, label, number, item.date, due, amountCents, status, src, extId);
  return { ok: true, id: r.lastInsertRowid, updated: false };
}
function checkImportToken(req, res) {
  const token = getSetting('integration_token', null);
  if (!token || req.params.token !== token) { res.status(404).json({ error: 'Jeton invalide.' }); return false; }
  return true;
}

// Applique le résultat d'un addon (server/addons/*.js) exactement comme un import manuel : même
// résolution enfant/cercle, même upsert par external_id. Un addon n'a donc pas besoin de connaître
// la base de données de Mosaïque, seulement de retourner des éléments au même format.
function applyAddonResult({ reservations = [], invoices = [], reservationsWindow } = {}) {
  const r = reservations.map((item) => {
    const child = resolveImportChild(item);
    return child ? upsertReservation(child.id, item) : { ok: false, error: 'Enfant introuvable.' };
  });
  // Un addon qui déclare la fenêtre de dates qu'il vient de couvrir (reservationsWindow) nous
  // permet de supprimer ce qui n'y figure plus — annulé depuis la dernière synchronisation, ou (cas
  // qui a motivé cet ajout) importé par erreur par une version antérieure de l'addon. Sans cette
  // déclaration explicite, on ne supprime rien : un import manuel ou un addon plus simple peut très
  // bien ne renvoyer qu'un sous-ensemble sans que le reste soit pour autant obsolète.
  if (reservationsWindow && reservationsWindow.source && reservationsWindow.from && reservationsWindow.to) {
    const keep = new Set(reservations.filter((it) => it.source === reservationsWindow.source && it.external_id).map((it) => it.external_id));
    const stale = db.prepare('SELECT id, external_id FROM school_reservations WHERE source=? AND date>=? AND date<=?')
      .all(reservationsWindow.source, reservationsWindow.from, reservationsWindow.to);
    for (const row of stale) {
      if (!row.external_id || !keep.has(row.external_id)) db.prepare('DELETE FROM school_reservations WHERE id=?').run(row.id);
    }
  }
  const f = invoices.map((item) => {
    const circle = resolveImportCircle(item);
    const child = resolveImportChild(item);
    return upsertInvoice(circle ? circle.id : null, child ? child.id : null, item);
  });
  return { reservations: r, invoices: f };
}
async function runAddonSync(id) {
  const addon = addonManager.find(id);
  if (!addon) throw new HttpError(404, 'Addon inconnu.');
  if (!addonManager.isEnabled(id)) throw new HttpError(400, "Cet addon n'est pas activé.");
  const raw = await addon.sync(addonManager.configOf(id));
  const applied = applyAddonResult(raw);
  addonManager.recordSyncOk(id);
  return applied;
}
// Synchronisation automatique, environ une fois par heure, de tout addon activé (voir tick()).
// Les erreurs (site indisponible, identifiants invalides…) sont journalisées et affichées dans
// Réglages, sans jamais interrompre le reste de Mosaïque.
async function maybeSyncAddons() {
  for (const a of addonManager.list()) {
    if (!a.enabled) continue;
    const last = a.last_sync_at ? new Date(a.last_sync_at).getTime() : 0;
    if (Date.now() - last < 55 * 60 * 1000) continue;
    try { await runAddonSync(a.id); } catch (e) { addonManager.recordSyncError(a.id, e.message); console.error(`Addon ${a.id} :`, e.message); }
  }
}
app.post('/import/:token/homework', (req, res) => {
  if (!checkImportToken(req, res)) return;
  const items = Array.isArray(req.body) ? req.body : [req.body];
  const results = items.map((item) => {
    const child = resolveImportChild(item);
    if (!child) return { ok: false, error: 'Enfant introuvable.' };
    return upsertHomework(child.id, item);
  });
  res.json({ results });
});
app.post('/import/:token/note', (req, res) => {
  if (!checkImportToken(req, res)) return;
  const items = Array.isArray(req.body) ? req.body : [req.body];
  const results = items.map((item) => {
    const child = resolveImportChild(item);
    if (!child) return { ok: false, error: 'Enfant introuvable.' };
    return upsertNote(child.id, item);
  });
  res.json({ results });
});
app.post('/import/:token/reservation', (req, res) => {
  if (!checkImportToken(req, res)) return;
  const items = Array.isArray(req.body) ? req.body : [req.body];
  const results = items.map((item) => {
    const child = resolveImportChild(item);
    if (!child) return { ok: false, error: 'Enfant introuvable.' };
    return upsertReservation(child.id, item);
  });
  res.json({ results });
});
app.post('/import/:token/facture', (req, res) => {
  if (!checkImportToken(req, res)) return;
  const items = Array.isArray(req.body) ? req.body : [req.body];
  const results = items.map((item) => {
    const circle = resolveImportCircle(item);
    const child = resolveImportChild(item);
    return upsertInvoice(circle ? circle.id : null, child ? child.id : null, item);
  });
  res.json({ results });
});

/* ───────────────────────── Fichiers statiques ───────────────────────── */
app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: 0,
  setHeaders: (res, file) => {
    if (/\.woff2$/.test(file)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    if (/\.webmanifest$/.test(file)) res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    if (/\/sw\.js$/.test(file)) res.setHeader('Cache-Control', 'no-cache'); // toujours revérifier une mise à jour du service worker
  },
}));

/* Erreurs hors routeur API (CSRF, JSON invalide…) */
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err instanceof HttpError || status < 500 ? err.message : 'Erreur interne du serveur.' });
});

/* ───────────────────────── Tâches planifiées ───────────────────────── */
// Interprète une chaîne "YYYY-MM-DDTHH:MM" comme une heure locale explicite, plutôt que de laisser
// le moteur JS deviner (évite toute ambiguïté de fuseau horaire lors du calcul du rappel).
function parseLocalDateTime(s) {
  const [datePart, timePart] = String(s).split('T');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi] = (timePart || '00:00').split(':').map(Number);
  return new Date(y, mo - 1, d, h, mi || 0);
}

// Rappels d'événements (façon Google Agenda) : à chaque passage, on déplie les occurrences des
// prochains jours (une série récurrente doit recevoir un rappel à CHAQUE occurrence, pas une seule
// fois pour toute la série) et on notifie dès que l'heure du rappel est atteinte, une seule fois
// par occurrence grâce à event_reminders_sent.
function checkEventReminders() {
  const rows = db.prepare('SELECT * FROM events WHERE reminder_minutes IS NOT NULL').all();
  if (!rows.length) return;
  const from = nowLocal().slice(0, 10);
  // Le rappel le plus lointain proposé dans l'agenda est "1 semaine avant" (voir REMINDERS côté client) :
  // pas besoin de déplier un mois d'occurrences récurrentes à chaque passage, 8 jours suffisent largement.
  const to = addDays(from, 8);
  const nights = db.prepare('SELECT date, child_id, parent_id FROM custody_nights WHERE date BETWEEN ? AND ?').all(from, to);
  const custodyMap = {};
  for (const n of nights) custodyMap[`${n.date}|${n.child_id}`] = n.parent_id;
  const occurrences = expandEvents(rows, from, to, custodyMap);
  const now = Date.now();
  for (const occ of occurrences) {
    const startMs = parseLocalDateTime(occ.starts_at).getTime();
    const remindMs = startMs - occ.reminder_minutes * 60000;
    if (remindMs > now) continue; // pas encore l'heure
    if (now - startMs > 3600000) continue; // événement passé depuis plus d'une heure : trop tard, on ne relance pas après coup
    if (db.prepare('SELECT 1 FROM event_reminders_sent WHERE event_id=? AND occurrence_date=?').get(occ.id, occ.occ_date)) continue;
    // occ.owner_id est déjà résolu pour cette occurrence (y compris en mode auto) par expandEvents ;
    // on y ajoute la personne chargée du dépôt et/ou de la récupération, si elle est différente.
    const extra = [occ.dropoff_by, occ.pickup_by].filter(Boolean);
    const targets = (occ.owner_id || extra.length) ? [...new Set([occ.owner_id, ...extra].filter(Boolean))] : circleMemberIds(occ.circle_id);
    const when = occ.all_day ? 'Toute la journée' : occ.starts_at.replace('T', ' à ');
    notify(targets, { kind: 'event', title: `Rappel : ${occ.title}`, body: [when, occ.location].filter(Boolean).join(' · '), link: '#/agenda' });
    db.prepare('INSERT OR IGNORE INTO event_reminders_sent(event_id, occurrence_date) VALUES (?,?)').run(occ.id, occ.occ_date);
  }
}

function tick() {
  try {
    const due = db.prepare('SELECT * FROM tasks WHERE done=0 AND reminded=0 AND remind_at IS NOT NULL AND remind_at<=?').all(nowLocal());
    for (const t of due) {
      const targets = t.assignee_id ? [t.assignee_id] : circleMemberIds(t.circle_id);
      notify(targets, { kind: 'task', title: `Rappel : ${t.title}`, body: t.due ? `À faire pour le ${t.due.replace('T', ' à ')}` : null, link: '#/taches' });
      db.prepare('UPDATE tasks SET reminded=1 WHERE id=?').run(t.id);
    }
    db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
    db.prepare('DELETE FROM invites WHERE expires_at<?').run(Date.now());
    maybeSendDailyRecap();
    maybeSendReservationRecap();
    maybeSendHolidayNotices();
    checkEventReminders();
    generateRecurringExpenses();
    maybeSyncAddons().catch((e) => console.error('maybeSyncAddons', e));
  } catch (e) { console.error('tick', e); }
}

// Récap quotidien École (devoirs/mots) : envoyé au plus une fois par jour, seulement s'il y a
// effectivement du nouveau, et seulement aux personnes qui l'ont explicitement demandé.
function maybeSendDailyRecap() {
  if (!mailer.configured() || getSetting('pronote_enabled', 'false') !== 'true') return;
  const todayStr = nowLocal().slice(0, 10);
  if (getSetting('last_recap_date', '') === todayStr) return;
  const hour = Number(getSetting('recap_hour', '18'));
  if (new Date().getHours() < hour) return;
  const newHomework = db.prepare("SELECT * FROM homework WHERE date(created_at)=date('now','localtime') OR date(updated_at)=date('now','localtime')").all();
  const newNotes = db.prepare("SELECT * FROM school_notes WHERE date(created_at)=date('now','localtime')").all();
  if (newHomework.length || newNotes.length) {
    const childName = (id) => { const c = db.prepare('SELECT name FROM children WHERE id=?').get(id); return c ? c.name : '?'; };
    for (const u of db.prepare('SELECT * FROM users WHERE homework_recap=1').all()) {
      const hw = newHomework.filter((h) => canSeeChild(u, h.child_id));
      const notes = newNotes.filter((n) => canSeeChild(u, n.child_id));
      if (!hw.length && !notes.length) continue;
      const lines = [
        ...hw.map((h) => `- [${childName(h.child_id)}] ${h.subject ? h.subject + ' — ' : ''}${h.title}${h.due_date ? ' (pour le ' + h.due_date + ')' : ''}`),
        ...notes.map((n) => `- [${childName(n.child_id)}] Mot de l'école : ${n.title}`),
      ];
      const url = mailer.link('#/ecole');
      mailer.sendMail({ to: u.email, subject: 'Mosaïque — nouveautés École du jour', text: `Bonjour ${u.name},\n\nVoici les nouveautés du jour :\n\n${lines.join('\n')}${url ? `\n\nVoir dans Mosaïque : ${url}` : ''}` });
    }
  }
  setSetting('last_recap_date', todayStr);
}

const frDate = (d) => d.split('-').reverse().join('/');

// Enfants « suivis » pour les réservations périscolaires : au moins une réservation déjà reçue un
// jour (par un addon ou l'import manuel) — filtre commun au rappel du jeudi soir et à la notification
// « vacances réservables » ci-dessous, pour ne jamais solliciter une famille qui n'utilise pas ça.
function trackedReservationChildren() {
  return db.prepare('SELECT DISTINCT child_id FROM school_reservations').all()
    .map((r) => db.prepare('SELECT * FROM children WHERE id=?').get(r.child_id)).filter(Boolean);
}
// Qui prévenir pour un enfant donné (hors événement) : ses parents désignés, ou tout le monde si
// aucun n'est désigné (même règle que la visibilité de l'enfant, voir canSeeChild).
function childNotifyTargets(childId) {
  const c = db.prepare('SELECT parent_ids FROM children WHERE id=?').get(childId);
  const pids = c ? parseJ(c.parent_ids, []) : [];
  return pids.length ? pids : db.prepare('SELECT id FROM users').all().map((u) => u.id);
}
// Classement sommaire d'une réservation pour la phrase de résumé ci-dessous — même logique que
// public/js/ecole.js, dupliquée volontairement ici (petite fonction pure : pas besoin d'un module
// partagé entre client et serveur pour ça, voir equalSplit/splitEqually pour le même choix).
function reservationKind(r) {
  const t = (r.title || '').toLowerCase();
  if (/cantine|repas|dejeuner|déjeuner|midi/.test(t)) return 'cantine';
  if (/alsh|loisirs|journee|journée/.test(t)) return 'alsh';
  if (/garderie|accueil|periscolaire|périscolaire/.test(t)) return (r.start_time && r.start_time < '12:00') ? 'garderie_matin' : 'garderie_soir';
  return 'autre';
}

const WEEKDAY_NAMES = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi'];
// Les 5 jours ouvrés de la semaine suivant une date de référence (le jeudi d'envoi, concrètement).
function nextWeekWeekdays(fromDateStr) {
  const dow = (new Date(parseD(fromDateStr)).getUTCDay() + 6) % 7; // 0 = lundi
  const nextMonday = addDays(fromDateStr, 7 - dow);
  return Array.from({ length: 5 }, (_, i) => addDays(nextMonday, i));
}
const RESA_SENTENCE = {
  none: "rien n'est encore réservé",
  cantine: 'seuls les midis sont réservés (cantine)',
  garderie: 'seule la garderie (matin et soir) est réservée, sans la cantine',
  garderie_matin: 'seule la garderie du matin est réservée',
  garderie_soir: 'seule la garderie du soir est réservée',
  journee: 'tout est réservé en journée complète (cantine et garderie)',
};
const RESA_LIST_LABEL = {
  none: 'rien de réservé', cantine: 'cantine', garderie: 'garderie (matin et soir)',
  garderie_matin: 'garderie matin', garderie_soir: 'garderie soir', journee: 'journée complète (cantine et garderie)',
};
// Résumé en une phrase (cas simples) ou en liste jour par jour (sinon), pour un sous-ensemble de
// jours donné — un parent ne voit que les jours où il/elle aura l'enfant la semaine prochaine.
function summarizeReservationDays(childId, dates) {
  const labelFor = (d) => {
    const kinds = new Set(db.prepare('SELECT * FROM school_reservations WHERE child_id=? AND date=?').all(childId, d).map(reservationKind));
    if (kinds.has('cantine') && (kinds.has('alsh') || (kinds.has('garderie_matin') && kinds.has('garderie_soir')))) return 'journee';
    if (kinds.has('cantine')) return 'cantine';
    if (kinds.has('garderie_matin') && kinds.has('garderie_soir')) return 'garderie';
    if (kinds.has('garderie_matin')) return 'garderie_matin';
    if (kinds.has('garderie_soir')) return 'garderie_soir';
    return 'none';
  };
  const labels = dates.map(labelFor);
  const dayName = (d) => WEEKDAY_NAMES[(new Date(parseD(d)).getUTCDay() + 6) % 7];
  if (labels.every((l) => l === labels[0])) return `Actuellement, ${RESA_SENTENCE[labels[0]]}.`;
  // Cas fréquent : une base de cantine la plupart des jours, avec un ou deux jours « en plus » réservés
  // en journée complète (ex. le mercredi, sans école l'après-midi) — seul autre motif reconnu en
  // phrase ; toute autre combinaison repart sur la liste jour par jour.
  const base = labels.filter((l) => l === 'cantine').length;
  const upgraded = dates.filter((d, i) => labels[i] === 'journee');
  if (upgraded.length && base + upgraded.length === labels.length && base >= upgraded.length) {
    return `Actuellement, les midis sont réservés, ainsi que toute la journée du ${upgraded.map(dayName).join(' et du ')}.`;
  }
  return dates.map((d, i) => `- ${dayName(d)} : ${RESA_LIST_LABEL[labels[i]]}`).join('\n');
}

// Rappel du jeudi soir : pour chaque enfant suivi, qui aura l'enfant chaque jour de la semaine
// prochaine (garde alternée, jour par jour si elle change en cours de semaine), avec un résumé de ce
// qui est déjà réservé pour ces jours-là. Les jours de vacances scolaires (zone de l'enfant) sont
// exclus : ils ont leur propre notification (voir maybeSendHolidayNotices ci-dessous).
function maybeSendReservationRecap() {
  if (new Date().getDay() !== 4) return; // jeudi
  const todayStr = nowLocal().slice(0, 10);
  if (getSetting('last_resa_recap_date', '') === todayStr) return;
  if (new Date().getHours() < Number(getSetting('reservation_recap_hour', '19'))) return;
  for (const child of trackedReservationChildren()) {
    const holidays = loadHolidays().filter((p) => p.zones.includes(child.zone));
    const weekdays = nextWeekWeekdays(todayStr).filter((d) => !holidays.some((p) => d >= p.start && d < p.end));
    if (!weekdays.length) continue; // toute la semaine prochaine tombe en vacances pour cet enfant
    const byParent = {};
    for (const d of weekdays) {
      const night = db.prepare('SELECT parent_id FROM custody_nights WHERE child_id=? AND date=?').get(child.id, d);
      const targets = (child.shared_custody && night) ? [night.parent_id] : childNotifyTargets(child.id);
      for (const uid of targets) (byParent[uid] ||= []).push(d);
    }
    for (const [uid, dates] of Object.entries(byParent)) {
      const body = `${child.name} — semaine du ${frDate(dates[0])} au ${frDate(dates[dates.length - 1])} :\n\n${summarizeReservationDays(child.id, dates)}\n\nPensez à réserver cantine/garderie si besoin.`;
      notify([Number(uid)], { kind: 'reservation', title: `Réservations périscolaires : ${child.name}`, body, link: '#/ecole' });
    }
  }
  setSetting('last_resa_recap_date', todayStr);
}

// Notification « vacances réservables » : le portail n'expose aucun signal fiable d'ouverture des
// réservations (voir server/addons/README.md — vérifié en direct sur un vrai portail), donc on
// estime la date d'ouverture à N semaines avant le début des prochaines vacances (réglable, Réglages
// → Administration). Première notification à cette date estimée, puis un rappel une semaine après,
// seulement si rien n'est encore réservé pour cette période (pour ne pas relancer pour rien).
function maybeSendHolidayNotices() {
  const weeks = Number(getSetting('holiday_notice_weeks', '3'));
  const todayStr = nowLocal().slice(0, 10);
  for (const child of trackedReservationChildren()) {
    const next = loadHolidays().filter((p) => p.zones.includes(child.zone) && p.name !== 'Été' && p.start > todayStr)
      .sort((a, b) => a.start.localeCompare(b.start))[0];
    if (!next) continue;
    const periodKey = `${next.name}-${next.start}`;
    const openDate = addDays(next.start, -7 * weeks);
    const reminderDate = addDays(openDate, 7);
    const sent = (stage) => !!db.prepare('SELECT 1 FROM holiday_notices WHERE child_id=? AND period_key=? AND stage=?').get(child.id, periodKey, stage);
    const markSent = (stage) => db.prepare('INSERT OR IGNORE INTO holiday_notices(child_id,period_key,stage) VALUES(?,?,?)').run(child.id, periodKey, stage);
    const when = `du ${frDate(next.start)} au ${frDate(addDays(next.end, -1))}`;
    if (todayStr >= openDate && !sent('opened')) {
      notify(childNotifyTargets(child.id), {
        kind: 'reservation', title: `Vacances de ${next.name} : pensez à réserver`,
        body: `Les réservations pour les vacances de ${next.name} (${when}) sont probablement ouvertes — pensez à réserver cantine/garderie/ALSH pour ${child.name} si besoin.`,
        link: '#/ecole',
      });
      markSent('opened');
    }
    if (todayStr >= reminderDate && !sent('reminded')) {
      const already = db.prepare('SELECT 1 FROM school_reservations WHERE child_id=? AND date>=? AND date<?').get(child.id, next.start, next.end);
      if (!already) {
        notify(childNotifyTargets(child.id), {
          kind: 'reservation', title: `Vacances de ${next.name} : rien n'est encore réservé`,
          body: `Pour ${child.name}, rien n'est encore réservé pour les vacances de ${next.name} (${when}). Pensez-y si besoin.`,
          link: '#/ecole',
        });
      }
      markSent('reminded'); // qu'on ait relancé ou non : pas de 3e tentative pour cette période
    }
  }
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  setInterval(tick, 30000);
  app.listen(port, '0.0.0.0', () => console.log(`Mosaïque écoute sur le port ${port}`));
  startAutoRefresh();
}

module.exports = { app, tick };
