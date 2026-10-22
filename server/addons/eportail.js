'use strict';
// Addon « e-portail » (Berger-Levrault) : réservations (garderie, cantine, ALSH…) et factures
// périscolaires. Modèle pour qui voudrait écrire un addon pour un autre site de réservation —
// voir le README de ce dossier (server/addons/README.md).
//
// Mosaïque garde vos identifiants (chiffrement du disque mis à part, comme le mot de passe SMTP
// déjà stocké de la même façon) : lisez le README principal, section « Modules complémentaires »,
// si vous préférez ne pas les lui confier et utiliser plutôt un script externe.
const https = require('https');
const http = require('http');
const { URL } = require('url');
const cheerio = require('cheerio');

const DAYS_BEFORE = 3;
const DAYS_AFTER = 45;

/* ───────────────────────── Petit client HTTP avec cookies, propre à cette synchronisation ─────────────────────────
   On utilise http(s) directement plutôt que fetch : fetch fusionne les en-têtes Set-Cookie multiples
   en une seule chaîne peu fiable à découper (les dates d'expiration contiennent elles-mêmes des
   virgules), alors que le module http de Node les expose déjà sous forme de tableau. */
function makeClient() {
  const jar = new Map();
  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  function storeCookies(headers) {
    const raw = headers['set-cookie'];
    if (!raw) return;
    for (const line of raw) { const m = /^([^=]+)=([^;]*)/.exec(line); if (m) jar.set(m[1], m[2]); }
  }
  function rawRequest(url, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(u, { method, headers: { Cookie: cookieHeader(), ...headers } }, (res) => {
        storeCookies(res.headers);
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }
  async function request(url, opts = {}, redirects = 0) {
    const res = await rawRequest(url, opts);
    if ([301, 302, 303].includes(res.status) && res.headers.location && redirects < 6) {
      return request(new URL(res.headers.location, url).toString(), { method: 'GET' }, redirects + 1);
    }
    return res;
  }
  return { request };
}

/* ───────────────────────── Connexion ─────────────────────────
   Formulaire classique « Spring Security » : champs j_username/j_password + un jeton CSRF (en
   paramètre de formulaire ET en en-tête X-CSRF-TOKEN), dont le nom et la valeur sont embarqués
   dans la page d'accueil (variable JS ou champ caché selon les tenants). */
function extractVar(html, name) {
  const m = new RegExp(`${name}\\s*[:=]\\s*["']([^"']+)["']`).exec(html);
  return m ? m[1] : null;
}

async function login(client, baseUrl, username, password) {
  const accueilUrl = `${baseUrl}/accueil`;
  const page = await client.request(accueilUrl);
  const $ = cheerio.load(page.body);

  const csrfToken = extractVar(page.body, 'csrfToken') || $('input[name*="csrf"]').attr('value');
  const csrfParam = extractVar(page.body, 'csrfParameterName') || $('input[name*="csrf"]').attr('name') || '_csrf';
  let loginUrl = extractVar(page.body, 'localLoginURL');
  if (!loginUrl) {
    const form = $('form').filter((_, f) => $(f).find('input[name="j_username"]').length > 0).first();
    loginUrl = form.attr('action');
  }
  if (!csrfToken || !loginUrl) {
    throw new Error("Jeton CSRF ou URL de connexion introuvables sur la page d'accueil du portail — sa structure a peut-être changé (voir server/addons/README.md).");
  }
  loginUrl = new URL(loginUrl, accueilUrl).toString();

  const form = new URLSearchParams();
  form.set('j_username', username);
  form.set('j_password', password);
  form.set(csrfParam, csrfToken);

  const res = await client.request(loginUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-TOKEN': csrfToken },
    body: form.toString(),
  });

  if (/name=["']j_username["']/.test(res.body)) {
    throw new Error('Connexion refusée par le portail — vérifiez l\'identifiant et le mot de passe. '
      + 'Si une double authentification (SMS, e-mail, application) est activée sur ce compte, elle ne peut pas être gérée automatiquement : '
      + 'désactivez-la pour ce compte si le portail le permet.');
  }
}

/* ───────────────────────── Réservations ─────────────────────────
   La page de planning embarque les événements comme un littéral JS renvoyé par une fonction
   getEventsList(), pas via un vrai appel JSON séparé. On extrait ce littéral et on l'évalue (sans
   risque : c'est une page de notre propre session authentifiée, pas un contenu tiers non fiable),
   plutôt que de le parser comme du JSON strict (les clés n'y sont pas forcément citées). */
async function fetchReservations(client, baseUrl) {
  const res = await client.request(`${baseUrl}/activites/planning`);
  const m = /getEventsList\s*\([^)]*\)\s*\{[\s\S]*?return\s*(\[[\s\S]*?\]);/.exec(res.body);
  if (!m) {
    throw new Error("Fonction getEventsList() introuvable sur /activites/planning — la page a changé de structure (voir server/addons/README.md).");
  }
  let raw;
  try {
    // Littéral JS de confiance (notre propre session authentifiée), pas du JSON strict.
    raw = new Function(`return (${m[1]});`)();
  } catch (e) {
    throw new Error(`Le contenu de getEventsList() n'a pas pu être interprété : ${e.message}`);
  }
  return Array.isArray(raw) ? raw : [];
}

function normalizeReservation(e) {
  const start = String(e.start || '');
  const end = e.end ? String(e.end) : '';
  return {
    child: String(e.individu || e.individuNom || '').trim(),
    title: String(e.title || e.libelle || 'Réservation périscolaire').trim(),
    date: start.slice(0, 10),
    start_time: /T\d{2}:\d{2}/.test(start) ? start.slice(11, 16) : null,
    end_time: /T\d{2}:\d{2}/.test(end) ? end.slice(11, 16) : null,
    status: e.etatPresence || e.statut || null,
    source: 'eportail',
    external_id: String(e.id != null ? e.id : `${e.idActivite || ''}-${start}`),
  };
}

function withinWindow(dateStr) {
  if (!dateStr) return false;
  const d = new Date(`${dateStr}T00:00:00`);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const min = new Date(now); min.setDate(min.getDate() - DAYS_BEFORE);
  const max = new Date(now); max.setDate(max.getDate() + DAYS_AFTER);
  return d >= min && d <= max;
}

/* ───────────────────────── Factures ─────────────────────────
   Tableau HTML classique, paginé. On repère les colonnes par leur intitulé plutôt que par leur
   position, pour tenir si l'ordre des colonnes diffère d'une commune à l'autre. */
function parseFrDate(s) {
  const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(s || '');
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
function parseAmount(s) {
  const m = /([\d\s]+[.,]\d{2})/.exec(s || '');
  return m ? Number(m[1].replace(/\s/g, '').replace(',', '.')) : null;
}

async function fetchInvoices(client, baseUrl, circleId) {
  const items = [];
  for (let page = 0; page < 50; page++) {
    const url = `${baseUrl}/espace_facturation/historique${page ? `?page=${page}` : ''}`;
    const res = await client.request(url);
    const $ = cheerio.load(res.body);
    const table = $('table').first();
    if (!table.length) break;

    const headerCells = table.find('thead th').length ? table.find('thead th') : table.find('tr').first().find('th,td');
    const headers = headerCells.map((_, th) => $(th).text().trim().toLowerCase()).get();
    const col = (names) => headers.findIndex((h) => names.some((n) => h.includes(n)));
    const idx = { date: col(['date']), number: col(['numéro', 'numero', 'n°', 'facture']), due: col(['échéance', 'echeance']), amount: col(['montant']), status: col(['statut', 'état', 'etat']) };

    const rows = table.find('tbody tr').toArray();
    if (!rows.length) break;
    for (const tr of rows) {
      const cells = $(tr).find('td').map((_, td) => $(td).text().trim()).get();
      if (!cells.length) continue;
      items.push({
        label: 'Facture périscolaire',
        number: idx.number >= 0 ? cells[idx.number] : '',
        date: idx.date >= 0 ? parseFrDate(cells[idx.date]) : null,
        due_date: idx.due >= 0 ? parseFrDate(cells[idx.due]) : null,
        amount: idx.amount >= 0 ? parseAmount(cells[idx.amount]) : null,
        status: idx.status >= 0 ? cells[idx.status] : null,
        source: 'eportail',
        external_id: (idx.number >= 0 && cells[idx.number]) || null,
        ...(circleId ? { circle_id: Number(circleId) } : {}),
      });
    }
  }
  return items;
}

module.exports = {
  id: 'eportail',
  label: 'e-portail (Berger-Levrault) — garderie, cantine, ALSH',
  fields: [
    { key: 'url', label: 'Adresse du portail', type: 'text', placeholder: 'https://portail.exemple.fr/VotreCommune' },
    { key: 'username', label: 'Identifiant', type: 'text' },
    { key: 'password', label: 'Mot de passe', type: 'password' },
    { key: 'circle', label: 'Cercle pour les factures (facultatif si un seul cercle)', type: 'circle' },
  ],
  async sync(config) {
    const baseUrl = String(config.url || '').trim().replace(/\/+$/, '');
    if (!baseUrl || !config.username || !config.password) {
      throw new Error('Adresse du portail, identifiant et mot de passe requis.');
    }
    const client = makeClient();
    await login(client, baseUrl, config.username, config.password);
    const reservations = (await fetchReservations(client, baseUrl)).map(normalizeReservation)
      .filter((r) => r.child && r.date && withinWindow(r.date));
    const invoices = (await fetchInvoices(client, baseUrl, config.circle)).filter((i) => i.date && i.number && i.amount != null);
    return { reservations, invoices };
  },
};
