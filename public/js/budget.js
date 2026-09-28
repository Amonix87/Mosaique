import { h, icon, state, get, post, put, del, act, toast, formModal, confirmBox, opt, onRefresh, pageHead, circleChips, periodFilter, activeCircleId, euro, fmtDayY, today, avatar, userById, userName, childById, myCircles, membersOfCircle, emptyState, mount, append, myEditableChildren } from './core.js';

const CATS = ['École', 'Santé', 'Loisirs', 'Habillement', 'Cantine', 'Activités', 'Autre'];
const FREQS = { weekly: 'Toutes les semaines', monthly: 'Tous les mois', quarterly: 'Tous les trimestres', yearly: 'Tous les ans' };

function splitEqually(ids) {
  const n = ids.length; const base = Math.floor(1000 / n); const out = {};
  ids.forEach((id, i) => { out[id] = (i === n - 1 ? 1000 - base * (n - 1) : base) / 10; });
  return out;
}

// Seule la personne qui a créé une ligne peut la modifier ou la supprimer (le serveur l'impose aussi).
// Exception de secours, identique côté serveur : un administrateur si le créateur n'existe plus.
const canModify = (row) => row.created_by === state.me.user.id
  || (state.me.user.is_admin && (row.created_by == null || !userById(row.created_by)));

/* ── Formulaire de dépense : nouvelle, modification d'une dépense, ou modification d'une dépense récurrente ── */
function expenseForm({ circleId: initialCircleId, done, expense = null, recurring = null }) {
  const editing = expense || recurring;            // une ligne existante est modifiée
  const isRecurringEdit = !!recurring;
  const isNew = !editing;
  const circles = myCircles();
  let circleId = editing ? editing.circle_id : initialCircleId;
  let childId = editing ? (editing.child_id ?? null) : null;
  let split = {};
  const paidBySelect = h('select', {});
  const sliders = h('div', { class: 'split-rows' });
  const total = h('p', { class: 'muted' });

  // Si l'enfant concerné a des parents désignés, seuls eux se partagent la dépense — un beau-parent
  // (ou toute autre personne) reste sélectionnable comme ayant payé, via « Payé par », sans faire
  // partie du partage. Sans enfant, ou sans parent désigné, tout le cercle reste éligible.
  const splitParticipants = () => {
    const base = membersOfCircle(circleId);
    const child = childId ? state.children.find((c) => c.id === childId) : null;
    return (child && child.parent_ids.length) ? base.filter((id) => child.parent_ids.includes(id)) : base;
  };
  const updateTotal = () => { total.textContent = `Total : ${Object.values(split).reduce((a, b) => a + b, 0)} %`; };
  const drawSliders = (ids) => {
    mount(sliders, ids.map((id) => h('div', { class: 'split-row' },
      h('span', null, userName(id)),
      h('input', { type: 'number', min: 0, max: 100, step: 1, value: split[id], oninput: (e) => { split[id] = Number(e.target.value); updateTotal(); } }),
      h('span', null, '%'))));
    updateTotal();
  };
  const resetSplit = (initial = null) => {
    const ids = splitParticipants();
    let next = null;
    if (initial) { // modification : on repart du partage existant, tant qu'il reste valable
      next = Object.fromEntries(ids.filter((id) => initial[id] !== undefined).map((id) => [id, initial[id]]));
      if (Math.abs(Object.values(next).reduce((a, b) => a + b, 0) - 100) > 0.01) next = null;
    }
    split = next || splitEqually(ids);
    drawSliders(ids);
  };
  const fillPayers = (selectedId) => {
    const ids = membersOfCircle(circleId);
    mount(paidBySelect, ids.map((id) => h('option', { value: id, selected: id === selectedId }, userName(id))));
  };
  const resetForCircle = (cid) => { circleId = cid; fillPayers(state.me.user.id); resetSplit(); };

  if (editing) { fillPayers(editing.paid_by); resetSplit(editing.split); } else resetForCircle(initialCircleId);

  const circleField = (isNew && circles.length > 1)
    ? { name: 'circle_id', node: h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Cercle'),
        h('select', { onchange: (e) => resetForCircle(Number(e.target.value)) }, circles.map((c) => h('option', { value: c.id, selected: c.id === circleId }, c.name)))), get: () => circleId }
    : null;

  const childChoices = [...myEditableChildren()];
  if (childId && !childChoices.some((c) => c.id === childId) && childById(childId)) childChoices.push(childById(childId));
  const childField = childChoices.length
    ? { name: 'child_id', node: h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Enfant concerné (facultatif)'),
        h('select', { onchange: (e) => { childId = e.target.value ? Number(e.target.value) : null; resetSplit(); } },
          h('option', { value: '' }, 'Toute la famille'), childChoices.map((c) => h('option', { value: c.id, selected: c.id === childId }, c.name))),
        h('span', { class: 'hint' }, "Si cet enfant a des parents désignés (Famille → Enfants), seuls eux se partageront cette dépense. Une autre personne (beau-parent...) reste sélectionnable comme ayant payé, ci-dessous.")), get: () => childId }
    : null;

  const currentDoc = expense && expense.document_id;
  const specs = [
    { name: 'title', label: 'Description', value: editing ? editing.title : '', required: true, maxlength: 200 },
    ...(circleField ? [circleField] : []),
    { name: 'amount', label: 'Montant (€)', type: 'number', step: '0.01', min: '0.01', required: true, value: editing ? (editing.amount_cents / 100).toFixed(2) : '' },
    { name: 'category', label: 'Catégorie', type: 'select', value: editing ? (editing.category || 'Autre') : 'École', options: CATS.map((c) => opt(c, c)) },
    ...(isRecurringEdit
      ? [{ name: '_info', node: h('p', { class: 'muted' }, `${FREQS[recurring.repeat]}, depuis le ${fmtDayY(recurring.start_date)}. Le début et la fréquence ne se modifient pas, et les changements ne concernent que les échéances à venir.`), get: () => null }]
      : [{ name: 'date', label: isNew ? 'Date (ou première échéance si la dépense se répète)' : 'Date', type: 'date', value: editing ? expense.date : today(), required: true }]),
    { name: 'paid_by', node: h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Payé par'), paidBySelect), get: () => Number(paidBySelect.value) },
    ...(childField ? [childField] : []),
    ...(isNew ? [{ name: 'repeat', label: 'Répétition', type: 'select', value: 'none', options: [opt('none', 'Ne se répète pas'), ...Object.entries(FREQS).map(([k, l]) => opt(k, l))] }] : []),
    ...((isNew || isRecurringEdit) ? [{ name: 'repeat_until', label: "Répéter jusqu'au (facultatif)", type: 'date', value: isRecurringEdit ? (recurring.repeat_until || '') : '' }] : []),
    ...(!isRecurringEdit ? [{ name: 'invoice', label: currentDoc ? 'Remplacer la facture (PDF, facultatif)' : 'Facture (PDF, facultatif)', type: 'file', accept: 'application/pdf', hint: "Retrouvable ensuite dans Documents, catégorie « Facture »." }] : []),
    ...(currentDoc ? [{ name: 'remove_invoice', label: 'Retirer la facture actuelle', type: 'checkbox', value: false }] : []),
    { node: sliders, name: '_split_ui', get: () => null }, { node: total, name: '_split_total', get: () => null },
  ];

  formModal(isRecurringEdit ? 'Modifier la dépense récurrente' : editing ? 'Modifier la dépense' : 'Nouvelle dépense', specs, {
    onSubmit: async (v, close) => {
      const sum = Object.values(split).reduce((a, b) => a + b, 0);
      if (Math.abs(sum - 100) > 0.01) throw new Error('La répartition doit totaliser 100 %.');
      const common = { title: v.title, amount_cents: Math.round(Number(v.amount) * 100), category: v.category, paid_by: v.paid_by, split, child_id: childId };
      if (isRecurringEdit) {
        await put(`/recurring-expenses/${recurring.id}`, { ...common, repeat_until: v.repeat_until || null });
        close(); toast('Dépense récurrente modifiée'); done(); return;
      }
      if (isNew && v.repeat !== 'none') {
        if (v.invoice) throw new Error("Une facture ne peut pas être jointe à une dépense récurrente : ajoutez-la à l'une de ses échéances, ensuite.");
        await post('/recurring-expenses', { ...common, circle_id: circleId, repeat: v.repeat, start_date: v.date, repeat_until: v.repeat_until || null });
        close(); toast('Dépense récurrente créée'); done(); return;
      }
      let id;
      if (expense) { await put(`/expenses/${expense.id}`, { ...common, date: v.date }); id = expense.id; }
      else id = (await post('/expenses', { ...common, circle_id: circleId, date: v.date })).id;
      try {
        if (v.remove_invoice && !v.invoice) await del(`/expenses/${id}/invoice`);
        if (v.invoice) { const fd = new FormData(); fd.append('file', v.invoice); await post(`/expenses/${id}/invoice`, fd); }
      } catch (e) { toast(`Dépense enregistrée, mais la facture a échoué : ${e.message}`, true); close(); done(); return; }
      close(); toast(expense ? 'Dépense modifiée' : 'Dépense ajoutée'); done();
    },
  });
}

/* ── Ligne de remboursement : X a rendu Y euros à Z (montant libre, donc éventuellement partiel) ── */
function settlementForm({ circleId, done, from = null, to = null, amountCents = null }) {
  const members = membersOfCircle(circleId);
  const me = state.me.user.id;
  const fromDefault = from ?? me;
  const toDefault = to ?? members.find((id) => id !== fromDefault);
  formModal('Enregistrer un remboursement', [
    { name: 'from_user', label: 'Qui a remboursé', type: 'select', value: fromDefault, options: members.map((id) => opt(id, userName(id))) },
    { name: 'to_user', label: 'À qui', type: 'select', value: toDefault, options: members.map((id) => opt(id, userName(id))) },
    { name: 'amount', label: 'Montant remboursé (€)', type: 'number', step: '0.01', min: '0.01', required: true, value: amountCents ? (amountCents / 100).toFixed(2) : '', hint: 'Un remboursement partiel est possible : le solde restant continue d\'être affiché.' },
    { name: 'date', label: 'Date', type: 'date', value: today(), required: true },
    { name: 'note', label: 'Note (facultatif)', maxlength: 200, placeholder: 'Virement, espèces…' },
  ], {
    onSubmit: async (v, close) => {
      if (String(v.from_user) === String(v.to_user)) throw new Error('Choisissez deux personnes différentes.');
      await post('/settlements', { circle_id: circleId, from_user: Number(v.from_user), to_user: Number(v.to_user), amount_cents: Math.round(Number(v.amount) * 100), date: v.date, note: v.note || null });
      close(); toast('Remboursement enregistré'); done();
    },
  });
}

export async function budget(root) {
  const circles = myCircles();
  if (!circles.length) { append(root, pageHead('Budget'), emptyState('Aucun cercle disponible.')); return; }
  let circleId;
  let category = ''; // filtre de catégorie de l'historique ('' = toutes)
  let expenses = []; let recurring = []; let summary = { balances: {}, transfers: [], categories: [], settlements: [] };

  // Pastilles partagées avec les autres pages : elles se redessinent au clic (la surbrillance suit
  // le cercle choisi) et gardent le même cercle actif d'une page à l'autre.
  const chips = circleChips(() => { circleId = activeCircleId(); load(); }, { all: false });
  circleId = activeCircleId();
  // Filtres : période (mois, année ou tout) et catégorie. Ils s'appliquent au détail par catégorie et à
  // l'historique ; les comptes (qui doit combien à qui) portent, eux, toujours sur l'ensemble.
  const period = periodFilter(() => load(), { mode: 'month' });
  const catSelect = h('select', { 'aria-label': 'Catégorie', onchange: (e) => { category = e.target.value; draw(); } });
  const resetBtn = h('button', { class: 'btn small', type: 'button', onclick: () => { category = ''; period.reset(); load(); } }, 'Réinitialiser');
  const filterBar = h('div', { class: 'filter-bar' }, period.node, catSelect, resetBtn);
  const balBox = h('div', { class: 'stack' });
  const catBox = h('div', { class: 'stack' });
  const recBox = h('div', { class: 'stack' });
  const listBox = h('div', { class: 'stack' });

  append(root, pageHead('Budget', h('div', { class: 'row gap' },
    h('button', { class: 'btn', onclick: () => settlementForm({ circleId, done: load }) }, icon('swap', 16), 'Remboursement'),
    h('button', { class: 'btn primary', onclick: () => expenseForm({ circleId, done: load }) }, icon('plus', 16), 'Dépense'))),
    chips, filterBar, balBox, catBox, recBox, listBox);

  async function load() {
    [expenses, recurring, summary] = await Promise.all([get('/expenses'), get('/recurring-expenses'), get(`/expenses/summary?circle_id=${circleId}&${period.query()}`)]);
    period.setYears([...new Set(expenses.filter((e) => e.circle_id === circleId).map((e) => e.date.slice(0, 4)))]);
    draw();
  }
  onRefresh(['expenses', 'recurring-expenses'], load);

  function draw() { drawBalances(); drawCats(); drawRecurring(); drawList(); }

  function drawBalances() {
    const me = state.me.user.id;
    const owe = summary.transfers.filter((t) => t.from === me);
    const owed = summary.transfers.filter((t) => t.to === me);
    mount(balBox,
      h('h2', null, 'Comptes'),
      h('p', { class: 'muted filter-summary' }, 'Sur l\'ensemble des dépenses, quels que soient les filtres ci-dessous.'),
      summary.transfers.length ? h('ul', { class: 'balance-list' }, summary.transfers.map((t) => h('li', null,
        h('span', { class: 'row gap center' }, avatar(t.from, 22), h('span', null, userName(t.from)), '→', avatar(t.to, 22), h('span', null, userName(t.to))),
        h('strong', null, euro(t.amount_cents)),
        h('button', { class: 'btn small', onclick: () => settlementForm({ circleId, done: load, from: t.from, to: t.to, amountCents: t.amount_cents }) }, 'Rembourser'))))
        : emptyState('Tous les comptes sont équilibrés.'),
      (owe.length || owed.length) ? h('p', { class: 'muted' }, owe.length ? `Vous devez ${euro(owe.reduce((a, t) => a + t.amount_cents, 0))}. ` : '', owed.length ? `On vous doit ${euro(owed.reduce((a, t) => a + t.amount_cents, 0))}.` : '') : null);
  }

  function drawCats() {
    const total = summary.categories.reduce((a, c) => a + c.total, 0);
    mount(catBox, h('h2', null, `Dépenses — ${period.label()}`),
      total ? h('ul', { class: 'cat-list' }, summary.categories.map((c) => h('li', {
        class: 'pickable' + (category === c.category ? ' on' : ''), role: 'button', tabindex: 0, title: 'Filtrer l\'historique sur cette catégorie',
        onclick: () => { category = category === c.category ? '' : c.category; draw(); },
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); category = category === c.category ? '' : c.category; draw(); } },
      },
      h('div', { class: 'row between' }, h('span', null, c.category), h('strong', null, euro(c.total))),
      h('div', { class: 'cat-bar' }, h('span', { style: { width: `${(c.total / total) * 100}%` } })))))
        : emptyState('Aucune dépense sur cette période.'));
  }

  function drawRecurring() {
    const rows = recurring.filter((r) => r.circle_id === circleId);
    if (!rows.length) { mount(recBox); return; } // rien à afficher tant qu'aucune n'existe
    mount(recBox, h('h2', null, 'Dépenses récurrentes'),
      h('ul', { class: 'expense-list' }, rows.map((r) => h('li', { class: 'expense-row' },
        avatar(r.paid_by, 28),
        h('div', { class: 'expense-main' }, h('strong', null, r.title),
          h('small', null, `${FREQS[r.repeat]} · ${r.category || 'Autre'} · payé par ${userName(r.paid_by)}`, r.child_id && childById(r.child_id) ? ` · ${childById(r.child_id).name}` : '',
            r.next_date ? ` · prochaine le ${fmtDayY(r.next_date)}` : ' · terminée')),
        h('strong', null, euro(r.amount_cents)),
        canModify(r) ? h('button', { class: 'icon-btn', 'aria-label': 'Modifier', onclick: () => expenseForm({ circleId, done: load, recurring: r }) }, icon('edit', 16)) : null,
        canModify(r) ? h('button', { class: 'icon-btn', 'aria-label': 'Supprimer', onclick: async () => { if (await confirmBox(`Supprimer la dépense récurrente « ${r.title} » ? Les dépenses déjà créées sont conservées.`)) act(async () => { await del(`/recurring-expenses/${r.id}`); load(); }); } }, icon('trash', 16)) : null))));
  }

  function drawList() {
    // Catégories proposées : les habituelles, plus celles réellement présentes (et la sélection en cours).
    const inCircle = expenses.filter((e) => e.circle_id === circleId);
    const cats = [...new Set([...CATS, ...inCircle.map((e) => e.category || 'Autre'), ...(category ? [category] : [])])];
    mount(catSelect, h('option', { value: '' }, 'Toutes les catégories'), cats.map((c) => h('option', { value: c, selected: c === category }, c)));
    resetBtn.hidden = !category && period.isDefault();

    // Dépenses et lignes de remboursement dans une même chronologie, la plus récente en premier.
    // Un remboursement n'a pas de catégorie : il disparaît dès qu'on filtre sur une catégorie.
    const shownExpenses = inCircle.filter((e) => period.match(e.date) && (!category || (e.category || 'Autre') === category));
    const lines = [
      ...shownExpenses.map((e) => ({ kind: 'expense', date: e.date, id: e.id, e })),
      ...(category ? [] : summary.settlements.filter((s) => period.match(s.date)).map((s) => ({ kind: 'settlement', date: s.date, id: s.id, s }))),
    ].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.kind === b.kind ? b.id - a.id : a.kind === 'expense' ? -1 : 1));

    const expenseRow = (e) => h('li', { class: 'expense-row' },
      avatar(e.paid_by, 28),
      h('div', { class: 'expense-main' }, h('strong', null, e.title),
        h('small', null, `${fmtDayY(e.date)} · ${e.category || 'Autre'} · payé par ${userName(e.paid_by)}`, e.child_id && childById(e.child_id) ? ` · ${childById(e.child_id).name}` : '',
          e.recurring_id ? ' · récurrente' : '', e.event_id ? ' · issue d\'un événement' : '')),
      h('strong', null, euro(e.amount_cents)),
      e.document_id ? h('a', { class: 'icon-btn', href: `/api/documents/${e.document_id}/file?inline=1`, target: '_blank', rel: 'noopener', 'aria-label': 'Voir la facture' }, icon('doc', 16)) : null,
      canModify(e) ? h('button', { class: 'icon-btn', 'aria-label': 'Modifier', onclick: () => expenseForm({ circleId, done: load, expense: e }) }, icon('edit', 16)) : null,
      canModify(e) ? h('button', { class: 'icon-btn', 'aria-label': 'Supprimer', onclick: async () => { if (await confirmBox(`Supprimer « ${e.title} » ?`)) act(async () => { await del(`/expenses/${e.id}`); load(); }); } }, icon('trash', 16)) : null);

    const settlementRow = (s) => h('li', { class: 'expense-row settle-row' },
      h('span', { class: 'settle-icon' }, icon('swap', 14)),
      h('div', { class: 'expense-main' }, h('strong', null, `Remboursement · ${userName(s.from_user)} → ${userName(s.to_user)}`),
        h('small', null, `${fmtDayY(s.date)}${s.note ? ` · ${s.note}` : ''}`)),
      h('strong', null, euro(s.amount_cents)),
      canModify(s) ? h('button', { class: 'icon-btn', 'aria-label': 'Supprimer', onclick: async () => { if (await confirmBox('Supprimer cette ligne de remboursement ? Le solde en sera modifié.')) act(async () => { await del(`/settlements/${s.id}`); load(); }); } }, icon('trash', 16)) : null);

    const total = shownExpenses.reduce((a, e) => a + e.amount_cents, 0);
    const filtered = !!category || !period.isDefault();
    mount(listBox, h('h2', null, 'Historique'),
      shownExpenses.length ? h('p', { class: 'muted filter-summary' }, `${shownExpenses.length} dépense${shownExpenses.length > 1 ? 's' : ''} · ${euro(total)}${category ? ` · ${category}` : ''} · ${period.label()}${category ? ' (remboursements non affichés)' : ''}`) : null,
      lines.length ? h('ul', { class: 'expense-list' }, lines.map((l) => (l.kind === 'expense' ? expenseRow(l.e) : settlementRow(l.s))))
        : emptyState(filtered && inCircle.length ? 'Aucune dépense ne correspond à ces filtres.' : 'Aucune dépense enregistrée pour ce cercle.'));
  }

  await load();
}
