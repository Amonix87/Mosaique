import { h, icon, state, get, put, del, act, toast, confirmBox, onRefresh, pageHead, emptyState, fmtDayY, ago, childById, mount, append } from './core.js';

export async function ecole(root) {
  let homework = []; let notes = []; let reservations = [];
  const hwBox = h('div', { class: 'stack big' });
  const notesBox = h('div', { class: 'stack' });
  const resaBox = h('div', { class: 'stack' });
  append(root, pageHead('École'), hwBox, h('h2', null, "Mots de l'école"), notesBox,
    h('h2', null, 'Réservations périscolaires'), resaBox,
    h('p', { class: 'muted' }, 'Les factures périscolaires se retrouvent et se règlent dans ', h('a', { href: '#/budget' }, 'Budget'), ', une fois attribuées à quelqu\'un.'));

  async function load() {
    [homework, notes, reservations] = await Promise.all([get('/homework'), get('/notes'), get('/reservations')]);
    draw();
  }
  onRefresh(['homework', 'notes', 'reservations'], load);

  function draw() {
    if (!state.children.length) { mount(hwBox, emptyState("Ajoutez d'abord des enfants dans « Famille ».")); mount(notesBox); mount(resaBox); return; }
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

    const byChildResa = {};
    for (const r of reservations) (byChildResa[r.child_id] ||= []).push(r);
    const resaGroups = state.children.filter((c) => byChildResa[c.id] && byChildResa[c.id].length);
    mount(resaBox, resaGroups.length ? resaGroups.map((c) => h('div', { class: 'card' },
      h('div', { class: 'row gap center' }, h('span', { class: 'dot big', style: { background: c.color } }), h('h3', null, c.name)),
      h('ul', { class: 'task-list' }, byChildResa[c.id].sort((a, b) => a.date.localeCompare(b.date)).map((r) => h('li', { class: 'task-row' },
        h('div', { class: 'task-main' },
          h('span', { class: 'task-title' }, r.title, r.start_time ? ` (${r.start_time}${r.end_time ? '–' + r.end_time : ''})` : ''),
          h('span', { class: 'muted' }, fmtDayY(r.date), r.status ? ` — ${r.status}` : '')),
        h('button', { class: 'icon-btn', 'aria-label': 'Supprimer', onclick: async () => { if (await confirmBox(`Supprimer « ${r.title} » ?`)) act(async () => { await del(`/reservations/${r.id}`); load(); }); } }, icon('trash', 16)))))))
      : emptyState("Aucune réservation pour l'instant. Elles apparaîtront ici une fois l'intégration e-portail connectée (voir Réglages)."));
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
