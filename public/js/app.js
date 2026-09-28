import { h, $, $$, state, get, post, icon, toast, dispatchRefresh, emitChat, clearRefresh, ago, act, applyMe, mount, append, modal } from './core.js';
import { setupScreen, loginScreen, joinScreen } from './auth.js';
import { agenda } from './agenda.js';
import { garde } from './garde.js';
import { taches, courses } from './taches.js';
import { budget } from './budget.js';
import { documents, contacts } from './documents.js';
import { fil, chat } from './social.js';
import { famille } from './famille.js';
import { reglages } from './reglages.js';
import { ecole } from './ecole.js';
import { recettes, planificateur } from './recettes.js';
import { aide } from './aide.js';
import { startInstallPrompts } from './install.js';

const app = $('#app');

const ROUTES = [
  { path: 'accueil', label: 'Accueil', icon: 'home', view: accueil, hideFromNav: true },
  { path: 'agenda', label: 'Agenda', icon: 'calendar', view: agenda },
  { path: 'garde', label: 'Garde', icon: 'moon', view: garde },
  { path: 'ecole', label: 'École', icon: 'school', view: ecole },
  { path: 'taches', label: 'Tâches', icon: 'check', view: taches },
  { path: 'courses', label: 'Courses', icon: 'cart', view: courses },
  { path: 'recettes', label: 'Recettes', icon: 'recipe', view: recettes },
  { path: 'repas', label: 'Repas', icon: 'meal', view: planificateur },
  { path: 'budget', label: 'Budget', icon: 'euro', view: budget },
  { path: 'documents', label: 'Documents', icon: 'doc', view: documents },
  { path: 'contacts', label: 'Contacts', icon: 'book', view: contacts },
  { path: 'fil', label: 'Fil familial', icon: 'image', view: fil },
  { path: 'messages', label: 'Messages', icon: 'chat', view: chat },
  { path: 'famille', label: 'Famille', icon: 'family', view: famille },
  { path: 'aide', label: 'Aide', icon: 'help', view: aide },
  { path: 'reglages', label: 'Réglages', icon: 'gear', view: reglages, hideFromNav: true },
];
const NAV_MAIN = ['accueil', 'agenda', 'garde', 'taches', 'budget'];

let stream = null;

async function accueil(root) {
  const { pageHead, emptyState, fmtWhen, fmtDayY, avatar, userById, childById, activeCircleId, today } = await import('./core.js');
  append(root, pageHead(`Bonjour ${state.me.user.name.split(' ')[0]}`));
  const [events, tasks, sos] = await Promise.all([
    get(`/events/range?from=${today()}&to=${(() => { const d = new Date(); d.setDate(d.getDate() + 14); return d.toISOString().slice(0, 10); })()}`),
    get('/tasks'), get('/sos'),
  ]);
  const openSos = sos.filter((s) => s.status === 'open');
  if (openSos.length) append(root, h('section', { class: 'card alert' }, h('h2', null, 'SOS remplacement'),
    h('ul', { class: 'stack' }, openSos.map((s) => h('li', { class: 'row between center' },
      h('span', null, h('strong', null, s.title), s.note ? h('div', { class: 'muted' }, s.note) : null),
      h('button', { class: 'btn primary small', onclick: () => act(async () => { await post(`/sos/${s.id}/take`); toast('Vous avez pris le relais'); location.reload(); }) }, 'Je prends')))))); 
  const upcoming = events.slice(0, 6);
  append(root, h('section', { class: 'card' }, h('h2', null, 'Prochains événements'),
    upcoming.length ? h('ul', { class: 'stack' }, upcoming.map((e) => h('li', { class: 'row between center' }, h('span', null, e.title), h('span', { class: 'muted' }, fmtWhen(e))))) : emptyState('Rien de prévu dans les 14 prochains jours.'),
    h('a', { class: 'btn small', href: '#/agenda' }, "Voir l'agenda")));
  const mine = tasks.filter((t) => !t.done && (t.assignee_id === state.me.user.id || !t.assignee_id)).slice(0, 5);
  append(root, h('section', { class: 'card' }, h('h2', null, 'Tâches à faire'),
    mine.length ? h('ul', { class: 'stack' }, mine.map((t) => h('li', { class: 'row between center' }, h('span', null, t.title), t.due ? h('span', { class: 'muted' }, fmtDayY(t.due)) : null))) : emptyState('Aucune tâche en attente.'),
    h('a', { class: 'btn small', href: '#/taches' }, 'Voir les tâches')));
  if (state.settings.pronote_enabled) {
    const homework = (await get('/homework')).filter((h) => !h.done).slice(0, 5);
    const rows = homework.map((hw) => h('li', { class: 'row between center' },
      h('span', null, childById(hw.child_id) ? `[${childById(hw.child_id).name}] ` : '', hw.title),
      hw.due_date ? h('span', { class: 'muted' }, fmtDayY(hw.due_date)) : null));
    append(root, h('section', { class: 'card' }, h('h2', null, 'Devoirs'),
      rows.length ? h('ul', { class: 'stack' }, rows) : emptyState('Aucun devoir en attente.'),
      h('a', { class: 'btn small', href: '#/ecole' }, "Voir l'école")));
  }
}

function navItem(r, activePath) {
  return h('a', { href: `#/${r.path}`, class: 'nav-item' + (activePath === r.path ? ' on' : ''), 'aria-current': activePath === r.path ? 'page' : null },
    icon(r.icon, 22), h('span', null, r.label));
}

function openMoreSheet() {
  const items = navRoutes().filter((r) => !NAV_MAIN.includes(r.path));
  let close;
  const body = h('div', { class: 'more-grid' }, items.map((r) => h('a', {
    href: `#/${r.path}`, class: 'more-item', onclick: () => close(),
  }, icon(r.icon, 24), h('span', null, r.label))));
  close = modal('Plus', body, { sheet: true });
}

function navRoutes() {
  return ROUTES.filter((r) => !r.hideFromNav
    && (r.path !== 'fil' || state.settings.fil_familial)
    && (r.path !== 'messages' || state.settings.messages_enabled)
    && (r.path !== 'courses' || state.settings.courses_enabled)
    && (r.path !== 'ecole' || state.settings.pronote_enabled)
    && (r.path !== 'recettes' || state.settings.recipes_enabled)
    && (r.path !== 'repas' || state.settings.recipes_enabled));
}

function renderShell() {
  const path = currentPath();
  const header = h('header', { class: 'topbar' },
    h('div', { class: 'brand' }, h('img', { class: 'auth-mark small', src: '/icons/logo.svg', alt: 'Mosaïque' }), h('strong', null, state.settings.family_name)),
    h('nav', { class: 'nav-desktop' }, navRoutes().map((r) => navItem(r, path))),
    h('div', { class: 'row gap center' },
      notifBell(),
      h('button', { class: 'icon-btn', 'aria-label': 'Changer de thème', onclick: () => { toggleTheme(); router(); } }, icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon', 20)),
      h('a', { href: '#/reglages', class: 'icon-btn', 'aria-label': 'Réglages' }, icon('gear', 20)),
      h('button', { class: 'icon-btn', 'aria-label': 'Se déconnecter', onclick: logout }, icon('logout', 20))));
  const main = h('main', { id: 'view' });
  const tabbar = h('nav', { class: 'nav-mobile' }, [...ROUTES.filter((r) => NAV_MAIN.includes(r.path)), { path: 'more', label: 'Plus', icon: 'more' }].map((r) => (
    r.path === 'more' ? h('button', { type: 'button', class: 'nav-item' + (!NAV_MAIN.includes(path) ? ' on' : ''), onclick: openMoreSheet }, icon('more', 22), h('span', null, 'Plus')) : navItem(r, path)
  )));
  mount(app, header, main, tabbar);
  return main;
}

function notifBell() {
  const btn = h('button', { class: 'icon-btn notif-btn', 'aria-label': 'Notifications' }, icon('bell', 20), state.unread ? h('span', { class: 'badge' }, state.unread > 9 ? '9+' : state.unread) : null);
  btn.onclick = async () => {
    const list = await get('/notifications');
    const { modal, emptyState } = await import('./core.js');
    modal('Notifications', list.length ? h('ul', { class: 'notif-list' }, list.map((n) => h('li', { class: n.read ? '' : 'unread' },
      h('a', { href: n.link || '#/accueil' }, h('strong', null, n.title), n.body ? h('div', { class: 'muted' }, n.body) : null, h('small', { class: 'muted' }, ago(n.created_at))))))
      : emptyState('Aucune notification.'));
    if (state.unread) { await post('/notifications/read'); state.unread = 0; refreshBell(); }
  };
  return btn;
}
function refreshBell() { const b = $('.notif-btn'); if (!b) return; const s = $('.badge', b); if (s) s.remove(); }

function currentPath() {
  const h1 = location.hash.replace(/^#\/?/, '');
  return h1.split('/')[0] || 'accueil';
}

function initTheme() {
  try {
    const saved = localStorage.getItem('mq-theme');
    if (saved === 'dark' || saved === 'light') document.documentElement.dataset.theme = saved;
  } catch { /* stockage indisponible : on garde la préférence du système */ }
}
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('mq-theme', next); } catch { /* tant pis, le choix ne sera pas mémorisé */ }
}

async function router() {
  clearRefresh();
  $$('dialog[open]').forEach((d) => d.close()); // sécurité : ferme toute modale restée ouverte lors d'un changement de page
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, arg] = raw.split('/');
  if (path === 'rejoindre' && arg) { await joinScreen(app, arg, () => { location.hash = '#/accueil'; boot(); }); return; }
  const route = ROUTES.find((r) => r.path === path) || ROUTES[0];
  const disabled = (route.path === 'fil' && !state.settings.fil_familial)
    || (route.path === 'messages' && !state.settings.messages_enabled)
    || (route.path === 'courses' && !state.settings.courses_enabled)
    || (route.path === 'ecole' && !state.settings.pronote_enabled)
    || (route.path === 'recettes' && !state.settings.recipes_enabled)
    || (route.path === 'repas' && !state.settings.recipes_enabled);
  if (disabled) { location.hash = '#/accueil'; return; }
  const main = renderShell();
  try { await route.view(main); } catch (e) { mount(main, h('div', { class: 'card' }, h('p', null, 'Impossible de charger cette page : ', e.message))); }
}

function connectStream() {
  if (stream) stream.close();
  stream = new EventSource('/api/stream');
  stream.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    if (data.type === 'refresh') dispatchRefresh(data.what);
    else if (data.type === 'chat') emitChat(data.message);
    else if (data.type === 'notify') { state.unread++; toast(data.title); refreshBadgeSoon(); }
  };
  stream.onerror = () => { stream.close(); setTimeout(connectStream, 4000); };
}
let badgeTimer;
function refreshBadgeSoon() { clearTimeout(badgeTimer); badgeTimer = setTimeout(() => router(), 50); }

async function logout() { await post('/logout'); if (stream) stream.close(); state.me = null; boot(); }

async function loadState() { applyMe(await get('/me')); }

async function boot() {
  window.addEventListener('mq:expired', () => { if (stream) stream.close(); state.me = null; boot(); }, { once: true });
  const raw = location.hash.replace(/^#\/?/, '');
  if (raw.startsWith('rejoindre/')) { await joinScreen(app, raw.split('/')[1], () => { location.hash = '#/accueil'; boot(); }); return; }
  const st = await get('/state').catch(() => ({ setup_needed: false }));
  if (st.setup_needed) { setupScreen(app, () => boot()); return; }
  try { await loadState(); } catch { loginScreen(app, () => boot()); return; }
  connectStream();
  await router();
  startInstallPrompts(); // invitation à installer l'application / activer les notifications (mobile seulement)
}

window.addEventListener('hashchange', router);
initTheme();
boot();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
