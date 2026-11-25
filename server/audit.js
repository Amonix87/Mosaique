'use strict';
/* Journal d'audit de Budget et de Garde : « qui a modifié quoi, comment ».
 *
 * Chaque écriture appelle audit.created / audit.updated / audit.deleted avec la ligne AVANT et/ou APRÈS ;
 * le module en tire un résumé en français et la liste des champs modifiés (ancienne → nouvelle valeur),
 * déjà mise en forme (noms, euros, dates) AU MOMENT de l'écriture : le journal reste lisible même si la
 * dépense, l'enfant ou le compte concerné est supprimé ou renommé ensuite. La table est en ajout seul
 * (voir server/db.js). Un journal ne doit jamais faire échouer l'action qu'il décrit : toute erreur
 * d'écriture est avalée et signalée sur la console.
 */
const { db } = require('./db');

const pad = (n) => String(n).padStart(2, '0');
const nowLocal = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };

const parseJ = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const EUR = (c) => `${(Number(c) / 100).toFixed(2).replace('.', ',')} €`;
const DATE = (d) => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : (d || ''));
const uname = (id) => {
  if (id === null || id === undefined || id === '') return null;
  const u = db.prepare('SELECT name FROM users WHERE id=?').get(Number(id));
  return u ? u.name : `compte supprimé (#${id})`;
};
const cname = (id) => {
  if (id === null || id === undefined || id === '') return null;
  const c = db.prepare('SELECT name FROM children WHERE id=?').get(Number(id));
  return c ? c.name : `enfant supprimé (#${id})`;
};
const names = (ids) => ids.map(uname).join(', ');
const SPLIT = (v) => {
  const o = typeof v === 'string' ? parseJ(v, {}) : (v || {});
  const parts = Object.entries(o).filter(([, p]) => p > 0).map(([id, p]) => `${uname(id)} ${String(Math.round(p * 100) / 100).replace('.', ',')} %`);
  return parts.join(', ');
};
const REPEAT = { weekly: 'chaque semaine', monthly: 'chaque mois', quarterly: 'chaque trimestre', yearly: 'chaque année' };
const YESNO = (v) => (v ? 'oui' : 'non');
const FILE = (v) => (v ? 'PDF joint' : null);

// Pour chaque type d'élément : domaine, libellé, résumé court d'une ligne, et champs suivis
// (colonne → [libellé, mise en forme]). Une valeur vide s'affiche « — » (voir show()).
const ENTITIES = {
  expense: {
    area: 'budget', noun: 'Dépense', fem: true, child: (r) => r.child_id,
    title: (r) => `« ${r.title} » (${EUR(r.amount_cents)})`,
    fields: {
      title: ['Intitulé'], amount_cents: ['Montant', EUR], category: ['Catégorie'], date: ['Date', DATE],
      paid_by: ['Payé par', uname], split: ['Répartition', SPLIT], child_id: ['Enfant', cname], document_id: ['Facture', FILE],
    },
  },
  recurring: {
    area: 'budget', noun: 'Dépense récurrente', fem: true, child: (r) => r.child_id,
    title: (r) => `« ${r.title} » (${EUR(r.amount_cents)}, ${REPEAT[r.repeat] || r.repeat})`,
    fields: {
      title: ['Intitulé'], amount_cents: ['Montant', EUR], category: ['Catégorie'], paid_by: ['Payé par', uname],
      split: ['Répartition', SPLIT], child_id: ['Enfant', cname], repeat: ['Fréquence', (v) => REPEAT[v] || v],
      start_date: ['Début', DATE], repeat_until: ['Jusqu\'au', DATE],
    },
  },
  settlement: {
    area: 'budget', noun: 'Remboursement', child: () => null,
    title: (r) => `${uname(r.from_user)} → ${uname(r.to_user)} (${EUR(r.amount_cents)})`,
    fields: { from_user: ['De', uname], to_user: ['À', uname], amount_cents: ['Montant', EUR], date: ['Date', DATE], note: ['Note'] },
  },
  invoice: {
    area: 'budget', noun: 'Facture', fem: true, child: (r) => r.child_id,
    title: (r) => `« ${r.label} — ${r.number} » (${EUR(r.amount_cents)})`,
    fields: {
      assigned_to: ['Attribuée à', uname], child_id: ['Enfant', cname], circle_id: ['Cercle', (v) => {
        const c = db.prepare('SELECT name FROM circles WHERE id=?').get(Number(v));
        return c ? c.name : null;
      }],
      amount_cents: ['Montant', EUR], status: ['Statut'],
    },
  },
  child: {
    area: 'garde', noun: 'Réglages de garde', plural: true, child: (r) => r.id,
    title: (r) => cname(r.id) || r.name,
    fields: {
      handover_location: ['Lieu de transition habituel'], handover_time: ['Heure de transition habituelle'],
      parent_ids: ['Parents', (v) => names(parseJ(v, []))], shared_custody: ['Garde partagée', YESNO],
    },
  },
  handover: {
    area: 'garde', noun: 'Transition ponctuelle', fem: true, child: (r) => r.child_id,
    title: (r) => `${DATE(r.date)} (${cname(r.child_id)})`,
    fields: { location: ['Lieu'], time: ['Heure'] },
  },
};

// Accord du participe passé avec le nom de l'élément (« Dépense ajoutée », « Réglages modifiés »).
const agree = (cfg, word) => word + (cfg.fem ? 'e' : '') + (cfg.plural ? 's' : '');

const show = (v, fmt) => {
  if (v === null || v === undefined || v === '') return '—';
  const out = fmt ? fmt(v) : String(v);
  return out === null || out === undefined || out === '' ? '—' : out;
};
// Comparaison tolérante : un partage JSON est comparé en objet trié, pour qu'un simple réordonnancement
// des clés ne passe pas pour une modification.
const norm = (v) => {
  if (v === undefined || v === '') return null;
  if (typeof v === 'string' && /^[[{]/.test(v)) {
    const o = parseJ(v, v);
    if (o && typeof o === 'object' && !Array.isArray(o)) return JSON.stringify(Object.fromEntries(Object.entries(o).sort()));
    return JSON.stringify(o);
  }
  return v;
};

function diff(entity, before, after) {
  const cfg = ENTITIES[entity];
  const out = [];
  for (const [col, [label, fmt]] of Object.entries(cfg.fields)) {
    const b = before ? before[col] : undefined; const a = after ? after[col] : undefined;
    if (before && after && norm(b) === norm(a)) continue;
    if (!before && (a === null || a === undefined || a === '')) continue;
    if (!after && (b === null || b === undefined || b === '')) continue;
    const c = { label };
    if (before) c.from = show(b, fmt);
    if (after) c.to = show(a, fmt);
    out.push(c);
  }
  return out;
}

function actorOf(a) {
  if (a === null || a === undefined) return { id: null, name: null };
  const id = typeof a === 'object' ? a.id : Number(a);
  return { id: id ?? null, name: id ? (uname(id) || (typeof a === 'object' ? a.name : null)) : null };
}

function insert(actor, via, row) {
  try {
    const who = actorOf(actor);
    db.prepare(`INSERT INTO audit_log(at,user_id,user_name,via,area,action,entity,entity_id,circle_id,child_id,summary,changes)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(nowLocal(), who.id, who.name, via || 'app', row.area, row.action, row.entity, row.entity_id ?? null,
        row.circle_id ?? null, row.child_id ?? null, row.summary, row.changes && row.changes.length ? JSON.stringify(row.changes) : null);
  } catch (e) { console.error('[audit] écriture impossible :', e.message); }
}

function entityRow(entity, r, extra) {
  const cfg = ENTITIES[entity];
  return {
    area: cfg.area, entity, entity_id: r.id, child_id: cfg.child(r) ?? null,
    circle_id: entity === 'child' || entity === 'handover' ? null : (r.circle_id ?? null), ...extra,
  };
}

// extra : { via, circle_id, note } — `note` s'ajoute au résumé (ex. « depuis l'agenda »).
function created(actor, entity, row, extra = {}) {
  const cfg = ENTITIES[entity];
  insert(actor, extra.via, {
    ...entityRow(entity, row, extra), action: 'create',
    summary: `${cfg.noun} ${agree(cfg, 'ajouté')} : ${cfg.title(row)}${extra.note ? ` — ${extra.note}` : ''}`,
    changes: diff(entity, null, row),
  });
}
function updated(actor, entity, before, after, extra = {}) {
  const cfg = ENTITIES[entity];
  const changes = diff(entity, before, after);
  if (!changes.length) return false;
  insert(actor, extra.via, {
    ...entityRow(entity, after, extra), action: 'update',
    summary: `${cfg.noun} ${agree(cfg, 'modifié')} : ${cfg.title(after)} — ${changes.map((c) => c.label.toLowerCase()).join(', ')}${extra.note ? ` (${extra.note})` : ''}`,
    changes,
  });
  return true;
}
function deleted(actor, entity, row, extra = {}) {
  const cfg = ENTITIES[entity];
  insert(actor, extra.via, {
    ...entityRow(entity, row, extra), action: 'delete',
    summary: `${cfg.noun} ${agree(cfg, 'supprimé')} : ${cfg.title(row)}${extra.note ? ` — ${extra.note}` : ''}`,
    changes: diff(entity, row, null),
  });
}
// Événement qui ne correspond pas à un champ (ex. « PDF joint à la dépense »).
function note(actor, entity, row, action, summary, changes, extra = {}) {
  insert(actor, extra.via, { ...entityRow(entity, row, extra), action, summary, changes });
}

/* ── Nuits de garde ───────────────────────────────────────────────────────────────────────────────
   setNights() note chaque nuit réellement modifiée dans un collecteur ({date, child_id, from, to}) ; une
   fois la saisie terminée, nights() écrit UNE ligne de journal par enfant, qui regroupe les nuits par
   changement (« Marie → Jean-Paul : 14 nuits, du … au … ») au lieu d'une ligne par nuit. */
function ranges(dates) {
  const sorted = [...dates].sort(); const out = [];
  let start = null; let prev = null;
  const next = (d) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };
  for (const d of sorted) {
    if (start && next(prev) === d) { prev = d; continue; }
    if (start) out.push(start === prev ? DATE(start) : `${DATE(start)} → ${DATE(prev)}`);
    start = d; prev = d;
  }
  if (start) out.push(start === prev ? DATE(start) : `${DATE(start)} → ${DATE(prev)}`);
  const text = out.join(', ');
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}
// Nuits réellement modifiées, regroupées par enfant puis par changement (« Marie → Jean-Paul : 14 nuits… ») :
// sert au journal ci-dessous et à la notification envoyée à l'autre parent (un seul message par saisie).
function groupNights(collected) {
  const byChild = new Map();
  for (const n of collected || []) {
    if (n.from === n.to) continue;
    if (!byChild.has(n.child_id)) byChild.set(n.child_id, []);
    byChild.get(n.child_id).push(n);
  }
  const out = [];
  for (const [childId, list] of byChild) {
    const groups = new Map();
    for (const n of list) {
      const k = `${n.from ?? ''}>${n.to ?? ''}`;
      if (!groups.has(k)) groups.set(k, { from: n.from, to: n.to, dates: [] });
      groups.get(k).dates.push(n.date);
    }
    const changes = [...groups.values()].map((g) => ({
      label: `${g.dates.length} nuit${g.dates.length > 1 ? 's' : ''} : ${ranges(g.dates)}`,
      from: show(g.from, uname), to: show(g.to, uname),
    }));
    const all = list.map((n) => n.date).sort();
    out.push({
      child_id: childId, child_name: cname(childId), count: list.length, changes,
      period: `${DATE(all[0])}${all[0] !== all[all.length - 1] ? ` → ${DATE(all[all.length - 1])}` : ''}`,
      parents: [...new Set(list.flatMap((n) => [n.from, n.to]).filter((x) => x))],
    });
  }
  return out;
}
function nights(actor, collected, how, extra = {}) {
  for (const g of groupNights(collected)) {
    insert(actor, extra.via, {
      area: 'garde', action: 'update', entity: 'custody', entity_id: g.child_id, child_id: g.child_id, circle_id: null,
      summary: `Garde de ${g.child_name} : ${g.count} nuit${g.count > 1 ? 's' : ''} modifiée${g.count > 1 ? 's' : ''} (${g.period}) — ${how}`,
      changes: g.changes,
    });
  }
}

module.exports = { created, updated, deleted, note, nights, groupNights, diff, ENTITIES, _ranges: ranges };
