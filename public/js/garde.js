import { h, icon, state, get, post, put, del, act, toast, formModal, confirmBox, opt, onRefresh, pageHead, emptyState, today, ymd, addDays, toDate, daysBetween, fmtDay, fmtDayY, fmtMonth, avatar, userById, childById, userName, readable, ago, mount, append, myEditableChildren, possibleCustodyParents, isoWeek, modal, handoverLocationField } from './core.js';

let cursor = null;
const gardeChildren = () => state.children.filter((c) => c.shared_custody);
const myEditableGardeChildren = () => myEditableChildren().filter((c) => c.shared_custody);

export const PATTERNS = [
  opt('alternate_weeks', 'Une semaine sur deux — cycle à date fixe (départ à une date choisie)'),
  opt('even_odd_weeks', 'Une semaine sur deux — semaines paires/impaires (indépendant de la date de début)'),
  opt('two_two_three', 'Rythme 2-2-3'),
  opt('two_two_five_five', 'Rythme 2-2-5-5'),
  opt('weekends', 'Week-ends alternés (1 sur 2)'),
  opt('halves', 'Moitié-moitié sur la période (vacances)'),
  opt('custom', 'Séquence personnalisée'),
];

export function generatorForm(preset = {}, done = () => {}) {
  // Ne restreindre la liste des parents proposés que si des enfants précis sont déjà connus (ex. bouton
  // « Partager en deux » depuis les vacances scolaires) : sinon, avec plusieurs enfants ayant des parents
  // différents, l'intersection pouvait se réduire à une seule personne commune et forcer Parent A = Parent B.
  const baseKids = preset.child_ids || [];
  const possible = possibleCustodyParents(baseKids);
  const adults = possible.map((u) => opt(u.id, u.name));
  const me = possible.some((u) => u.id === state.me.user.id) ? state.me.user.id : (possible[0] || state.users[0]).id;
  const other = (possible.find((u) => u.id !== me) || state.users.find((u) => u.id !== me) || possible[0] || state.users[0]).id;
  formModal('Créer un planning de garde', [
    { name: 'pattern', label: 'Modèle', type: 'select', value: preset.pattern || 'alternate_weeks', options: PATTERNS },
    { name: 'parent_a', label: 'Parent A (première période du cycle, ou semaines paires selon le modèle)', type: 'select', value: me, options: adults, hint: possible.length < state.users.length ? 'Limité aux parents désignés des enfants déjà connus.' : undefined },
    { name: 'parent_b', label: 'Parent B (ou semaines impaires selon le modèle)', type: 'select', value: other, options: adults },
    { name: 'parent_a_weeks', label: 'Pour le modèle « par numéro de semaine » : le parent A a les semaines', type: 'select', value: 'even', options: [opt('even', 'paires'), opt('odd', 'impaires')] },
    { name: 'child_ids', label: 'Enfants', type: 'checkboxes', value: preset.child_ids || [], options: myEditableGardeChildren().map((c) => opt(c.id, c.name)), hint: preset.child_ids ? undefined : 'Choisissez les enfants concernés par ce planning : chaque enfant peut avoir un rythme différent.' },
    { name: 'start', label: 'Première nuit du cycle', type: 'date', value: preset.start || today(), required: true, hint: 'Le parent A a la première nuit. Pour les week-ends alternés, indiquez le vendredi du premier week-end du parent B. Sans effet pour le modèle « par numéro de semaine ».' },
    { name: 'end', label: 'Dernière nuit', type: 'date', value: preset.end || addDays(today(), 180), required: true },
    { name: 'sequence', label: 'Séquence personnalisée (si choisie)', placeholder: 'AABBAAABBAABBB', hint: 'Une lettre par nuit : A = parent A, B = parent B. Le cycle se répète.' },
  ], {
    submit: 'Générer',
    onSubmit: async (v, close) => {
      if (Number(v.parent_a) === Number(v.parent_b)) throw new Error('Choisissez deux parents différents pour A et B.');
      if (!(await confirmBox('Les nuits déjà enregistrées sur cette période seront remplacées. Continuer ?', 'Générer'))) return;
      const r = await post('/custody/generate', {
        pattern: v.pattern, sequence: v.sequence, child_ids: v.child_ids, parent_a: Number(v.parent_a), parent_b: Number(v.parent_b), start: v.start, end: v.end, parent_a_weeks: v.parent_a_weeks,
      });
      close(); toast(`${r.nights} nuits planifiées`); done();
    },
  });
}

export async function garde(root) {
  const now = new Date();
  if (!cursor) cursor = { y: now.getFullYear(), m: now.getMonth() };
  let nights = []; let stats = { month: {}, year: {} }; let swaps = []; let holidaysByZone = {}; let handovers = [];
  let anchor = null; let sel = null; // sélection de nuits { from, to }
  let chosenKids = null;

  const monthBox = h('div', { class: 'stack big' });
  const bar = h('div', { class: 'action-bar', hidden: true });
  const statsBox = h('section', { class: 'stack' });
  const swapBox = h('section', { class: 'stack' });
  const holBox = h('section', { class: 'stack' });

  append(root, pageHead('Garde',
    h('button', { class: 'btn', onclick: () => generatorForm({}, load) }, icon('moon', 16), 'Créer un planning')),
  h('div', { class: 'cal-nav' },
    h('button', { class: 'icon-btn', 'aria-label': 'Mois précédent', onclick: () => { cursor.m--; if (cursor.m < 0) { cursor.m = 11; cursor.y--; } clearSel(); load(); } }, icon('left')),
    h('h2', { class: 'cal-title' }, () => null),
    h('button', { class: 'icon-btn', 'aria-label': 'Mois suivant', onclick: () => { cursor.m++; if (cursor.m > 11) { cursor.m = 0; cursor.y++; } clearSel(); load(); } }, icon('right'))),
  monthBox, bar, statsBox, swapBox, holBox);
  const title = root.querySelector('.cal-title');

  const clearSel = () => { anchor = null; sel = null; };
  const monthKey = () => `${cursor.y}-${String(cursor.m + 1).padStart(2, '0')}`;

  async function load() {
    const from = ymd(new Date(cursor.y, cursor.m, 1));
    const to = ymd(new Date(cursor.y, cursor.m + 1, 0));
    // Un jour avant le mois : permet de détecter une transition dès le 1er du mois, en comparant à la
    // dernière nuit du mois précédent.
    const fetchFrom = addDays(from, -1);
    const zones = [...new Set(gardeChildren().map((c) => c.zone))];
    const [n, s, sw, ho, ...hols] = await Promise.all([
      get(`/custody?from=${fetchFrom}&to=${to}`), get(`/custody/stats?month=${monthKey()}`), get('/swaps'),
      get(`/custody/handovers?from=${from}&to=${to}`),
      ...zones.map((z) => get(`/holidays?zone=${z}`)),
    ]);
    nights = n; stats = s; swaps = sw; handovers = ho;
    holidaysByZone = Object.fromEntries(zones.map((z, i) => [z, hols[i].periods]));
    draw();
  }
  onRefresh(['custody', 'swaps'], load);

  function draw() {
    title.textContent = fmtMonth(cursor.y, cursor.m);
    drawMonth(); drawBar(); drawStats(); drawSwaps(); drawHolidays();
  }

  function drawMonth() {
    const kids = gardeChildren();
    if (!kids.length) {
      mount(monthBox, emptyState(
        state.children.length ? "Aucun enfant n'est concerné par une garde partagée. Activez-la dans Famille → Enfants si besoin." : "Ajoutez d'abord les enfants dans « Famille » pour planifier la garde.",
        h('a', { class: 'btn primary', href: '#/famille' }, 'Aller dans Famille')));
      return;
    }
    const first = new Date(cursor.y, cursor.m, 1);
    const lead = (first.getDay() + 6) % 7;
    const days = new Date(cursor.y, cursor.m + 1, 0).getDate();
    const map = {};
    for (const n of nights) map[`${n.date}|${n.child_id}`] = n.parent_id;
    const hoMap = {};
    for (const r of handovers) hoMap[`${r.date}|${r.child_id}`] = r;
    const inSel = (d, childId) => sel && chosenKids && chosenKids.includes(childId) && d >= sel.from && d <= sel.to;
    mount(monthBox, ...kids.map((c) => {
      const tiles = [];
      let col = 0;
      for (let i = 0; i < lead; i++) {
        if (col === 0) tiles.push(h('span', { class: 'tile-week', 'aria-hidden': 'true' }, isoWeek(ymd(new Date(cursor.y, cursor.m, 1)))));
        tiles.push(h('span', { class: 'tile ghost' }));
        col = (col + 1) % 7;
      }
      for (let d = 1; d <= days; d++) {
        if (col === 0) tiles.push(h('span', { class: 'tile-week', 'aria-hidden': 'true' }, isoWeek(ymd(new Date(cursor.y, cursor.m, d)))));
        const date = ymd(new Date(cursor.y, cursor.m, d));
        const pid = map[`${date}|${c.id}`];
        const p = pid ? userById(pid) : null;
        const holiday = (holidaysByZone[c.zone] || []).some((x) => date >= x.start && date < x.end);
        // Jour de transition : le parent change par rapport à la nuit précédente (les deux nuits doivent
        // être renseignées). On compare toujours à la veille, y compris le 1er du mois (nuits du mois
        // précédent chargées en plus dans load()).
        const prevDate = ymd(new Date(cursor.y, cursor.m, d - 1));
        const prevPid = map[`${prevDate}|${c.id}`];
        const isTransition = pid && prevPid && pid !== prevPid;
        const override = hoMap[`${date}|${c.id}`];
        const dayBtn = h('button', {
          type: 'button', class: ['tile', p ? 'filled' : 'empty', inSel(date, c.id) ? 'sel' : '', date === today() ? 'today' : '', holiday ? 'hol' : ''].join(' '),
          style: p ? { background: p.color, color: readable(p.color) } : null,
          'aria-label': `${fmtDay(date)} : ${p ? c.name + ' chez ' + p.name : 'non renseigné'}`,
          'aria-pressed': !!inSel(date, c.id),
          onclick: () => pick(date, c.id),
        }, d);
        tiles.push((isTransition || override) ? h('span', { class: 'tile-cell' }, dayBtn,
          h('button', {
            type: 'button', class: 'tile-pin' + (override ? ' set' : ''),
            'aria-label': `Transition du ${fmtDay(date)} (${c.name}) : lieu et heure ${override ? 'personnalisés' : 'habituels'}`,
            onclick: (e) => { e.stopPropagation(); handoverForm(date, c, override); },
          }, icon('pin', 10))) : dayBtn);
        col = (col + 1) % 7;
      }
      return h('div', { class: 'child-month' },
        h('div', { class: 'child-head' }, h('span', { class: 'dot big', style: { background: c.color } }), h('h3', null, c.name),
          !myEditableChildren().some((e) => e.id === c.id) ? h('span', { class: 'tag' }, 'Lecture seule') : null),
        (c.handover_location || c.handover_time) ? h('p', { class: 'muted handover-line' },
          'Transition habituelle : ', [c.handover_location, c.handover_time].filter(Boolean).join(', ')) : null,
        h('div', { class: 'tile-grid' }, h('span', { class: 'tile-week tile-week-head' }, 'Sem.'), ['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((x) => h('span', { class: 'tile-dow' }, x)), tiles));
    }), legend());
  }

  function legend() {
    const used = [...new Set(nights.map((n) => n.parent_id))].map(userById).filter(Boolean);
    return used.length ? h('div', { class: 'legend' }, used.map((u) => h('span', { class: 'legend-item' }, h('span', { class: 'swatch', style: { background: u.color } }), u.name)),
      h('span', { class: 'muted' }, 'Touchez un jour, puis un second pour choisir une période.')) : h('p', { class: 'muted' }, "Aucune nuit renseignée ce mois-ci. Créez un planning ou touchez des jours pour les attribuer.");
  }

  function pick(date, childId) {
    if (!anchor || (sel && sel.from !== sel.to)) { anchor = date; sel = { from: date, to: date }; chosenKids = [childId]; }
    else { sel = date < anchor ? { from: date, to: anchor } : { from: anchor, to: date }; }
    drawMonth(); drawBar();
  }

  function drawBar() {
    bar.hidden = !sel;
    if (!sel) return;
    if (!chosenKids) chosenKids = [];
    const count = daysBetween(sel.from, sel.to) + 1;
    const possibleParents = possibleCustodyParents(chosenKids);
    const parentSel = h('select', { 'aria-label': 'Parent' }, possibleParents.map((u) => h('option', { value: u.id }, u.name)));
    parentSel.value = possibleParents.some((u) => u.id === state.me.user.id) ? state.me.user.id : (possibleParents[0] || {}).id;
    const apply = (pid) => act(async () => {
      await put('/custody', { date_from: sel.from, date_to: sel.to, child_ids: chosenKids, parent_id: pid });
      toast('Planning mis à jour'); clearSel(); load();
    });
    mount(bar, 
      h('div', { class: 'bar-text' }, h('strong', null, count === 1 ? `Nuit du ${fmtDay(sel.from)}` : `${count} nuits, du ${fmtDay(sel.from)} au ${fmtDay(sel.to)}`)),
      h('div', { class: 'checks' }, myEditableGardeChildren().map((c) => h('label', { class: 'check-chip' },
        h('input', { type: 'checkbox', checked: chosenKids.includes(c.id), onchange: (e) => { chosenKids = e.target.checked ? [...chosenKids, c.id] : chosenKids.filter((x) => x !== c.id); } }), h('span', null, c.name)))),
      h('div', { class: 'row gap wrap' },
        parentSel,
        h('button', { class: 'btn primary', onclick: () => apply(Number(parentSel.value)) }, 'Attribuer'),
        h('button', { class: 'btn', onclick: () => swapForm() }, icon('swap', 16), 'Demander un échange'),
        h('button', { class: 'btn ghost', onclick: () => apply(null) }, 'Effacer'),
        h('button', { class: 'btn ghost', onclick: () => { clearSel(); drawMonth(); drawBar(); } }, 'Annuler')));
  }

  // Lieu/heure de transition au cas par cas pour ce jour précis (remplace le lieu/heure habituel de
  // l'enfant, défini dans Famille → Enfants, sans le modifier).
  function handoverForm(date, child, existing) {
    const habitual = [child.handover_location, child.handover_time].filter(Boolean).join(', ');
    const close = formModal(`Transition du ${fmtDay(date)} — ${child.name}`, [
      { name: 'location', ...handoverLocationField(existing ? existing.location : '', 'Lieu pour cette transition') },
      { name: 'time', label: 'Heure pour cette transition', type: 'time', value: existing ? existing.time : '', hint: habitual ? `Habituellement : ${habitual}` : "Rien de défini comme lieu/heure habituel pour cet enfant." },
    ], {
      submit: 'Enregistrer',
      onSubmit: async (v, closeForm) => {
        await put('/custody/handovers', { child_id: child.id, date, location: v.location, time: v.time });
        closeForm(); toast('Transition mise à jour'); load();
      },
      extra: existing ? h('button', {
        type: 'button', class: 'btn ghost',
        onclick: () => act(async () => {
          await put('/custody/handovers', { child_id: child.id, date, location: '', time: '' });
          close(); toast('Transition réinitialisée : lieu et heure habituels repris.'); load();
        }),
      }, 'Réinitialiser') : null,
    });
  }

  function swapForm() {
    const me = state.me.user.id;
    const others = state.users.filter((u) => u.id !== me);
    if (!others.length) return toast("Invitez d'abord l'autre parent dans « Famille ».", true);
    const possibleParents = possibleCustodyParents(chosenKids);
    const recipientOptions = others.filter((u) => possibleParents.some((p) => p.id === u.id));
    if (!recipientOptions.length) return toast("Aucun autre parent désigné pour les enfants sélectionnés.", true);
    formModal("Demande d'échange de garde", [
      { name: 'recipient_id', label: 'À qui demandez-vous ?', type: 'select', value: recipientOptions[0].id, options: recipientOptions.map((u) => opt(u.id, u.name)) },
      { name: 'new_parent_id', label: 'Qui aura les enfants ?', type: 'select', value: me, options: [opt(me, 'Moi'), ...recipientOptions.map((u) => opt(u.id, u.name))], hint: "Doit être vous ou la personne sollicitée." },
      { name: 'child_ids', label: 'Enfants', type: 'checkboxes', value: chosenKids, options: myEditableGardeChildren().map((c) => opt(c.id, c.name)) },
      { name: 'date_from', label: 'Première nuit', type: 'date', value: sel.from, required: true },
      { name: 'date_to', label: 'Dernière nuit', type: 'date', value: sel.to, required: true },
      { name: 'location', label: 'Lieu de transition (si différent de d\'habitude)', placeholder: 'Ex. : chez mamie, à la gare…' },
      { name: 'time', label: 'Heure de transition (si différente)', type: 'time' },
      { name: 'message', label: 'Message (facultatif)', type: 'textarea', placeholder: 'Ex. : mariage de ma sœur ce week-end' },
    ], {
      submit: 'Envoyer la demande',
      onSubmit: async (v, close) => {
        await post('/swaps', { ...v, recipient_id: Number(v.recipient_id), new_parent_id: Number(v.new_parent_id) });
        close(); toast('Demande envoyée. Le planning changera dès son acceptation.'); clearSel(); load();
      },
    });
  }

  function drawStats() {
    if (!gardeChildren().length) { mount(statsBox, ); return; }
    mount(statsBox, h('div', { class: 'row between center' }, h('h2', null, 'Répartition des nuits'),
      h('button', { class: 'icon-btn', 'aria-label': 'Voir le détail par mois et par année', onclick: () => statsDetailModal() }, icon('plus', 16))),
      h('div', { class: 'stats-grid' }, statBlock(stats.month, fmtMonth(cursor.y, cursor.m)), statBlock(stats.year, `Année ${cursor.y}`)));
  }

  function statBlock(data, label) {
    return h('div', { class: 'stat-group' }, h('h4', null, label),
      gardeChildren().map((c) => {
        const row = data[c.id] || {};
        const total = Object.values(row).reduce((a, b) => a + b, 0);
        return h('div', { class: 'stat-row' },
          h('div', { class: 'stat-name' }, h('span', { class: 'dot', style: { background: c.color } }), c.name),
          total ? h('div', { class: 'stat-bar', role: 'img', 'aria-label': Object.entries(row).map(([p, n]) => `${userName(Number(p))} : ${n} nuits`).join(', ') },
            Object.entries(row).map(([p, n]) => { const u = userById(Number(p)); return h('span', { style: { flex: n, background: u ? u.color : '#999', color: readable(u ? u.color : '#999') } }, n); }))
            : h('span', { class: 'muted' }, 'Aucune nuit'));
      }));
  }

  async function statsDetailModal() {
    const box = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Chargement…'));
    modal('Répartition des nuits — détail', box, { wide: true });
    const d = await get(`/custody/stats/detail?year=${cursor.y}`);
    const monthNames = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
    const years = Object.keys(d.years).sort();
    mount(box,
      h('h3', null, `Par mois — ${d.year}`),
      h('div', { class: 'stats-grid detail' }, Object.keys(d.months).sort().map((key, i) => statBlock(d.months[key], monthNames[i]))),
      years.length > 1 ? h('h3', { style: { marginTop: '1.2rem' } }, 'Par année') : null,
      years.length > 1 ? h('div', { class: 'stats-grid detail' }, years.map((y) => statBlock(d.years[y], y))) : null);
  }

  function drawSwaps() {
    const me = state.me.user.id;
    const pending = swaps.filter((s) => s.status === 'pending');
    const past = swaps.filter((s) => s.status !== 'pending').slice(0, 5);
    if (!swaps.length) { mount(swapBox, ); return; }
    const kidsOf = (s) => s.child_ids.map(childById).filter(Boolean).map((c) => c.name).join(', ');
    const line = (s) => {
      const parts = [`${s.date_from === s.date_to ? 'Nuit du ' + fmtDay(s.date_from) : 'Du ' + fmtDay(s.date_from) + ' au ' + fmtDay(s.date_to)} · ${kidsOf(s)} chez ${userName(s.new_parent_id)}`];
      if (s.location || s.time) parts.push(`Transition${s.location ? ' : ' + s.location : ''}${s.time ? ' à ' + s.time : ''}`);
      return parts.join(' — ');
    };
    const STATUS = { accepted: 'Accepté', declined: 'Refusé', cancelled: 'Annulé' };
    mount(swapBox, h('h2', null, "Demandes d'échange"),
      pending.length ? h('ul', { class: 'swap-list' }, pending.map((s) => h('li', { class: 'swap' },
        h('div', null, h('strong', null, s.requester_id === me ? `Vous → ${userName(s.recipient_id)}` : `${userName(s.requester_id)} → vous`), h('p', null, line(s)), s.message ? h('p', { class: 'muted' }, `« ${s.message} »`) : null),
        s.recipient_id === me ? h('div', { class: 'row gap' },
          h('button', { class: 'btn primary small', onclick: () => act(async () => { await post(`/swaps/${s.id}/answer`, { accept: true }); toast('Échange accepté, planning mis à jour'); load(); }) }, 'Accepter'),
          h('button', { class: 'btn small', onclick: () => act(async () => { await post(`/swaps/${s.id}/answer`, { accept: false }); load(); }) }, 'Refuser'))
          : h('button', { class: 'btn small', onclick: () => act(async () => { await post(`/swaps/${s.id}/cancel`); load(); }) }, 'Annuler la demande'))))
        : h('p', { class: 'muted' }, 'Aucune demande en attente.'),
      past.length ? h('ul', { class: 'swap-history' }, past.map((s) => h('li', null, h('span', { class: 'status ' + s.status }, STATUS[s.status]), ` ${line(s)} `, h('span', { class: 'muted' }, `· ${ago(s.answered_at || s.created_at)}`)))) : null);
  }

  function drawHolidays() {
    const t = today();
    const zones = [...new Set(gardeChildren().map((c) => c.zone))];
    const groups = zones.map((z) => ({
      zone: z,
      kids: gardeChildren().filter((c) => c.zone === z),
      upcoming: (holidaysByZone[z] || []).filter((p) => p.end > t && p.name !== 'Été').sort((a, b) => a.start.localeCompare(b.start)).slice(0, 3),
    })).filter((g) => g.upcoming.length);
    if (!groups.length || !gardeChildren().length) { mount(holBox); return; }
    mount(holBox, h('h2', null, 'Vacances scolaires'),
      groups.map((g) => h('div', { class: 'stack', style: { marginBottom: '.8rem' } },
        h('p', { class: 'muted' }, zones.length > 1 ? `Zone ${g.zone} — ${g.kids.map((k) => k.name).join(', ')}` : `Zone ${g.zone}`),
        h('ul', { class: 'hol-list' }, g.upcoming.map((p) => h('li', null,
          h('span', null, h('strong', null, p.name), ` : du ${fmtDayY(p.start)} au ${fmtDayY(addDays(p.end, -1))}`)))))));
  }

  await load();
}
