// Noyau : helpers DOM sûrs (aucun innerHTML), appels API, modales, formulaires, dates.

export const state = { me: null, users: [], circles: [], children: [], settings: {}, unread: 0, circleFilter: 'all' };

// Applique la réponse de GET /me (forme {user, users, circles, children, unread, settings}) à l'état global.
export function applyMe(s) {
  state.me = { user: s.user };
  state.users = s.users; state.circles = s.circles; state.children = s.children;
  state.unread = s.unread; state.settings = s.settings;
}

/* ───── DOM ───── */
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  let deferredValue;
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') deferredValue = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  const add = (k) => {
    if (k === null || k === undefined || k === false) return;
    if (Array.isArray(k)) k.forEach(add);
    else el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  };
  kids.forEach(add);
  if (deferredValue !== undefined) el.value = deferredValue;
  return el;
}

// Remplace le contenu d'un élément / y ajoute des enfants, en filtrant null/undefined/false
// et en aplatissant les tableaux — contrairement à Element.replaceChildren/append natifs, qui
// transforment ces valeurs en le texte littéral "null".
function flattenKids(kids, out = []) {
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue;
    if (Array.isArray(k)) flattenKids(k, out);
    else out.push(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return out;
}
export function mount(el, ...kids) { el.replaceChildren(...flattenKids(kids)); return el; }
export function append(el, ...kids) { el.append(...flattenKids(kids)); return el; }

const ICONS = {
  home: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
  cart: '<path d="M3 4h2l2.4 11h10.2L20 8H6.2"/><circle cx="9" cy="19.5" r="1.3"/><circle cx="17" cy="19.5" r="1.3"/>',
  euro: '<path d="M17 7a6 6 0 1 0 0 10M5 10h8M5 14h8"/>',
  doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
  book: '<path d="M5 4h12a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z"/><circle cx="12" cy="10" r="2.5"/><path d="M8.5 16c.6-1.6 2-2.4 3.5-2.4s2.9.8 3.5 2.4"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M4 18l5-5 4 4 3-3 4 4"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
  swap: '<path d="M4 8h14M14 4l4 4-4 4M20 16H6M10 12l-4 4 4 4"/>',
  sos: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5"/><path d="M5.6 5.6l3.9 3.9M14.5 14.5l3.9 3.9M18.4 5.6l-3.9 3.9M9.5 14.5l-3.9 3.9"/>',
  left: '<path d="M14 6l-6 6 6 6"/>',
  right: '<path d="M10 6l6 6-6 6"/>',
  gear: '<line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2.1"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2.1"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="7.5" cy="18" r="2.1"/>',
  family: '<circle cx="8.5" cy="7.5" r="3"/><circle cx="17" cy="8.5" r="2.4"/><path d="M2.5 20c0-3.6 2.8-6 6-6s6 2.4 6 6"/><path d="M14.2 14.3c2.6.2 4.8 2.3 4.8 5.7"/>',
  logout: '<path d="M9 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20H9"/><path d="M14 16l4.5-4-4.5-4"/><path d="M18.3 12H9"/>',
  school: '<path d="M12 3l9 4.5-9 4.5-9-4.5z"/><path d="M6.5 9.7v4.3c0 1.4 2.5 2.6 5.5 2.6s5.5-1.2 5.5-2.6V9.7"/><path d="M21 7.5v6"/>',
  recipe: '<path d="M4 11h16"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M9 11V7.5a3 3 0 0 1 6 0V11"/><path d="M12 3v1.5"/>',
  meal: '<rect x="3" y="10" width="18" height="9" rx="1.5"/><path d="M3 10a9 9 0 0 1 18 0"/><path d="M12 5V3"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="M15 9l-2 6-6 2 2-6z"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  share: '<path d="M12 15V3"/><path d="M8 7l4-4 4 4"/><path d="M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.2 9.3a2.8 2.8 0 0 1 5.4 1c0 1.8-2.6 1.9-2.6 3.7"/><circle cx="12" cy="17" r=".6" fill="currentColor" stroke="none"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-5-5"/>',
  sun: '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>',
  phone: '<path d="M6 3h3l2 5-2.5 1.5a11 11 0 0 0 6 6L16 13l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 4 5a2 2 0 0 1 2-2z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  star: '<path d="M12 3.5l2.6 5.5 6 .8-4.3 4.2 1 6-5.3-2.9-5.3 2.9 1-6-4.3-4.2 6-.8z"/>',
};
export function icon(name, size = 20) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name] || ''; // contenu statique défini ci-dessus, jamais de données utilisateur
  return s;
}

/* ───── API ───── */
export async function api(method, url, body) {
  const opts = { method, headers: { 'X-Requested-With': 'mosaique' }, credentials: 'same-origin' };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch('/api' + url, opts); } catch { throw new Error('Serveur injoignable. Vérifiez votre connexion.'); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.me) { window.dispatchEvent(new Event('mq:expired')); throw new Error('Session expirée, reconnectez-vous.'); }
  if (!res.ok) throw new Error(data.error || 'Une erreur est survenue.');
  return data;
}
export const get = (u) => api('GET', u);
export const post = (u, b) => api('POST', u, b ?? {});
export const put = (u, b) => api('PUT', u, b ?? {});
export const del = (u) => api('DELETE', u);

/* ───── Rafraîchissement temps réel ───── */
let listeners = [];
export const onRefresh = (kinds, fn) => listeners.push({ kinds, fn });
export const clearRefresh = () => { listeners = []; };
let timers = {};
export function dispatchRefresh(what) {
  for (const l of listeners) {
    if (!l.kinds.includes(what)) continue;
    clearTimeout(timers[l.fn.name + what]);
    timers[l.fn.name + what] = setTimeout(l.fn, 150);
  }
}
let chatHandler = null;
export const onChat = (fn) => { chatHandler = fn; };
export const emitChat = (m) => chatHandler && chatHandler(m);

/* ───── Retours utilisateur ───── */
export function toast(msg, isError = false) {
  const t = h('div', { class: 'toast' + (isError ? ' err' : ''), role: isError ? 'alert' : 'status' }, msg);
  document.body.append(t);
  // Un message d'erreur reste affiché jusqu'à ce qu'on clique dessus (le temps de le lire, de le
  // sélectionner et de le copier si besoin) plutôt que de disparaître tout seul après 5 secondes.
  if (isError) t.addEventListener('click', () => t.remove());
  else setTimeout(() => t.remove(), 2600);
}
export async function act(fn) {
  try { return await fn(); } catch (e) { toast(e.message, true); }
}

/* ───── Modales et formulaires ───── */
export function modal(title, content, { wide = false, sheet = false, xl = false } = {}) {
  const dlg = h('dialog', { class: 'modal' + (wide ? ' wide' : '') + (xl ? ' xl' : '') + (sheet ? ' sheet' : '') },
    h('form', { method: 'dialog', class: 'modal-head' }, h('h2', null, title),
      h('button', { class: 'icon-btn', 'aria-label': 'Fermer' }, icon('x'))),
    h('div', { class: 'modal-body' }, content));
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.showModal();
  const close = () => dlg.close();
  close.dlg = dlg;
  return close;
}

export function confirmBox(message, okLabel = 'Supprimer') {
  return new Promise((resolve) => {
    let done = false;
    const close = modal('Confirmation', h('div', { class: 'stack' },
      h('p', null, message),
      h('div', { class: 'row end gap' },
        h('button', { class: 'btn', type: 'button', onclick: () => { done = true; resolve(false); close(); } }, 'Annuler'),
        h('button', { class: 'btn danger', type: 'button', onclick: () => { done = true; resolve(true); close(); } }, okLabel))));
    close.dlg.addEventListener('close', () => { if (!done) resolve(false); });
  });
}

export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'hint' }, hint) : null);
}

// Fabrique un formulaire à partir d'une description ; onSubmit reçoit les valeurs et peut lever une erreur.
export function formModal(title, specs, { submit = 'Enregistrer', onSubmit, extra, wide } = {}) {
  const getters = {};
  const err = h('p', { class: 'form-error', role: 'alert' });
  const nodes = specs.map((s) => {
    if (s.node) { getters[s.name] = s.get; return s.node; }
    let input;
    const common = { name: s.name, required: s.required, placeholder: s.placeholder, maxlength: s.maxlength, min: s.min, max: s.max, step: s.step, list: s.list };
    switch (s.type) {
      case 'textarea': input = h('textarea', { ...common, rows: 3, value: s.value ?? '' }); getters[s.name] = () => input.value; break;
      case 'select':
        input = h('select', { ...common, value: s.value ?? '', ...(s.onchange ? { onchange: (ev) => s.onchange(ev.target.value) } : {}) }, s.options.map((o) => h('option', { value: o.value }, o.label)));
        getters[s.name] = () => input.value; break;
      case 'color': {
        let picked = s.value;
        const swatches = s.options.map((o) => h('button', {
          type: 'button', class: 'swatch-btn' + (o.value === picked ? ' sel' : ''), style: { background: o.value },
          'aria-label': o.label || o.value, 'aria-pressed': o.value === picked,
          onclick: () => { picked = o.value; swatches.forEach((btn, i) => { const on = s.options[i].value === picked; btn.classList.toggle('sel', on); btn.setAttribute('aria-pressed', on); }); },
        }));
        input = h('div', { class: 'swatch-row', role: 'radiogroup', 'aria-label': s.label }, swatches);
        getters[s.name] = () => picked; break;
      }
      case 'checkbox':
        input = h('input', { type: 'checkbox', name: s.name, checked: !!s.value });
        getters[s.name] = () => input.checked;
        return h('div', { class: 'field' }, h('label', { class: 'check-field' }, input, h('span', null, s.label)), s.hint ? h('span', { class: 'hint' }, s.hint) : null);
      case 'checkboxes': {
        const boxes = s.options.map((o) => ({ o, el: h('input', { type: 'checkbox', checked: (s.value || []).includes(o.value) }) }));
        input = h('div', { class: 'checks' }, boxes.map((b) => h('label', { class: 'check-chip' }, b.el, h('span', null, b.o.label))));
        getters[s.name] = () => boxes.filter((b) => b.el.checked).map((b) => b.o.value);
        break;
      }
      case 'file': input = h('input', { ...common, type: 'file', accept: s.accept }); getters[s.name] = () => input.files[0] || null; break;
      case 'time': {
        input = h('input', { ...common, type: 'text', inputmode: 'numeric', placeholder: 'hh:mm', value: s.value || '' });
        input.addEventListener('input', () => { input.value = maskFrTime(input.value); });
        getters[s.name] = () => { const d = input.value.replace(/\D/g, ''); if (!d.length) return ''; return d.length < 4 ? 'invalide' : `${d.slice(0, 2)}:${d.slice(2, 4)}`; };
        break;
      }
      case 'date': case 'datetime-local': {
        const withTime = s.type === 'datetime-local';
        input = h('input', { ...common, type: 'text', inputmode: 'numeric', placeholder: withTime ? 'jj/mm/aaaa hh:mm' : 'jj/mm/aaaa', value: isoToFr(s.value, withTime) });
        input.addEventListener('input', () => { input.value = maskFrDate(input.value, withTime); });
        getters[s.name] = () => frToIso(input.value, withTime);
        break;
      }
      default: input = h('input', { ...common, type: s.type || 'text', value: s.value ?? '', autocomplete: s.autocomplete || 'off' }); getters[s.name] = () => input.value;
    }
    return field(s.label, input, s.hint);
  });
  let close;
  const form = h('form', { class: 'stack', novalidate: false, onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = '';
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    try {
      const values = Object.fromEntries(Object.entries(getters).map(([k, g]) => [k, g()]));
      await onSubmit(values, () => close());
    } catch (ex) { err.textContent = ex.message; } finally { btn.disabled = false; }
  } }, nodes, err,
  h('div', { class: 'row end gap' }, extra || null, h('button', { class: 'btn primary', type: 'submit' }, submit)));
  close = modal(title, form, { wide });
  return close;
}

export const opt = (value, label) => ({ value, label });

/* ───── Dates (locales, sans fuseau) ───── */
// Notifications push (Web Push) : demande la permission au navigateur, s'abonne auprès de lui avec
// la clé publique du serveur, puis enregistre l'abonnement côté serveur (server/push.js).
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}
export async function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
}
export async function pushSubscriptionStatus() {
  if (!(await pushSupported())) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub ? 'subscribed' : 'unsubscribed';
}
export async function enablePush() {
  if (!(await pushSupported())) throw new Error("Les notifications push ne sont pas prises en charge par ce navigateur.");
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error("Autorisation refusée par le navigateur.");
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(state.settings.vapid_public_key) });
  const j = sub.toJSON();
  await post('/push/subscribe', { endpoint: j.endpoint, keys: j.keys });
}
export async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) { await post('/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
}

// Champ d'adresse avec autocomplétion OpenStreetMap, réutilisable partout où une adresse est
// saisie (événements, contacts...). `opts.onEmpty`, s'il est fourni, remplace le comportement par
// défaut (liste vide) quand le champ est vidé — utile pour y afficher autre chose à la place
// (ex. : les adresses déjà connues du carnet de contacts, dans l'agenda).
export function addressField(initialValue, initialLat, initialLon, opts = {}) {
  let value = initialValue || '';
  let lat = initialLat ?? null;
  let lon = initialLon ?? null;
  let debounceTimer;
  const input = h('input', {
    value: initialValue || '', placeholder: opts.placeholder || 'Adresse…', autocomplete: 'off',
    oninput: () => { lat = null; lon = null; }, // retapé à la main : les coordonnées d'une éventuelle suggestion précédente ne sont plus valables
  });
  const list = h('div', { class: 'addr-suggestions' });
  function pick(label, plat, plon) { input.value = label; value = label; lat = plat; lon = plon; mount(list); }
  input.addEventListener('input', () => {
    value = input.value;
    clearTimeout(debounceTimer);
    const q = input.value.trim();
    if (!q) { if (opts.onEmpty) opts.onEmpty(); else mount(list); return; }
    if (q.length < 3) { mount(list); return; }
    mount(list, h('p', { class: 'muted addr-status' }, 'Recherche…'));
    debounceTimer = setTimeout(async () => {
      let results;
      try { results = await get(`/geocode?q=${encodeURIComponent(q)}`); }
      catch { if (input.value.trim() === q) mount(list, h('p', { class: 'muted addr-status' }, "Recherche indisponible pour le moment — vous pouvez laisser votre propre texte.")); return; }
      if (input.value.trim() !== q) return; // la personne a continué à taper entre-temps
      if (!results.length) { mount(list, h('p', { class: 'muted addr-status' }, "Aucune adresse trouvée — vous pouvez laisser votre propre texte.")); return; }
      mount(list, results.map((r) => h('button', { type: 'button', class: 'addr-suggestion', onclick: () => pick(r.label, Number(r.lat), Number(r.lon)) }, r.label)));
      list.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); // reste visible même si le clavier virtuel occupe une partie de l'écran
    }, 450);
  });
  return { input, list, pick, get: () => value, getLat: () => lat, getLon: () => lon };
}

// Filtre de période partagé (Budget, Documents...) : un mois précis, une année, ou toute la période.
// `match(date)` teste une date « AAAA-MM-JJ… » ; `query()` donne les paramètres à envoyer au serveur
// quand c'est lui qui agrège ; `setYears` propose les années réellement présentes dans les données.
export function periodFilter(onChange, { mode = 'month' } = {}) {
  const nowY = String(new Date().getFullYear());
  const nowM = ymd(new Date()).slice(0, 7);
  const st = { mode, month: nowM, year: nowY };
  let years = [];
  const node = h('div', { class: 'period-filter' });
  const draw = () => {
    const ys = [...new Set([...years, st.year, nowY])].sort().reverse();
    mount(node,
      h('select', { 'aria-label': 'Période', onchange: (e) => { st.mode = e.target.value; draw(); onChange(); } },
        h('option', { value: 'month', selected: st.mode === 'month' }, 'Par mois'),
        h('option', { value: 'year', selected: st.mode === 'year' }, 'Par année'),
        h('option', { value: 'all', selected: st.mode === 'all' }, 'Toute la période')),
      st.mode === 'month' ? h('input', { type: 'month', value: st.month, 'aria-label': 'Mois', onchange: (e) => { if (e.target.value) { st.month = e.target.value; onChange(); } } }) : null,
      st.mode === 'year' ? h('select', { 'aria-label': 'Année', onchange: (e) => { st.year = e.target.value; onChange(); } }, ys.map((y) => h('option', { value: y, selected: y === st.year }, y))) : null);
  };
  draw();
  return {
    node,
    setYears(list) {
      const next = [...new Set(list)].sort();
      if (next.join() === years.join()) return; // rien de neuf : on évite de redessiner (et de faire perdre le focus)
      years = next; draw();
    },
    reset() { st.mode = mode; st.month = nowM; st.year = nowY; draw(); },
    isDefault: () => st.mode === mode && st.month === nowM && st.year === nowY,
    match: (date) => st.mode === 'all' || (st.mode === 'month' ? String(date).slice(0, 7) === st.month : String(date).slice(0, 4) === st.year),
    query: () => (st.mode === 'all' ? 'all=1' : st.mode === 'month' ? `month=${st.month}` : `year=${st.year}`),
    label: () => (st.mode === 'all' ? 'toute la période' : st.mode === 'month' ? fmtMonth(Number(st.month.slice(0, 4)), Number(st.month.slice(5)) - 1).toLowerCase() : st.year),
  };
}

export function isoWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dayNum = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  return 1 + Math.round((dt - firstThursday) / (7 * 86400000));
}
export const pad2 = (n) => String(n).padStart(2, '0');

// Saisie de date au format français (jj/mm/aaaa), indépendante de la langue du navigateur —
// contrairement aux <input type="date"> natifs, dont l'affichage suit la locale du navigateur/système.
const onlyDigits = (s) => s.replace(/\D/g, '');
export function maskFrDate(raw, withTime) {
  const d = onlyDigits(raw).slice(0, withTime ? 12 : 8);
  let out = d.slice(0, 2);
  if (d.length > 2) out += '/' + d.slice(2, 4);
  if (d.length > 4) out += '/' + d.slice(4, 8);
  if (withTime && d.length > 8) out += ' ' + d.slice(8, 10);
  if (withTime && d.length > 10) out += ':' + d.slice(10, 12);
  return out;
}
export function maskFrTime(raw) {
  const d = onlyDigits(raw).slice(0, 4);
  let out = d.slice(0, 2);
  if (d.length > 2) out += ':' + d.slice(2, 4);
  return out;
}
export function isoToFr(iso, withTime) {
  if (!iso) return '';
  const datePart = String(iso).slice(0, 10);
  const [yyyy, mm, dd] = datePart.split('-');
  if (!yyyy || !mm || !dd) return '';
  let out = `${dd}/${mm}/${yyyy}`;
  if (withTime) out += ' ' + (iso.length > 10 ? iso.slice(11, 16) : '00:00');
  return out;
}
export function frToIso(display, withTime) {
  const d = onlyDigits(display);
  if (!d.length) return '';
  const needed = withTime ? 12 : 8;
  if (d.length < needed) return 'invalide'; // saisie incomplète : rejetée proprement par la validation du serveur
  const dd = d.slice(0, 2); const mm = d.slice(2, 4); const yyyy = d.slice(4, 8);
  const datePart = `${yyyy}-${mm}-${dd}`;
  return withTime ? `${datePart}T${d.slice(8, 10)}:${d.slice(10, 12)}` : datePart;
}
export const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export const toDate = (s) => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
export const today = () => ymd(new Date());
export const addDays = (s, n) => { const d = toDate(s); d.setDate(d.getDate() + n); return ymd(d); };
export const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 86400000);
const F = {
  short: new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }),
  long: new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }),
  day: new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }),
  dayY: new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }),
  month: new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' }),
};
export const fmtShort = (s) => F.short.format(toDate(s));
export const fmtLong = (s) => F.long.format(toDate(s));
export const fmtDay = (s) => F.day.format(toDate(s));
export const fmtDayY = (s) => F.dayY.format(toDate(s));
export const fmtMonth = (y, m) => F.month.format(new Date(y, m, 1));
export const timeOf = (s) => (s && s.length > 10 ? s.slice(11, 16) : '');
export const fmtWhen = (e) => {
  const d = e.starts_at.slice(0, 10);
  const t1 = timeOf(e.starts_at); const t2 = timeOf(e.ends_at);
  return `${fmtShort(d)}${e.all_day || !t1 ? '' : ` · ${t1}${t2 ? '–' + t2 : ''}`}`;
};
export const sqlToDate = (s) => new Date(s.replace(' ', 'T') + 'Z');
export const ago = (s) => {
  const mins = Math.round((Date.now() - sqlToDate(s)) / 60000);
  if (mins < 1) return "à l'instant";
  if (mins < 60) return `il y a ${mins} min`;
  if (mins < 1440) return `il y a ${Math.round(mins / 60)} h`;
  return F.dayY.format(sqlToDate(s));
};
export const euro = (cents) => (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
export const fileSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' Mo' : Math.max(1, Math.round(n / 1024)) + ' Ko');

/* ───── Personnes, enfants, cercles ───── */
export const userById = (id) => state.users.find((u) => u.id === id);
export const childById = (id) => state.children.find((c) => c.id === id);
export const circleById = (id) => state.circles.find((c) => c.id === id);
export const myCircles = () => state.circles.filter((c) => c.mine !== false);
// Base à utiliser pour tout lien destiné à être partagé (invitation, agenda, présence, intégration École) :
// l'adresse publique configurée par l'administrateur (PUBLIC_URL) si elle existe, sinon l'adresse actuelle
// du navigateur — qui peut être une adresse locale inutilisable depuis l'extérieur.
export const publicOrigin = () => state.settings.public_url || location.origin;
// Enfants que la personne connectée peut modifier (et pas seulement consulter). Un enfant sans
// parent désigné est modifiable par tout le monde (comportement par défaut) ; sinon, seuls les
// parents désignés (et les administrateurs) le sont — un·e lecteur·rice ne l'est pas.
export const myEditableChildren = () => state.children.filter((c) => state.me.user.is_admin || !c.parent_ids.length || c.parent_ids.includes(state.me.user.id));
// Membres à qui la garde des enfants donnés peut être attribuée : les parents désignés en commun
// à tous ces enfants, ou tout le monde si aucun n'a de parent désigné (comportement par défaut).
export function possibleCustodyParents(childIds) {
  const kids = childIds.map(childById).filter(Boolean);
  const restricted = kids.filter((k) => k.parent_ids.length);
  if (!restricted.length) return state.users;
  return state.users.filter((u) => restricted.every((k) => k.parent_ids.includes(u.id)));
}
export const userName = (id) => (userById(id) ? userById(id).name : 'Ancien membre');

export function readable(bg) {
  const n = parseInt(bg.slice(1), 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.62 ? '#1C2333' : '#FFFFFF';
}
export function avatar(user, size = 28) {
  const u = typeof user === 'number' ? userById(user) : user;
  const color = u ? u.color : '#9AA1B2';
  return h('span', { class: 'avatar', title: u ? u.name : '', style: { width: size + 'px', height: size + 'px', background: color, color: readable(color), fontSize: Math.round(size * 0.45) + 'px' } },
    u ? u.name.trim().charAt(0).toUpperCase() : '?');
}
export function childDot(child) {
  const c = typeof child === 'number' ? childById(child) : child;
  return h('span', { class: 'dot', style: { background: c ? c.color : '#999' }, title: c ? c.name : '' });
}

export const TILE_COLORS = ['#E4572E', '#17A2A2', '#F2B21A', '#7A5CC7', '#4FA35B', '#D6457F', '#3D7BE0', '#2A3EB1'];
// Doit rester identique à GROCERY_CATEGORIES côté serveur (server/index.js), pour que les
// ingrédients générés par le planificateur de repas se regroupent avec les articles ajoutés à la main.
export const GROCERY_CATEGORIES = ['Fruits & légumes', 'Viande & poisson', 'Crémerie & œufs', 'Épicerie', 'Boulangerie', 'Surgelés', 'Boissons', 'Hygiène & entretien', 'Autre'];

export function circleChips(onChange, { all = true } = {}) {
  const cs = myCircles();
  if (cs.length < 2) { if (state.circleFilter === 'all') state.circleFilter = cs[0] ? cs[0].id : 'all'; return null; }
  if (!all && state.circleFilter === 'all') state.circleFilter = cs[0].id;
  const wrap = h('div', { class: 'chips', role: 'group', 'aria-label': 'Filtrer par cercle' });
  const draw = () => {
    wrap.replaceChildren(...[...(all ? [{ id: 'all', name: 'Tous', color: null }] : []), ...cs].map((c) =>
      h('button', { class: 'chip' + (state.circleFilter === c.id ? ' on' : ''), type: 'button', 'aria-pressed': state.circleFilter === c.id,
        onclick: () => { state.circleFilter = c.id; draw(); onChange(); } },
      c.color ? h('span', { class: 'dot', style: { background: c.color } }) : null, c.name)));
  };
  draw();
  return wrap;
}
// Membres d'un cercle (à défaut, tout le monde), pour proposer les bonnes personnes dans un formulaire.
export const membersOfCircle = (cid) => {
  const m = (myCircles().find((c) => c.id === cid) || {}).member_ids || state.users.map((u) => u.id);
  return m.length ? m : state.users.map((u) => u.id);
};
export const activeCircleId = () => (state.circleFilter !== 'all' && circleById(state.circleFilter) ? state.circleFilter : (myCircles()[0] || {}).id);
export const inFilter = (row) => state.circleFilter === 'all' || row.circle_id === state.circleFilter;
// Variante pour les ressources qui peuvent appartenir à plusieurs cercles à la fois (ex. contacts).
export const inFilterIds = (row) => state.circleFilter === 'all' || (row.circle_ids || []).includes(state.circleFilter);
export const circleSelectOptions = () => myCircles().map((c) => opt(c.id, c.name));

export function emptyState(text, action) {
  return h('div', { class: 'empty' }, h('p', null, text), action || null);
}
export function pageHead(title, ...actions) {
  return h('header', { class: 'page-head' }, h('h1', null, title), h('div', { class: 'row gap' }, actions));
}
