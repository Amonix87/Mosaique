// Installation sur l'écran d'accueil et notifications push : détection, invitations, instructions.
//
// Ce que le navigateur permet — et ne permet pas :
//  • Savoir si l'application est LANCÉE depuis l'écran d'accueil (mode « standalone ») : oui, partout.
//  • Savoir, depuis un onglet du navigateur, si elle est installée ailleurs : non (aucune API sur iPhone,
//    peu fiable sur Android). C'est donc l'application installée qui le signale au serveur (par personne),
//    pour ne plus solliciter cette personne dans son navigateur.
//  • Android (Chrome, Edge, Samsung Internet) : le navigateur envoie « beforeinstallprompt », qui permet
//    d'afficher notre propre bouton « Installer ». iPhone : rien de tel, seulement des instructions.
//  • Sur iPhone/iPad, les notifications push ne fonctionnent qu'une fois l'application ajoutée à l'écran
//    d'accueil, et à partir d'iOS 16.4.
import { h, icon, state, post, act, toast, modal, mount, enablePush, pushSubscriptionStatus } from './core.js';

/* ───────────────────────── Détection (fonctions pures, testées) ───────────────────────── */
export function describeDevice({ ua = '', platform = '', maxTouchPoints = 0 } = {}) {
  const ios = /iPhone|iPod|iPad/.test(ua) || (platform === 'MacIntel' && maxTouchPoints > 1); // iPadOS se présente comme un Mac
  const android = /Android/i.test(ua);
  // La version n'est lisible que dans l'identifiant « OS 17_2 » ; un iPad en mode « site pour ordinateur » ne la donne pas.
  const m = ios ? /OS (\d+)[_.](\d+)/.exec(ua) : null;
  let browser = 'other';
  if (ios) browser = /FBAN|FBAV|Instagram|Line\/|Snapchat|Twitter|LinkedInApp|MicroMessenger/i.test(ua) ? 'in-app' : /CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(ua) ? 'ios-other' : 'safari';
  return { os: ios ? 'ios' : android ? 'android' : 'other', mobile: ios || android, iosVersion: m ? [Number(m[1]), Number(m[2])] : null, browser };
}
// Version inconnue : on suppose capable plutôt que de priver quelqu'un d'une fonction qui marcherait.
export const iosPushCapable = (dev) => !dev.iosVersion || dev.iosVersion[0] > 16 || (dev.iosVersion[0] === 16 && dev.iosVersion[1] >= 4);
export const isStandalone = (nav = navigator, win = window) => !!nav.standalone || !!(win.matchMedia && win.matchMedia('(display-mode: standalone)').matches);
const currentDevice = () => describeDevice({ ua: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints });

/* ───────────────────────── Instructions (partagées avec la page Aide) ───────────────────────── */
// « {share} » : l'icône Partager d'iOS, pour la reconnaître dans le menu.
export const STEPS = {
  ios: [
    "Ouvrez Mosaïque dans Safari — pas depuis une autre application comme Messenger ou Instagram, qui n'ont pas cette option.",
    "Touchez le bouton Partager {share} (un carré avec une flèche vers le haut) : en bas de l'écran sur iPhone, en haut sur iPad.",
    "Faites défiler le menu et touchez « Sur l'écran d'accueil » (parfois caché derrière « Plus »).",
    "Gardez le nom proposé ou changez-le, puis touchez « Ajouter » en haut à droite.",
    "Fermez Safari et ouvrez Mosaïque depuis sa nouvelle icône : c'est depuis cette icône, et seulement là, que les notifications peuvent être activées. Vous devrez peut-être vous reconnecter.",
  ],
  android: [
    "Ouvrez Mosaïque dans Chrome (ou Edge, Samsung Internet).",
    "Touchez le menu ⋮ en haut à droite (☰ dans Samsung Internet).",
    "Touchez « Installer l'application » — ou « Ajouter à l'écran d'accueil » selon la version — puis confirmez avec « Installer ».",
    "L'icône Mosaïque apparaît sur l'écran d'accueil et dans la liste de vos applications : ouvrez-la depuis là.",
  ],
};
export const PUSH_STEPS = {
  ios: [
    "Vérifiez que Mosaïque est ajoutée à l'écran d'accueil et ouvrez-la depuis son icône : dans Safari, iOS ne propose pas les notifications.",
    "Allez dans Réglages → Mon compte → « Notifications push sur cet appareil ».",
    "Touchez « Activer » : iOS demande l'autorisation, touchez « Autoriser ».",
    "Touchez « Tester » : une notification doit arriver dans les secondes qui suivent.",
  ],
  android: [
    "Allez dans Réglages → Mon compte → « Notifications push sur cet appareil ». Inutile d'installer l'application d'abord : Chrome le permet depuis le navigateur.",
    "Touchez « Activer », puis « Autoriser » quand le téléphone le demande.",
    "Touchez « Tester » : une notification doit arriver dans les secondes qui suivent.",
  ],
};
export function renderStep(text) {
  const parts = text.split('{share}');
  return parts.flatMap((p, i) => (i < parts.length - 1 ? [p, h('span', { class: 'inline-icon', role: 'img', 'aria-label': 'Partager' }, icon('share', 16))] : [p]));
}
export const plainStep = (text) => text.replace('{share}', '(Partager)');
// Sous Safari on est déjà dans le bon navigateur : la première étape ne sert qu'aux autres.
const stepsFor = (dev) => (dev.os === 'ios' ? (dev.browser === 'safari' ? STEPS.ios.slice(1) : STEPS.ios) : STEPS.android);

/* ───────────────────────── Mémoire des refus (par navigateur) ───────────────────────── */
const KEYS = { install: 'mosaique.prompt.install', push: 'mosaique.prompt.push' };
function snoozed(key) {
  try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return !!v && (!!v.never || v.until > Date.now()); } catch { return false; }
}
function snooze(key, days) { // days = 0 : « ne plus me le proposer »
  try { localStorage.setItem(key, JSON.stringify(days ? { until: Date.now() + days * 86400000 } : { never: true })); } catch { /* navigation privée : tant pis */ }
}

/* ───────────────────────── Installation Android / desktop (beforeinstallprompt) ───────────────────────── */
let deferredPrompt = null;
async function reportInstalled() {
  if (!state.me || state.me.user.app_installed) return;
  try { await post('/me/installed'); state.me.user.app_installed = true; } catch { /* réessayé au prochain lancement */ }
}
if (typeof window !== 'undefined') {
  // À écouter dès le chargement : l'événement part très tôt, avant l'affichage de la moindre page.
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; });
  window.addEventListener('appinstalled', () => { deferredPrompt = null; reportInstalled(); });
}
export const canPromptInstall = () => !!deferredPrompt;
export async function promptInstall() {
  if (!deferredPrompt) return 'unavailable';
  const ev = deferredPrompt; deferredPrompt = null; // un événement ne sert qu'une fois
  await ev.prompt();
  return (await ev.userChoice).outcome;
}

/* ───────────────────────── Fenêtres d'invitation ───────────────────────── */
function stepsList(dev, steps = stepsFor(dev)) {
  return h('ol', { class: 'install-steps' }, steps.map((s) => h('li', null, renderStep(s))));
}
export function showStepsModal(dev = currentDevice()) {
  const ios = dev.os === 'ios';
  const close = modal("Ajouter à l'écran d'accueil", h('div', { class: 'stack' },
    stepsList(dev),
    ios && !iosPushCapable(dev) ? h('p', { class: 'hint' }, "Les notifications sur iPhone et iPad demandent iOS 16.4 ou plus récent. L'application fonctionne dès maintenant, mais sans notifications tant que l'appareil n'est pas à jour.") : null,
    h('div', { class: 'row end' }, h('button', { class: 'btn primary', type: 'button', onclick: () => close() }, "J'ai compris"))), { sheet: true });
  return close;
}

// Une fenêtre qui glisse depuis le bas. Fermée sans choix : « plus tard ».
function sheet(title, key, laterDays, buildBody) {
  let answered = false;
  const body = h('div', { class: 'stack' });
  const close = modal(title, body, { sheet: true });
  const done = (days) => { answered = true; if (days !== null) snooze(key, days); close(); };
  close.dlg.addEventListener('close', () => { if (!answered) snooze(key, laterDays); });
  mount(body, buildBody({ body, done }));
  return close;
}
const laterButtons = (done, laterDays) => h('div', { class: 'sheet-later' },
  h('button', { class: 'btn', type: 'button', onclick: () => done(laterDays) }, 'Plus tard'),
  h('button', { class: 'link-btn', type: 'button', onclick: () => done(0) }, 'Ne plus me le proposer'));

function showInstallSheet(dev) {
  // Sur iPhone, promettre des notifications qui échoueraient (adresse publique absente, iOS trop ancien) serait pire que de se taire.
  const pushOk = dev.os === 'ios' ? (iosPushCapable(dev) && !!state.settings.public_url) : true;
  const why = pushOk
    ? "Vous serez averti·e des événements, rappels, échanges de garde et dépenses même quand l'application est fermée, et vous la retrouverez d'un geste sur votre écran d'accueil."
    : "Vous la retrouverez d'un geste sur votre écran d'accueil, en plein écran, comme une vraie application.";
  sheet('Installer Mosaïque', KEYS.install, 7, ({ body, done }) => [
    h('p', null, why),
    canPromptInstall()
      ? h('button', { class: 'btn primary', type: 'button', onclick: async () => {
        done(null);
        const outcome = await promptInstall();
        if (outcome === 'accepted') { toast('Mosaïque installée'); reportInstalled(); } else snooze(KEYS.install, 14);
      } }, icon('download', 16), "Installer l'application")
      : h('button', { class: 'btn primary', type: 'button', onclick: () => mount(body, [
        h('p', null, dev.os === 'ios' ? "Sur iPhone, l'installation se fait à la main :" : 'Voici comment faire :'),
        stepsList(dev),
        h('div', { class: 'row gap wrap end' },
          h('button', { class: 'btn primary', type: 'button', onclick: () => done(30) }, "J'ai compris"),
          h('button', { class: 'link-btn', type: 'button', onclick: () => done(0) }, 'Ne plus me le proposer')),
      ]) }, 'Comment faire ?'),
    laterButtons(done, 7),
  ]);
}

function showPushSheet() {
  sheet('Activer les notifications', KEYS.push, 14, ({ done }) => [
    h('p', null, "Recevez une alerte sur ce téléphone pour les nouveaux événements, les rappels, les échanges de garde et les dépenses, même quand Mosaïque est fermée."),
    h('button', { class: 'btn primary', type: 'button', onclick: () => {
      done(null);
      act(async () => { await enablePush(); toast('Notifications activées sur cet appareil'); });
    } }, icon('bell', 16), 'Activer les notifications'),
    laterButtons(done, 14),
  ]);
}

async function maybeShowPushSheet(dev) {
  if (snoozed(KEYS.push)) return;
  if (dev.os === 'ios' && !state.settings.public_url) return; // Apple exige une vraie adresse https : rien à proposer tant qu'un administrateur ne l'a pas renseignée
  let status; try { status = await pushSubscriptionStatus(); } catch { return; }
  if (status === 'unsubscribed') showPushSheet();
}

let started = false;
// Appelée une fois l'application affichée. Au plus UNE fenêtre par session : l'installation d'abord,
// sinon (déjà installée, ou refusée) l'activation des notifications. Rien du tout sur ordinateur.
export function startInstallPrompts() {
  if (started || typeof window === 'undefined') return;
  started = true;
  const dev = currentDevice();
  const standalone = isStandalone();
  if (standalone) reportInstalled();
  if (!dev.mobile) return;
  const attempt = async (n) => {
    if (!state.me) return;
    if (document.querySelector('dialog[open]')) { if (n < 3) setTimeout(() => attempt(n + 1), 6000); return; } // ne pas passer par-dessus un formulaire
    if (!standalone && !state.me.user.app_installed && !snoozed(KEYS.install)) { showInstallSheet(dev); return; }
    await maybeShowPushSheet(dev);
  };
  setTimeout(() => attempt(0), 3500); // laisser la page s'afficher avant de solliciter
}

/* ───────────────────────── Réglages → Mon compte ───────────────────────── */
export function installBlock() {
  const dev = currentDevice();
  const box = h('div', { style: { marginTop: '1rem' } }, h('strong', null, 'Application sur cet appareil'));
  if (isStandalone()) {
    box.append(h('p', { class: 'muted' }, "✓ Vous utilisez l'application installée sur cet appareil."));
    return box;
  }
  const intro = dev.mobile
    ? `Pas encore ajoutée à l'écran d'accueil de cet appareil. Installée, elle s'ouvre en plein écran comme une vraie application${dev.os === 'ios' ? ', et c\'est indispensable pour recevoir les notifications sur iPhone et iPad.' : '.'}`
    : "Vous pouvez aussi l'installer sur ordinateur : Chrome et Edge proposent une icône « Installer » dans la barre d'adresse.";
  box.append(h('p', { class: 'muted' }, intro),
    h('div', { class: 'row gap wrap' },
      canPromptInstall() ? h('button', { class: 'btn small primary', type: 'button', onclick: () => act(async () => { if (await promptInstall() === 'accepted') { toast('Mosaïque installée'); reportInstalled(); } }) }, icon('download', 14), "Installer l'application") : null,
      dev.mobile ? h('button', { class: 'btn small', type: 'button', onclick: () => showStepsModal(dev) }, 'Comment faire ?') : null));
  return box;
}

// Remplace l'ancien « non pris en charge par ce navigateur », trompeur sur iPhone : Safari ne propose pas
// le push dans un onglet, mais le propose dès que l'application est ajoutée à l'écran d'accueil.
export function pushUnsupportedNode() {
  const dev = currentDevice();
  if (dev.os !== 'ios') return h('p', { class: 'hint' }, 'Les notifications push ne sont pas prises en charge par ce navigateur.');
  if (!iosPushCapable(dev)) return h('p', { class: 'hint' }, 'Les notifications sur iPhone et iPad demandent iOS 16.4 ou plus récent : mettez votre appareil à jour, puis ajoutez Mosaïque à l\'écran d\'accueil.');
  if (isStandalone()) return h('p', { class: 'hint' }, 'Les notifications push ne sont pas disponibles ici : vérifiez que la navigation privée est désactivée, puis rouvrez l\'application depuis son icône.');
  return h('div', { class: 'stack' },
    h('p', { class: 'hint' }, "Sur iPhone et iPad, les notifications ne fonctionnent qu'une fois Mosaïque ajoutée à l'écran d'accueil : ajoutez-la, ouvrez-la depuis son icône, puis revenez ici pour les activer."),
    h('div', null, h('button', { class: 'btn small', type: 'button', onclick: () => showStepsModal(dev) }, 'Comment faire ?')));
}
