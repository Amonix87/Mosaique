'use strict';
// Lance le serveur sur une base temporaire et déroule un scénario complet.
// Usage : npm test
const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mosaique-'));

const { execSync } = require('child_process');
const https = require('https');

// Faux service de notifications push : évite de dépendre d'un vrai service (FCM/Mozilla) pendant
// les tests. web-push exige toujours du HTTPS, même en local : un certificat auto-signé jetable
// suffit (accepté grâce à NODE_TLS_REJECT_UNAUTHORIZED=0, réservé au processus de test).
const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mosaique-cert-'));
const keyPath = path.join(certDir, 'key.pem');
const certPath = path.join(certDir, 'cert.pem');
execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 1 -nodes -subj "/CN=localhost"`, { stdio: 'ignore' });
let pushHits = 0;
let pushNextStatus = 201;
const fakePushService = https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, (req, res) => {
  pushHits++;
  res.writeHead(pushNextStatus, { 'Content-Type': 'text/plain' });
  res.end();
});
function fakePushSubscription(port) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `https://127.0.0.1:${port}/push/${crypto.randomBytes(4).toString('hex')}`,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
  };
}

// Faux serveur Nominatim local : évite de dépendre d'un accès réseau externe pendant les tests.
const fakeNominatim = http.createServer((req, res) => {
  const q = new URL(req.url, 'http://x').searchParams.get('q') || '';
  if (q.includes('erreur')) { res.writeHead(500); res.end('erreur simulée'); return; }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(q.includes('vide') ? [] : [
    {
      display_name: `1, rue de Test, Quartier Historique, 1er Arrondissement, ${q}, Île-de-France, France métropolitaine, 75001, France`,
      lat: '48.8566', lon: '2.3522',
      address: { house_number: '1', road: 'rue de Test', postcode: '75001', city: q },
    },
    { display_name: `${q} bis, 75001 Paris, France`, lat: '48.8567', lon: '2.3523', address: { road: `${q} bis`, postcode: '75001', city: 'Paris' } },
  ]));
});

// Faux serveur SMTP local : capture les e-mails envoyés par l'application pendant les tests,
// sans dépendre d'un vrai serveur ni d'un accès réseau externe.
const inbox = [];
const fakeSmtp = new SMTPServer({
  authOptional: true,
  disabledCommands: ['STARTTLS'],
  onData(stream, _session, callback) {
    simpleParser(stream).then((mail) => inbox.push(mail)).catch(() => {});
    stream.on('end', callback);
  },
});

class Client {
  constructor() { this.cookie = ''; }
  async call(method, url, body, raw) {
    const headers = { 'X-Requested-With': 'mosaique' };
    let payload;
    if (raw) payload = raw; else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    if (this.cookie) headers.Cookie = this.cookie;
    const res = await fetch(BASE + url, { method, headers, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  }
  get(u) { return this.call('GET', u); }
  post(u, b) { return this.call('POST', u, b ?? {}); }
  put(u, b) { return this.call('PUT', u, b ?? {}); }
  del(u) { return this.call('DELETE', u); }
}

async function testDateUtils() {
  const core = await import('../public/js/core.js');
  assert.strictEqual(core.maskFrDate('22092026', false), '22/09/2026', 'saisie masquée jj/mm/aaaa');
  assert.strictEqual(core.maskFrDate('220920261530', true), '22/09/2026 15:30', 'saisie masquée avec heure');
  assert.strictEqual(core.frToIso('22/09/2026', false), '2026-09-22', 'conversion vers ISO');
  assert.strictEqual(core.frToIso('22/09/2026 15:30', true), '2026-09-22T15:30', 'conversion vers ISO avec heure');
  assert.strictEqual(core.isoToFr('2026-09-22', false), '22/09/2026', 'conversion depuis ISO');
  assert.strictEqual(core.isoToFr('2026-09-22T15:30', true), '22/09/2026 15:30', 'conversion depuis ISO avec heure');
  assert.strictEqual(core.frToIso('', false), '', 'champ vide accepté');
  assert.strictEqual(core.frToIso('22/09', false), 'invalide', 'saisie incomplète rejetée proprement');
  console.log('✔ Fonctions de date française vérifiées');
}

// Détection de l'appareil pour l'invitation à installer l'application (fonctions pures, sans navigateur).
function testInstallDetection() {
  const { describeDevice, iosPushCapable, isStandalone, STEPS, PUSH_STEPS, plainStep } = require('../public/js/install.js');
  const UA = {
    iphone17: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    iphone15: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1',
    iphone163: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.3 Mobile/15E148 Safari/604.1',
    iphone164: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Mobile/15E148 Safari/604.1',
    ipadOld: 'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
    chromeIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1',
    instagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 320.0.0.12.108',
    androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    macDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
    winChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
  const d = (ua, platform = '', maxTouchPoints = 0) => describeDevice({ ua, platform, maxTouchPoints });

  const a = d(UA.iphone17);
  assert.deepStrictEqual([a.os, a.mobile, a.iosVersion, a.browser], ['ios', true, [17, 2], 'safari'], 'iPhone sous Safari');
  assert.strictEqual(iosPushCapable(a), true);
  assert.strictEqual(iosPushCapable(d(UA.iphone15)), false, 'iOS 15 : pas de notifications push, même installée');
  assert.strictEqual(iosPushCapable(d(UA.iphone163)), false, 'iOS 16.3 : trop ancien');
  assert.strictEqual(iosPushCapable(d(UA.iphone164)), true, 'iOS 16.4 : premier à les gérer');
  assert.deepStrictEqual([d(UA.ipadOld).os, d(UA.ipadOld).iosVersion], ['ios', [16, 6]], 'iPad');
  const pad = d(UA.ipadDesktop, 'MacIntel', 5);
  assert.deepStrictEqual([pad.os, pad.mobile, pad.iosVersion], ['ios', true, null], "un iPad qui se présente comme un Mac est reconnu grâce à l'écran tactile, sa version reste inconnue");
  assert.strictEqual(iosPushCapable(pad), true, 'version inconnue : on suppose capable plutôt que de priver quelqu\'un');
  assert.deepStrictEqual([d(UA.macDesktop, 'MacIntel', 0).os, d(UA.macDesktop, 'MacIntel', 0).mobile], ['other', false], 'un vrai Mac (sans écran tactile) n\'est pas un iPad');
  assert.strictEqual(d(UA.chromeIos).browser, 'ios-other', 'Chrome sur iPhone');
  assert.strictEqual(d(UA.instagram).browser, 'in-app', "navigateur intégré d'une application : pas d'option « Sur l'écran d'accueil »");
  const and = d(UA.androidChrome);
  assert.deepStrictEqual([and.os, and.mobile, and.iosVersion], ['android', true, null]);
  assert.strictEqual(d(UA.winChrome).mobile, false, 'ordinateur : aucune invitation');

  assert.strictEqual(isStandalone({ standalone: true }, {}), true, 'iOS : navigator.standalone');
  assert.strictEqual(isStandalone({}, { matchMedia: (q) => ({ matches: q === '(display-mode: standalone)' }) }), true, 'Android et autres : display-mode standalone');
  assert.strictEqual(isStandalone({}, { matchMedia: () => ({ matches: false }) }), false, 'onglet de navigateur');
  assert.strictEqual(isStandalone({}, {}), false, 'sans matchMedia : pas installée');

  assert.ok(STEPS.ios.length >= 4 && STEPS.android.length >= 3 && PUSH_STEPS.ios.length >= 3 && PUSH_STEPS.android.length >= 3, 'instructions présentes pour chaque plateforme');
  assert.ok(STEPS.ios.some((s) => s.includes('{share}')) && !plainStep(STEPS.ios[1]).includes('{'), "l'icône Partager est remplacée par son nom dans l'aide");
  console.log("✔ Détection de l'appareil (installation sur l'écran d'accueil) vérifiée");
}

// Vérifie l'analyse de la réponse de l'API officielle (data.education.gouv.fr), sans dépendre du
// réseau : ce test ne peut pas être exécuté contre la vraie API depuis cet environnement, mais
// couvre la logique d'analyse elle-même à partir d'un échantillon fidèle au format documenté.
function testHolidaysParsing() {
  const { _parseRows } = require('../server/holidays.js');
  const sample = [
    { description: 'Vacances de la Toussaint', zones: 'Zone A', start_date: '2026-10-17T00:00:00+00:00', end_date: '2026-11-02T00:00:00+00:00', population: 'Élèves' },
    { description: 'Vacances de la Toussaint', zones: 'Zone A', start_date: '2026-10-17T00:00:00+00:00', end_date: '2026-11-02T00:00:00+00:00', population: 'Élèves' }, // doublon (autre académie)
    { description: 'Vacances de la Toussaint', zones: 'Zone B', start_date: '2026-10-17T00:00:00+00:00', end_date: '2026-11-02T00:00:00+00:00', population: 'Élèves' },
    { description: "Vacances d'Hiver", zones: 'Zone A', start_date: '2027-02-13T00:00:00+00:00', end_date: '2027-03-01T00:00:00+00:00', population: 'Élèves' },
    { description: "Vacances d'Hiver", zones: 'Zone B', start_date: '2027-02-20T00:00:00+00:00', end_date: '2027-03-08T00:00:00+00:00', population: 'Élèves' },
    { description: "Vacances d'Été", zones: 'Zone A', start_date: '2027-07-03T00:00:00+00:00', end_date: '2027-09-01T00:00:00+00:00', population: 'Élèves' },
    { description: "Pont de l'Ascension", zones: 'Zone A', start_date: '2027-05-13T00:00:00+00:00', end_date: '2027-05-17T00:00:00+00:00', population: 'Élèves' }, // à ignorer
    { description: 'Vacances de la Toussaint', zones: 'Zone A', start_date: '2026-10-17T00:00:00+00:00', end_date: '2026-11-02T00:00:00+00:00', population: '-' }, // enseignants : à ignorer
  ];
  const periods = _parseRows(sample);
  assert.strictEqual(periods.length, 4, "Toussaint (A+B fusionnés car mêmes dates), Hiver A, Hiver B, Été — le pont et la ligne enseignants sont ignorés");
  const toussaint = periods.find((p) => p.name === 'Toussaint');
  assert.deepStrictEqual(toussaint.zones.sort(), ['A', 'B'], 'les doublons de la même période/zone sont fusionnés, les zones différentes regroupées');
  assert.strictEqual(toussaint.start, '2026-10-17', "l'heure est retirée, seule la date est gardée");
  assert.ok(!periods.some((p) => p.start === '2027-05-13'), "le pont de l'Ascension n'est pas une des 5 périodes connues, donc ignoré");
  console.log('✔ Analyse du calendrier scolaire (API education.gouv.fr) vérifiée');
}

async function main() {
  const smtpPort = await new Promise((resolve) => fakeSmtp.listen(0, '127.0.0.1', () => resolve(fakeSmtp.server.address().port)));
  const nominatimPort = await new Promise((resolve) => fakeNominatim.listen(0, '127.0.0.1', () => resolve(fakeNominatim.address().port)));
  const pushPort = await new Promise((resolve) => fakePushService.listen(0, '127.0.0.1', () => resolve(fakePushService.address().port)));
  const srv = spawn('node', [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT, DATA_DIR: dir, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtpPort), SMTP_FROM: 'Mosaïque <test@mosaique.local>', PUBLIC_URL: 'https://famille.test', NOMINATIM_URL: `http://127.0.0.1:${nominatimPort}/search`, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    stdio: 'inherit',
  });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/state'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const ok = (r, code = 200, msg = '') => assert.strictEqual(r.status, code, `${msg} → ${r.status} ${JSON.stringify(r.body)}`);

    const anon = new Client();
    ok(await anon.get('/api/state'));
    ok(await anon.get('/api/me'), 401, 'me sans session');
    const noHeader = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.strictEqual(noHeader.status, 403, 'CSRF : en-tête requis');

    // Installation
    const alice = new Client();
    ok(await alice.post('/api/setup', { family_name: 'Les Test', name: 'Alice', email: 'alice@ex.fr', password: 'motdepasse1' }), 200, 'setup');
    ok(await alice.post('/api/setup', { family_name: 'X', name: 'Mallory', email: 'm@ex.fr', password: 'motdepasse1' }), 403, 'setup rejoué');
    let me = (await alice.get('/api/me')).body;
    assert.strictEqual(me.user.is_admin, true);
    assert.strictEqual(me.circles.length, 1);
    const circle = me.circles[0].id;

    // Cercles et invitations : la personne est créée tout de suite (utilisable partout),
    // le lien ne sert qu'à activer son propre accès (e-mail + mot de passe).
    const c2 = (await alice.post('/api/circles', { name: 'Coparents', member_ids: [me.user.id] })).body.id;
    const invRes = await alice.post('/api/invites', { name: 'Bob', circle_ids: [circle, c2], color: '#3D7BE0' });
    ok(invRes, 200, 'création du membre + invitation');
    const inv = invRes.body.token; const bobId = invRes.body.user_id;
    assert.strictEqual((await anon.get(`/api/invites/${inv}`)).body.name, 'Bob');
    // Bob existe déjà, avant même d'avoir cliqué le lien : visible par l'admin, dans les bons cercles, utilisable en assignation.
    let meNow = (await alice.get('/api/me')).body;
    let bobEntry = meNow.users.find((u) => u.id === bobId);
    assert.ok(bobEntry, 'Bob apparaît déjà dans la liste des membres');
    assert.strictEqual(bobEntry.claimed, false, "Bob n'a pas encore activé son compte");
    assert.strictEqual(bobEntry.color, '#3D7BE0');
    assert.ok(meNow.circles.find((c) => c.id === c2).member_ids.includes(bobId), 'Bob est déjà dans le cercle Coparents');
    const preTask = (await alice.post('/api/tasks', { circle_id: circle, title: 'Acheter un cadeau', assignee_id: bobId })).body;
    assert.strictEqual(preTask.assignee_id, bobId, "on peut assigner une tâche à Bob avant même qu'il n'ait activé son compte");
    // Modifier le profil d'un membre non activé : réservé à l'admin, plus possible une fois activé.
    ok(await alice.put(`/api/users/${bobId}`, { name: 'Bobby' }), 200, "l'admin peut renommer un membre pas encore activé");
    // Se connecter avant activation : impossible (email provisoire, mot de passe inconnu de tous), et la nouvelle invitation (reinvite) fonctionne.
    const reinv = await alice.post(`/api/users/${bobId}/reinvite`);
    ok(reinv, 200, "générer un nouveau lien pour un membre pas encore activé");
    ok(await anon.get(`/api/invites/${inv}`), 404, "l'ancien lien est invalidé par la régénération");
    const bob = new Client();
    ok(await bob.post(`/api/invites/${reinv.body.token}/accept`, { email: 'bob@ex.fr', password: 'court' }), 400, 'mot de passe trop court');
    ok(await bob.post(`/api/invites/${reinv.body.token}/accept`, { email: 'bob@ex.fr', password: 'motdepasse2' }), 200, 'accept');
    ok(await anon.get(`/api/invites/${reinv.body.token}`), 404, 'invitation à usage unique');
    ok(await alice.put(`/api/users/${bobId}`, { name: 'Encore' }), 400, "l'admin ne peut plus modifier Bob une fois son compte activé");
    const inv2 = (await alice.post('/api/invites', { name: 'Carla', circle_ids: [circle] })).body.token;
    const carla = new Client();
    ok(await carla.post(`/api/invites/${inv2}/accept`, { email: 'carla@ex.fr', password: 'motdepasse3' }));
    const bobMe = (await bob.get('/api/me')).body;
    const carlaMe = (await carla.get('/api/me')).body;
    const A = me.user.id; const B = bobMe.user.id; const C = carlaMe.user.id;
    assert.strictEqual(bobMe.user.name, 'Bobby', 'le nom modifié avant activation a bien été conservé');
    assert.strictEqual(bobMe.circles.length, 2);
    assert.strictEqual(carlaMe.circles.length, 1);

    // Connexion / déconnexion
    const again = new Client();
    ok(await again.post('/api/login', { email: 'alice@ex.fr', password: 'faux' }), 401);
    ok(await again.post('/api/login', { email: 'ALICE@ex.fr', password: 'motdepasse1' }), 200, 'login insensible à la casse');
    ok(await again.post('/api/logout'));
    ok(await again.get('/api/me'), 401, 'session détruite');

    // Enfants
    const kid1 = (await alice.post('/api/children', { name: 'Léo', color: '#17BEBB' })).body.id;
    assert.strictEqual((await alice.get('/api/me')).body.children.find((c) => c.id === kid1).shared_custody, true, 'garde partagée activée par défaut');
    ok(await alice.put(`/api/children/${kid1}`, { shared_custody: false }), 200, 'désactivation de la garde partagée');
    assert.strictEqual((await alice.get('/api/me')).body.children.find((c) => c.id === kid1).shared_custody, false);
    ok(await alice.put(`/api/children/${kid1}`, { shared_custody: true }), 200, 'réactivation'); // remis à true pour la suite du scénario
    // Lieu et heure de transition
    ok(await alice.put(`/api/children/${kid1}`, { handover_time: '25:00' }), 400, 'heure de transition invalide refusée');
    ok(await alice.put(`/api/children/${kid1}`, { handover_location: 'École', handover_time: '17:00' }), 200);
    let kid1Info = (await alice.get('/api/me')).body.children.find((c) => c.id === kid1);
    assert.strictEqual(kid1Info.handover_location, 'École');
    assert.strictEqual(kid1Info.handover_time, '17:00');
    ok(await alice.put(`/api/children/${kid1}`, { handover_time: '' }), 200, "effacer l'heure sans toucher au lieu");
    kid1Info = (await alice.get('/api/me')).body.children.find((c) => c.id === kid1);
    assert.strictEqual(kid1Info.handover_location, 'École', 'le lieu reste inchangé');
    assert.strictEqual(kid1Info.handover_time, null, "l'heure a bien été effacée");
    // Fiche santé (groupe sanguin, allergies, médecin traitant) : facultative.
    ok(await alice.put(`/api/children/${kid1}`, { blood_type: 'XX' }), 400, 'groupe sanguin invalide refusé');
    ok(await alice.put(`/api/children/${kid1}`, { blood_type: 'O+', allergies: 'Arachides', doctor_name: 'Dr Petit', doctor_phone: '0102030405' }), 200);
    kid1Info = (await alice.get('/api/me')).body.children.find((c) => c.id === kid1);
    assert.deepStrictEqual([kid1Info.blood_type, kid1Info.allergies, kid1Info.doctor_name, kid1Info.doctor_phone], ['O+', 'Arachides', 'Dr Petit', '0102030405'], 'fiche santé enregistrée');
    const kid2 = (await alice.post('/api/children', { name: 'Mia', color: '#FFC914' })).body.id;
    ok(await alice.post('/api/children', { name: 'Doublon', color: '#17BEBB' }), 400, 'couleur déjà utilisée refusée à la création');
    ok(await alice.put(`/api/children/${kid2}`, { color: '#17BEBB' }), 400, 'couleur déjà utilisée refusée à la modification');
    ok(await alice.put(`/api/children/${kid2}`, { color: '#FFC914' }), 200, "garder sa propre couleur reste autorisé");

    // Événements récurrents + isolation entre cercles
    const ev = (await alice.post('/api/events', { circle_id: c2, title: 'Foot', starts_at: '2026-10-03T10:00', ends_at: '2026-10-03T11:30', repeat: 'weekly', repeat_until: '2026-10-31', child_ids: [kid1], owner_id: A })).body;
    const range = (await alice.get('/api/events/range?from=2026-10-01&to=2026-11-30')).body;
    assert.deepStrictEqual(range.map((e) => e.occ_date), ['2026-10-03', '2026-10-10', '2026-10-17', '2026-10-24', '2026-10-31']);
    assert.strictEqual(range[1].starts_at, '2026-10-10T10:00');
    // Suppression d'une seule occurrence, sans toucher au reste de la série
    ok(await carla.post(`/api/events/${ev.id}/exclude`, { date: '2026-10-10' }), 403, "Carla n'est pas dans le cercle Coparents");
    ok(await alice.post(`/api/events/${ev.id}/exclude`, { date: '2026-10-99' }), 400, 'date invalide');
    ok(await alice.post(`/api/events/${ev.id}/exclude`, { date: '2026-10-10' }), 200);
    const rangeAfterExclude = (await alice.get('/api/events/range?from=2026-10-01&to=2026-11-30')).body.filter((e) => e.id === ev.id);
    assert.deepStrictEqual(rangeAfterExclude.map((e) => e.occ_date), ['2026-10-03', '2026-10-17', '2026-10-24', '2026-10-31'], "l'occurrence du 10/10 a disparu, les autres restent");
    ok(await alice.post(`/api/events/${ev.id}/exclude`, { date: '2026-10-10' }), 200, 'exclure deux fois la même date ne plante pas');
    const nonRecurring = (await alice.post('/api/events', { circle_id: circle, title: 'Ponctuel', starts_at: '2026-09-05T09:00' })).body;
    ok(await alice.post(`/api/events/${nonRecurring.id}/exclude`, { date: '2026-09-05' }), 400, 'un événement non récurrent ne peut pas exclure une occurrence');

    // « Cette occurrence et les suivantes » : tronque la série, garde les occurrences passées
    const evT = (await alice.post('/api/events', { circle_id: circle, title: 'Piscine', starts_at: '2026-09-07T10:00', repeat: 'weekly', repeat_until: '2026-10-05', child_ids: [kid1] })).body;
    ok(await bob.post(`/api/events/${evT.id}/truncate`, { date: '2026-09-21' }), 200, "Léo n'est pas encore restreint : Bob peut agir");
    let rangeT = (await alice.get('/api/events/range?from=2026-09-01&to=2026-10-31')).body.filter((e) => e.id === evT.id);
    assert.deepStrictEqual(rangeT.map((e) => e.occ_date), ['2026-09-07', '2026-09-14'], 'les occurrences avant le 21/09 restent, celle-ci et les suivantes ont disparu');
    ok(await alice.post(`/api/events/${evT.id}/truncate`, { date: '2026-09-07' }), 200, "tronquer à la toute première occurrence supprime l'événement entier");
    assert.strictEqual((await alice.get('/api/events/range?from=2026-09-01&to=2026-10-31')).body.filter((e) => e.id === evT.id).length, 0);
    const evNonRec = (await alice.post('/api/events', { circle_id: circle, title: 'Ponctuel 2', starts_at: '2026-09-10T09:00' })).body;
    ok(await alice.post(`/api/events/${evNonRec.id}/truncate`, { date: '2026-09-10' }), 400, "un événement non récurrent ne peut pas être tronqué");
    assert.strictEqual((await carla.get('/api/events/range?from=2026-10-01&to=2026-11-30')).body.length, 0, 'Carla ne voit pas le cercle Coparents');
    ok(await carla.put(`/api/events/${ev.id}`, { title: 'Piraté' }), 403, "modification hors cercle");
    ok(await alice.post('/api/events', { circle_id: circle, title: 'x', starts_at: '2026-13-40' }), 400, 'date invalide');
    const monthly = (await alice.post('/api/events', { circle_id: circle, title: 'Loyer', starts_at: '2026-01-31', all_day: true, repeat: 'monthly' })).body;
    const feb = (await alice.get('/api/events/range?from=2027-02-01&to=2027-02-28')).body.filter((e) => e.id === monthly.id);
    assert.strictEqual(feb[0].occ_date, '2027-02-28', 'répétition mensuelle : fin de mois');

    // Garde : modèles
    let r = await alice.post('/api/custody/generate', { pattern: 'alternate_weeks', child_ids: [kid1, kid2], parent_a: A, parent_b: B, start: '2026-10-02', end: '2026-10-29' });
    ok(r, 200, 'generate'); assert.strictEqual(r.body.nights, 28 * 2);
    let nights = (await alice.get('/api/custody?from=2026-10-02&to=2026-10-29')).body.filter((n) => n.child_id === kid1);
    assert.strictEqual(nights.filter((n) => n.parent_id === A).length, 14);
    assert.strictEqual(nights.find((n) => n.date === '2026-10-09').parent_id, B);
    ok(await alice.post('/api/custody/generate', { pattern: 'two_two_three', child_ids: [kid1], parent_a: A, parent_b: B, start: '2026-11-01', end: '2026-11-14' }));
    nights = (await alice.get('/api/custody?from=2026-11-01&to=2026-11-14')).body.filter((n) => n.child_id === kid1).sort((x, y) => x.date.localeCompare(y.date));
    assert.strictEqual(nights.map((n) => (n.parent_id === A ? 'A' : 'B')).join(''), 'AABBAAABBAABBB');
    ok(await alice.post('/api/custody/generate', { pattern: 'custom', sequence: 'AXB', child_ids: [kid1], parent_a: A, parent_b: B, start: '2026-11-01', end: '2026-11-03' }), 400, 'séquence invalide');
    ok(await alice.post('/api/custody/generate', { pattern: 'halves', child_ids: [kid1], parent_a: A, parent_b: B, start: '2026-12-19', end: '2027-01-03' }));
    nights = (await alice.get('/api/custody?from=2026-12-19&to=2027-01-03')).body.filter((n) => n.child_id === kid1);
    assert.strictEqual(nights.filter((n) => n.parent_id === A).length, 8);
    assert.strictEqual(nights.filter((n) => n.parent_id === B).length, 8);
    ok(await alice.post('/api/custody/generate', { pattern: 'even_odd_weeks', child_ids: [kid1], parent_a: A, parent_b: A, start: '2026-11-16', end: '2026-11-29' }), 400, 'Parent A = Parent B toujours refusé');
    ok(await alice.post('/api/custody/generate', { pattern: 'even_odd_weeks', child_ids: [kid1], parent_a: A, parent_b: B, parent_a_weeks: 'even', start: '2026-11-16', end: '2026-11-29' }));
    // Semaine du 16/11/2026 = semaine ISO 47 (impaire) ; semaine du 23/11/2026 = semaine 48 (paire).
    nights = (await alice.get('/api/custody?from=2026-11-16&to=2026-11-29')).body.filter((n) => n.child_id === kid1).sort((x, y) => x.date.localeCompare(y.date));
    assert.ok(nights.slice(0, 7).every((n) => n.parent_id === B), 'semaine 47 (impaire) → parent B');
    assert.ok(nights.slice(7, 14).every((n) => n.parent_id === A), 'semaine 48 (paire) → parent A');
    ok(await alice.put('/api/custody', { date_from: '2026-10-02', date_to: '2026-10-02', child_ids: [kid1], parent_id: null }));
    assert.ok(!(await alice.get('/api/custody?from=2026-10-02&to=2026-10-02')).body.some((n) => n.child_id === kid1), 'nuit effacée');
    const stats = (await alice.get('/api/custody/stats?month=2026-10')).body;
    assert.ok(stats.month[kid2][A] > 0 && stats.month[kid2][B] > 0, 'statistiques par mois');
    const detail = (await alice.get('/api/custody/stats/detail?year=2026')).body;
    assert.strictEqual(Object.keys(detail.months).length, 12, 'les 12 mois de 2026 sont présents');
    assert.deepStrictEqual(detail.months['2026-10'], stats.month, 'le détail mensuel correspond aux statistiques du mois');
    assert.ok(detail.years['2026'], "l'année 2026 apparaît, puisqu'elle contient des nuits enregistrées");
    assert.ok(!detail.years['2019'], "une année sans aucune nuit n'apparaît pas");

    // Demandes d'échange de garde
    r = await alice.post('/api/swaps', { recipient_id: B, child_ids: [kid2], date_from: '2026-10-09', date_to: '2026-10-11', new_parent_id: A, message: 'Mariage', location: 'Chez mamie', time: '18:00' });
    ok(r, 200, 'swap'); const swapId = r.body.id;
    ok(await alice.post('/api/swaps', { recipient_id: B, child_ids: [kid2], date_from: '2026-10-09', date_to: '2026-10-11', new_parent_id: A, time: '25:99' }), 400, 'heure de transition invalide');
    const swapDetail = (await bob.get('/api/swaps')).body.find((s) => s.id === swapId);
    assert.strictEqual(swapDetail.location, 'Chez mamie');
    assert.strictEqual(swapDetail.time, '18:00');
    ok(await alice.post('/api/swaps', { recipient_id: B, child_ids: [kid2], date_from: '2026-10-09', date_to: '2026-10-11', new_parent_id: C }), 400, 'parent hors échange');
    ok(await alice.post(`/api/swaps/${swapId}/answer`, { accept: true }), 404, "le demandeur ne peut pas s'auto-accepter");
    assert.ok((await bob.get('/api/notifications')).body.some((n) => n.kind === 'swap'), 'notification reçue');
    ok(await bob.post(`/api/swaps/${swapId}/answer`, { accept: true }), 200, 'accept swap');
    ok(await bob.post(`/api/swaps/${swapId}/answer`, { accept: false }), 409, 'déjà traitée');
    nights = (await alice.get('/api/custody?from=2026-10-09&to=2026-10-11')).body.filter((n) => n.child_id === kid2);
    assert.ok(nights.length === 3 && nights.every((n) => n.parent_id === A), 'garde transférée à Alice');
    assert.ok((await alice.get('/api/notifications')).body.some((n) => n.title.includes('accepté')));
    const s2 = (await alice.post('/api/swaps', { recipient_id: B, child_ids: [kid1], date_from: '2026-10-20', date_to: '2026-10-21', new_parent_id: B })).body.id;
    ok(await alice.post(`/api/swaps/${s2}/cancel`), 200);
    ok(await bob.post(`/api/swaps/${s2}/answer`, { accept: true }), 409, 'demande annulée');

    // SOS remplacement : le premier qui accepte gagne
    const sosId = (await alice.post('/api/sos', { circle_id: circle, title: 'Aller chercher Léo à 17h', note: 'Bloquée au travail' })).body.id;
    assert.ok((await carla.get('/api/notifications')).body.some((n) => n.kind === 'sos'));
    ok(await alice.post(`/api/sos/${sosId}/take`), 400, 'pas sa propre demande');
    const [t1, t2] = await Promise.all([bob.post(`/api/sos/${sosId}/take`), carla.post(`/api/sos/${sosId}/take`)]);
    assert.deepStrictEqual([t1.status, t2.status].sort(), [200, 409], 'un seul gagnant');
    const sosDone = (await alice.get('/api/sos')).body[0];
    assert.strictEqual(sosDone.status, 'taken');
    assert.strictEqual(sosDone.taken_by, t1.status === 200 ? B : C, "on sait qui a pris le relais (pour l'historique)");
    assert.ok(sosDone.taken_at, "l'horodatage de la prise en charge est renseigné");

    // Tâches, rappels, courses
    const task = (await alice.post('/api/tasks', { circle_id: circle, title: 'Rendez-vous dentiste', assignee_id: C, due: '2026-10-05', remind_at: '2026-01-01T08:00' })).body;
    assert.ok((await carla.get('/api/notifications')).body.some((n) => n.kind === 'task'), 'assignation notifiée');
    ok(await carla.put(`/api/tasks/${task.id}`, { done: true }));
    assert.strictEqual((await carla.get('/api/tasks')).body.find((x) => x.id === task.id).done, 1);
    ok(await alice.post('/api/shopping', { circle_id: circle, list: 'Courses', label: 'Lait', qty: '2' }));
    const milk = (await alice.get('/api/shopping')).body[0];
    ok(await bob.put(`/api/shopping/${milk.id}`, { done: true }));
    ok(await bob.del(`/api/shopping/done?circle_id=${circle}&list=Courses`));
    assert.strictEqual((await alice.get('/api/shopping')).body.length, 0);

    // Budget : répartition et remboursement
    ok(await alice.post('/api/expenses', { circle_id: circle, title: 'Cantine', amount_cents: 10000, category: 'École', date: '2026-10-01', paid_by: A, split: { [A]: 50, [B]: 50 } }));
    ok(await alice.post('/api/expenses', { circle_id: circle, title: 'Lunettes', amount_cents: 20001, category: 'Santé', date: '2026-10-02', paid_by: B, split: { [A]: 70, [B]: 20, [C]: 10 } }));
    ok(await alice.post('/api/expenses', { circle_id: circle, title: 'Faux', amount_cents: 100, date: '2026-10-02', paid_by: A, split: { [A]: 60, [B]: 20 } }), 400, 'répartition ≠ 100 %');
    let sum = (await alice.get(`/api/expenses/summary?circle_id=${circle}&month=2026-10`)).body;
    assert.strictEqual(Object.values(sum.balances).reduce((a, b) => a + b, 0), 0, 'la somme des soldes est nulle');
    assert.strictEqual(sum.balances[A], 10000 - 5000 - 14001, 'solde Alice');
    assert.ok(sum.transfers.length >= 1 && sum.categories.length === 2);
    for (const t of sum.transfers) ok(await alice.post('/api/settlements', { circle_id: circle, from_user: t.from, to_user: t.to, amount_cents: t.amount_cents }));
    sum = (await alice.get(`/api/expenses/summary?circle_id=${circle}`)).body;
    assert.strictEqual(sum.transfers.length, 0, 'tout est remboursé');
    ok(await bob.get(`/api/expenses/summary?circle_id=${c2}`), 200);
    ok(await carla.get(`/api/expenses/summary?circle_id=${c2}`), 403, 'cercle non partagé');

    // Contacts et visibilité par cercle
    ok(await alice.post('/api/contacts', { circle_ids: [c2], name: 'Dr Martin', category: 'Médecin', phone: '0102030405', child_id: kid1 }));
    assert.strictEqual((await carla.get('/api/contacts')).body.length, 0, 'contact du cercle Coparents invisible pour Carla');
    assert.strictEqual((await bob.get('/api/contacts')).body.length, 1);

    // Un contact peut désormais être partagé entre plusieurs cercles à la fois.
    const sharedContact = (await alice.post('/api/contacts', { circle_ids: [circle, c2], name: 'Pharmacie du coin' })).body;
    assert.deepStrictEqual([...sharedContact.circle_ids].sort(), [circle, c2].sort(), 'le contact est rattaché aux deux cercles');
    assert.ok((await carla.get('/api/contacts')).body.some((c) => c.name === 'Pharmacie du coin'), 'Carla (membre de Famille) voit le contact partagé');
    assert.ok((await bob.get('/api/contacts')).body.some((c) => c.name === 'Pharmacie du coin'), 'Bob (membre des deux cercles) voit le contact partagé');
    ok(await alice.put(`/api/contacts/${sharedContact.id}`, { circle_ids: [c2] }), 200, "on peut retirer un des cercles ensuite");
    assert.ok(!(await carla.get('/api/contacts')).body.some((c) => c.name === 'Pharmacie du coin'), 'Carla ne voit plus le contact une fois retiré du cercle Famille');
    ok(await alice.put(`/api/contacts/${sharedContact.id}`, { circle_ids: [] }), 400, 'il faut garder au moins un cercle');

    // Favoris : épinglés en haut de la liste des contacts.
    const favContact = (await alice.post('/api/contacts', { circle_ids: [circle], name: 'Pompiers' })).body;
    assert.strictEqual(favContact.favorite, 0, 'pas favori par défaut');
    const favUpdated = (await alice.put(`/api/contacts/${favContact.id}`, { favorite: true })).body;
    assert.strictEqual(favUpdated.favorite, 1, 'marqué favori');
    assert.strictEqual((await alice.get('/api/contacts')).body.find((c) => c.id === favContact.id).favorite, 1, 'le statut favori est bien renvoyé par la liste');
    ok(await alice.put(`/api/contacts/${favContact.id}`, { favorite: false }));

    // Documents
    const fd = new FormData();
    fd.append('circle_id', String(circle)); fd.append('title', 'Carnet de santé'); fd.append('category', 'Santé');
    fd.append('file', new Blob(['contenu pdf factice'], { type: 'application/pdf' }), 'carnet é.pdf');
    r = await alice.call('POST', '/api/documents', undefined, fd); ok(r, 200, 'upload');
    const docs = (await carla.get('/api/documents')).body;
    assert.strictEqual(docs.length, 1);
    const dl = await fetch(`${BASE}/api/documents/${docs[0].id}/file`, { headers: { Cookie: carla.cookie } });
    assert.strictEqual(await dl.text(), 'contenu pdf factice');
    assert.ok((dl.headers.get('content-disposition') || '').startsWith('attachment'), 'téléchargement forcé');
    ok(await bob.get(`/api/documents/${docs[0].id}/file`), 200);

    // Affichage en ligne (?inline=1) : reconnu d'après le CONTENU, jamais d'après le type annoncé au dépôt
    const inlineFake = await fetch(`${BASE}/api/documents/${docs[0].id}/file?inline=1`, { headers: { Cookie: carla.cookie } });
    assert.ok((inlineFake.headers.get('content-disposition') || '').startsWith('attachment'), "un « PDF » qui n'en est pas un repart en téléchargement, même avec ?inline=1");
    const mkDoc = async (name, type, bytes) => { const f = new FormData(); f.append('circle_id', String(circle)); f.append('title', name); f.append('file', new Blob([bytes], { type }), name); return (await alice.call('POST', '/api/documents', undefined, f)).body.id; };
    const realPdfId = await mkDoc('vrai.pdf', 'application/pdf', '%PDF-1.4\n%contenu factice\n');
    const viewPdf = await fetch(`${BASE}/api/documents/${realPdfId}/file?inline=1`, { headers: { Cookie: carla.cookie } });
    assert.ok((viewPdf.headers.get('content-disposition') || '').startsWith('inline'), 'un vrai PDF est affiché sur place');
    assert.strictEqual(viewPdf.headers.get('content-type'), 'application/pdf');
    assert.strictEqual(viewPdf.headers.get('x-frame-options'), 'SAMEORIGIN', "l'aperçu peut être incrusté par l'application elle-même");
    assert.ok((viewPdf.headers.get('content-security-policy') || '').includes("frame-ancestors 'self'"));
    assert.strictEqual(viewPdf.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(((await fetch(`${BASE}/api/documents/${realPdfId}/file`, { headers: { Cookie: carla.cookie } })).headers.get('content-disposition') || '').startsWith('attachment'), 'sans ?inline, le téléchargement reste la règle');
    const pngDocId = await mkDoc('photo.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
    assert.strictEqual((await fetch(`${BASE}/api/documents/${pngDocId}/file?inline=1`, { headers: { Cookie: carla.cookie } })).headers.get('content-type'), 'image/png', 'une image est affichée sur place');
    const svgDocId = await mkDoc('dessin.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    const viewSvg = await fetch(`${BASE}/api/documents/${svgDocId}/file?inline=1`, { headers: { Cookie: carla.cookie } });
    assert.ok((viewSvg.headers.get('content-disposition') || '').startsWith('attachment'), "un SVG (qui peut contenir des scripts) n'est jamais affiché en ligne");
    assert.strictEqual(viewSvg.headers.get('content-type'), 'application/octet-stream');
    assert.strictEqual(viewSvg.headers.get('x-frame-options'), 'DENY', "l'interdiction d'incrustation reste en vigueur pour tout le reste");
    assert.strictEqual((await fetch(`${BASE}/api/documents/${realPdfId}/file?inline=1`)).status, 401, 'toujours réservé aux membres connectés');
    for (const id of [realPdfId, pngDocId, svgDocId]) ok(await alice.del(`/api/documents/${id}`), 200);
    ok(await carla.del(`/api/documents/${docs[0].id}`), 403, 'suppression réservée à l’auteur/admin');
    const fd2 = new FormData(); fd2.append('circle_id', String(circle)); fd2.append('file', new Blob(['x']), 'a.txt');
    assert.strictEqual((await anon.call('POST', '/api/documents', undefined, fd2)).status, 401, 'upload sans session');

    // Fil : photo valide / fausse
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
    const fp = new FormData(); fp.append('circle_id', String(circle)); fp.append('body', 'Sortie au parc'); fp.append('photo', new Blob([png], { type: 'image/png' }), 'p.png');
    ok(await alice.call('POST', '/api/posts', undefined, fp), 200, 'post avec photo');
    const fake = new FormData(); fake.append('circle_id', String(circle)); fake.append('body', 'faux'); fake.append('photo', new Blob(['<script>alert(1)</script>'], { type: 'image/png' }), 'p.png');
    ok(await alice.call('POST', '/api/posts', undefined, fake), 400, "faux fichier image refusé");
    const posts = (await bob.get('/api/posts')).body;
    assert.strictEqual(posts.length, 1);
    const ph = await fetch(`${BASE}/api/posts/${posts[0].id}/photo`, { headers: { Cookie: bob.cookie } });
    assert.strictEqual(ph.headers.get('content-type'), 'image/png');

    // Chat
    ok(await bob.post('/api/messages', { circle_id: c2, body: 'Salut !' }));
    assert.strictEqual((await alice.get(`/api/messages?circle_id=${c2}`)).body.length, 1);
    ok(await carla.get(`/api/messages?circle_id=${c2}`), 403);

    // Vacances
    const hol = (await alice.get('/api/holidays')).body;
    assert.strictEqual(hol.zone, 'B');
    assert.strictEqual(hol.periods.find((p) => p.name === 'Hiver').start, '2027-02-20');

    // Zone scolaire par enfant (et non plus par famille)
    assert.strictEqual((await alice.get('/api/me')).body.children.find((c) => c.id === kid1).zone, 'B', 'zone par défaut = B');
    ok(await alice.put(`/api/children/${kid1}`, { zone: 'C' }), 200, 'changer la zone de Léo');
    ok(await alice.put(`/api/children/${kid2}`, { zone: 'Z' }), 400, 'zone invalide refusée');
    const zonedChildren = (await alice.get('/api/me')).body.children;
    assert.strictEqual(zonedChildren.find((c) => c.id === kid1).zone, 'C', 'Léo est bien passé en zone C');
    assert.strictEqual(zonedChildren.find((c) => c.id === kid2).zone, 'B', 'Mia reste en zone B (défaut)');
    const holC = (await alice.get('/api/holidays?zone=C')).body;
    assert.strictEqual(holC.periods.find((p) => p.name === 'Hiver').start, '2027-02-06', 'dates de vacances différentes en zone C');

    // iCal
    const ics = await fetch(`${BASE}/ical/${me.user.ical_token}.ics`);
    const txt = await ics.text();
    assert.ok(txt.startsWith('BEGIN:VCALENDAR') && txt.includes('RRULE:FREQ=WEEKLY') && txt.includes('Mia chez'), 'flux iCal');
    assert.strictEqual((await fetch(`${BASE}/ical/nimportequoi.ics`)).status, 404);
    const carlaIcs = await (await fetch(`${BASE}/ical/${carlaMe.user.ical_token}.ics`)).text();
    assert.ok(!carlaIcs.includes('SUMMARY:Foot'), 'iCal filtré par cercle');

    // Présence (Home Assistant) : basée sur la nuit de garde du jour même. Date locale (comme
    // nowLocal() côté serveur), pas UTC : sinon le test devient faux entre minuit local et minuit UTC.
    const todayD = new Date();
    const todayStr = `${todayD.getFullYear()}-${String(todayD.getMonth() + 1).padStart(2, '0')}-${String(todayD.getDate()).padStart(2, '0')}`;
    ok(await alice.put('/api/custody', { date_from: todayStr, date_to: todayStr, child_ids: [kid1], parent_id: A }));
    ok(await alice.put('/api/custody', { date_from: todayStr, date_to: todayStr, child_ids: [kid2], parent_id: null }));
    let presence = await (await fetch(`${BASE}/presence/${me.user.ical_token}.json`)).json();
    assert.strictEqual(presence.as, 'Alice');
    assert.deepStrictEqual(presence.children.find((c) => c.name === 'Léo'), { id: kid1, name: 'Léo', home: true, with: 'Alice' }, 'Léo est chez Alice ce soir');
    assert.strictEqual(presence.children.find((c) => c.name === 'Mia').home, null, "Mia : aucune nuit renseignée aujourd'hui → home=null, pas false");
    presence = await (await fetch(`${BASE}/presence/${bobMe.user.ical_token}.json`)).json();
    assert.strictEqual(presence.children.find((c) => c.name === 'Léo').home, false, "chez Bob, Léo n'est pas « home » ce soir (il est chez Alice)");
    assert.strictEqual((await fetch(`${BASE}/presence/un-jeton-inexistant.json`)).status, 404, 'jeton de présence invalide → 404');

    // Droits d'administration
    ok(await bob.post('/api/invites', { name: 'Eve' }), 403);
    ok(await bob.put('/api/settings', { family_name: 'Hack' }), 403);
    ok(await alice.put('/api/settings', { family_name: 'Les Test 2' }));
    ok(await alice.put(`/api/users/${C}/password`, { password: 'nouveaumdp1' }));
    ok(await carla.get('/api/me'), 401, 'sessions révoquées après changement du mot de passe');
    ok(await carla.post('/api/login', { email: 'carla@ex.fr', password: 'nouveaumdp1' }));

    // Sécurité : en-têtes
    const idx = await fetch(BASE + '/');
    assert.ok((idx.headers.get('content-security-policy') || '').includes("script-src 'self'"));

    // Calendriers séparés par enfant : Bob est le parent de Léo (kid1) uniquement,
    // Carla est la parente de Mia (kid2) uniquement — chacun ne doit voir que « son » enfant.
    ok(await bob.put(`/api/children/${kid1}`, { parent_ids: [A, B] }), 403, "un non-admin ne peut pas désigner les parents");
    ok(await alice.put(`/api/children/${kid1}`, { parent_ids: [A, B] }), 200, 'admin désigne les parents de Léo');
    ok(await alice.put(`/api/children/${kid2}`, { parent_ids: [A, C] }), 200, 'admin désigne les parents de Mia');

    const meBob = (await bob.get('/api/me')).body;
    const meCarla = (await carla.get('/api/me')).body;
    assert.ok(meBob.children.some((c) => c.id === kid1), 'Bob voit Léo (son enfant)');
    assert.ok(!meBob.children.some((c) => c.id === kid2), 'Bob ne voit pas Mia (pas son enfant)');
    assert.ok(meCarla.children.some((c) => c.id === kid2), 'Carla voit Mia (son enfant)');
    assert.ok(!meCarla.children.some((c) => c.id === kid1), 'Carla ne voit pas Léo (pas son enfant)');
    assert.ok((await alice.get('/api/me')).body.children.some((c) => c.id === kid1 && c.id !== undefined), "l'admin voit tout");

    const evKid1 = (await alice.post('/api/events', { circle_id: circle, title: 'Anniversaire Léo', starts_at: '2026-11-05T10:00', child_ids: [kid1] })).body;
    const evKid2 = (await alice.post('/api/events', { circle_id: circle, title: 'Anniversaire Mia', starts_at: '2026-11-06T10:00', child_ids: [kid2] })).body;
    const evGeneral = (await alice.post('/api/events', { circle_id: circle, title: 'Réunion de famille', starts_at: '2026-11-07T10:00' })).body;
    const rangeBob = (await bob.get('/api/events/range?from=2026-11-01&to=2026-11-30')).body.map((e) => e.title);
    const rangeCarla = (await carla.get('/api/events/range?from=2026-11-01&to=2026-11-30')).body.map((e) => e.title);
    assert.deepStrictEqual(rangeBob.sort(), ['Anniversaire Léo', 'Loyer', 'Réunion de famille'], "Bob ne voit pas l'événement de Mia");
    assert.deepStrictEqual(rangeCarla.sort(), ['Anniversaire Mia', 'Loyer', 'Réunion de famille'], "Carla ne voit pas l'événement de Léo");
    ok(await bob.post('/api/events', { circle_id: circle, title: 'x', starts_at: '2026-11-08T10:00', child_ids: [kid2] }), 403, "Bob ne peut pas créer un événement pour Mia");
    ok(await bob.put(`/api/events/${evKid2.id}`, { child_ids: [kid2] }), 403, "Bob ne peut pas modifier un événement pour Mia");

    // Dépôt/récupération par quelqu'un d'autre que le responsable habituel (ex. : covoiturage).
    const evCarpool = (await alice.post('/api/events', { circle_id: circle, title: 'Foot de Léo', starts_at: '2026-11-09T17:00', child_ids: [kid1], owner_id: A, owner_mode: 'manual', dropoff_by: B, pickup_by: C })).body;
    assert.strictEqual(evCarpool.dropoff_by, B, 'amené par Bob');
    assert.strictEqual(evCarpool.pickup_by, C, 'récupéré par Carla');
    assert.strictEqual((await alice.get('/api/events/range?from=2026-11-01&to=2026-11-30')).body.find((e) => e.id === evCarpool.id).owner_id, A, 'le responsable habituel ne change pas');
    ok(await alice.put(`/api/events/${evCarpool.id}`, { dropoff_by: 999999 }), 400, "le dépôt doit être confié à quelqu'un du cercle de l'événement");
    // Confier après coup la récupération à quelqu'un d'autre doit le prévenir (pas seulement à la création).
    ok(await alice.put(`/api/events/${evCarpool.id}`, { pickup_by: B }), 200, 'confier la récupération à Bob à la place de Carla');
    assert.ok((await bob.get('/api/notifications')).body.some((n) => n.title === 'Événement modifié : Foot de Léo'), 'Bob est prévenu quand on lui confie la récupération');
    const bobModifiedCount = (await bob.get('/api/notifications')).body.filter((n) => n.title === 'Événement modifié : Foot de Léo').length;
    ok(await alice.put(`/api/events/${evCarpool.id}`, { notes: 'Pas oublier les crampons' }), 200, 'une simple note se modifie sans notifier personne en particulier');
    assert.strictEqual((await bob.get('/api/notifications')).body.filter((n) => n.title === 'Événement modifié : Foot de Léo').length, bobModifiedCount, "modifier juste une note n'envoie pas de notification « modifié »");

    ok(await alice.put('/api/custody', { date_from: '2026-11-10', date_to: '2026-11-10', child_ids: [kid1], parent_id: A }));
    ok(await alice.put('/api/custody', { date_from: '2026-11-10', date_to: '2026-11-10', child_ids: [kid2], parent_id: A }));

    // Responsable automatique d'un événement : suit qui a la garde ce jour-là, et change si la garde change.
    const autoEv = (await alice.post('/api/events', { circle_id: circle, title: 'Rendez-vous dentiste', starts_at: '2026-11-10T09:00', child_ids: [kid1], owner_mode: 'auto' })).body;
    assert.strictEqual(autoEv.owner_mode, 'auto');
    let rangeAuto = (await alice.get('/api/events/range?from=2026-11-10&to=2026-11-10')).body;
    assert.strictEqual(rangeAuto.find((e) => e.id === autoEv.id).owner_id, A, 'le 10/11, Léo est chez Alice → responsable automatique = Alice');
    ok(await bob.put('/api/custody', { date_from: '2026-11-10', date_to: '2026-11-10', child_ids: [kid1], parent_id: B }), 200, 'Bob change la garde du 10/11 (il est bien parent désigné)');
    rangeAuto = (await alice.get('/api/events/range?from=2026-11-10&to=2026-11-10')).body;
    assert.strictEqual(rangeAuto.find((e) => e.id === autoEv.id).owner_id, B, "le responsable automatique suit le changement de garde, sans rien modifier sur l'événement lui-même");
    const manualEv = (await alice.post('/api/events', { circle_id: circle, title: 'Anniversaire de Carla', starts_at: '2026-11-10T18:00', owner_id: A })).body;
    assert.strictEqual(manualEv.owner_mode, 'manual', "sans précision, le mode reste manuel (pas d'enfant concerné ici)");
    rangeAuto = (await alice.get('/api/events/range?from=2026-11-10&to=2026-11-10')).body;
    assert.strictEqual(rangeAuto.find((e) => e.id === manualEv.id).owner_id, A, 'un responsable manuel ne bouge jamais tout seul');

    // Notification de création d'événement : seul le responsable est notifié quand il est identifiable
    // (manuel ou automatique via la garde), tout le cercle sinon — et jamais soi-même.
    ok(await bob.post('/api/events', { circle_id: circle, title: 'Sans responsable précis', starts_at: '2026-11-12T09:00' }));
    assert.ok((await alice.get('/api/notifications')).body.some((n) => n.title === 'Nouvel événement : Sans responsable précis'), 'sans responsable, tout le cercle est notifié (Alice)');
    assert.ok((await carla.get('/api/notifications')).body.some((n) => n.title === 'Nouvel événement : Sans responsable précis'), 'sans responsable, tout le cercle est notifié (Carla)');
    ok(await bob.post('/api/events', { circle_id: circle, title: 'Avec responsable manuel', starts_at: '2026-11-12T10:00', owner_id: C }));
    assert.ok((await carla.get('/api/notifications')).body.some((n) => n.title === 'Nouvel événement : Avec responsable manuel'), 'le responsable désigné (Carla) est notifié');
    assert.ok(!(await alice.get('/api/notifications')).body.some((n) => n.title === 'Nouvel événement : Avec responsable manuel'), "les autres membres (Alice) ne le sont pas");
    ok(await alice.put('/api/custody', { date_from: '2026-11-13', date_to: '2026-11-13', child_ids: [kid1], parent_id: B }));
    ok(await alice.post('/api/events', { circle_id: circle, title: 'Responsable automatique', starts_at: '2026-11-13T09:00', child_ids: [kid1], owner_mode: 'auto' }));
    assert.ok((await bob.get('/api/notifications')).body.some((n) => n.title === 'Nouvel événement : Responsable automatique'), "le responsable résolu par la garde (Bob, ce jour-là) est notifié");
    assert.ok(!(await carla.get('/api/notifications')).body.some((n) => n.title === 'Nouvel événement : Responsable automatique'), "les autres (Carla) ne le sont pas");
    ok(await alice.post('/api/events', { circle_id: circle, title: 'Automatique sans garde connue', starts_at: '2026-12-25T09:00', child_ids: [kid2], owner_mode: 'auto' }));
    assert.ok((await bob.get('/api/notifications')).body.some((n) => n.title === 'Nouvel événement : Automatique sans garde connue'), "sans garde renseignée ce jour-là, repli sur tout le cercle (Bob)");
    assert.ok((await carla.get('/api/notifications')).body.some((n) => n.title === 'Nouvel événement : Automatique sans garde connue'), "sans garde renseignée ce jour-là, repli sur tout le cercle (Carla)");

    // Conjoint·e notifié·e automatiquement (réglage personnel, sans changer l'organisation des cercles)
    ok(await bob.put('/api/me', { partner_id: B }), 400, 'on ne peut pas se désigner soi-même comme conjoint');
    ok(await bob.put('/api/me', { partner_id: C }), 200, 'Bob désigne Carla comme conjointe à notifier aussi');
    ok(await alice.post('/api/events', { circle_id: circle, title: 'Avec conjoint', starts_at: '2026-11-14T09:00', owner_id: B }));
    assert.ok((await bob.get('/api/notifications')).body.some((n) => n.title === 'Nouvel événement : Avec conjoint'), 'Bob (responsable) est notifié');
    assert.ok((await carla.get('/api/notifications')).body.some((n) => n.title === 'Nouvel événement : Avec conjoint'), "Carla (conjointe de Bob) l'est aussi, alors qu'elle n'est pas responsable");
    ok(await bob.put('/api/me', { partner_id: null }), 200, 'Bob retire ce lien');
    ok(await alice.post('/api/events', { circle_id: circle, title: 'Sans conjoint declare', starts_at: '2026-11-15T09:00', owner_id: B }));
    assert.ok(!(await carla.get('/api/notifications')).body.some((n) => n.title === 'Nouvel événement : Sans conjoint declare'), "sans lien, Carla n'est plus notifiée pour Bob");

    // Application vue « installée » : signalée par l'application elle-même, par personne
    assert.strictEqual((await bob.get('/api/me')).body.user.app_installed, false, "par défaut, personne n'a été vu utiliser l'application installée");
    assert.strictEqual((await anon.post('/api/me/installed')).status, 401, 'réservé aux personnes connectées');
    ok(await bob.post('/api/me/installed'), 200);
    assert.strictEqual((await bob.get('/api/me')).body.user.app_installed, true);
    assert.strictEqual((await carla.get('/api/me')).body.user.app_installed, false, "repère par personne : celui de Bob ne concerne pas Carla");
    ok(await bob.post('/api/me/installed'), 200, 'répéter le signalement est sans effet');

    // Rappels d'événements (façon Google Agenda) : /api/admin/run-checks force la vérification
    // habituellement faite en tâche de fond, pour ne pas dépendre d'un vrai délai de 30 secondes.
    const pad2 = (n) => String(n).padStart(2, '0');
    const localDT = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    const addDaysStr = (s, n) => { const [y, m, d] = s.split('-').map(Number); const dt = new Date(y, m - 1, d + n); return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`; };
    const soon = localDT(new Date(Date.now() + 2 * 60000)); // dans 2 minutes : le rappel (1h avant) est donc déjà passé
    ok(await bob.get('/api/admin/run-checks'), 404, 'GET non défini : seul POST'); // vérifie qu'on ne déclenche pas par erreur via une méthode inattendue
    ok(await bob.post('/api/admin/run-checks'), 403, 'réservé aux administrateurs');
    const remEv = (await alice.post('/api/events', { circle_id: circle, title: 'Rappel imminent', starts_at: soon, owner_id: B, pickup_by: C, reminder_minutes: 60 })).body;
    ok(await alice.post('/api/admin/run-checks'), 200);
    assert.ok((await bob.get('/api/notifications')).body.some((n) => n.title === 'Rappel : Rappel imminent'), 'le responsable (Bob) reçoit bien le rappel');
    assert.ok((await carla.get('/api/notifications')).body.some((n) => n.title === 'Rappel : Rappel imminent'), 'Carla (chargée de la récupération) reçoit aussi le rappel');

    // Sauvegarde manuelle (admin) : une archive zip contenant une copie de la base et les fichiers envoyés.
    ok(await bob.get('/api/admin/backup'), 403, 'réservé aux administrateurs');
    const backup = await alice.get('/api/admin/backup');
    assert.strictEqual(backup.status, 200);
    assert.strictEqual(backup.headers.get('content-type'), 'application/zip');
    assert.ok(/attachment; filename="mosaique-sauvegarde-\d{4}-\d{2}-\d{2}\.zip"/.test(backup.headers.get('content-disposition') || ''), 'nom de fichier daté');
    assert.ok(typeof backup.body === 'string' && backup.body.length > 100, "l'archive n'est pas vide");
    assert.ok(backup.body.startsWith('PK'), "signature zip (PK\\x03\\x04) présente en tête de fichier");
    const bobCountBefore = (await bob.get('/api/notifications')).body.filter((n) => n.title === 'Rappel : Rappel imminent').length;
    ok(await alice.post('/api/admin/run-checks'), 200);
    const bobCountAfter = (await bob.get('/api/notifications')).body.filter((n) => n.title === 'Rappel : Rappel imminent').length;
    assert.strictEqual(bobCountAfter, bobCountBefore, 'un second passage ne renvoie pas le même rappel (une seule fois par occurrence)');
    ok(await alice.put(`/api/events/${remEv.id}`, { reminder_minutes: 5 }), 200);
    ok(await alice.post('/api/admin/run-checks'), 200);
    assert.strictEqual((await bob.get('/api/notifications')).body.filter((n) => n.title === 'Rappel : Rappel imminent').length, bobCountAfter + 1, "changer le délai de rappel après coup permet à nouveau l'envoi (5 min avant est aussi déjà passé)");

    // Événement récurrent : chaque occurrence est suivie indépendamment (une série ne reçoit pas un
    // rappel unique pour toute sa durée, mais un par occurrence, chacune en temps voulu).
    const soonRec = localDT(new Date(Date.now() + 2 * 60000));
    const recEv = (await alice.post('/api/events', { circle_id: circle, title: 'Rappel récurrent', starts_at: soonRec, repeat: 'daily', repeat_until: addDaysStr(soonRec.slice(0, 10), 2), owner_id: B, reminder_minutes: 60 })).body;
    ok(await alice.post('/api/admin/run-checks'), 200);
    const bobRecCount = (await bob.get('/api/notifications')).body.filter((n) => n.title === 'Rappel : Rappel récurrent').length;
    assert.strictEqual(bobRecCount, 1, "seule l'occurrence du jour (déjà due) déclenche un rappel, pas celles des jours suivants (pas encore dues)");
    ok(await alice.post('/api/admin/run-checks'), 200);
    assert.strictEqual((await bob.get('/api/notifications')).body.filter((n) => n.title === 'Rappel : Rappel récurrent').length, bobRecCount, "toujours pas de doublon pour l'occurrence du jour");

    // Aide à la saisie d'adresse (relais Nominatim)
    ok(await anon.get('/api/geocode?q=xx'), 401, 'le géocodage nécessite une session');
    assert.deepStrictEqual((await alice.get('/api/geocode?q=ab')).body, [], 'requête trop courte → aucun appel, liste vide');
    const geo = (await alice.get('/api/geocode?q=Mairie+de+Paris')).body;
    assert.strictEqual(geo.length, 2);
    assert.strictEqual(geo[0].label, '1 rue de Test, 75001 Mairie de Paris', "adresse courte au format postal, reconstruite depuis le détail structuré (utilisable telle quelle dans Waze/Maps)");
    assert.ok(geo[0].display_name.includes('Mairie de Paris'), "l'adresse complète reste disponible séparément");
    assert.strictEqual(geo[1].label, 'Mairie de Paris bis, 75001 Paris', "repli correct même sans numéro de rue");
    ok(await alice.get('/api/geocode?q=une+erreur+ici'), 502, "un vrai échec du service de recherche remonte une erreur distincte, pas une simple liste vide");

    // Coordonnées d'un lieu d'événement (pour un lien « Itinéraire » fiable, indépendant du format texte)
    const evLoc = (await alice.post('/api/events', { circle_id: circle, title: 'RDV pédiatre', starts_at: '2026-11-12T10:00', location: geo[0].label, location_lat: Number(geo[0].lat), location_lon: Number(geo[0].lon) })).body;
    assert.strictEqual(evLoc.location_lat, 48.8566);
    assert.strictEqual(evLoc.location_lon, 2.3522);
    ok(await alice.put(`/api/events/${evLoc.id}`, { location: 'Autre adresse tapée à la main' }), 200);
    const evLocAfter = (await alice.get('/api/events/range?from=2026-11-12&to=2026-11-12')).body.find((e) => e.id === evLoc.id);
    assert.strictEqual(evLocAfter.location, 'Autre adresse tapée à la main');
    assert.strictEqual(evLocAfter.location_lat, null, "changer le lieu à la main sans nouvelle coordonnée efface l'ancienne (elle ne correspondrait plus)");
    assert.strictEqual(evLocAfter.location_lon, null);
    assert.strictEqual(geo[0].lat, '48.8566');
    assert.deepStrictEqual((await alice.get('/api/geocode?q=adresse+vide+test')).body, [], "aucun résultat renvoyé proprement (liste vide, pas d'erreur)");

    // Recettes (optionnel) : notation globale + par enfant
    const recipe = (await alice.post('/api/recipes', { circle_id: c2, title: 'Gratin de courgettes', ingredients: 'Courgettes\nCrème\nFromage', instructions: 'Cuire au four 30 min.' })).body;
    assert.deepStrictEqual(recipe.child_ratings, {}, 'aucune note par enfant au départ');
    ok(await alice.put(`/api/recipes/${recipe.id}`, { rating_global: 6 }), 400, 'note globale hors intervalle refusée');
    ok(await alice.put(`/api/recipes/${recipe.id}`, { rating_global: 4 }), 200);
    ok(await alice.put(`/api/recipes/${recipe.id}/child-rating`, { child_id: kid1, rating: 5 }), 200, 'Léo adore');
    ok(await alice.put(`/api/recipes/${recipe.id}/child-rating`, { child_id: kid2, rating: 1 }), 200, 'Mia déteste');
    ok(await alice.put(`/api/recipes/${recipe.id}/child-rating`, { child_id: kid1, rating: 7 }), 400, 'note enfant hors intervalle refusée');
    let rec = (await alice.get('/api/recipes')).body.find((x) => x.id === recipe.id);
    assert.strictEqual(rec.rating_global, 4);
    assert.deepStrictEqual(rec.child_ratings, { [kid1]: 5, [kid2]: 1 });
    ok(await alice.put(`/api/recipes/${recipe.id}/child-rating`, { child_id: kid1, rating: null }), 200, 'effacer la note de Léo');
    rec = (await alice.get('/api/recipes')).body.find((x) => x.id === recipe.id);
    assert.deepStrictEqual(rec.child_ratings, { [kid2]: 1 });
    assert.ok(!(await carla.get('/api/recipes')).body.some((x) => x.id === recipe.id), "Carla n'est pas dans le cercle Coparents : recette isolée par cercle");
    ok(await carla.put(`/api/recipes/${recipe.id}`, { rating_global: 2 }), 403, "Carla n'est pas membre du cercle de cette recette");

    // Ingrédients structurés (nom/quantité/unité/catégorie) et portions, pour le planificateur de repas
    const recipe2 = (await alice.post('/api/recipes', {
      circle_id: c2, title: 'Pâtes bolognaise', servings: 4,
      ingredients_json: [
        { name: 'Pâtes', amount: 400, unit: 'g', category: 'Épicerie' },
        { name: 'Bœuf haché', amount: 500, unit: 'g', category: 'Viande & poisson' },
        { name: 'Tomates pelées', amount: 800, unit: 'g', category: 'Épicerie' },
        { name: 'Sel', category: 'Épicerie' }, // sans quantité : autorisé
      ],
    })).body;
    assert.strictEqual(recipe2.servings, 4);
    assert.strictEqual(recipe2.ingredients_json.length, 4);
    assert.strictEqual(recipe2.ingredients_json[3].amount, null, 'un ingrédient sans quantité reste valide');
    ok(await alice.post('/api/recipes', { circle_id: c2, title: 'Sans ingrédients' }), 200, "les ingrédients structurés restent facultatifs (liste vide par défaut)");
    ok(await alice.put(`/api/recipes/${recipe2.id}`, { servings: 0 }), 400, 'un nombre de portions doit être positif');

    // Planificateur de repas
    ok(await carla.put('/api/meal-plans', { circle_id: c2, date: '2026-11-16', slot: 'diner', recipe_id: recipe2.id }), 403, "Carla n'est pas membre du cercle Coparents");
    let meal = (await alice.put('/api/meal-plans', { circle_id: c2, date: '2026-11-16', slot: 'diner', recipe_id: recipe2.id, servings: 8 })).body;
    assert.strictEqual(meal.servings, 8);
    // Assigner à nouveau le même jour/créneau remplace l'existant plutôt que d'en créer un second
    meal = (await alice.put('/api/meal-plans', { circle_id: c2, date: '2026-11-16', slot: 'diner', title: 'Restes', recipe_id: null })).body;
    const mealsThatDay = (await alice.get('/api/meal-plans?from=2026-11-16&to=2026-11-16')).body;
    assert.strictEqual(mealsThatDay.length, 1, 'un seul repas par jour/créneau : le second assigné remplace le premier');
    assert.strictEqual(mealsThatDay[0].title, 'Restes');
    ok(await alice.put('/api/meal-plans', { circle_id: c2, date: '2026-11-16', slot: 'diner', recipe_id: recipe2.id, servings: 8 }), 200, 'on peut réattribuer une recette au même créneau');
    ok(await alice.put('/api/meal-plans', { circle_id: c2, date: '2026-11-17', slot: 'diner', recipe_id: recipe2.id, servings: 4 }), 200);
    ok(await alice.put('/api/meal-plans', { circle_id: c2, date: '2026-11-18', slot: 'dejeuner', title: 'Pizza (aucune recette liée)' }), 200);

    // Génération de la liste de courses depuis la semaine planifiée, avec mise à l'échelle des quantités
    const genShop = await alice.post('/api/meal-plans/shopping-list', { circle_id: c2, from: '2026-11-16', to: '2026-11-18' });
    assert.strictEqual(genShop.body.meals, 2, "2 repas avec recette liée sur la période (la pizza sans recette est ignorée)");
    assert.strictEqual(genShop.body.added, 4, '4 ingrédients distincts agrégés');
    const shopItems = (await alice.get('/api/shopping')).body.filter((i) => i.circle_id === c2);
    const pasta = shopItems.find((i) => i.label === 'Pâtes');
    assert.strictEqual(pasta.qty, '1200 g', '400g × (8/4=2 portions) + 400g × (4/4=1 portion) = 1200g');
    assert.strictEqual(pasta.category, 'Épicerie');
    const salt = shopItems.find((i) => i.label === 'Sel');
    assert.strictEqual(salt.qty, null, 'un ingrédient sans quantité de base reste sans quantité, même agrégé');
    ok(await carla.post('/api/meal-plans/shopping-list', { circle_id: c2, from: '2026-11-16', to: '2026-11-18' }), 403, "Carla n'est pas membre du cercle Coparents");
    ok(await alice.del(`/api/meal-plans/${meal.id}`), 200);
    assert.strictEqual((await alice.get('/api/meal-plans?from=2026-11-16&to=2026-11-16')).body.length, 0);

    const custodyBob = (await bob.get('/api/custody?from=2026-11-10&to=2026-11-10')).body;
    const custodyCarla = (await carla.get('/api/custody?from=2026-11-10&to=2026-11-10')).body;
    assert.ok(custodyBob.every((n) => n.child_id === kid1), 'Bob ne voit que les nuits de Léo');
    assert.ok(custodyCarla.every((n) => n.child_id === kid2), 'Carla ne voit que les nuits de Mia');
    ok(await bob.put('/api/custody', { date_from: '2026-11-11', date_to: '2026-11-11', child_ids: [kid2], parent_id: B }), 403, "Bob ne peut pas modifier la garde de Mia");
    ok(await bob.post('/api/custody/generate', { pattern: 'halves', child_ids: [kid2], parent_a: A, parent_b: B, start: '2026-11-12', end: '2026-11-13' }), 403, "Bob ne peut pas générer un planning pour Mia");
    // La garde ne peut être attribuée qu'à un parent désigné de l'enfant, même par un administrateur.
    ok(await alice.put('/api/custody', { date_from: '2026-11-13', date_to: '2026-11-13', child_ids: [kid1], parent_id: C }), 400, "Carla n'est pas un parent désigné de Léo : attribution refusée");
    ok(await alice.post('/api/custody/generate', { pattern: 'halves', child_ids: [kid1], parent_a: A, parent_b: C, start: '2026-11-14', end: '2026-11-15' }), 400, "idem pour la génération de planning");
    ok(await alice.put('/api/custody', { date_from: '2026-11-13', date_to: '2026-11-13', child_ids: [kid1], parent_id: B }), 200, 'Bob, lui, est bien un parent désigné de Léo');

    ok(await alice.post('/api/contacts', { circle_ids: [circle], name: 'Pédiatre de Léo', child_id: kid1 }));
    ok(await alice.post('/api/contacts', { circle_ids: [circle], name: 'Pédiatre de Mia', child_id: kid2 }));
    const contactsBob = (await bob.get('/api/contacts')).body.map((c) => c.name);
    const contactsCarla = (await carla.get('/api/contacts')).body.map((c) => c.name);
    assert.ok(contactsBob.includes('Pédiatre de Léo') && !contactsBob.includes('Pédiatre de Mia'), 'Bob ne voit pas le contact de Mia');
    assert.ok(contactsCarla.includes('Pédiatre de Mia') && !contactsCarla.includes('Pédiatre de Léo'), 'Carla ne voit pas le contact de Léo');

    // Accès « lecture seule » (ex. le compagnon d'un parent) : voit, ne modifie jamais.
    const davidInv = await alice.post('/api/invites', { name: 'David', circle_ids: [circle] });
    const david = new Client();
    ok(await david.post(`/api/invites/${davidInv.body.token}/accept`, { email: 'david@ex.fr', password: 'motdepasse4' }), 200);
    const davidId = davidInv.body.user_id;
    ok(await alice.put(`/api/children/${kid1}`, { viewer_ids: [davidId] }), 200, 'David devient lecteur de Léo');
    ok(await bob.put(`/api/children/${kid1}`, { viewer_ids: [davidId] }), 403, "un parent (non-admin) ne peut pas désigner de lecteur");
    const davidMe = (await david.get('/api/me')).body;
    assert.ok(davidMe.children.some((c) => c.id === kid1), 'David voit Léo (lecteur)');
    assert.ok(!davidMe.children.some((c) => c.id === kid2), 'David ne voit pas Mia (aucun lien)');
    assert.ok((await david.get('/api/events/range?from=2026-11-01&to=2026-11-30')).body.some((e) => e.title === 'Anniversaire Léo'), 'David voit les événements de Léo');
    ok(await david.post('/api/events', { circle_id: circle, title: 'x', starts_at: '2026-11-09T10:00', child_ids: [kid1] }), 403, "David ne peut pas créer un événement pour Léo (lecture seule)");
    ok(await david.put(`/api/events/${evKid1.id}`, { title: 'Modifié par David' }), 403, "David ne peut pas modifier un événement de Léo, même sans toucher aux enfants");
    assert.ok((await david.get('/api/custody?from=2026-11-10&to=2026-11-10')).body.some((n) => n.child_id === kid1), 'David voit la garde de Léo');
    ok(await david.put('/api/custody', { date_from: '2026-11-15', date_to: '2026-11-15', child_ids: [kid1], parent_id: davidId }), 403, 'David ne peut pas modifier la garde de Léo');
    ok(await david.post('/api/custody/generate', { pattern: 'halves', child_ids: [kid1], parent_a: A, parent_b: B, start: '2026-11-20', end: '2026-11-21' }), 403, 'David ne peut pas générer un planning pour Léo');
    assert.ok((await david.get('/api/contacts')).body.some((c) => c.name === 'Pédiatre de Léo'), 'David voit le contact de Léo');
    ok(await david.post('/api/contacts', { circle_ids: [circle], name: 'x', child_id: kid1 }), 403, 'David ne peut pas créer un contact pour Léo');
    ok(await david.del(`/api/events/${evKid1.id}`), 403, 'David ne peut pas supprimer un événement de Léo');
    // Un simple événement général (sans enfant précis) reste créable par David, comme tout membre du cercle.
    ok(await david.post('/api/events', { circle_id: circle, title: 'Barbecue', starts_at: '2026-11-09T18:00' }), 200, 'David peut créer un événement général');

    ok(await alice.post('/api/expenses', { circle_id: circle, title: 'Cantine Léo', amount_cents: 5000, date: '2026-11-01', paid_by: A, split: { [A]: 100 }, child_id: kid1 }));
    assert.ok((await bob.get('/api/expenses')).body.some((e) => e.title === 'Cantine Léo'), "la dépense reste visible par tout le cercle malgré le rattachement à un enfant");

    // Seuls les parents désignés d'un enfant se partagent le remboursement ; un beau-parent (ou
    // toute autre personne) peut avoir payé et être remboursé sans faire partie du partage.
    ok(await alice.post('/api/expenses', { circle_id: circle, title: 'Dentiste Léo', amount_cents: 8000, date: '2026-11-03', paid_by: A, split: { [A]: 50, [davidId]: 50 }, child_id: kid1 }), 400, "David n'est pas un parent désigné de Léo, il ne peut pas faire partie du partage");
    ok(await alice.post('/api/expenses', { circle_id: circle, title: 'Dentiste Léo', amount_cents: 8000, date: '2026-11-03', paid_by: davidId, split: { [A]: 50, [B]: 50 }, child_id: kid1 }), 200, "David peut en revanche avoir payé, sans faire partie du partage lui-même");
    const expLeo = (await alice.get('/api/expenses')).body.find((e) => e.title === 'Dentiste Léo');
    assert.strictEqual(expLeo.paid_by, davidId, 'David reste bien enregistré comme ayant payé');
    ok(await alice.post('/api/expenses', { circle_id: circle, title: 'Lunettes Mia', amount_cents: 15000, date: '2026-11-04', paid_by: C, split: { [A]: 50, [C]: 50 }, child_id: kid2 }), 200, 'les parents désignés de Mia (Alice, Carla) peuvent bien se partager sa dépense');
    ok(await alice.post('/api/expenses', { circle_id: circle, title: 'Fausse pour Mia', amount_cents: 100, date: '2026-11-04', paid_by: A, split: { [B]: 100 }, child_id: kid2 }), 400, "Bob n'est pas un parent désigné de Mia");
    ok(await alice.post('/api/expenses', { circle_id: circle, title: 'Sans enfant précis', amount_cents: 100, date: '2026-11-04', paid_by: A, split: { [A]: 50, [davidId]: 50 } }), 200, "sans enfant rattaché, le partage reste ouvert à tout le cercle, comme avant");
    const freeExp = (await alice.get('/api/expenses')).body.find((e) => e.title === 'Sans enfant précis');
    ok(await alice.put(`/api/expenses/${freeExp.id}`, { child_id: kid1 }), 400, "rattacher après coup à Léo, avec un partage qui inclut David, doit être refusé");
    ok(await alice.put(`/api/expenses/${freeExp.id}`, { child_id: kid1, split: { [A]: 50, [B]: 50 } }), 200, 'mais passe en changeant le partage en même temps pour ne garder que les parents de Léo');

    // ── Dépenses : modification et suppression réservées à leur créateur ──
    const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const nowD = new Date();
    const bobExp = (await bob.post('/api/expenses', { circle_id: circle, title: 'Achat de Bob', amount_cents: 3000, date: '2026-11-05', paid_by: B, split: { [A]: 50, [B]: 50 } })).body;
    ok(await alice.put(`/api/expenses/${bobExp.id}`, { title: 'Piraté' }), 403, "Alice (même administratrice) ne peut pas modifier la dépense de Bob");
    ok(await alice.del(`/api/expenses/${bobExp.id}`), 403, "ni la supprimer");
    ok(await alice.del(`/api/expenses/${bobExp.id}/invoice`), 403, "ni toucher à sa facture");
    ok(await bob.put(`/api/expenses/${bobExp.id}`, { title: 'Achat de Bob (corrigé)', amount_cents: 3500 }), 200, 'Bob, son créateur, peut la modifier');
    const bobExpAfter = (await bob.get('/api/expenses')).body.find((e) => e.id === bobExp.id);
    assert.strictEqual(bobExpAfter.title, 'Achat de Bob (corrigé)');
    assert.strictEqual(bobExpAfter.amount_cents, 3500);
    assert.ok((await alice.get('/api/notifications')).body.some((n) => n.title === 'Dépense modifiée : Achat de Bob (corrigé)'), 'les autres sont prévenus de la modification');
    ok(await bob.put(`/api/expenses/${bobExp.id}`, { split: { [A]: 50, [davidId]: 50 }, child_id: kid1 }), 400, "la règle des parents désignés s'applique aussi à la modification");

    // ── Lignes de remboursement : montant libre (partiel), date, note ; réservées aux personnes concernées ──
    ok(await carla.post('/api/settlements', { circle_id: circle, from_user: A, to_user: B, amount_cents: 500 }), 403, "Carla n'est ni Alice ni Bob : ce remboursement ne la concerne pas");
    ok(await alice.post('/api/settlements', { circle_id: c2, from_user: A, to_user: C, amount_cents: 500 }), 400, "Carla n'est pas membre du cercle Coparents");
    ok(await alice.post('/api/settlements', { circle_id: circle, from_user: A, to_user: B, amount_cents: 1234, date: '2026-11-06', note: 'Virement partiel' }), 200, 'remboursement partiel avec date et note');
    ok(await alice.post('/api/settlements', { circle_id: circle, from_user: A, to_user: A, amount_cents: 100 }), 400, 'on ne se rembourse pas soi-même');
    const settleLine = (await alice.get(`/api/expenses/summary?circle_id=${circle}`)).body.settlements.find((x) => x.note === 'Virement partiel');
    assert.ok(settleLine && settleLine.amount_cents === 1234 && settleLine.date === '2026-11-06' && settleLine.created_by === A, 'la ligne est bien conservée avec son créateur');
    ok(await bob.del(`/api/settlements/${settleLine.id}`), 403, "Bob n'a pas enregistré cette ligne : il ne peut pas la supprimer");
    ok(await alice.del(`/api/settlements/${settleLine.id}`), 200, 'son créateur, oui');

    // ── Dépenses récurrentes : un modèle qui génère une vraie dépense à chaque échéance ──
    const weeklyStart = isoDay(new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate() - 15));
    const recWeekly = (await alice.post('/api/recurring-expenses', { circle_id: circle, title: 'Cantine hebdo', amount_cents: 6000, category: 'Cantine', paid_by: A, split: { [A]: 50, [B]: 50 }, repeat: 'weekly', start_date: weeklyStart })).body;
    let genRows = (await alice.get('/api/expenses')).body.filter((e) => e.recurring_id === recWeekly.id);
    assert.strictEqual(genRows.length, 3, "démarrée il y a 15 jours, chaque semaine : trois échéances sont déjà dues (J-15, J-8, J-1)");
    assert.deepStrictEqual(genRows.map((e) => e.date).sort(), [0, 7, 14].map((n) => isoDay(new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate() - 15 + n))));
    assert.ok(genRows.every((e) => e.created_by === A && e.amount_cents === 6000 && e.category === 'Cantine'), 'chaque échéance est une vraie dépense, au nom du créateur du modèle');
    ok(await alice.post('/api/admin/run-checks'), 200);
    assert.strictEqual((await alice.get('/api/expenses')).body.filter((e) => e.recurring_id === recWeekly.id).length, 3, 'un nouveau passage ne recrée pas les mêmes échéances');
    ok(await alice.del(`/api/expenses/${genRows[0].id}`), 200, 'on peut supprimer une échéance isolée (un mois sauté)');
    ok(await alice.post('/api/admin/run-checks'), 200);
    assert.strictEqual((await alice.get('/api/expenses')).body.filter((e) => e.recurring_id === recWeekly.id).length, 2, 'et elle ne revient pas');
    const futureStart = isoDay(new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate() + 3));
    const recFuture = (await alice.post('/api/recurring-expenses', { circle_id: circle, title: 'Pas encore', amount_cents: 1000, paid_by: A, split: { [A]: 100 }, repeat: 'monthly', start_date: futureStart })).body;
    assert.strictEqual((await alice.get('/api/expenses')).body.filter((e) => e.recurring_id === recFuture.id).length, 0, "début dans le futur : rien n'est créé avant l'échéance");
    const firstOf = (off) => isoDay(new Date(nowD.getFullYear(), nowD.getMonth() + off, 1));
    const recEnd = (await alice.post('/api/recurring-expenses', { circle_id: circle, title: 'Avec fin', amount_cents: 1000, paid_by: A, split: { [A]: 100 }, repeat: 'monthly', start_date: firstOf(-3), repeat_until: firstOf(-2) })).body;
    assert.strictEqual((await alice.get('/api/expenses')).body.filter((e) => e.recurring_id === recEnd.id).length, 2, "une date de fin arrête la série : seules les échéances jusqu'à celle-ci sont créées");
    ok(await alice.post('/api/recurring-expenses', { circle_id: circle, title: 'Fin avant début', amount_cents: 1000, paid_by: A, split: { [A]: 100 }, repeat: 'monthly', start_date: firstOf(-1), repeat_until: firstOf(-3) }), 400, 'fin avant le début refusée');
    ok(await alice.post('/api/recurring-expenses', { circle_id: circle, title: 'Fréquence bizarre', amount_cents: 1000, paid_by: A, split: { [A]: 100 }, repeat: 'daily', start_date: firstOf(-1) }), 400, 'fréquence quotidienne non proposée pour une dépense');
    ok(await alice.post('/api/recurring-expenses', { circle_id: circle, title: 'Léo + David', amount_cents: 1000, paid_by: A, split: { [A]: 50, [davidId]: 50 }, child_id: kid1, repeat: 'monthly', start_date: firstOf(-1) }), 400, 'la règle des parents désignés vaut aussi pour les dépenses récurrentes');
    ok(await bob.put(`/api/recurring-expenses/${recWeekly.id}`, { title: 'Piraté' }), 403, 'seul le créateur modifie le modèle');
    ok(await alice.put(`/api/recurring-expenses/${recWeekly.id}`, { repeat: 'monthly' }), 400, 'la fréquence ne se modifie pas');
    ok(await alice.put(`/api/recurring-expenses/${recWeekly.id}`, { start_date: firstOf(-1) }), 400, 'ni le début');
    ok(await alice.put(`/api/recurring-expenses/${recWeekly.id}`, { amount_cents: 6500 }), 200, 'mais le montant, oui (pour les échéances à venir)');
    assert.ok((await alice.get('/api/expenses')).body.filter((e) => e.recurring_id === recWeekly.id).every((e) => e.amount_cents === 6000), 'les échéances déjà créées gardent leur montant');
    ok(await bob.del(`/api/recurring-expenses/${recWeekly.id}`), 403, 'seul le créateur supprime le modèle');
    ok(await alice.del(`/api/recurring-expenses/${recWeekly.id}`), 200);
    assert.strictEqual((await alice.get('/api/expenses')).body.filter((e) => e.title === 'Cantine hebdo').length, 2, 'supprimer le modèle conserve les dépenses déjà créées');

    // ── Événements : catégorie, et prix qui alimente Budget ──
    const evP = (await alice.post('/api/events', { circle_id: circle, title: 'Dentiste', starts_at: '2026-11-20T10:00', category: 'Santé', price_cents: 4500, child_ids: [kid1] })).body;
    assert.strictEqual(evP.category, 'Santé');
    let exP = (await alice.get('/api/expenses')).body.find((e) => e.event_id === evP.id);
    assert.ok(exP, 'un prix sur un événement crée la dépense correspondante dans Budget');
    assert.deepStrictEqual([exP.amount_cents, exP.category, exP.paid_by, exP.date, exP.child_id, exP.title], [4500, 'Santé', A, '2026-11-20', kid1, 'Dentiste']);
    assert.deepStrictEqual(exP.split, { [A]: 50, [B]: 50 }, 'partagée entre les parents désignés de Léo, par défaut');
    ok(await alice.put(`/api/events/${evP.id}`, { price_cents: 5000 }), 200);
    assert.strictEqual((await alice.get('/api/expenses')).body.find((e) => e.id === exP.id).amount_cents, 5000, 'changer le prix met la dépense à jour');
    ok(await bob.put(`/api/events/${evP.id}`, { price_cents: 100 }), 403, "seul le créateur de l'événement modifie son prix");
    ok(await bob.put(`/api/events/${evP.id}`, { title: 'Dentiste (déplacé)' }), 200, "un autre parent peut en revanche modifier l'événement sans toucher au prix");
    assert.strictEqual((await alice.get('/api/expenses')).body.find((e) => e.id === exP.id).title, 'Dentiste (déplacé)', 'le nouveau titre est répercuté sur la dépense');
    ok(await alice.put(`/api/expenses/${exP.id}`, { amount_cents: 5200 }), 200);
    assert.strictEqual((await alice.get('/api/events/range?from=2026-11-20&to=2026-11-20')).body.find((e) => e.id === evP.id).price_cents, 5200, "modifier la dépense met aussi à jour le prix affiché sur l'événement");
    const evRange = (await alice.get('/api/events/range?from=2026-11-20&to=2026-11-20')).body.find((e) => e.id === evP.id);
    assert.strictEqual(evRange.category, 'Santé');
    assert.strictEqual(evRange.price_paid_by, A, "sans choix explicite, le payeur mémorisé est celui qui a saisi le prix");

    // Payeur choisi pour le prix d'un événement (pas forcément le créateur)
    const evPay = (await alice.post('/api/events', { circle_id: circle, title: 'Orthodontiste', starts_at: '2026-11-24T10:00', price_cents: 8000, price_paid_by: davidId, child_ids: [kid1] })).body;
    let exPay = (await alice.get('/api/expenses')).body.find((e) => e.event_id === evPay.id);
    assert.strictEqual(exPay.paid_by, davidId, "David (ni parent, ni créateur) est bien le payeur choisi");
    assert.deepStrictEqual(exPay.split, { [A]: 50, [B]: 50 }, "il avance l'argent sans faire partie du partage, réservé aux parents de Léo");
    assert.strictEqual(exPay.created_by, A, 'la dépense reste celle du créateur de l\'événement : lui seul pourra la modifier');
    ok(await alice.post('/api/events', { circle_id: c2, title: 'Payeur hors cercle', starts_at: '2026-11-24T11:00', price_cents: 1000, price_paid_by: C }), 400, "Carla n'est pas membre du cercle Coparents : elle ne peut pas être payeuse");
    ok(await alice.put(`/api/events/${evPay.id}`, { price_paid_by: B }), 200, 'changer le payeur depuis l\'événement');
    assert.strictEqual((await alice.get('/api/expenses')).body.find((e) => e.id === exPay.id).paid_by, B, 'la dépense suit');
    ok(await bob.put(`/api/events/${evPay.id}`, { price_paid_by: A }), 403, "seul le créateur de l'événement change le payeur");
    ok(await alice.put(`/api/expenses/${exPay.id}`, { paid_by: A }), 200, 'changer le payeur depuis Budget');
    assert.strictEqual((await alice.get('/api/events/range?from=2026-11-24&to=2026-11-24')).body.find((e) => e.id === evPay.id).price_paid_by, A, "l'événement suit aussi");
    ok(await alice.put(`/api/events/${evPay.id}`, { price_cents: null, price_paid_by: null }), 200);
    assert.strictEqual((await alice.get('/api/events/range?from=2026-11-24&to=2026-11-24')).body.find((e) => e.id === evPay.id).price_paid_by, null, 'retirer le prix efface aussi le payeur');
    ok(await alice.put(`/api/events/${evP.id}`, { repeat: 'weekly' }), 400, "un événement qui a un prix ne peut pas devenir récurrent");
    ok(await alice.post('/api/events', { circle_id: circle, title: 'Cours de piano', starts_at: '2026-11-21T10:00', repeat: 'weekly', price_cents: 3000 }), 400, "pas de prix sur un événement récurrent (utiliser une dépense récurrente)");
    ok(await alice.post('/api/events', { circle_id: circle, title: 'Catégorie inconnue', starts_at: '2026-11-21T10:00', category: 'Inventée' }), 400, 'catégorie inconnue refusée');
    ok(await alice.put(`/api/events/${evP.id}`, { price_cents: null }), 200, 'retirer le prix');
    assert.ok(!(await alice.get('/api/expenses')).body.some((e) => e.event_id === evP.id), 'retire aussi la dépense associée');
    const evQ = (await alice.post('/api/events', { circle_id: circle, title: 'Sortie ciné', starts_at: '2026-11-22T15:00', category: 'Famille', price_cents: 2000 })).body;
    const exQ = (await alice.get('/api/expenses')).body.find((e) => e.event_id === evQ.id);
    assert.strictEqual(exQ.category, 'Loisirs', "la catégorie d'événement « Famille » range la dépense en « Loisirs »");
    ok(await alice.del(`/api/events/${evQ.id}`), 200);
    const exQAfter = (await alice.get('/api/expenses')).body.find((e) => e.id === exQ.id);
    assert.ok(exQAfter && exQAfter.event_id === null, "supprimer l'événement ne supprime jamais silencieusement une dépense : elle est conservée, détachée");
    const evR = (await alice.post('/api/events', { circle_id: circle, title: 'Coiffeur', starts_at: '2026-11-23T15:00', price_cents: 1500 })).body;
    const exR = (await alice.get('/api/expenses')).body.find((e) => e.event_id === evR.id);
    ok(await alice.del(`/api/expenses/${exR.id}`), 200);
    assert.strictEqual((await alice.get('/api/events/range?from=2026-11-23&to=2026-11-23')).body.find((e) => e.id === evR.id).price_cents, null, "supprimer la dépense efface le prix sur l'événement");

    // ── Recherche dans l'agenda (passé et à venir) ──
    const searchIds = async (client, q) => (await client.get(`/api/events/search?q=${encodeURIComponent(q)}`)).body;
    const todayIso = localDT(new Date()).slice(0, 10);
    await alice.post('/api/events', { circle_id: circle, title: 'Réunion parents-profs', location: 'École Jean Moulin', starts_at: '2026-12-10T18:00', category: 'École', notes: 'Apporter le carnet' });
    await alice.post('/api/events', { circle_id: circle, title: 'Vieux souvenir Zanzibar', starts_at: '2025-01-10T10:00' });
    await alice.post('/api/events', { circle_id: circle, title: 'Secret Zorglub', starts_at: '2026-12-11T10:00', child_ids: [kid1] });
    const wk = (await alice.post('/api/events', { circle_id: circle, title: 'Judo Zanzibar hebdo', starts_at: '2026-01-05T17:00', ends_at: '2026-01-05T18:00', repeat: 'weekly' })).body;
    assert.deepStrictEqual((await searchIds(alice, 'a')).length, 0, 'une requête trop courte ne renvoie rien');
    assert.ok((await searchIds(alice, 'moulin')).some((e) => e.title === 'Réunion parents-profs'), 'recherche dans le lieu');
    assert.ok((await searchIds(alice, 'ecole')).some((e) => e.title === 'Réunion parents-profs'), 'sans tenir compte des accents (ecole → École)');
    assert.ok((await searchIds(alice, 'REUNION')).some((e) => e.title === 'Réunion parents-profs'), 'ni de la casse');
    assert.ok((await searchIds(alice, 'carnet')).some((e) => e.title === 'Réunion parents-profs'), 'recherche dans les notes');
    assert.ok((await searchIds(alice, 'reunion moulin')).some((e) => e.title === 'Réunion parents-profs'), 'plusieurs mots : tous doivent correspondre');
    assert.ok(!(await searchIds(alice, 'reunion zanzibar')).some((e) => e.title === 'Réunion parents-profs'), "un mot absent exclut le résultat");
    const zanz = await searchIds(alice, 'zanzibar');
    assert.strictEqual(zanz.filter((e) => e.title === 'Judo Zanzibar hebdo').length, 1, 'une série récurrente apparaît une seule fois');
    const judo = zanz.find((e) => e.title === 'Judo Zanzibar hebdo');
    assert.ok(judo.recurring && judo.occ_date >= todayIso && !judo.past, 'avec sa prochaine occurrence');
    const oldOne = zanz.find((e) => e.title === 'Vieux souvenir Zanzibar');
    assert.ok(oldOne && oldOne.past === true, 'un événement passé reste trouvable');
    assert.ok(zanz.indexOf(judo) < zanz.indexOf(oldOne), "les événements à venir passent avant les passés");
    assert.ok((await searchIds(alice, 'zorglub')).some((e) => e.title === 'Secret Zorglub'), 'Alice, parent désigné de Léo, le trouve');
    assert.ok(!(await searchIds(carla, 'zorglub')).length, "la recherche respecte la confidentialité par enfant : Carla ne trouve rien");
    assert.ok(!(await searchIds(carla, 'moulin')).some((e) => e.circle_id !== circle), 'et jamais hors de ses cercles');
    assert.strictEqual((await anon.get('/api/events/search?q=moulin')).status, 401, 'réservé aux membres connectés');

    // ── Budget : détail par catégorie selon le mois, l'année ou toute la période ──
    await alice.post('/api/expenses', { circle_id: circle, title: 'Dépense 2025', amount_cents: 1234, category: 'Santé', date: '2025-06-01', paid_by: A, split: { [A]: 100 } });
    const allExp = (await alice.get('/api/expenses')).body.filter((e) => e.circle_id === circle);
    const byCat = (rows) => rows.reduce((m, e) => { const c = e.category || 'Autre'; m[c] = (m[c] || 0) + e.amount_cents; return m; }, {});
    const catsOf = async (qs) => { const r = (await alice.get(`/api/expenses/summary?circle_id=${circle}&${qs}`)).body; return { period: r.period, cats: Object.fromEntries(r.categories.map((c) => [c.category, c.total])) }; };
    const y25 = await catsOf('year=2025');
    assert.deepStrictEqual(y25.period, { kind: 'year', value: '2025' });
    assert.deepStrictEqual(y25.cats, byCat(allExp.filter((e) => e.date.startsWith('2025'))), 'le détail par année ne compte que cette année');
    assert.strictEqual(y25.cats['Santé'], 1234);
    assert.deepStrictEqual((await catsOf('year=2026')).cats, byCat(allExp.filter((e) => e.date.startsWith('2026'))));
    const everything = await catsOf('all=1');
    assert.strictEqual(everything.period.kind, 'all');
    assert.deepStrictEqual(everything.cats, byCat(allExp), 'toute la période');
    const m = await catsOf('month=2025-06');
    assert.deepStrictEqual([m.period.kind, m.cats], ['month', { Santé: 1234 }], 'le détail par mois existant fonctionne toujours');
    assert.strictEqual((await alice.get(`/api/expenses/summary?circle_id=${circle}`)).body.period.kind, 'month', 'par défaut : le mois courant, comme avant');

    // Facture PDF sur une dépense, retrouvable dans Documents → Facture
    const invoiceExp = (await alice.post('/api/expenses', { circle_id: c2, title: 'Lunettes', amount_cents: 12000, date: '2026-11-02', paid_by: A, split: { [A]: 100 } })).body;
    const fdBadPdf = new FormData(); fdBadPdf.append('file', new Blob(['pas un pdf']), 'x.txt');
    ok(await alice.call('POST', `/api/expenses/${invoiceExp.id}/invoice`, undefined, fdBadPdf), 400, 'un fichier qui n\'est pas un vrai PDF est refusé');
    const pdfBytes = '%PDF-1.4\n%%EOF';
    const fdPdf = new FormData(); fdPdf.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'facture.pdf');
    ok(await carla.call('POST', `/api/expenses/${invoiceExp.id}/invoice`, undefined, fdPdf), 403, "Carla n'est pas membre du cercle Coparents");
    const fdPdf2 = new FormData(); fdPdf2.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'facture.pdf');
    const invoiceUpload = await alice.call('POST', `/api/expenses/${invoiceExp.id}/invoice`, undefined, fdPdf2);
    ok(invoiceUpload, 200, 'upload de la facture PDF');
    const docId = invoiceUpload.body.document_id;
    let expAfter = (await bob.get('/api/expenses')).body.find((e) => e.id === invoiceExp.id);
    assert.strictEqual(expAfter.document_id, docId, "la dépense pointe vers le document créé");
    const docsForBob = (await bob.get('/api/documents')).body;
    const invoiceDoc = docsForBob.find((d) => d.id === docId);
    assert.ok(invoiceDoc, 'le document créé est bien visible dans Documents');
    assert.strictEqual(invoiceDoc.category, 'Facture', 'classé automatiquement dans la catégorie Facture');
    const dlInv = await fetch(`${BASE}/api/documents/${docId}/file`, { headers: { Cookie: bob.cookie } });
    assert.strictEqual(await dlInv.text(), pdfBytes, 'le contenu du PDF est bien récupérable depuis Documents');
    // Remplacer la facture : l'ancien document disparaît, un seul document lié à la fois
    // (SQLite peut réutiliser le même identifiant juste libéré : ce qui compte est le contenu, pas l'id.)
    const fdPdf3 = new FormData(); fdPdf3.append('file', new Blob(['%PDF-1.4\nautre'], { type: 'application/pdf' }), 'facture2.pdf');
    const invRes2 = await alice.call('POST', `/api/expenses/${invoiceExp.id}/invoice`, undefined, fdPdf3);
    const docId2 = invRes2.body.document_id;
    const dlInv2 = await fetch(`${BASE}/api/documents/${docId2}/file`, { headers: { Cookie: alice.cookie } });
    assert.strictEqual(await dlInv2.text(), '%PDF-1.4\nautre', 'la facture liée est bien la nouvelle, pas l\'ancienne');
    assert.strictEqual((await alice.get('/api/documents')).body.filter((d) => d.category === 'Facture').length, 1, "l'ancienne facture a bien été supprimée (une seule reste)");
    ok(await alice.del(`/api/expenses/${invoiceExp.id}/invoice`), 200, 'retirer la facture sans supprimer la dépense');
    expAfter = (await alice.get('/api/expenses')).body.find((e) => e.id === invoiceExp.id);
    assert.strictEqual(expAfter.document_id, null);
    assert.strictEqual((await alice.get('/api/documents')).body.filter((d) => d.category === 'Facture').length, 0, 'le document est bien supprimé avec la facture retirée');
    // Supprimer la dépense supprime aussi sa facture jointe
    const fdPdf4 = new FormData(); fdPdf4.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'facture3.pdf');
    const invRes3 = await alice.call('POST', `/api/expenses/${invoiceExp.id}/invoice`, undefined, fdPdf4);
    const docId3 = invRes3.body.document_id;
    ok(await alice.del(`/api/expenses/${invoiceExp.id}`), 200);
    assert.ok(!(await alice.get('/api/documents')).body.some((d) => d.id === docId3), "supprimer la dépense supprime aussi le document de facture associé");

    // Notifications par e-mail (faux serveur SMTP local)
    assert.strictEqual((await bob.get('/api/me')).body.settings.smtp_configured, true, 'le serveur signale le SMTP comme configuré');
    assert.strictEqual((await bob.get('/api/me')).body.settings.public_url, 'https://famille.test', "l'adresse publique configurée (PUBLIC_URL) est exposée au client, pour des liens toujours valides");

    // Configuration SMTP depuis les réglages admin (prioritaire sur les variables d'environnement)
    ok(await bob.get('/api/settings/smtp'), 403, 'seul un administrateur peut consulter la config SMTP');
    const smtpBefore = (await alice.get('/api/settings/smtp')).body;
    assert.strictEqual(smtpBefore.configured, true, 'déjà configuré via les variables d\'environnement (faux serveur de test)');
    assert.strictEqual(smtpBefore.has_password, false);
    ok(await bob.put('/api/settings/smtp', { host: 'x' }), 403, 'seul un administrateur peut modifier la config SMTP');
    ok(await alice.put('/api/settings/smtp', { host: '' }), 400, 'hôte vide refusé');
    ok(await alice.put('/api/settings/smtp', { host: 'smtp.example.com', port: 999999 }), 400, 'port invalide refusé');
    ok(await alice.put('/api/settings/smtp', { host: 'smtp.example.com', port: 465, user: 'x@example.com', pass: 'secret', from: 'x@example.com', secure: true }), 200, 'configuration enregistrée depuis l\'application');
    let smtpNow = (await alice.get('/api/settings/smtp')).body;
    assert.strictEqual(smtpNow.host, 'smtp.example.com', 'la config enregistrée prend le dessus sur la variable d\'environnement');
    assert.strictEqual(smtpNow.has_password, true);
    assert.strictEqual(smtpNow.pass, undefined, 'le mot de passe ne doit jamais être renvoyé au client');
    ok(await alice.put('/api/settings/smtp', { host: 'smtp.example.com', pass: '' }), 200, 'champ mot de passe laissé vide = inchangé, pas effacé');
    assert.strictEqual((await alice.get('/api/settings/smtp')).body.has_password, true, 'le mot de passe précédent est resté en place');
    ok(await alice.del('/api/settings/smtp'), 200, 'réinitialisation : repli sur les variables d\'environnement');
    smtpNow = (await alice.get('/api/settings/smtp')).body;
    assert.strictEqual(smtpNow.host, '127.0.0.1', 'de retour sur la configuration du faux serveur SMTP de test (variable d\'environnement)');

    // Adresse publique (PUBLIC_URL) configurable depuis les réglages admin, avec repli sur la variable d'environnement
    ok(await bob.get('/api/settings/public-url'), 403, 'seul un administrateur peut consulter cette adresse');
    let urlInfo = (await alice.get('/api/settings/public-url')).body;
    assert.strictEqual(urlInfo.url, 'https://famille.test', 'valeur initiale reprise de la variable d\'environnement');
    assert.strictEqual(urlInfo.source, 'env');
    ok(await bob.put('/api/settings/public-url', { url: 'https://x.fr' }), 403, 'seul un administrateur peut la modifier');
    ok(await alice.put('/api/settings/public-url', { url: 'ftp://pas-http.fr' }), 400, 'seuls http(s) sont acceptés');
    ok(await alice.put('/api/settings/public-url', { url: 'https://mafamille.example.fr' }), 200);
    urlInfo = (await alice.get('/api/settings/public-url')).body;
    assert.strictEqual(urlInfo.url, 'https://mafamille.example.fr', 'la config enregistrée prend le dessus sur la variable d\'environnement');
    assert.strictEqual(urlInfo.source, 'app');
    assert.strictEqual((await bob.get('/api/me')).body.settings.public_url, 'https://mafamille.example.fr', 'immédiatement répercuté, sans redémarrage');
    ok(await alice.del('/api/settings/public-url'), 200, 'réinitialisation : repli sur la variable d\'environnement');
    urlInfo = (await alice.get('/api/settings/public-url')).body;
    assert.strictEqual(urlInfo.url, 'https://famille.test');
    assert.strictEqual(urlInfo.source, 'env');

    ok(await bob.put('/api/me', { email_notify: true }), 200, 'Bob active les notifications par e-mail');
    ok(await bob.post('/api/me/test-email'), 200, "e-mail de test envoyé");
    await new Promise((r) => setTimeout(r, 250));
    let mail = inbox.find((m) => m.subject === 'Mosaïque — e-mail de test' && m.to && m.to.text.includes('bob@ex.fr'));
    assert.ok(mail, "l'e-mail de test a bien été reçu par le faux serveur SMTP");

    inbox.length = 0;
    const task2 = (await alice.post('/api/tasks', { circle_id: circle, title: 'Acheter des cahiers', assignee_id: B })).body;
    await new Promise((r) => setTimeout(r, 400));
    mail = inbox.find((m) => m.to.text.includes('bob@ex.fr'));
    if (!mail) console.error('DEBUG inbox:', JSON.stringify(inbox.map((m) => ({ to: m.to.text, subject: m.subject }))), 'bobMe email_notify?', (await bob.get('/api/me')).body.user);
    assert.ok(mail, 'un e-mail est envoyé à Bob pour une tâche qui lui est assignée (notification activée)');
    assert.ok(mail.subject.includes('Acheter des cahiers'), "le sujet de l'e-mail reprend le titre de la notification");
    assert.ok(mail.text.includes('https://famille.test/#/taches'), "l'e-mail contient un lien vers l'application (PUBLIC_URL)");

    inbox.length = 0;
    const task3 = (await alice.post('/api/tasks', { circle_id: circle, title: 'Prendre rendez-vous', assignee_id: C })).body;
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!inbox.some((m) => m.to.text.includes('carla@ex.fr')), "Carla ne reçoit pas d'e-mail : elle n'a pas activé l'option");

    // École (devoirs et mots) : jeton famille distinct, réservé à l'admin, upsert par external_id.
    ok(await bob.get('/api/settings/integration-token'), 403, "un non-admin ne peut pas voir/générer le jeton d'intégration");
    const tokRes = await alice.post('/api/settings/integration-token');
    ok(tokRes, 200, "génération du jeton d'intégration");
    const schoolToken = tokRes.body.token;
    assert.strictEqual((await alice.get('/api/settings/integration-token')).body.token, schoolToken, 'le jeton est bien relisible par un admin');
    ok(await anon.call('POST', `/import/${schoolToken}/homework`, { child: 'Léo', title: 'Exercices de maths', subject: 'Maths', due_date: '2026-10-05', external_id: 'pronote-1' }), 200, 'import devoir (sans session, jeton famille)');
    ok(await anon.call('POST', '/import/mauvais-jeton/homework', { child: 'Léo', title: 'x' }), 404, "jeton d'intégration invalide");
    const batchRes = await anon.call('POST', `/import/${schoolToken}/homework`, [
      { child: 'Léo', title: 'Exercices de maths (màj)', subject: 'Maths', due_date: '2026-10-06', external_id: 'pronote-1' }, // même external_id → mise à jour, pas doublon
      { child: 'Mia', title: 'Poésie à apprendre', subject: 'Français', external_id: 'pronote-2' },
      { child: 'Inconnu', title: 'x' },
    ]);
    assert.deepStrictEqual(batchRes.body.results.map((r) => r.ok), [true, true, false], 'lot mixte : succès, succès, enfant introuvable');
    assert.strictEqual(batchRes.body.results[0].updated, true, "l'import réutilise le même external_id (pas de doublon)");
    ok(await anon.call('POST', `/import/${schoolToken}/note`, { child: 'Léo', title: 'Réunion parents-profs le 12/11', external_id: 'mot-1' }), 200, 'import mot');

    const hwForAlice = (await alice.get('/api/homework')).body;
    assert.strictEqual(hwForAlice.filter((h) => h.title.includes('Exercices de maths')).length, 1, "l'upsert n'a pas créé de doublon");
    assert.ok(hwForAlice.some((h) => h.title === 'Exercices de maths (màj)'), 'le titre a bien été mis à jour');
    const hwForBob = (await bob.get('/api/homework')).body;
    assert.ok(hwForBob.some((h) => h.child_id === kid1), 'Bob (parent de Léo) voit ses devoirs');
    assert.ok(!hwForBob.some((h) => h.child_id === kid2), 'Bob ne voit pas les devoirs de Mia');
    const hwForCarla = (await carla.get('/api/homework')).body;
    assert.ok(hwForCarla.some((h) => h.child_id === kid2) && !hwForCarla.some((h) => h.child_id === kid1), 'Carla ne voit que les devoirs de Mia');
    const leoHwId = hwForBob.find((h) => h.child_id === kid1).id;
    ok(await david.put(`/api/homework/${leoHwId}`, { done: true }), 403, 'David (lecteur de Léo) ne peut pas cocher un devoir');
    ok(await bob.put(`/api/homework/${leoHwId}`, { done: true }), 200, 'Bob (parent) peut cocher un devoir de Léo');
    assert.strictEqual((await alice.get('/api/homework')).body.find((h) => h.id === leoHwId).done, 1);
    ok(await david.del(`/api/homework/${leoHwId}`), 403, 'David ne peut pas supprimer un devoir de Léo');

    const notesForBob = (await bob.get('/api/notes')).body;
    assert.ok(notesForBob.some((n) => n.title.includes('Réunion parents-profs')), 'Bob voit le mot concernant Léo');
    const noteId = notesForBob[0].id;
    ok(await david.put(`/api/notes/${noteId}`, { read: true }), 200, "un lecteur peut marquer un mot comme lu (ce n'est pas une donnée scolaire modifiée)");
    ok(await david.del(`/api/notes/${noteId}`), 403, 'mais pas le supprimer');

    // Réservations et factures périscolaires (addon e-portail) : même jeton famille, même logique
    // d'upsert par external_id ; les réservations suivent la visibilité par enfant, les factures
    // sont rattachées au cercle (un seul cercle ici → résolu automatiquement sans le préciser).
    ok(await anon.call('POST', `/import/${schoolToken}/reservation`, { child: 'Léo', title: 'Garderie matin', date: '2026-11-10', start_time: '07:30', end_time: '08:30', status: 'confirmée', external_id: 'eportail-r1' }), 200, 'import réservation');
    const resaBatch = await anon.call('POST', `/import/${schoolToken}/reservation`, [
      { child: 'Léo', title: 'Garderie matin', date: '2026-11-10', start_time: '07:30', end_time: '08:30', status: 'annulée', external_id: 'eportail-r1' }, // même external_id → mise à jour
      { child: 'Mia', title: 'Cantine', date: '2026-11-10', external_id: 'eportail-r2' },
      { child: 'Inconnu', title: 'x', date: '2026-11-10' },
    ]);
    assert.deepStrictEqual(resaBatch.body.results.map((r) => r.ok), [true, true, false], 'lot mixte réservations : succès, succès, enfant introuvable');
    assert.strictEqual(resaBatch.body.results[0].updated, true, "l'import réutilise le même external_id (pas de doublon)");
    ok(await anon.call('POST', `/import/${schoolToken}/reservation`, { child: 'Léo', title: 'x', date: 'pas une date' }), 200, 'date invalide : réponse 200 avec erreur dans le résultat');
    const resaForBob = (await bob.get('/api/reservations')).body;
    assert.ok(resaForBob.some((r) => r.child_id === kid1 && r.status === 'annulée'), 'Bob voit la réservation de Léo, mise à jour');
    assert.ok(!resaForBob.some((r) => r.child_id === kid2), 'Bob ne voit pas les réservations de Mia');
    const resaForCarla = (await carla.get('/api/reservations')).body;
    assert.ok(resaForCarla.some((r) => r.child_id === kid2) && !resaForCarla.some((r) => r.child_id === kid1), 'Carla ne voit que les réservations de Mia');
    const leoResaId = resaForBob.find((r) => r.child_id === kid1).id;
    ok(await david.del(`/api/reservations/${leoResaId}`), 403, "David (lecteur de Léo) ne peut pas supprimer sa réservation");
    ok(await bob.del(`/api/reservations/${leoResaId}`), 200, 'Bob (parent) peut supprimer une réservation de Léo');

    // Plusieurs cercles existent ('Les Test' et 'Coparents') : sans précision, le cercle est ambigu.
    assert.strictEqual((await anon.call('POST', `/import/${schoolToken}/facture`, { label: 'x', number: 'y', date: '2026-11-01', amount: 10 })).body.results[0].error, 'Cercle introuvable.', 'facture sans cercle précisé, plusieurs cercles existants → erreur');
    ok(await anon.call('POST', `/import/${schoolToken}/facture`, { label: 'Cantine novembre', number: 'F-2026-11', date: '2026-11-01', due_date: '2026-11-30', amount: 42.5, status: 'à payer', circle: 'Famille', external_id: 'eportail-f1' }), 200, 'import facture (cercle précisé par son nom)');
    const facBatch = await anon.call('POST', `/import/${schoolToken}/facture`, { label: 'Cantine novembre', number: 'F-2026-11', date: '2026-11-01', amount: 42.5, status: 'payée', circle_id: circle, external_id: 'eportail-f1' });
    assert.strictEqual(facBatch.body.results[0].updated, true, "l'import de facture réutilise le même external_id");
    const invForBob = (await bob.get('/api/invoices')).body;
    const fac1 = invForBob.find((i) => i.number === 'F-2026-11');
    assert.ok(fac1, 'Bob (membre du cercle) voit la facture');
    assert.strictEqual(fac1.amount_cents, 4250, 'le montant en euros est bien converti en centimes');
    assert.strictEqual(fac1.status, 'payée', 'le statut a bien été mis à jour');
    assert.ok((await carla.get('/api/invoices')).body.some((i) => i.id === fac1.id), 'Carla (même cercle) voit aussi la facture');
    ok(await anon.call('POST', `/import/${schoolToken}/facture`, { label: 'x', number: 'y', date: '2026-11-01', amount: -5 }), 200, 'montant invalide : réponse 200 avec erreur dans le résultat');
    assert.strictEqual((await anon.call('POST', `/import/${schoolToken}/facture`, { label: 'x', number: 'y', date: '2026-11-01', amount: -5 })).body.results[0].ok, false, "montant négatif rejeté par l'upsert");

    // Attribution des factures en attente (Budget) : à quelqu'un qui va payer (reste en attente, hors
    // des comptes), ou qui a déjà payé (crée une vraie dépense partagée, qui la fait sortir de « en attente »).
    assert.strictEqual(fac1.expense_id, null, "une facture importée démarre « en attente », sans dépense liée");
    assert.strictEqual(fac1.assigned_to, null, 'et non attribuée');
    ok(await bob.put(`/api/invoices/${fac1.id}/assign`, { assigned_to: 999999 }), 400, 'le payeur doit faire partie du cercle');
    const assigned = (await bob.put(`/api/invoices/${fac1.id}/assign`, { assigned_to: B })).body;
    assert.strictEqual(assigned.assigned_to, B, 'la facture est attribuée à Bob, qui va la payer');
    assert.strictEqual(assigned.expense_id, null, 'mais reste en attente (pas encore payée)');
    assert.ok(!(await alice.get('/api/expenses')).body.some((e) => e.title.includes('Cantine novembre')), "aucune dépense créée tant que ce n'est que « va payer »");
    const paidInv = (await alice.put(`/api/invoices/${fac1.id}/assign`, { assigned_to: C, paid: true, date: '2026-11-05' })).body;
    assert.ok(paidInv.expense_id, 'marquer payée crée bien une dépense liée');
    assert.strictEqual(paidInv.assigned_to, C, 'attribuée à Carla, qui a payé (réattribution possible tant que ce n\'est pas encore payé)');
    const facExpense = (await bob.get('/api/expenses')).body.find((e) => e.id === paidInv.expense_id);
    assert.ok(facExpense, 'la dépense correspondante apparaît dans Budget, visible par tout le cercle');
    assert.strictEqual(facExpense.paid_by, C);
    assert.strictEqual(facExpense.amount_cents, 4250);
    assert.strictEqual(facExpense.date, '2026-11-05');
    assert.strictEqual(facExpense.category, 'Cantine');
    assert.deepStrictEqual(Object.keys(facExpense.split).map(Number).sort((x, y) => x - y), [A, B, C, davidId].sort((x, y) => x - y), 'partagée à égalité entre tout le cercle (facture non rattachée à un enfant)');
    ok(await bob.put(`/api/invoices/${fac1.id}/assign`, { assigned_to: B, paid: true }), 400, 'une facture déjà payée ne se réattribue plus directement (passer par Budget)');
    ok(await alice.del(`/api/expenses/${paidInv.expense_id}`), 200, 'supprimer la dépense depuis Budget');
    const revived = (await bob.get('/api/invoices')).body.find((i) => i.id === fac1.id);
    assert.strictEqual(revived.expense_id, null, 'supprimer la dépense redonne automatiquement la facture en attente');
    assert.strictEqual(revived.assigned_to, C, 'toujours attribuée à Carla, juste de nouveau non payée');

    // Addons de réservation périscolaire (Réglages → Administration → « Modules complémentaires ») :
    // configuration admin-only, mot de passe jamais renvoyé en clair, synchronisation déclenchée manuellement.
    ok(await bob.get('/api/addons'), 403, "un non-admin n'a pas accès aux addons");
    const addonsList = (await alice.get('/api/addons')).body;
    const eportail = addonsList.find((a) => a.id === 'eportail');
    assert.ok(eportail, "l'addon e-portail est bien découvert");
    assert.strictEqual(eportail.enabled, false, 'désactivé par défaut');
    assert.strictEqual(eportail.config.password, false, "aucun mot de passe enregistré au départ");
    ok(await bob.put('/api/addons/eportail', { enabled: true }), 403, "un non-admin ne peut pas configurer un addon");
    ok(await alice.put('/api/addons/inconnu', { enabled: true }), 404, 'addon inconnu');
    // Sans activation préalable, une tentative de synchronisation est refusée avant tout appel réseau.
    ok(await alice.post('/api/addons/eportail/sync'), 400, "synchronisation refusée : addon pas encore activé");
    const saved1 = (await alice.put('/api/addons/eportail', { enabled: true, config: { url: 'https://invalid.example.invalid/Commune', username: 'parent1', password: 'secret123' } })).body;
    assert.strictEqual(saved1.enabled, true);
    assert.strictEqual(saved1.config.url, 'https://invalid.example.invalid/Commune', "l'URL n'est pas un secret : renvoyée telle quelle");
    assert.strictEqual(saved1.config.username, 'parent1');
    assert.strictEqual(saved1.config.password, true, 'mot de passe renseigné : seulement un booléen, jamais la valeur');
    // Un mot de passe vide lors d'une mise à jour ultérieure laisse l'ancien inchangé (comme le SMTP).
    const saved2 = (await alice.put('/api/addons/eportail', { enabled: true, config: { url: 'https://invalid.example.invalid/Commune', username: 'parent1', password: '' } })).body;
    assert.strictEqual(saved2.config.password, true, "mot de passe vide à la mise à jour : l'ancien reste en place");
    // La synchronisation réelle nécessite le vrai portail (hors de portée de ce test) : on vérifie
    // seulement qu'un échec réseau remonte une erreur claire plutôt qu'un faux succès, et qu'elle
    // est journalisée pour être visible dans Réglages.
    const syncFail = await alice.post('/api/addons/eportail/sync');
    assert.ok(syncFail.status >= 400, "un portail injoignable remonte une erreur, jamais un faux succès");
    const afterFail = (await alice.get('/api/addons')).body.find((a) => a.id === 'eportail');
    assert.ok(afterFail.last_error, "l'échec est journalisé et visible dans Réglages");

    // Notifications push (Web Push) : abonnement, envoi réel (chiffré) vers un faux service local,
    // désabonnement, et nettoyage automatique d'un abonnement expiré (410).
    assert.ok((await alice.get('/api/me')).body.settings.vapid_public_key, 'une clé VAPID publique est exposée');
    ok(await alice.post('/api/push/subscribe', { endpoint: 'x' }), 400, 'abonnement incomplet refusé');
    const sub1 = fakePushSubscription(pushPort);
    ok(await alice.post('/api/push/subscribe', sub1), 200);
    ok(await alice.post('/api/push/test'), 200, "test manuel : au moins un appareil abonné");
    assert.strictEqual(pushHits, 1, "l'envoi du test a bien atteint le faux service push");
    // Un vrai échec d'envoi (ex. rejeté par le service push) doit remonter comme une erreur claire,
    // jamais un faux succès (bug corrigé : la route avalait silencieusement les erreurs).
    pushHits = 0; pushNextStatus = 500;
    const failedTest = await alice.post('/api/push/test');
    assert.strictEqual(failedTest.status, 502, 'un échec réel remonte une erreur, pas un faux succès');
    assert.ok(/500/.test(failedTest.body.error || ''), "le message d'erreur inclut le code renvoyé par le service push");
    pushNextStatus = 201;
    pushHits = 0;
    // On s'attend à être notifié des actions des AUTRES, pas des siennes : c'est donc Bob qui doit
    // être abonné pour recevoir une notification quand Alice crée une dépense (comportement voulu,
    // cohérent avec les notifications par e-mail).
    const bobSub = fakePushSubscription(pushPort);
    ok(await bob.post('/api/push/subscribe', bobSub), 200);
    ok(await alice.post('/api/expenses', { circle_id: circle, title: 'Test notif push', amount_cents: 100, date: '2026-11-20', paid_by: A, split: { [A]: 100 } }));
    await new Promise((r) => setTimeout(r, 800)); // l'envoi push est asynchrone, non bloquant pour la réponse HTTP
    assert.ok(pushHits >= 1, "créer une dépense notifie bien Bob par push (comme les autres membres du cercle)");
    pushHits = 0;
    ok(await bob.post('/api/push/unsubscribe', { endpoint: bobSub.endpoint }), 200);
    ok(await alice.post('/api/expenses', { circle_id: circle, title: 'Encore un test', amount_cents: 100, date: '2026-11-21', paid_by: A, split: { [A]: 100 } }));
    await new Promise((r) => setTimeout(r, 800));
    assert.strictEqual(pushHits, 0, 'Bob désabonné : plus aucun envoi le concernant');
    // Abonnement expiré côté navigateur (410) : nettoyé automatiquement, sans nouvelle tentative ensuite.
    const bobSub2 = fakePushSubscription(pushPort);
    ok(await bob.post('/api/push/subscribe', bobSub2), 200);
    pushNextStatus = 410;
    ok(await alice.post('/api/expenses', { circle_id: circle, title: 'Déclenche un 410', amount_cents: 100, date: '2026-11-22', paid_by: A, split: { [A]: 100 } }));
    await new Promise((r) => setTimeout(r, 800));
    assert.strictEqual(pushHits, 1, 'une tentative a bien eu lieu (410 reçu)');
    pushNextStatus = 201; pushHits = 0;
    ok(await alice.post('/api/expenses', { circle_id: circle, title: 'Ne devrait plus rien recevoir', amount_cents: 100, date: '2026-11-23', paid_by: A, split: { [A]: 100 } }));
    await new Promise((r) => setTimeout(r, 800));
    assert.strictEqual(pushHits, 0, "l'abonnement expiré a bien été supprimé après le 410, pas de nouvelle tentative");

    // Installabilité PWA (icône sur l'écran d'accueil, ouverture en plein écran)
    const manifestRes = await fetch(`${BASE}/manifest.webmanifest`);
    assert.strictEqual(manifestRes.status, 200);
    assert.ok((manifestRes.headers.get('content-type') || '').includes('application/manifest+json'), 'type MIME correct pour le manifeste');
    const manifestBody = await manifestRes.json();
    assert.strictEqual(manifestBody.display, 'standalone');
    assert.ok(manifestBody.icons.length >= 2, 'au moins deux tailles d\'icône déclarées');
    for (const icon of manifestBody.icons) {
      assert.strictEqual((await fetch(`${BASE}${icon.src}`)).status, 200, `icône manquante : ${icon.src}`);
    }
    assert.strictEqual((await fetch(`${BASE}/sw.js`)).status, 200, 'le service worker est bien servi');
    assert.strictEqual((await fetch(`${BASE}/icons/icon-180.png`)).status, 200, "icône Apple touch (iOS) accessible");

    console.log('\n✔ Tous les tests passent');
  } finally {
    srv.kill();
    fakeSmtp.close();
    fakeNominatim.close();
    fakePushService.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(certDir, { recursive: true, force: true });
  }
}
testHolidaysParsing();
testInstallDetection();
testDateUtils().then(main).catch((e) => { console.error('\n✘', e.message); process.exit(1); });
