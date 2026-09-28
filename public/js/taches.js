import { h, icon, state, get, post, put, del, act, toast, formModal, confirmBox, opt, onRefresh, pageHead, circleChips, inFilter, emptyState, today, fmtDayY, avatar, userById, activeCircleId, circleSelectOptions, myCircles, mount, append, GROCERY_CATEGORIES } from './core.js';

function taskForm(t, done) {
  const isNew = !t;
  formModal(isNew ? 'Nouvelle tâche' : 'Modifier la tâche', [
    { name: 'title', label: 'Titre', value: t ? t.title : '', required: true, maxlength: 200 },
    ...(myCircles().length > 1 ? [{ name: 'circle_id', label: 'Cercle', type: 'select', value: t ? t.circle_id : activeCircleId(), options: circleSelectOptions() }] : []),
    { name: 'assignee_id', label: 'Assignée à', type: 'select', value: t ? (t.assignee_id ?? '') : '', options: [opt('', 'Personne en particulier'), ...state.users.map((u) => opt(u.id, u.name))] },
    { name: 'due', label: 'Échéance (facultatif)', type: 'datetime-local', value: t && t.due ? t.due : '' },
    { name: 'remind_at', label: 'Me le rappeler le (facultatif)', type: 'datetime-local', value: t && t.remind_at ? t.remind_at : '' },
  ], {
    onSubmit: async (v, close) => {
      const body = { title: v.title, assignee_id: v.assignee_id ? Number(v.assignee_id) : null, due: v.due || null, remind_at: v.remind_at || null };
      if (isNew) { body.circle_id = Number(v.circle_id || activeCircleId()); await post('/tasks', body); } else await put(`/tasks/${t.id}`, body);
      close(); toast(isNew ? 'Tâche ajoutée' : 'Tâche modifiée'); done();
    },
  });
}

export async function taches(root) {
  let tasks = [];
  const chips = circleChips(() => draw());
  const list = h('div', { class: 'stack' });
  append(root, pageHead('Tâches', h('button', { class: 'btn primary', onclick: () => taskForm(null, load) }, icon('plus', 16), 'Tâche')), chips, list);

  async function load() { tasks = await get('/tasks'); draw(); }
  onRefresh(['tasks'], load);

  function draw() {
    const visible = tasks.filter(inFilter);
    const todo = visible.filter((t) => !t.done);
    const done = visible.filter((t) => t.done);
    mount(list, 
      todo.length ? h('ul', { class: 'task-list' }, todo.map(row)) : emptyState('Aucune tâche en cours.'),
      done.length ? h('details', { class: 'done-block' }, h('summary', null, `${done.length} terminée(s)`), h('ul', { class: 'task-list' }, done.map(row))) : null);
  }

  function row(t) {
    const overdue = t.due && !t.done && t.due < today();
    const assignee = t.assignee_id ? userById(t.assignee_id) : null;
    return h('li', { class: 'task-row' + (overdue ? ' overdue' : '') },
      h('input', { type: 'checkbox', checked: !!t.done, 'aria-label': `Marquer « ${t.title} » comme ${t.done ? 'à faire' : 'faite'}`,
        onchange: () => act(async () => { await put(`/tasks/${t.id}`, { done: !t.done }); load(); }) }),
      h('div', { class: 'task-main', onclick: () => taskForm(t, load) },
        h('span', { class: 'task-title' + (t.done ? ' strike' : '') }, t.title),
        t.due ? h('span', { class: 'muted' }, fmtDayY(t.due)) : null),
      assignee ? avatar(assignee, 24) : null,
      h('button', { class: 'icon-btn', 'aria-label': 'Supprimer', onclick: async () => { if (await confirmBox(`Supprimer « ${t.title} » ?`)) act(async () => { await del(`/tasks/${t.id}`); load(); }); } }, icon('trash', 16)));
  }

  await load();
}

export async function courses(root) {
  let items = [];
  let listName = 'Courses';
  const chips = circleChips(() => draw());
  const box = h('div', { class: 'stack' });
  const addRow = h('form', { class: 'quick-add', onsubmit: (e) => { e.preventDefault(); const inp = e.target.elements.label; const v = inp.value.trim(); if (!v) return; act(async () => { await post('/shopping', { circle_id: activeCircleId(), list: listName, label: v }); inp.value = ''; load(); }); } },
    h('input', { name: 'label', placeholder: 'Ajouter un article…', 'aria-label': 'Nouvel article', maxlength: 200 }),
    h('button', { class: 'btn primary', type: 'submit' }, icon('plus', 16)));
  append(root, pageHead('Courses'), chips, addRow, box);

  async function load() { items = await get('/shopping'); draw(); }
  onRefresh(['shopping'], load);

  function draw() {
    const visible = items.filter(inFilter);
    const lists = [...new Set(visible.map((i) => i.list))];
    if (!lists.includes(listName)) listName = lists[0] || 'Courses';
    const pending = visible.filter((i) => i.list === listName && !i.done);
    const done = visible.filter((i) => i.list === listName && i.done);
    const groups = GROCERY_CATEGORIES.map((cat) => ({ cat, rows: pending.filter((i) => (i.category || 'Autre') === cat) })).filter((g) => g.rows.length);
    mount(box, 
      lists.length > 1 ? h('div', { class: 'chips' }, lists.map((l) => h('button', { class: 'chip' + (l === listName ? ' on' : ''), type: 'button', onclick: () => { listName = l; draw(); } }, l))) : null,
      pending.length ? h('div', { class: 'stack' }, groups.map((g) => h('div', { class: 'shop-group' }, h('h3', null, g.cat), h('ul', { class: 'shop-list' }, g.rows.map(row))))) : emptyState('Rien à acheter pour le moment.'),
      done.length ? h('details', { class: 'done-block' }, h('summary', null, `${done.length} coché(s)`),
        h('ul', { class: 'shop-list' }, done.map(row)),
        h('button', { class: 'btn small', onclick: () => act(async () => { await del(`/shopping/done?circle_id=${activeCircleId()}&list=${encodeURIComponent(listName)}`); load(); }) }, 'Vider les articles cochés'))
        : null);
  }

  function row(i) {
    return h('li', { class: 'shop-row' },
      h('label', { class: 'row gap center', style: { flex: 1 } },
        h('input', { type: 'checkbox', checked: !!i.done, onchange: () => act(async () => { await put(`/shopping/${i.id}`, { done: !i.done }); load(); }) }),
        h('span', { class: i.done ? 'strike' : '' }, i.label, i.qty ? h('small', null, ' · ' + i.qty) : null)),
      h('button', { class: 'icon-btn', 'aria-label': 'Supprimer', onclick: () => act(async () => { await del(`/shopping/${i.id}`); load(); }) }, icon('x', 16)));
  }

  await load();
}
