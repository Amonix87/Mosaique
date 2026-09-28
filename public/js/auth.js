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

export function loginScreen(root, onDone) {
  const err = h('p', { class: 'form-error', role: 'alert' });
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
  h('button', { class: 'btn primary block', type: 'submit' }, 'Se connecter'));
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
