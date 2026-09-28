'use strict';
const webpush = require('web-push');
const { db } = require('./db');
const { getSetting, setSetting, currentPublicUrl } = require('./settings');

// Clés VAPID : identité du serveur pour le protocole Web Push. Générées une seule fois au
// premier démarrage puis conservées dans la base (comme n'importe quel autre réglage), afin que
// les abonnements déjà enregistrés par les navigateurs restent valides après un redémarrage.
let publicKey = getSetting('vapid_public_key');
let privateKey = getSetting('vapid_private_key');
if (!publicKey || !privateKey) {
  const keys = webpush.generateVAPIDKeys();
  publicKey = keys.publicKey;
  privateKey = keys.privateKey;
  setSetting('vapid_public_key', publicKey);
  setSetting('vapid_private_key', privateKey);
}

// Le sujet VAPID (obligatoire) est recalculé à CHAQUE envoi à partir de l'adresse publique
// actuelle (réglages admin, puis variable d'environnement) — jamais figé au démarrage, pour
// qu'un changement dans Réglages s'applique immédiatement, sans redémarrer le serveur.
// mailto:admin@localhost n'est qu'un repli technique pour que la bibliothèque ne plante pas
// quand rien n'est configuré : les services de push (Apple en particulier) rejettent ce genre de
// sujet local avec une erreur BadJwtToken — voir le hint ajouté plus bas quand ce cas se présente.
function currentVapidDetails() {
  const url = currentPublicUrl();
  const usingLocalhostSubject = !url;
  return { subject: url || 'mailto:admin@localhost', publicKey, privateKey, usingLocalhostSubject };
}

// Point d'extension pour les tests automatisés : remplace l'envoi réel par une fonction de test,
// sans jamais toucher au reste de la logique (nettoyage des abonnements expirés compris).
let sendFn = (sub, payload, vapidDetails) => webpush.sendNotification(sub, payload, { vapidDetails });
function _setSendFn(fn) { sendFn = fn; }

// Envoi « silencieux » (jamais d'exception) pour les notifications déclenchées par l'activité normale
// (tâche assignée, dépense ajoutée...) : un souci d'envoi push ne doit jamais faire échouer l'action
// qui l'a déclenché. Renvoie un résumé (succès/échecs) que l'appelant peut choisir d'exploiter ou d'ignorer.
async function sendPush(userId, payload) {
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id=?').all(userId);
  const body = JSON.stringify(payload);
  const { usingLocalhostSubject, ...vapidDetails } = currentVapidDetails();
  const errors = [];
  for (const s of subs) {
    try {
      await sendFn({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, vapidDetails);
    } catch (err) {
      // Abonnement expiré ou révoqué côté navigateur : on l'oublie plutôt que de réessayer indéfiniment.
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(s.id);
      } else {
        // Journal détaillé et sans ambiguïté (champ par champ) : la cause précise d'un échec d'envoi
        // push est souvent dans le corps de la réponse du service de push (ex. Apple), pas seulement
        // dans le code HTTP.
        console.error('[push] échec', JSON.stringify({
          endpoint: s.endpoint, status: err && err.statusCode, message: err && err.message, body: err && err.body,
        }));
        const hint = (usingLocalhostSubject && err && /BadJwtToken/.test(err.body || ''))
          ? " — cause probable : l'adresse publique (PUBLIC_URL) n'est pas configurée (une adresse https réelle est requise pour Apple ; voir Réglages ou le README)." : '';
        errors.push({ status: err && err.statusCode, message: ((err && err.message) || 'Erreur inconnue') + hint, body: err && err.body, endpoint: s.endpoint });
      }
    }
  }
  return { total: subs.length, sent: subs.length - errors.length, errors };
}

module.exports = { publicKey, sendPush, _setSendFn };
