import { h, icon, state, get, put, del, act, toast, confirmBox, onRefresh, pageHead, emptyState, fmtDayY, fmtDay, fmtMonth, ago, childById, mount, append, ymd, isoWeek, today, modal } from './core.js';

// Classement d'une réservation en 4 grandes familles, pour l'affichage (petit point coloré dans le
// calendrier). Purement indicatif : basé sur des mots-clés dans le titre, comme envoyé par l'addon
// (ex. « GARDERIE SOIR », « REPAS »...), avec l'horaire en repli pour distinguer matin/soir.
function reservationKind(r) {
  const t = (r.title || '').toLowerCase();
  if (/cantine|repas|d[ée]jeuner|midi/.test(t)) return 'cantine';
  if (/alsh|loisirs|journee|journée/.test(t)) return 'alsh';
  if (/garderie|accueil|p[ée]riscolaire/.test(t)) return (r.start_time && r.start_time < '12:00') ? 'garderie_matin' : 'garderie_soir';
  return 'autre';
}
const KIND_LABEL = { cantine: 'Cantine', garderie_matin: 'Garderie (matin)', garderie_soir: 'Garderie (soir)', alsh: 'ALSH / journée', autre: 'Autre' };

let resaCursor = null; // { y, m } — mois affiché dans le calendrier des réservations, partagé par tous les enfants

export async function ecole(root) {
  let homework = []; let notes = []; let reservations = []; let holidaysByZone = {};
  const hwBox = h('div', { class: 'stack big' });
  const notesBox = h('div', { class: 'stack' });
  const resaBox = h('div', { class: 'stack' });
  append(root, pageHead('École'), hwBox, h('h2', null, "Mots de l'école"), notesBox,
    h('h2', null, 'Réservations périscolaires'), resaBox,
    h('p', { class: 'muted' }, 'Les factures périscolaires se retrouvent et se règlent dans ', h('a', { href: '#/budget' }, 'Budget'), ', une fois attribuées à quelqu\'un.'));

  async function load() {
    [homework, notes, reservations] = await Promise.all([get('/homework'), get('/notes'), get('/reservations')]);
    const zones = [...new Set(state.children.filter((c) => reservations.some((r) => r.child_id === c.id)).map((c) => c.zone))];
    holidaysByZone = Object.fromEntries(await Promise.all(zones.map(async (z) => [z, (await get(`/holidays?zone=${z}`)).periods])));
    draw();
  }
  onRefresh(['homework', 'notes', 'reservations'], load);

  function draw() {
    if (!state.children.length) { mount(hwBox, emptyState("Ajoutez d'abord des enfants dans « Famille ».")); mount(notesBox); mount(resaBox); return; }
    drawResaCalendar();
    const byChild = {};
    for (const h of homework) (byChild[h.child_id] ||= []).push(h);
    const groups = state.children.filter((c) => byChild[c.id] && byChild[c.id].length);
    mount(hwBox, h('h2', null, 'Devoirs'),
      groups.length ? groups.map((c) => {
        const items = byChild[c.id].sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999'));
        const todo = items.filter((i) => !i.done); const done = items.filter((i) => i.done);
        return h('div', { class: 'card' },
          h('div', { class: 'row gap center' }, h('span', { class: 'dot big', style: { background: c.color } }), h('h3', null, c.name)),
          todo.length ? h('ul', { class: 'task-list' }, todo.map(row)) : h('p', { class: 'muted' }, 'Rien en attente.'),
          done.length ? h('details', { class: 'done-block' }, h('summary', null, `${done.length} terminé(s)`), h('ul', { class: 'task-list' }, done.map(row))) : null);
      }) : emptyState("Aucun devoir pour l'instant. Ils apparaîtront ici une fois l'intégration École connectée (voir Réglages)."));

    mount(notesBox, notes.length ? h('ul', { class: 'task-list' }, notes.map((n) => {
      const c = childById(n.child_id);
      return h('li', { class: 'task-row' },
        h('input', { type: 'checkbox', checked: !!n.read, 'aria-label': `Marquer « ${n.title} » comme ${n.read ? 'non lu' : 'lu'}`,
          onchange: () => act(async () => { await put(`/notes/${n.id}`, { read: !n.read }); load(); }) }),
        h('div', { class: 'task-main' },
          h('span', { class: 'task-title' + (n.read ? ' strike' : '') }, c ? `[${c.name}] ` : '', n.title),
          n.body ? h('span', { class: 'muted' }, n.body) : null,
          h('span', { class: 'muted' }, n.date ? fmtDayY(n.date) : ago(n.created_at))),
        h('button', { class: 'icon-btn', 'aria-label': 'Supprimer', onclick: async () => { if (await confirmBox(`Supprimer « ${n.title} » ?`)) act(async () => { await del(`/notes/${n.id}`); load(); }); } }, icon('trash', 16)));
    })) : emptyState("Aucun mot de l'école pour l'instant."));

  }

  // Calendrier mensuel des réservations périscolaires, un par enfant suivi (même principe que Garde) :
  // la seule chose consultée ici est ce qu'un addon (ou l'import manuel) a déjà renvoyé — rien ne
  // s'y saisit à la main. Toucher un jour garni ouvre le détail (horaires, statut, suppression).
  function drawResaCalendar() {
    const kids = state.children.filter((c) => reservations.some((r) => r.child_id === c.id));
    if (!kids.length) { mount(resaBox, emptyState("Aucune réservation pour l'instant. Elles apparaîtront ici une fois l'intégration e-portail connectée (voir Réglages).")); return; }
    if (!resaCursor) { const n = new Date(); resaCursor = { y: n.getFullYear(), m: n.getMonth() }; }

    const byKey = {};
    for (const r of reservations) (byKey[`${r.date}|${r.child_id}`] ||= []).push(r);
    const first = new Date(resaCursor.y, resaCursor.m, 1);
    const lead = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(resaCursor.y, resaCursor.m + 1, 0).getDate();

    const nav = h('div', { class: 'cal-nav' },
      h('button', { class: 'icon-btn', 'aria-label': 'Mois précédent', onclick: () => { resaCursor.m--; if (resaCursor.m < 0) { resaCursor.m = 11; resaCursor.y--; } drawResaCalendar(); } }, icon('left')),
      h('h3', { class: 'cal-title' }, fmtMonth(resaCursor.y, resaCursor.m)),
      h('button', { class: 'icon-btn', 'aria-label': 'Mois suivant', onclick: () => { resaCursor.m++; if (resaCursor.m > 11) { resaCursor.m = 0; resaCursor.y++; } drawResaCalendar(); } }, icon('right')));

    const grids = kids.map((c) => {
      const tiles = [];
      let col = 0;
      for (let i = 0; i < lead; i++) {
        if (col === 0) tiles.push(h('span', { class: 'tile-week', 'aria-hidden': 'true' }, isoWeek(ymd(new Date(resaCursor.y, resaCursor.m, 1)))));
        tiles.push(h('span', { class: 'tile ghost' }));
        col = (col + 1) % 7;
      }
      for (let d = 1; d <= daysInMonth; d++) {
        if (col === 0) tiles.push(h('span', { class: 'tile-week', 'aria-hidden': 'true' }, isoWeek(ymd(new Date(resaCursor.y, resaCursor.m, d)))));
        const date = ymd(new Date(resaCursor.y, resaCursor.m, d));
        const items = (byKey[`${date}|${c.id}`] || []).slice().sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
        const kinds = [...new Set(items.map(reservationKind))];
        const holiday = (holidaysByZone[c.zone] || []).some((x) => date >= x.start && date < x.end);
        tiles.push(h('button', {
          type: 'button', class: ['tile', items.length ? 'filled' : 'empty', date === today() ? 'today' : '', holiday ? 'hol' : ''].join(' '),
          'aria-label': `${fmtDay(date)}${items.length ? ' : ' + items.map((i) => i.title).join(', ') : ''}`,
          onclick: items.length ? () => resaDayDetails(c, date, items) : undefined,
        },
          h('span', { class: 'cal-daynum' }, d),
          items.length ? h('span', { class: 'cal-dots' }, kinds.map((k) => h('span', { class: `cal-dot ${k}` }))) : null));
        col = (col + 1) % 7;
      }
      return h('div', { class: 'child-month' },
        h('div', { class: 'child-head' }, h('span', { class: 'dot big', style: { background: c.color } }), h('h3', null, c.name)),
        h('div', { class: 'tile-grid' }, h('span', { class: 'tile-week tile-week-head' }, 'Sem.'), ['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((x) => h('span', { class: 'tile-dow' }, x)), tiles));
    });

    const usedKinds = [...new Set(kids.flatMap((c) => reservations.filter((r) => r.child_id === c.id).map(reservationKind)))];
    mount(resaBox, nav, grids,
      usedKinds.length ? h('div', { class: 'legend' }, usedKinds.map((k) => h('span', { class: 'legend-item' }, h('span', { class: `swatch cal-dot ${k}`, style: { width: '10px', height: '10px' } }), KIND_LABEL[k]))) : null);
  }

  function resaDayDetails(child, date, items) {
    const box = h('div', { class: 'stack' },
      h('ul', { class: 'task-list' }, items.map((r) => h('li', { class: 'task-row' },
        h('div', { class: 'task-main' },
          h('span', { class: 'task-title' }, r.title, r.start_time ? ` (${r.start_time}${r.end_time ? '–' + r.end_time : ''})` : '')),
        h('button', { class: 'icon-btn', 'aria-label': 'Supprimer', onclick: async () => {
          if (await confirmBox(`Supprimer « ${r.title} » ?`)) act(async () => { await del(`/reservations/${r.id}`); close(); load(); });
        } }, icon('trash', 16))))));
    const close = modal(`${child.name} — ${fmtDayY(date)}`, box);
  }

  function row(i) {
    return h('li', { class: 'task-row' },
      h('input', { type: 'checkbox', checked: !!i.done, 'aria-label': `Marquer « ${i.title} » comme ${i.done ? 'à faire' : 'fait'}`,
        onchange: () => act(async () => { await put(`/homework/${i.id}`, { done: !i.done }); load(); }) }),
      h('div', { class: 'task-main' },
        h('span', { class: 'task-title' + (i.done ? ' strike' : '') }, i.subject ? `${i.subject} — ` : '', i.title),
        i.description ? h('span', { class: 'muted' }, i.description) : null,
        i.due_date ? h('span', { class: 'muted' }, 'Pour le ', fmtDayY(i.due_date)) : null),
      h('button', { class: 'icon-btn', 'aria-label': 'Supprimer', onclick: async () => { if (await confirmBox(`Supprimer « ${i.title} » ?`)) act(async () => { await del(`/homework/${i.id}`); load(); }); } }, icon('trash', 16)));
  }

  await load();
}
