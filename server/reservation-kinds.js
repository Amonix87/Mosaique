'use strict';
/* Classement des réservations périscolaires (cantine, garderie, mercredi, ALSH…) d'après leur titre
   tel que le portail l'envoie (« REPAS », « GARDERIE MATIN », « MERCREDI MATIN », « MERCREDI APRES MIDI »,
   « JOURNEE ALSH - 8h »…). Fonctions pures, sans base de données : utilisées par le rappel du jeudi soir
   (server/index.js) et testées seules (test/smoke.js). Le client (public/js/ecole.js) en a une copie. */

function reservationKind(r) {
  const t = (r.title || '').toLowerCase();
  // « MERCREDI APRES MIDI » contient « midi » : à tester AVANT la cantine, sinon l'après-midi du mercredi
  // passe pour un repas (et le matin du mercredi n'était reconnu par rien).
  if (/mercredi/.test(t)) {
    if (/matin/.test(t)) return 'mercredi_matin';
    if (/apr[eè]s|midi/.test(t)) return 'mercredi_apres_midi';
    return 'autre';
  }
  if (/cantine|repas|dejeuner|déjeuner|midi/.test(t)) return 'cantine';
  if (/alsh|loisirs|journee|journée/.test(t)) return 'alsh';
  if (/garderie|accueil|periscolaire|périscolaire/.test(t)) return (r.start_time && r.start_time < '12:00') ? 'garderie_matin' : 'garderie_soir';
  return 'autre';
}

const PART_ORDER = [
  ['garderie_matin', 'garderie matin'], ['mercredi_matin', 'mercredi matin'], ['cantine', 'cantine'],
  ['mercredi_apres_midi', 'mercredi après-midi'], ['garderie_soir', 'garderie soir'], ['alsh', 'ALSH'],
];

// Étiquette d'une journée d'après l'ensemble de ses types de réservation. Les étiquettes historiques
// (none, cantine, garderie, garderie_matin, garderie_soir, journee) sont conservées ; toute autre
// combinaison donne « custom:<texte> » (ex. « custom:cantine + mercredi après-midi »).
function dayLabel(kinds) {
  const k = kinds instanceof Set ? kinds : new Set(kinds);
  const wednesday = k.has('mercredi_matin') && k.has('mercredi_apres_midi');
  if (k.has('cantine') && (k.has('alsh') || (k.has('garderie_matin') && k.has('garderie_soir')) || wednesday)) return 'journee';
  const wed = k.has('mercredi_matin') || k.has('mercredi_apres_midi');
  if (!wed && !k.has('alsh')) {
    if (k.has('cantine')) return 'cantine';
    if (k.has('garderie_matin') && k.has('garderie_soir')) return 'garderie';
    if (k.has('garderie_matin')) return 'garderie_matin';
    if (k.has('garderie_soir')) return 'garderie_soir';
    return 'none';
  }
  const parts = PART_ORDER.filter(([key]) => k.has(key)).map(([, text]) => text);
  return `custom:${parts.join(' + ')}`;
}
const labelText = (label) => (label.startsWith('custom:') ? label.slice(7) : label);

module.exports = { reservationKind, dayLabel, labelText };
