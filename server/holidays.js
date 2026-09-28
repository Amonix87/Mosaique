'use strict';
// Vacances scolaires : "start" = premier jour de vacances (samedi), "end" = jour de reprise (lundi, exclu).
//
// Récupérées automatiquement auprès de l'API officielle du ministère de l'Éducation nationale
// (data.education.gouv.fr) au démarrage puis une fois par jour, mises en cache sur disque pour
// survivre à un redémarrage sans accès réseau. En cas d'échec (API injoignable, changement de
// format...), on retombe sur la dernière copie mise en cache, puis sur une liste figée de secours.
// Un administrateur qui préfère tout maîtriser à la main peut toujours créer data/holidays.json
// (même structure, liste "periods") : ce fichier est alors utilisé en priorité et le
// rafraîchissement automatique est ignoré.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { DATA_DIR } = require('./db');

const CACHE_FILE = path.join(DATA_DIR, 'holidays-cache.json');
const OVERRIDE_FILE = path.join(DATA_DIR, 'holidays.json');
const API_URL = 'https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/fr-en-calendrier-scolaire/records';
const REFRESH_MS = 24 * 60 * 60 * 1000; // une fois par jour suffit, ce calendrier ne change pas souvent

// Repli ultime si l'API n'a jamais pu être jointe (première installation hors-ligne, par exemple).
const DEFAULT_PERIODS = [
  { name: 'Toussaint', zones: ['A', 'B', 'C'], start: '2026-10-17', end: '2026-11-02' },
  { name: 'Noël', zones: ['A', 'B', 'C'], start: '2026-12-19', end: '2027-01-04' },
  { name: 'Hiver', zones: ['A'], start: '2027-02-13', end: '2027-03-01' },
  { name: 'Hiver', zones: ['B'], start: '2027-02-20', end: '2027-03-08' },
  { name: 'Hiver', zones: ['C'], start: '2027-02-06', end: '2027-02-22' },
  { name: 'Printemps', zones: ['A'], start: '2027-04-10', end: '2027-04-26' },
  { name: 'Printemps', zones: ['B'], start: '2027-04-17', end: '2027-05-03' },
  { name: 'Printemps', zones: ['C'], start: '2027-04-03', end: '2027-04-19' },
  { name: 'Été', zones: ['A', 'B', 'C'], start: '2027-07-03', end: '2027-09-01' },
];

// Les intitulés officiels varient un peu (« Vacances de la Toussaint », « Vacances d'Été »...) :
// on retrouve simplement lequel de nos 5 noms internes correspond, et on ignore le reste (rentrée,
// ponts, etc.).
const NAME_PATTERNS = [
  [/toussaint/i, 'Toussaint'],
  [/noël|noel/i, 'Noël'],
  [/hiver/i, 'Hiver'],
  [/printemps/i, 'Printemps'],
  [/été|ete/i, 'Été'],
];
function matchName(description) {
  for (const [re, name] of NAME_PATTERNS) if (re.test(description || '')) return name;
  return null;
}

let memCache = null; // { fetchedAt, periods } — dernier résultat obtenu avec succès, en mémoire

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mosaique (auto-hébergé)' }, timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('délai dépassé')); });
  });
}

function parseRows(rows) {
  const seen = new Set();
  const periods = [];
  for (const r of rows) {
    const name = matchName(r.description);
    const zoneMatch = /Zone\s*([ABC])/i.exec(r.zones || '');
    if (!name || !zoneMatch || !r.start_date || !r.end_date) continue;
    const start = String(r.start_date).slice(0, 10);
    const end = String(r.end_date).slice(0, 10);
    const zone = zoneMatch[1].toUpperCase();
    const key = `${name}|${zone}|${start}|${end}`;
    if (seen.has(key)) continue; // plusieurs académies partagent la même zone : on ne garde qu'une fois
    seen.add(key);
    const existing = periods.find((p) => p.name === name && p.start === start && p.end === end);
    if (existing) existing.zones.push(zone);
    else periods.push({ name, zones: [zone], start, end });
  }
  return periods;
}

async function fetchFromApi() {
  // On demande les deux prochaines années scolaires d'un coup (assez large pour couvrir toute
  // l'année en cours et la suivante), filtré sur la population "Élèves" pour ne garder que les
  // vacances des enfants (pas celles, légèrement différentes, des enseignants).
  const thisYear = new Date().getFullYear();
  const where = encodeURIComponent(`population="Élèves" AND start_date>="${thisYear - 1}-08-01"`);
  const url = `${API_URL}?where=${where}&limit=100&order_by=start_date`;
  const json = await fetchJson(url);
  const rows = Array.isArray(json.results) ? json.results : [];
  const periods = parseRows(rows);
  if (!periods.length) throw new Error('réponse vide ou format inattendu');
  return periods;
}

async function refresh() {
  try {
    const periods = await fetchFromApi();
    memCache = { fetchedAt: Date.now(), periods };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(memCache), 'utf8');
  } catch (e) {
    console.error("Vacances scolaires : échec de la récupération automatique, on garde la copie précédente —", e.message);
  }
}

function loadDiskCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (j && Array.isArray(j.periods) && j.periods.length) return j;
    }
  } catch { /* cache illisible : ignoré, on retombe plus loin */ }
  return null;
}

function loadHolidays() {
  // 1. Réglage manuel explicite d'un administrateur : toujours prioritaire.
  try {
    if (fs.existsSync(OVERRIDE_FILE)) {
      const j = JSON.parse(fs.readFileSync(OVERRIDE_FILE, 'utf8'));
      if (Array.isArray(j.periods)) return j.periods;
    }
  } catch (e) {
    console.error('holidays.json illisible, repli sur les données automatiques :', e.message);
  }
  // 2. Dernière récupération automatique réussie (mémoire, puis disque).
  if (!memCache) memCache = loadDiskCache();
  if (memCache) return memCache.periods;
  // 3. Personne n'a jamais réussi à joindre l'API (ex. tout premier démarrage hors-ligne) : secours figé.
  return DEFAULT_PERIODS;
}

function startAutoRefresh() {
  refresh(); // au démarrage, sans bloquer le lancement du serveur
  setInterval(refresh, REFRESH_MS).unref();
}

module.exports = { loadHolidays, startAutoRefresh, _fetchFromApi: fetchFromApi, _parseRows: parseRows };
