// Historique des modifications (journal d'audit) de Budget et de Garde : qui a modifié quoi, quand, et
// l'avant → après. Lecture seule ; le serveur ne renvoie que ce que la personne a le droit de voir
// (voir GET /audit). Chargement par pages, du plus récent au plus ancien.
import { h, icon, get, modal, state, userName, childById, membersOfCircle } from './core.js';

const option = (value, label) => h('option', { value }, label);

const VIA = { agenda: "via l'agenda", 'système': 'automatique', portail: 'via le portail' };
const ACTION = { create: 'Ajout', update: 'Modification', delete: 'Suppression' };

function when(at) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(at || '');
  return m ? `${m[3]}/${m[2]}/${m[1]} à ${m[4]}h${m[5]}` : (at || '');
}

function entryNode(e) {
  const who = e.user_id ? (e.user_name || userName(e.user_id)) : 'Système';
  const meta = `${who}${VIA[e.via] ? ` · ${VIA[e.via]}` : ''} · ${when(e.at)}`;
  const changes = e.changes || [];
  const body = changes.length
    ? h('ul', { class: 'audit-changes' }, ...changes.map((c) => h('li', null,
      h('span', { class: 'audit-label' }, c.label),
      c.from !== undefined && c.to !== undefined
        ? h('span', null, h('del', null, c.from), ' → ', h('ins', null, c.to))
        : h('span', null, h(c.from !== undefined ? 'del' : 'ins', null, c.from !== undefined ? c.from : c.to)))))
    : null;
  return h('li', { class: `audit-row ${e.action}` },
    h('div', { class: 'audit-head' },
      h('span', { class: `audit-badge ${e.action}` }, ACTION[e.action] || e.action),
      h('strong', null, e.summary)),
    h('small', { class: 'muted' }, meta),
    body);
}

// area : 'budget' (avec circleId) ou 'garde' (avec childId facultatif : tous les enfants visibles sinon).
export function auditDialog({ area, circleId = null, childId = null }) {
  const list = h('ul', { class: 'audit-list' });
  const status = h('p', { class: 'muted' }, 'Chargement…');
  const moreBtn = h('button', { class: 'btn', type: 'button', hidden: true }, 'Voir plus ancien');
  let lastId = null; let userId = ''; let kid = childId ? String(childId) : '';

  const query = () => {
    const q = new URLSearchParams({ area, limit: '40' });
    if (area === 'budget') q.set('circle_id', circleId);
    if (kid) q.set('child_id', kid);
    if (userId) q.set('user_id', userId);
    if (lastId) q.set('before', lastId);
    return q.toString();
  };
  async function load(reset) {
    if (reset) { lastId = null; list.replaceChildren(); status.hidden = false; status.textContent = 'Chargement…'; }
    try {
      const data = await get(`/audit?${query()}`);
      for (const e of data.entries) list.append(entryNode(e));
      if (data.entries.length) lastId = data.entries[data.entries.length - 1].id;
      moreBtn.hidden = !data.more;
      status.hidden = !!list.children.length;
      status.textContent = 'Aucune modification enregistrée pour le moment.';
    } catch (err) { status.hidden = false; status.textContent = err.message || 'Chargement impossible.'; }
  }
  moreBtn.onclick = () => load(false);

  const ids = area === 'budget' && circleId ? membersOfCircle(circleId) : state.users.map((u) => u.id);
  const people = state.users.filter((u) => ids.includes(u.id));
  const who = h('select', { 'aria-label': 'Auteur', onchange: (ev) => { userId = ev.target.value; load(true); } },
    option('', 'Toutes les personnes'), ...people.map((u) => option(String(u.id), u.name)));
  const kids = area === 'garde' && !childId && state.children.length > 1
    ? h('select', { 'aria-label': 'Enfant', onchange: (ev) => { kid = ev.target.value; load(true); } },
      option('', 'Tous les enfants'), ...state.children.map((c) => option(String(c.id), c.name)))
    : null;
  const title = area === 'budget' ? 'Historique du budget' : `Historique de la garde${childId && childById(childId) ? ` — ${childById(childId).name}` : ''}`;
  modal(title, h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'Qui a modifié quoi, et comment. Ce journal est en ajout seul : il ne peut ni être modifié ni effacé.'),
    h('div', { class: 'row gap wrap' }, who, kids),
    status, list, h('div', { class: 'row center' }, moreBtn)), { wide: true });
  load(true);
}

export const historyButton = (opts) => h('button', { class: 'btn', type: 'button', onclick: () => auditDialog(opts) }, icon('history', 16), 'Historique');
