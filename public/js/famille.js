import { h, icon, state, get, post, put, del, act, toast, formModal, confirmBox, modal, opt, pageHead, avatar, TILE_COLORS, myCircles, applyMe, mount, append, publicOrigin } from './core.js';

function inviteLink(token) {
  return `${publicOrigin()}/#/rejoindre/${token}`;
}

function inviteForm(circles, done) {
  const usedColors = new Set(state.users.map((u) => u.color.toLowerCase()));
  const availableColors = TILE_COLORS.filter((x) => !usedColors.has(x.toLowerCase()));
  const colorChoices = availableColors.length ? availableColors : TILE_COLORS;
  formModal('Ajouter un membre', [
    { name: 'name', label: 'Prénom', required: true, maxlength: 80 },
    { name: 'color', label: 'Couleur', type: 'color', value: colorChoices[0], options: colorChoices.map((x) => opt(x, x)) },
    { name: 'is_admin', label: 'Droits administrateur', type: 'checkbox' },
    { name: 'circle_ids', label: 'Accès aux cercles', type: 'checkboxes', value: circles.map((c) => c.id), options: circles.map((c) => opt(c.id, c.name)) },
  ], {
    submit: 'Créer et obtenir le lien',
    onSubmit: async (v, close) => {
      const r = await post('/invites', { ...v, circle_ids: v.circle_ids.map(Number) });
      close();
      const link = inviteLink(r.token);
      modal('Membre créé', h('div', { class: 'stack' },
        h('p', null, `${v.name} apparaît déjà partout dans l'application (cercles, garde, tâches...). Envoyez-lui ce lien pour qu'il ou elle active son compte (mot de passe, e-mail) — valable 7 jours :`),
        h('div', { class: 'copy-row' }, h('input', { readonly: true, value: link, onclick: (e) => e.target.select() }),
          h('button', { class: 'btn', type: 'button', onclick: (e) => { navigator.clipboard.writeText(link); e.target.textContent = 'Copié !'; } }, 'Copier')),
        !state.settings.public_url ? h('p', { class: 'hint' }, "Ce lien reprend l'adresse depuis laquelle vous êtes connecté·e en ce moment. Si la personne invitée n'est pas sur le même réseau, définissez PUBLIC_URL (voir le README) pour un lien toujours valide de partout.") : null));
      done();
    },
  });
}

function reinviteLink(u, done) {
  modal('Lien à renvoyer', h('div', { class: 'stack' },
    h('p', null, `Génère un nouveau lien d'activation pour ${u.name} (l'ancien, s'il existait encore, sera invalidé).`),
    h('div', { class: 'row end' }, h('button', { class: 'btn primary', type: 'button', onclick: async (e) => {
      const r = await post(`/users/${u.id}/reinvite`);
      const link = inviteLink(r.token);
      e.target.closest('dialog').close();
      modal('Nouveau lien', h('div', { class: 'stack' },
        h('div', { class: 'copy-row' }, h('input', { readonly: true, value: link, onclick: (ev) => ev.target.select() }),
          h('button', { class: 'btn', type: 'button', onclick: (ev) => { navigator.clipboard.writeText(link); ev.target.textContent = 'Copié !'; } }, 'Copier')),
        !state.settings.public_url ? h('p', { class: 'hint' }, "Ce lien reprend l'adresse depuis laquelle vous êtes connecté·e en ce moment (PUBLIC_URL non configuré).") : null));
      done();
    } }, 'Générer le lien'))));
}

function circleForm(c, done) {
  formModal(c ? 'Modifier le cercle' : 'Nouveau cercle', [
    { name: 'name', label: 'Nom', value: c ? c.name : '', required: true, maxlength: 60, placeholder: 'Ex. : Famille, Coparents, Grands-parents' },
    { name: 'color', label: 'Couleur', type: 'color', value: c ? c.color : TILE_COLORS[0], options: TILE_COLORS.map((x) => opt(x, x)) },
    { name: 'member_ids', label: 'Membres', type: 'checkboxes', value: c ? c.member_ids : state.users.map((u) => u.id), options: state.users.map((u) => opt(u.id, u.name)) },
  ], {
    onSubmit: async (v, close) => {
      const body = { name: v.name, color: v.color, member_ids: v.member_ids.map(Number) };
      if (c) await put(`/circles/${c.id}`, body); else await post('/circles', body);
      close(); toast(c ? 'Cercle modifié' : 'Cercle créé'); done();
    },
  });
}

// Lieu de transition : suggestions rapides (école, domicile de chacun) tout en acceptant un texte libre.
function handoverLocationField(initialValue) {
  const listId = 'handover-locations-' + Math.random().toString(36).slice(2, 8);
  const options = ['École', ...state.users.map((u) => `Domicile de ${u.name}`)];
  const input = h('input', { value: initialValue || '', list: listId, placeholder: 'École, domicile de…', maxlength: 200 });
  const datalist = h('datalist', { id: listId }, options.map((o) => h('option', { value: o })));
  const node = h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Lieu de transition habituel'), input, datalist,
    h('span', { class: 'hint' }, "Suggestions (école, domicile d'un parent…) ou votre propre texte."));
  return { node, get: () => input.value.trim() };
}

// Parents et lecteurs d'un enfant : deux listes liées. Un parent est retiré des lecteurs
// automatiquement (et inversement, un lecteur ne peut pas être coché parmi les parents), et au-delà
// de 2 parents cochés, les autres membres sont grisés jusqu'à en décocher un.
function parentsViewersField(c) {
  let parentIds = c ? [...c.parent_ids] : [];
  let viewerIds = c ? c.viewer_ids.filter((id) => !parentIds.includes(id)) : [];
  const parentsBox = h('div', { class: 'checks' });
  const viewersBox = h('div', { class: 'checks' });

  function renderParents() {
    mount(parentsBox, state.users.map((u) => {
      const checked = parentIds.includes(u.id);
      const disabled = !checked && parentIds.length >= 2;
      return h('label', { class: 'check-chip' + (disabled ? ' disabled' : '') },
        h('input', {
          type: 'checkbox', checked, disabled,
          onchange: (e) => {
            parentIds = e.target.checked ? [...parentIds, u.id] : parentIds.filter((id) => id !== u.id);
            viewerIds = viewerIds.filter((id) => !parentIds.includes(id)); // un parent ne peut pas aussi être lecteur
            renderParents(); renderViewers();
          },
        }), h('span', null, u.name));
    }));
  }
  function renderViewers() {
    const candidates = state.users.filter((u) => !parentIds.includes(u.id));
    mount(viewersBox, candidates.length ? candidates.map((u) => h('label', { class: 'check-chip' },
      h('input', {
        type: 'checkbox', checked: viewerIds.includes(u.id),
        onchange: (e) => { viewerIds = e.target.checked ? [...viewerIds, u.id] : viewerIds.filter((id) => id !== u.id); },
      }), h('span', null, u.name))) : h('p', { class: 'muted' }, 'Personne : tous les membres sont déjà désignés comme parents.'));
  }
  renderParents(); renderViewers();

  const node = h('div', { class: 'stack' },
    h('div', { class: 'field' },
      h('span', { class: 'field-label' }, 'Parents / tuteurs de cet enfant (2 maximum)'), parentsBox,
      h('span', { class: 'hint' }, "Si vous n'en cochez aucun, cet enfant reste visible et modifiable par tous les membres des cercles concernés (comportement par défaut). Si vous en cochez, seuls eux (et les administrateurs) verront et pourront modifier son calendrier, sa garde et ses contacts — utile pour qu'un ex sans lien avec cet enfant n'y ait pas accès.")),
    h('div', { class: 'field' },
      h('span', { class: 'field-label' }, 'Lecteurs (voient sans pouvoir modifier)'), viewersBox,
      h('span', { class: 'hint' }, "Par exemple le ou la compagnon·ne d'un parent : il ou elle voit le calendrier, la garde et les contacts de cet enfant, mais ne peut rien modifier. Sans effet si aucun parent n'est désigné ci-dessus.")));
  return { node, getParents: () => parentIds, getViewers: () => viewerIds };
}

function childForm(c, done) {
  const isAdmin = state.me.user.is_admin;
  const usedColors = new Set(state.children.filter((x) => !c || x.id !== c.id).map((x) => x.color.toLowerCase()));
  const availableColors = TILE_COLORS.filter((x) => !usedColors.has(x.toLowerCase()));
  const colorChoices = availableColors.length ? availableColors : TILE_COLORS; // repli si toutes les couleurs sont déjà prises
  const defaultColor = c ? c.color : (colorChoices.find((x) => !usedColors.has(x.toLowerCase())) || colorChoices[0]);
  formModal(c ? "Modifier l'enfant" : 'Ajouter un enfant', [
    { name: 'name', label: 'Prénom', value: c ? c.name : '', required: true, maxlength: 60 },
    { name: 'birthdate', label: 'Date de naissance (facultatif)', type: 'date', value: c ? c.birthdate || '' : '' },
    { name: 'zone', label: 'Zone scolaire', type: 'select', value: c ? c.zone : 'B', options: [opt('A', 'Zone A'), opt('B', 'Zone B'), opt('C', 'Zone C')], hint: 'Utilisée pour afficher les bonnes dates de vacances scolaires pour cet enfant.' },
    { name: 'shared_custody', label: 'Concerné par une garde partagée', type: 'checkbox', value: c ? c.shared_custody : true, hint: "Si décoché, cet enfant n'apparaît pas dans l'onglet Garde — utile s'il vit toujours au même endroit et n'a pas de planning de garde à suivre." },
    { name: 'handover_location', ...handoverLocationField(c ? c.handover_location : '') },
    { name: 'handover_time', label: 'Heure de transition habituelle (facultatif)', type: 'time', value: c ? c.handover_time || '' : '' },
    {
      name: 'color', label: 'Couleur', type: 'color', value: defaultColor, options: colorChoices.map((x) => opt(x, x)),
      hint: availableColors.length ? undefined : 'Toutes les couleurs disponibles sont déjà utilisées par un autre enfant ; deux enfants partageront la même.',
    },
    ...(isAdmin ? (() => {
      const pv = parentsViewersField(c);
      return [
        { name: 'parent_ids', node: pv.node, get: pv.getParents },
        { name: 'viewer_ids', node: h('span', { style: { display: 'none' } }), get: pv.getViewers },
      ];
    })() : []),
  ], {
    onSubmit: async (v, close) => {
      if (c) await put(`/children/${c.id}`, v); else await post('/children', v);
      close(); toast(c ? 'Enfant modifié' : 'Enfant ajouté'); done();
    },
  });
}

function memberEditForm(u, done) {
  const usedColors = new Set(state.users.filter((x) => x.id !== u.id).map((x) => x.color.toLowerCase()));
  const availableColors = TILE_COLORS.filter((x) => !usedColors.has(x.toLowerCase()));
  const colorChoices = availableColors.includes(u.color) || !availableColors.length ? (availableColors.length ? availableColors : TILE_COLORS) : [u.color, ...availableColors];
  formModal(`Modifier ${u.name}`, [
    { name: 'name', label: 'Prénom', value: u.name, required: true, maxlength: 80 },
    { name: 'color', label: 'Couleur', type: 'color', value: u.color, options: colorChoices.map((x) => opt(x, x)) },
  ], {
    onSubmit: async (v, close) => { await put(`/users/${u.id}`, v); close(); toast('Membre modifié'); done(); },
  });
}

function passwordForm(u) {
  formModal(`Nouveau mot de passe pour ${u.name}`, [{ name: 'password', label: 'Nouveau mot de passe', type: 'password', required: true, hint: '8 caractères minimum.' }], {
    submit: 'Changer',
    onSubmit: async (v, close) => { await put(`/users/${u.id}/password`, v); close(); toast('Mot de passe changé, la personne devra se reconnecter.'); },
  });
}

export async function famille(root) {
  const me = state.me.user;
  const box = h('div', { class: 'stack big' });
  append(root, pageHead('Famille'), box);

  function draw() {
    const circles = myCircles();
    const sections = [];

    sections.push(h('section', { class: 'card' }, h('h2', null, 'Membres'),
      h('ul', { class: 'member-list' }, state.users.map((u) => h('li', { class: 'member-row' },
        avatar(u, 32), h('div', { class: 'member-main' }, h('strong', null, u.name), u.is_admin ? h('span', { class: 'tag' }, 'Administrateur') : null,
          u.claimed === false ? h('span', { class: 'tag pending' }, 'En attente d\'activation') : (u.email ? h('small', { class: 'muted' }, u.email) : null)),
        me.is_admin ? h('div', { class: 'row gap' },
          u.claimed === false ? h('button', { class: 'btn small', onclick: () => memberEditForm(u, refresh) }, 'Modifier') : null,
          u.claimed === false ? h('button', { class: 'btn small', onclick: () => reinviteLink(u, refresh) }, icon('copy', 14), 'Lien') : null,
          (u.id !== me.id && u.claimed !== false) ? h('button', { class: 'btn small', onclick: () => passwordForm(u) }, 'Mot de passe') : null,
          u.id !== me.id ? h('button', { class: 'btn small', onclick: () => act(async () => { await put(`/users/${u.id}/admin`, { is_admin: !u.is_admin }); toast('Rôle mis à jour'); refresh(); }) }, u.is_admin ? 'Retirer admin' : 'Rendre admin') : null,
          u.id !== me.id ? h('button', { class: 'icon-btn', 'aria-label': 'Retirer', onclick: async () => { if (await confirmBox(u.claimed === false ? `Annuler l'invitation de ${u.name} ?` : `Retirer ${u.name} de la famille ? Ses contributions resteront visibles.`)) act(async () => { await del(`/users/${u.id}`); toast(u.claimed === false ? 'Invitation annulée' : 'Membre retiré'); refresh(); }); } }, icon('trash', 16)) : null)
          : null))),
      me.is_admin ? h('button', { class: 'btn primary', onclick: () => inviteForm(circles, refresh) }, icon('plus', 16), 'Ajouter un membre') : null));

    sections.push(h('section', { class: 'card' }, h('h2', null, 'Cercles'), h('p', { class: 'muted' }, "Un cercle regroupe des personnes qui partagent agenda, tâches, budget et documents (ex. : la famille au complet, ou seulement les coparents)."),
      h('ul', { class: 'circle-list' }, state.circles.map((c) => h('li', { class: 'circle-row' },
        h('span', { class: 'dot big', style: { background: c.color } }), h('strong', null, c.name),
        h('span', { class: 'muted' }, `${c.member_ids.length} membre(s)`),
        me.is_admin ? h('div', { class: 'row gap' },
          h('button', { class: 'btn small', onclick: () => circleForm(c, refresh) }, 'Modifier'),
          state.circles.length > 1 ? h('button', { class: 'icon-btn', 'aria-label': 'Supprimer', onclick: async () => { if (await confirmBox(`Supprimer le cercle « ${c.name} » ? Son contenu sera supprimé.`)) act(async () => { await del(`/circles/${c.id}`); toast('Cercle supprimé'); refresh(); }); } }, icon('trash', 16)) : null)
          : null))),
      me.is_admin ? h('button', { class: 'btn', onclick: () => circleForm(null, refresh) }, icon('plus', 16), 'Nouveau cercle') : null));

    sections.push(h('section', { class: 'card' }, h('h2', null, 'Enfants'),
      h('ul', { class: 'circle-list' }, state.children.map((c) => h('li', { class: 'circle-row' },
        h('span', { class: 'dot big', style: { background: c.color } }), h('strong', null, c.name), c.birthdate ? h('span', { class: 'muted' }, c.birthdate) : null, h('span', { class: 'tag' }, `Zone ${c.zone}`),
        c.parent_ids.length ? h('span', { class: 'tag' }, 'Parents : ', c.parent_ids.map((id) => (state.users.find((u) => u.id === id) || {}).name).filter(Boolean).join(', ')) : h('span', { class: 'muted' }, 'Visible par tout le cercle'),
        c.viewer_ids.length ? h('span', { class: 'tag' }, 'Lecture seule : ', c.viewer_ids.map((id) => (state.users.find((u) => u.id === id) || {}).name).filter(Boolean).join(', ')) : null,
        h('div', { class: 'row gap' }, h('button', { class: 'btn small', onclick: () => childForm(c, refresh) }, 'Modifier'),
          me.is_admin ? h('button', { class: 'icon-btn', 'aria-label': 'Supprimer', onclick: async () => { if (await confirmBox(`Supprimer ${c.name} ?`)) act(async () => { await del(`/children/${c.id}`); toast('Enfant supprimé'); refresh(); }); } }, icon('trash', 16)) : null)))),
      h('button', { class: 'btn', onclick: () => childForm(null, refresh) }, icon('plus', 16), 'Ajouter un enfant')));

    mount(box, sections);
  }

  async function refresh() { applyMe(await get('/me')); draw(); }
  draw();
}
