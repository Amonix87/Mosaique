import { h, icon, state, get, post, put, del, act, toast, modal, formModal, confirmBox, opt, onRefresh, pageHead, circleChips, inFilter, today, ymd, addDays, toDate, fmtLong, fmtWhen, fmtDay, fmtMonth, timeOf, avatar, userById, childById, circleById, circleSelectOptions, activeCircleId, emptyState, readable, myCircles, mount, append, myEditableChildren, isoWeek, addressField, euro, userName, membersOfCircle, fmtDayY } from './core.js';

let cursor = null; // { y, m }
let selected = today();

const REPEATS = [opt('none', 'Ne se répète pas'), opt('daily', 'Tous les jours'), opt('weekly', 'Toutes les semaines'), opt('monthly', 'Tous les mois'), opt('yearly', 'Tous les ans')];
// Doit rester identique à EVENT_CATEGORIES côté serveur (server/index.js).
const EVENT_CATEGORIES = ['Rendez-vous', 'Santé', 'École', 'Activité', 'Famille', 'Autre'];
const REMINDERS = [
  opt('', 'Aucun'), opt('0', "Au moment de l'événement"), opt('5', '5 minutes avant'), opt('10', '10 minutes avant'),
  opt('15', '15 minutes avant'), opt('30', '30 minutes avant'), opt('60', '1 heure avant'), opt('120', '2 heures avant'),
  opt('1440', '1 jour avant'), opt('2880', '2 jours avant'), opt('10080', '1 semaine avant'),
];

// Champ « Lieu » avec suggestions d'adresses (relayées par le serveur depuis OpenStreetMap), pour
// être sûr de l'adresse plutôt que de taper un texte libre approximatif. En plus de la recherche
// générique (voir addressField dans core.js), propose aussi les adresses déjà connues du carnet de
// contacts quand le champ est vide.
function locationField(initialValue, initialLat, initialLon) {
  let contactSuggestions = null; // chargées à la demande (une seule fois par ouverture du formulaire)
  async function loadContactSuggestions() {
    if (contactSuggestions) return contactSuggestions;
    try {
      const contacts = await get('/contacts');
      contactSuggestions = contacts.filter((c) => c.address && c.address.trim());
    } catch { contactSuggestions = []; }
    return contactSuggestions;
  }
  function showContactSuggestions() {
    if (!contactSuggestions || !contactSuggestions.length) { mount(field.list); return; }
    mount(field.list, contactSuggestions.map((c) => h('button', {
      type: 'button', class: 'addr-suggestion', onclick: () => field.pick(c.address, null, null),
    }, h('strong', null, c.name), ' — ', c.address)));
  }
  const field = addressField(initialValue, initialLat, initialLon, {
    placeholder: 'Ex. : école, adresse, ou un contact du carnet…',
    onEmpty: showContactSuggestions,
  });
  field.input.addEventListener('focus', async () => {
    if (field.input.value.trim()) return; // déjà une valeur : pas besoin de proposer les contacts par-dessus
    await loadContactSuggestions();
    if (!field.input.value.trim()) showContactSuggestions();
  });
  const node = h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Lieu'), field.input, field.list,
    h('span', { class: 'hint' }, "Suggestions depuis vos contacts (s'ils ont une adresse) ou OpenStreetMap pendant la frappe. Vous pouvez aussi laisser votre propre texte (« chez papi », « école »…)."));
  return { node, get: field.get, getLat: field.getLat, getLon: field.getLon };
}

export function eventForm(ev, defaults = {}, done = () => {}) {
  const isNew = !ev;
  const e = ev || { title: '', all_day: 0, starts_at: (defaults.date || today()) + 'T09:00', ends_at: (defaults.date || today()) + 'T10:00', repeat: 'none', child_ids: [], owner_id: null, owner_mode: 'auto', circle_id: activeCircleId() };
  const allDay = e.all_day || e.starts_at.length === 10;
  const canEditPrice = isNew || e.created_by === state.me.user.id;
  // Payeur de la dépense créée par le prix : n'importe quel membre du cercle (un beau-parent peut
  // avoir avancé l'argent). Par défaut : le payeur déjà enregistré, sinon celui qui saisit.
  const payerSelect = h('select', {});
  const fillPayers = (cid, keep) => {
    const ids = membersOfCircle(cid);
    mount(payerSelect, ids.map((id) => h('option', { value: id, selected: id === keep }, userName(id))));
  };
  fillPayers(e.circle_id, e.price_paid_by ?? (e.price_cents ? e.created_by : null) ?? state.me.user.id);
  const startDate = e.starts_at.slice(0, 10);
  const endDate = (e.ends_at || e.starts_at).slice(0, 10);
  const timeBlock = { s: e.starts_at.length > 10 ? e.starts_at.slice(11, 16) : '09:00', e: e.ends_at && e.ends_at.length > 10 ? e.ends_at.slice(11, 16) : '10:00' };
  const circles = myCircles();
  const ownerSel = [opt('auto', 'Automatique (selon la garde)'), opt('', 'Personne en particulier'), ...state.users.map((u) => opt(u.id, u.name))];
  const ownerValue = e.owner_mode === 'auto' ? 'auto' : (e.owner_id ?? '');
  const locField = locationField(e.location || '', e.location_lat, e.location_lon);
  const specs = [
    { name: 'title', label: 'Titre', value: e.title, required: true, maxlength: 120 },
    ...(circles.length > 1 ? [{ name: 'circle_id', label: 'Partagé avec le cercle', type: 'select', value: e.circle_id, options: circleSelectOptions(), onchange: (v) => fillPayers(Number(v), Number(payerSelect.value)) }] : []),
    { name: 'all_day', label: 'Toute la journée', type: 'checkbox', value: allDay },
    { name: 'start_date', label: 'Début', type: 'date', value: startDate, required: true },
    { name: 'start_time', label: 'Heure de début', type: 'time', value: timeBlock.s },
    { name: 'end_date', label: 'Fin', type: 'date', value: endDate, required: true },
    { name: 'end_time', label: 'Heure de fin', type: 'time', value: timeBlock.e },
    { name: 'owner_id', label: 'Responsable', type: 'select', value: ownerValue, options: ownerSel, hint: "« Automatique » suit qui a la garde ce jour-là ; si la garde change, le responsable affiché change avec elle." },
    { name: 'child_ids', label: 'Enfants concernés', type: 'checkboxes', value: e.child_ids, options: myEditableChildren().map((c) => opt(c.id, c.name)), hint: 'Le responsable automatique se base sur le premier enfant coché ici.' },
    { name: 'location', node: locField.node, get: locField.get },
    { name: 'location_lat', node: h('span', { style: { display: 'none' } }), get: () => locField.getLat() },
    { name: 'location_lon', node: h('span', { style: { display: 'none' } }), get: () => locField.getLon() },
    { name: 'repeat', label: 'Répétition', type: 'select', value: e.repeat, options: REPEATS },
    { name: 'repeat_until', label: "Jusqu'au (facultatif)", type: 'date', value: e.repeat_until || '' },
    { name: 'reminder_minutes', label: 'Rappel', type: 'select', value: e.reminder_minutes ?? '', options: REMINDERS },
    { name: 'category', label: 'Catégorie', type: 'select', value: e.category || '', options: [opt('', 'Aucune'), ...EVENT_CATEGORIES.map((c) => opt(c, c))] },
    // Le prix crée (et tient à jour) une dépense dans Budget : seul le créateur de l'événement peut donc le saisir.
    ...(canEditPrice ? [{ name: 'price', label: 'Prix (€, facultatif)', type: 'number', step: '0.01', min: '0.01', value: e.price_cents ? (e.price_cents / 100).toFixed(2) : '',
      hint: "Ajoute automatiquement une dépense dans Budget (vous en êtes le payeur, partagée entre les parents désignés de l'enfant s'il y en a, sinon tout le cercle) — modifiable ensuite depuis Budget. Indisponible pour un événement qui se répète : utilisez alors une dépense récurrente dans Budget." },
      { name: 'price_paid_by', node: h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Payé par (si un prix est indiqué)'), payerSelect), get: () => Number(payerSelect.value) }] : []),
    { name: 'notes', label: 'Notes', type: 'textarea', value: e.notes || '' },
  ];
  formModal(isNew ? 'Nouvel événement' : "Modifier l'événement", specs, {
    onSubmit: async (v, close) => {
      const ad = v.all_day;
      const body = {
        title: v.title, all_day: ad, location: v.location, location_lat: v.location_lat, location_lon: v.location_lon, notes: v.notes, repeat: v.repeat, repeat_until: v.repeat_until || null,
        reminder_minutes: v.reminder_minutes !== '' ? Number(v.reminder_minutes) : null,
        category: v.category || null,
        owner_mode: v.owner_id === 'auto' ? 'auto' : 'manual',
        owner_id: (v.owner_id && v.owner_id !== 'auto') ? Number(v.owner_id) : null,
        child_ids: v.child_ids,
        starts_at: ad ? v.start_date : `${v.start_date}T${v.start_time || '00:00'}`,
        ends_at: ad ? v.end_date : `${v.end_date}T${v.end_time || v.start_time || '00:00'}`,
      };
      if (v.circle_id) body.circle_id = Number(v.circle_id); else body.circle_id = e.circle_id;
      if (canEditPrice) {
        body.price_cents = v.price ? Math.round(Number(v.price) * 100) : null;
        body.price_paid_by = body.price_cents ? v.price_paid_by : null;
        if (body.price_cents && v.repeat !== 'none') throw new Error("Un prix ne peut pas être associé à un événement qui se répète : utilisez une dépense récurrente dans Budget.");
      }
      if (isNew) await post('/events', body); else await put(`/events/${e.id}`, body);
      close(); toast(isNew ? 'Événement ajouté' : 'Événement modifié'); done();
    },
  });
}

// Lien universel « Itinéraire » : avec des coordonnées (issues d'une suggestion choisie), il pointe
// pile sur le lieu, quel que soit le format du texte affiché — la façon la plus fiable d'ouvrir
// Waze, Google Maps ou Apple Plans sans dépendre de leur analyse du texte. Sans coordonnées (lieu
// tapé à la main), on retombe sur une recherche texte classique.
function mapsUrl(ev) {
  const q = (ev.location_lat != null && ev.location_lon != null) ? `${ev.location_lat},${ev.location_lon}` : ev.location;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

export function openEvent(ev, reload) {
  const owner = ev.owner_id ? userById(ev.owner_id) : null;
  const circle = circleById(ev.circle_id);
  const kids = ev.child_ids.map(childById).filter(Boolean);
  const close = modal(ev.title, h('div', { class: 'stack' },
    h('p', { class: 'lead' }, fmtWhen(ev), ev.recurring ? ' · se répète' : ''),
    ev.location ? h('p', { class: 'row gap center' }, 'Lieu : ', ev.location,
      h('a', { class: 'btn small', href: mapsUrl(ev), target: '_blank', rel: 'noopener' }, icon('compass', 14), ' Itinéraire')) : null,
    owner ? h('p', { class: 'row gap center' }, 'Responsable : ', avatar(owner, 22), owner.name) : null,
    kids.length ? h('p', { class: 'row gap center wrap' }, 'Enfants : ', kids.map((k) => h('span', { class: 'tag', style: { background: k.color, color: readable(k.color) } }, k.name))) : null,
    circle && myCircles().length > 1 ? h('p', { class: 'muted' }, 'Cercle : ', circle.name) : null,
    ev.notes ? h('p', { class: 'notes' }, ev.notes) : null,
    ev.category ? h('p', null, h('span', { class: 'tag cat' }, ev.category)) : null,
    ev.price_cents ? h('p', { class: 'row gap center' }, icon('euro', 14), ' Prix : ', h('strong', null, euro(ev.price_cents)), ev.price_paid_by ? h('span', { class: 'muted' }, `· payé par ${userName(ev.price_paid_by)}`) : null, h('a', { class: 'btn small', href: '#/budget', onclick: () => close() }, 'Voir dans Budget')) : null,
    (ev.reminder_minutes !== null && ev.reminder_minutes !== undefined) ? h('p', { class: 'muted' }, icon('bell', 14), ' Rappel : ', (REMINDERS.find((r) => r.value === String(ev.reminder_minutes)) || {}).label || `${ev.reminder_minutes} min avant`) : null,
    h('div', { class: 'row gap wrap end' },
      h('button', { class: 'btn', type: 'button', onclick: () => { close(); sosForm(ev, reload); } }, icon('sos', 16), 'SOS remplacement'),
      h('button', { class: 'btn', type: 'button', onclick: () => { close(); eventForm(ev, {}, reload); } }, icon('edit', 16), 'Modifier'),
      h('button', { class: 'btn danger', type: 'button', onclick: async () => { close(); await deleteEventPrompt(ev, reload); } }, icon('trash', 16), 'Supprimer'))));
}

async function deleteEventPrompt(ev, reload) {
  if (!ev.recurring) {
    if (await confirmBox('Supprimer cet événement ?')) act(async () => { await del(`/events/${ev.id}`); toast('Événement supprimé'); reload(); });
    return;
  }
  let closePrompt;
  const body = h('div', { class: 'stack' },
    h('p', null, 'Cet événement se répète. Que voulez-vous supprimer ?'),
    h('div', { class: 'stack' },
      h('button', { class: 'btn', type: 'button', onclick: () => act(async () => { closePrompt(); await post(`/events/${ev.id}/exclude`, { date: ev.occ_date }); toast('Occurrence supprimée'); reload(); }) }, 'Cette occurrence seulement'),
      h('button', { class: 'btn', type: 'button', onclick: () => act(async () => { closePrompt(); await post(`/events/${ev.id}/truncate`, { date: ev.occ_date }); toast('Occurrences supprimées'); reload(); }) }, 'Cette occurrence et les suivantes'),
      h('button', { class: 'btn danger', type: 'button', onclick: () => act(async () => { closePrompt(); await del(`/events/${ev.id}`); toast('Série supprimée'); reload(); }) }, 'Toute la série')),
    h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: () => closePrompt() }, 'Annuler')));
  closePrompt = modal('Supprimer un événement récurrent', body);
}

export function sosForm(ev, done = () => {}) {
  const circles = myCircles();
  formModal('SOS remplacement', [
    ...(circles.length > 1 ? [{ name: 'circle_id', label: 'Prévenir le cercle', type: 'select', value: ev ? ev.circle_id : activeCircleId(), options: circleSelectOptions() }] : []),
    { name: 'title', label: 'Que faut-il faire ?', value: ev ? `${ev.title} — ${fmtWhen(ev)}` : '', required: true, placeholder: 'Ex. : aller chercher Léo à 17 h' },
    { name: 'note', label: 'Précisions (facultatif)', type: 'textarea' },
  ], {
    submit: 'Envoyer la demande',
    onSubmit: async (v, close) => {
      await post('/sos', { circle_id: Number(v.circle_id || (ev ? ev.circle_id : activeCircleId())), title: v.title, note: v.note, event_id: ev ? ev.id : undefined });
      close(); toast('Le cercle est prévenu : le premier qui accepte prend le relais'); done();
    },
  });
}

export async function agenda(root) {
  const now = new Date();
  if (!cursor) cursor = { y: now.getFullYear(), m: now.getMonth() };
  const head = h('div', { class: 'cal-nav' });
  const gridWrap = h('div');
  const panel = h('section', { class: 'day-panel' });
  const chips = circleChips(() => { draw(); if (searching) drawResults(); });
  const legend = h('div', { class: 'cal-legend' });

  // Recherche dans tout l'agenda (passé et à venir) : elle remplace le calendrier par la liste des
  // résultats tant qu'au moins deux caractères sont saisis, et le rend dès qu'on efface.
  let query = ''; let results = []; let searching = false; let searchTimer; let searchSeq = 0;
  const searchInput = h('input', {
    type: 'search', placeholder: "Rechercher dans l'agenda (titre, lieu, notes, catégorie…)", 'aria-label': "Rechercher dans l'agenda", autocomplete: 'off',
    oninput: (e) => { query = e.target.value; clearBtn.hidden = !query; clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 250); },
    onkeydown: (e) => { if (e.key === 'Escape') clearSearch(); },
  });
  const clearBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Effacer la recherche', hidden: true, onclick: () => { clearSearch(); searchInput.focus(); } }, icon('x', 16));
  const searchBar = h('div', { class: 'search-field cal-search' }, icon('search', 18), searchInput, clearBtn);
  const resultsBox = h('div', { class: 'search-results', hidden: true });
  const calWrap = h('div', null, head, legend, gridWrap, panel);
  append(root, pageHead('Agenda',
    h('button', { class: 'btn primary', type: 'button', onclick: () => eventForm(null, { date: selected }, reloadAll) }, icon('plus', 16), 'Événement')),
  chips, searchBar, calWrap, resultsBox);

  let events = []; let custody = []; let holidays = [];
  const first = () => { const d = new Date(cursor.y, cursor.m, 1); const off = (d.getDay() + 6) % 7; d.setDate(1 - off); return d; };

  async function load() {
    const start = first();
    const from = ymd(start); const to = addDays(from, 41);
    const [e, c, hol] = await Promise.all([get(`/events/range?from=${from}&to=${to}`), get(`/custody?from=${from}&to=${to}`), get('/holidays')]);
    events = e; custody = c; holidays = hol.periods;
    draw();
  }
  const reloadAll = () => { load(); if (searching) runSearch(); };
  onRefresh(['events', 'custody'], reloadAll);

  function clearSearch() { query = ''; searchInput.value = ''; clearBtn.hidden = true; clearTimeout(searchTimer); runSearch(); }
  async function runSearch() {
    const q = query.trim();
    if (q.length < 2) { searching = false; searchSeq++; calWrap.hidden = false; resultsBox.hidden = true; return; }
    searching = true; calWrap.hidden = true; resultsBox.hidden = false;
    const seq = ++searchSeq;
    let found;
    try { found = await get(`/events/search?q=${encodeURIComponent(q)}`); } catch { found = null; }
    if (seq !== searchSeq) return; // une saisie plus récente a pris le relais
    results = found;
    drawResults();
  }
  // Depuis un résultat : revenir au calendrier, sur le jour de l'événement.
  function jumpTo(date) {
    clearSearch();
    selected = date;
    const d = toDate(date); cursor = { y: d.getFullYear(), m: d.getMonth() };
    load();
  }
  function drawResults() {
    if (results === null) { mount(resultsBox, emptyState('La recherche est momentanément indisponible.')); return; }
    const list = results.filter(inFilter);
    const row = (e) => h('li', { class: 'result-item' },
      h('button', { class: 'ev-row', type: 'button', onclick: () => openEvent(e, reloadAll), style: { '--c': (circleById(e.circle_id) || {}).color || '#2A3EB1' } },
        h('span', { class: 'ev-time' }, e.all_day || !timeOf(e.starts_at) ? 'Journée' : timeOf(e.starts_at)),
        h('span', { class: 'ev-title' }, h('span', { class: 'result-date' }, `${fmtDayY(e.occ_date)}${e.recurring ? ' · se répète' : ''}`), e.title,
          e.category ? h('small', { class: 'ev-cat' }, e.category) : null, e.location ? h('small', null, e.location) : null),
        e.owner_id ? avatar(e.owner_id, 24) : null),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Voir ce jour dans le calendrier', title: 'Voir dans le calendrier', onclick: () => jumpTo(e.occ_date) }, icon('calendar', 18)));
    const group = (title, items) => (items.length ? h('div', { class: 'search-group' }, h('h3', null, title), h('ul', { class: 'ev-list' }, items.map(row))) : null);
    mount(resultsBox,
      h('p', { class: 'muted search-count' }, list.length ? `${list.length} événement${list.length > 1 ? 's' : ''} pour « ${query.trim()} »` : ''),
      group('À venir', list.filter((e) => !e.past)), group('Passés', list.filter((e) => e.past)),
      list.length ? null : emptyState(`Aucun événement ne correspond à « ${query.trim()} ».`));
  }

  const holidayOn = (d) => holidays.find((p) => d >= p.start && d < p.end);

  function draw() {
    mount(head, 
      h('button', { class: 'icon-btn', 'aria-label': 'Mois précédent', onclick: () => { cursor.m--; if (cursor.m < 0) { cursor.m = 11; cursor.y--; } load(); } }, icon('left')),
      h('h2', { class: 'cal-title' }, fmtMonth(cursor.y, cursor.m)),
      h('button', { class: 'icon-btn', 'aria-label': 'Mois suivant', onclick: () => { cursor.m++; if (cursor.m > 11) { cursor.m = 0; cursor.y++; } load(); } }, icon('right')),
      h('button', { class: 'btn small', onclick: () => { const n = new Date(); cursor = { y: n.getFullYear(), m: n.getMonth() }; selected = today(); load(); } }, "Aujourd'hui"));

    const monthStart = ymd(new Date(cursor.y, cursor.m, 1));
    const monthEnd = ymd(new Date(cursor.y, cursor.m + 1, 0));
    const hols = holidays.filter((p) => p.start <= monthEnd && p.end > monthStart);
    mount(legend, ...hols.map((p) => h('span', { class: 'hol-tag' }, `Vacances de ${p.name} : du ${fmtDay(p.start)} au ${fmtDay(addDays(p.end, -1))}`)));

    const visible = events.filter(inFilter);
    const byDay = {};
    for (const e of visible) {
      const span = Math.round((toDate((e.ends_at || e.starts_at).slice(0, 10)) - toDate(e.occ_date)) / 86400000);
      for (let i = 0; i <= Math.min(span, 30); i++) (byDay[addDays(e.occ_date, i)] ||= []).push(e);
    }
    const nightsByDay = {};
    for (const n of custody) (nightsByDay[n.date] ||= []).push(n);

    const cells = [];
    const start = first();
    for (let i = 0; i < 42; i++) {
      const d = ymd(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
      if (i % 7 === 0) cells.push(h('span', { class: 'cal-week', 'aria-hidden': 'true' }, isoWeek(d)));
      const inMonth = d >= monthStart && d <= monthEnd;
      const evs = byDay[d] || [];
      const nights = nightsByDay[d] || [];
      const hol = holidayOn(d);
      const cls = ['day', inMonth ? '' : 'out', d === today() ? 'today' : '', d === selected ? 'sel' : '', hol ? 'hol' : ''].join(' ');
      cells.push(h('button', { class: cls, type: 'button', 'aria-label': fmtLong(d) + (evs.length ? `, ${evs.length} événement(s)` : ''), 'aria-pressed': d === selected,
        onclick: () => { selected = d; if (!inMonth) { cursor = { y: toDate(d).getFullYear(), m: toDate(d).getMonth() }; load(); } else draw(); } },
      h('span', { class: 'num' }, toDate(d).getDate()),
      h('span', { class: 'evs' }, evs.slice(0, 2).map((e) => h('span', { class: 'ev', style: { '--c': (circleById(e.circle_id) || {}).color || '#2A3EB1' } }, timeOf(e.starts_at) && !e.all_day ? timeOf(e.starts_at) + ' ' : '', e.title)),
        evs.length > 2 ? h('span', { class: 'more' }, `+${evs.length - 2}`) : null),
      h('span', { class: 'dots' }, evs.slice(0, 4).map((e) => h('span', { class: 'dot', style: { background: (circleById(e.circle_id) || {}).color || '#2A3EB1' } }))),
      nights.length ? h('span', { class: 'stripes' }, nights.sort((a, b) => a.child_id - b.child_id).map((n) => h('span', { style: { background: (userById(n.parent_id) || {}).color || '#999' } }))) : null));
    }
    mount(gridWrap, h('div', { class: 'cal-grid', role: 'grid' },
      h('span', { class: 'cal-week cal-week-head', 'aria-hidden': 'true' }, 'Sem.'), ['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'].map((n) => h('div', { class: 'cal-dow' }, n)), cells));

    drawPanel(byDay[selected] || [], nightsByDay[selected] || []);
  }

  function drawPanel(evs, nights) {
    mount(panel, 
      h('div', { class: 'row between center' }, h('h3', null, fmtLong(selected)),
        h('button', { class: 'btn small', onclick: () => eventForm(null, { date: selected }, load) }, icon('plus', 14), 'Ajouter')),
      nights.length ? h('ul', { class: 'night-list' }, nights.map((n) => {
        const kid = childById(n.child_id); const p = userById(n.parent_id);
        return kid && p ? h('li', null, h('span', { class: 'tile mini', style: { background: p.color, color: readable(p.color) } }, kid.name.charAt(0)), `Nuit du ${fmtDay(selected)} : ${kid.name} chez `, h('strong', null, p.name)) : null;
      })) : null,
      evs.length ? h('ul', { class: 'ev-list' }, evs.map((e) => h('li', null, h('button', { class: 'ev-row', onclick: () => openEvent(e, load), style: { '--c': (circleById(e.circle_id) || {}).color || '#2A3EB1' } },
        h('span', { class: 'ev-time' }, e.all_day || !timeOf(e.starts_at) ? 'Journée' : timeOf(e.starts_at)),
        h('span', { class: 'ev-title' }, e.title, e.category ? h('small', { class: 'ev-cat' }, e.category) : null, e.location ? h('small', null, e.location) : null),
        e.owner_id ? avatar(e.owner_id, 24) : null))))
        : emptyState('Rien de prévu ce jour-là.'));
  }

  await load();
}
