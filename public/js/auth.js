import { h, $, get, post, act, toast, opt, mount } from './core.js';

function shell(subtitle, node) {
  return h('div', { class: 'auth-screen' },
    h('div', { class: 'auth-card' },
      h('div', { class: 'auth-brand' }, h('img', { class: 'auth-mark', src: '/icons/logo.svg', alt: 'Mosaïque' }), h('h1', null, 'Mosaïque')),
      h('p', { class: 'auth-subtitle' }, subtitle),
      node));
}

export function setupScreen(root, onDone) {
  const err = h('p', { class: 'form-error', role: 'alert' });
  const form = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    const f = e.target.elements;
    if (f.password.value.length < 8) { err.textContent = 'Le mot de passe doit contenir au moins 8 caractères.'; return; }
    if (f.password.value !== f.password2.value) { err.textContent = 'Les mots de passe ne correspondent pas.'; return; }
    try {
      await post('/setup', { family_name: f.family_name.value, name: f.name.value, email: f.email.value, password: f.password.value });
      onDone();
    } catch (ex) { err.textContent = ex.message; }
  } },
  h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Nom de la famille'), h('input', { name: 'family_name', required: true, maxlength: 80, placeholder: 'Ex. : Famille Martin-Dupuis' })),
  h('hr'),
  h('p', { class: 'muted' }, 'Créez votre compte administrateur :'),
  h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Votre prénom'), h('input', { name: 'name', required: true, maxlength: 80, autocomplete: 'name' })),
  h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'E-mail'), h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' })),
  h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Mot de passe'), h('input', { name: 'password', type: 'password', required: true, autocomplete: 'new-password' })),
  h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Confirmer le mot de passe'), h('input', { name: 'password2', type: 'password', required: true, autocomplete: 'new-password' })),
  err,
  h('button', { class: 'btn primary block', type: 'submit' }, "Créer l'espace familial"));
  mount(root, shell('Installez votre espace familial privé, hébergé ici même.', form));
}

// Messages affichés quand la connexion par OpenID Connect (Authelia...) échoue : le serveur renvoie ici avec
// « ?oidc_error=<code> » (voir /auth/oidc/callback dans server/index.js).
const OIDC_ERRORS = {
  unknown_user: "Votre identité est reconnue, mais aucun compte Mosaïque n'a cette adresse e-mail. Demandez une invitation à un administrateur de la famille.",
  no_email: "Le service de connexion n'a pas transmis votre adresse e-mail. Un administrateur doit autoriser la portée « email » pour Mosaïque.",
  unverified: "Votre adresse e-mail n'est pas vérifiée auprès du service de connexion.",
  linked_other: 'Ce compte Mosaïque est déjà lié à une autre identité.',
  expired: 'La connexion a expiré ou a déjà été utilisée. Réessayez.',
  state: 'La connexion a été interrompue (navigateur différent ou cookies bloqués). Réessayez.',
  denied: "Le service de connexion a refusé l'accès.",
  disabled: "La connexion par ce service n'est pas activée.",
  provider: "Le service de connexion est injoignable ou mal configuré. Voir les journaux du serveur.",
  token: "Le service de connexion a renvoyé une réponse invalide. Voir les journaux du serveur.",
};

export function loginScreen(root, onDone, oidc) {
  const err = h('p', { class: 'form-error', role: 'alert' });
  const code = new URLSearchParams(location.search).get('oidc_error');
  if (code) {
    err.textContent = OIDC_ERRORS[code] || 'La connexion a échoué.';
    history.replaceState(null, '', location.pathname + location.hash); // l'erreur ne doit pas rester dans l'adresse
  }
  const ssoButton = oidc ? h('a', { class: 'btn block' + (oidc.password_login ? '' : ' primary'), href: '/api/auth/oidc/start' }, `Se connecter avec ${oidc.name}`) : null;
  if (oidc && !oidc.password_login) {
    mount(root, shell('Retrouvez votre agenda, votre budget et votre famille.', h('div', { class: 'stack' }, err, ssoButton)));
    return;
  }
  const form = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    const f = e.target.elements;
    const btn = $('button[type=submit]', form); btn.disabled = true;
    try { await post('/login', { email: f.email.value, password: f.password.value }); onDone(); }
    catch (ex) { err.textContent = ex.message; } finally { btn.disabled = false; }
  } },
  h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'E-mail'), h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email', autofocus: true })),
  h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Mot de passe'), h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' })),
  err,
  h('button', { class: 'btn primary block', type: 'submit' }, 'Se connecter'),
  ssoButton ? h('p', { class: 'muted auth-or' }, 'ou') : null,
  ssoButton);
  mount(root, shell('Retrouvez votre agenda, votre budget et votre famille.', form));
}

export async function joinScreen(root, token, onDone) {
  let invite;
  try { invite = await get(`/invites/${token}`); }
  catch { mount(root, shell('Invitation introuvable', h('p', null, "Ce lien n'est plus valable. Demandez-en un nouveau à un administrateur de votre famille."))); return; }
  const err = h('p', { class: 'form-error', role: 'alert' });
  const form = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    const f = e.target.elements;
    if (f.password.value.length < 8) { err.textContent = 'Le mot de passe doit contenir au moins 8 caractères.'; return; }
    if (f.password.value !== f.password2.value) { err.textContent = 'Les mots de passe ne correspondent pas.'; return; }
    try { await post(`/invites/${token}/accept`, { email: f.email.value, password: f.password.value }); onDone(); }
    catch (ex) { err.textContent = ex.message; }
  } },
  h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'E-mail'), h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email', autofocus: true })),
  h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Choisissez un mot de passe'), h('input', { name: 'password', type: 'password', required: true, autocomplete: 'new-password' })),
  h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Confirmer le mot de passe'), h('input', { name: 'password2', type: 'password', required: true, autocomplete: 'new-password' })),
  err,
  h('button', { class: 'btn primary block', type: 'submit' }, 'Activer mon compte'));
  mount(root, shell(`Bienvenue ${invite.name} ! Votre profil existe déjà dans la famille : choisissez votre e-mail et votre mot de passe pour y accéder.`, form));
}
