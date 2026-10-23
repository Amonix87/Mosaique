'use strict';
// Gestionnaire d'addons : découvre les connecteurs disponibles dans server/addons/, garde leur
// configuration (activé ou non, identifiants) dans les réglages, et fournit un statut prêt à
// afficher côté client (jamais les mots de passe en clair, seulement "configuré ou pas").
//
// Pour ajouter la prise en charge d'un autre site de réservation périscolaire, il suffit de
// déposer un nouveau fichier dans server/addons/ qui exporte { id, label, fields, async sync(config) }
// — voir server/addons/eportail.js comme modèle. Aucune autre modification n'est nécessaire :
// ce fichier le découvre automatiquement au démarrage, et il apparaît dans Réglages → Administration.
const fs = require('fs');
const path = require('path');
const { getSetting, setSetting } = require('./settings');

const DIR = path.join(__dirname, 'addons');

function loadRegistry() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.js')).map((f) => {
    try {
      const mod = require(path.join(DIR, f));
      if (!mod || !mod.id || !mod.label || !Array.isArray(mod.fields) || typeof mod.sync !== 'function') {
        console.error(`Addon ${f} ignoré : format invalide (id, label, fields[] et sync() sont requis).`);
        return null;
      }
      return mod;
    } catch (e) { console.error(`Addon ${f} ignoré :`, e.message); return null; }
  }).filter(Boolean);
}
const REGISTRY = loadRegistry(); // chargés une fois au démarrage, comme le reste du serveur

function find(id) { return REGISTRY.find((a) => a.id === id); }

function configOf(id) {
  const raw = getSetting(`addon_${id}_config`);
  return raw ? JSON.parse(raw) : {};
}
function isEnabled(id) { return getSetting(`addon_${id}_enabled`) === 'true'; }

// Un champ "password" ne revient jamais en clair côté client : juste un booléen "déjà renseigné",
// exactement comme has_password pour le SMTP (server/mailer.js).
function publicConfig(addon, cfg) {
  const out = {};
  for (const f of addon.fields) out[f.key] = f.type === 'password' ? !!cfg[f.key] : (cfg[f.key] || '');
  return out;
}

function status(id) {
  const addon = find(id);
  if (!addon) return null;
  const supportsHistory = typeof addon.syncHistory === 'function';
  return {
    id: addon.id, label: addon.label, fields: addon.fields,
    enabled: isEnabled(id),
    config: publicConfig(addon, configOf(id)),
    last_sync_at: getSetting(`addon_${id}_last_sync_at`),
    last_error: getSetting(`addon_${id}_last_error`),
    supportsHistory,
    history: supportsHistory ? historyState(id) : null,
  };
}
function list() { return REGISTRY.map((a) => status(a.id)); }

function saveConfig(id, { enabled, config } = {}) {
  const addon = find(id);
  if (!addon) throw Object.assign(new Error('Addon inconnu.'), { status: 404 });
  if (config) {
    const cfg = configOf(id);
    for (const f of addon.fields) {
      const v = config[f.key];
      if (v === undefined) continue;
      if (f.type === 'password' && v === '') continue; // champ laissé vide = identifiant inchangé (comme SMTP)
      cfg[f.key] = String(v).trim();
    }
    setSetting(`addon_${id}_config`, JSON.stringify(cfg));
  }
  if (enabled !== undefined) setSetting(`addon_${id}_enabled`, enabled ? 'true' : 'false');
  return status(id);
}

function recordSyncOk(id) { setSetting(`addon_${id}_last_sync_at`, new Date().toISOString()); setSetting(`addon_${id}_last_error`, null); }
function recordSyncError(id, message) { setSetting(`addon_${id}_last_error`, String(message || 'Erreur inconnue').slice(0, 500)); }

// Import complet de l'historique des réservations (addon.syncHistory, facultatif — voir eportail.js) :
// un parcours long (une requête par demande acceptée), donc toujours en tâche de fond, jamais dans la
// requête HTTP qui l'a déclenché (voir runAddonHistory dans server/index.js). coveredRef permet de
// reprendre là où le dernier parcours complet s'est arrêté plutôt que tout refaire à chaque fois.
function historyState(id) {
  const raw = getSetting(`addon_${id}_history`);
  return raw ? JSON.parse(raw) : { running: false, processed: 0, total: null, coveredRef: 0, error: null, started_at: null, finished_at: null };
}
function saveHistoryState(id, patch) {
  const state = { ...historyState(id), ...patch };
  setSetting(`addon_${id}_history`, JSON.stringify(state));
  return state;
}

module.exports = { list, find, status, configOf, isEnabled, saveConfig, recordSyncOk, recordSyncError, historyState, saveHistoryState };
