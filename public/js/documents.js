import { h, icon, get, post, put, del, act, toast, formModal, confirmBox, opt, onRefresh, pageHead, circleChips, inFilter, inFilterIds, emptyState, fmtDayY, userName, activeCircleId, circleSelectOptions, myCircles, circleById, fileSize, childById, state, mount, append, myEditableChildren, addressField, modal, periodFilter } from './core.js';

const DOC_CATS = ['Santé', 'École', 'Administratif', 'Justice', 'Autre'];

function docForm(done) {
  formModal('Ajouter un document', [
    { name: 'title', label: 'Titre', maxlength: 200 },
    { name: 'category', label: 'Catégorie', type: 'select', value: 'Autre', options: DOC_CATS.map((c) => opt(c, c)) },
    ...(myCircles().length > 1 ? [{ name: 'circle_id', label: 'Cercle', type: 'select', value: activeCircleId(), options: circleSelectOptions() }] : []),
    { name: 'file', label: 'Fichier', type: 'file', required: true },
  ], {
    submit: 'Envoyer',
    onSubmit: async (v, close) => {
      if (!v.file) throw new Error('Choisissez un fichier.');
      const fd = new FormData();
      fd.append('circle_id', v.circle_id || activeCircleId());
      fd.append('title', v.title); fd.append('category', v.category); fd.append('file', v.file);
      await post('/documents', fd);
      close(); toast('Document ajouté'); done();
    },
  });
}

// Aperçu direct, sans téléchargement : PDF et images (le serveur le confirme d'après le contenu du
// fichier ; tout autre type reste un téléchargement). Le lien « ?inline=1 » sert aussi de secours
// pour ouvrir dans un onglet.
const previewable = (d) => /\.(pdf|png|jpe?g|gif|webp)$/i.test(d.filename);
const inlineUrl = (d) => `/api/documents/${d.id}/file?inline=1`;
const downloadUrl = (d) => `/api/documents/${d.id}/file`;
// Sur téléphone/tablette, un PDF incrusté s'affiche mal (première page seule, pas de défilement) :
// mieux vaut l'ouvrir dans le lecteur du navigateur, dans un nouvel onglet.
const wantsModalPreview = () => !window.matchMedia('(max-width: 720px), (pointer: coarse)').matches;
function previewDocument(d) {
  const isPdf = /\.pdf$/i.test(d.filename);
  modal(d.title, h('div', { class: 'doc-preview' },
    isPdf ? h('iframe', { src: inlineUrl(d), title: d.title }) : h('img', { src: inlineUrl(d), alt: d.title }),
    h('div', { class: 'row gap wrap end' },
      h('a', { class: 'btn', href: inlineUrl(d), target: '_blank', rel: 'noopener' }, icon('eye', 16), 'Ouvrir dans un onglet'),
      h('a', { class: 'btn', href: downloadUrl(d), download: d.filename }, icon('download', 16), 'Télécharger'))), { xl: true });
}

export async function documents(root) {
  let docs = [];
  let category = '';
  const chips = circleChips(() => draw());
  const period = periodFilter(() => draw(), { mode: 'all' });
  const catSelect = h('select', { 'aria-label': 'Catégorie', onchange: (e) => { category = e.target.value; draw(); } });
  const resetBtn = h('button', { class: 'btn small', type: 'button', onclick: () => { category = ''; period.reset(); draw(); } }, 'Réinitialiser');
  const bar = h('div', { class: 'filter-bar' }, catSelect, period.node, resetBtn);
  const summary = h('p', { class: 'muted filter-summary' });
  const box = h('div', { class: 'stack' });
  append(root, pageHead('Documents', h('button', { class: 'btn primary', onclick: () => docForm(load) }, icon('plus', 16), 'Document')), chips, bar, summary, box);

  async function load() {
    docs = await get('/documents');
    period.setYears([...new Set(docs.map((d) => String(d.created_at).slice(0, 4)))]);
    draw();
  }
  onRefresh(['documents'], load);

  function draw() {
    const inCircle = docs.filter(inFilter);
    // Catégories proposées : celles qui existent vraiment (plus la sélection en cours, pour ne pas la perdre).
    const cats = [...new Set([...DOC_CATS, ...inCircle.map((d) => d.category || 'Autre'), ...(category ? [category] : [])])];
    mount(catSelect, h('option', { value: '' }, 'Toutes les catégories'), cats.map((c) => h('option', { value: c, selected: c === category }, c)));
    const visible = inCircle.filter((d) => (!category || (d.category || 'Autre') === category) && period.match(d.created_at));
    resetBtn.hidden = !category && period.isDefault();
    const filtered = !!category || !period.isDefault();
    summary.textContent = filtered ? `${visible.length} document${visible.length > 1 ? 's' : ''} sur ${inCircle.length}` : '';

    const groups = [...new Set(visible.map((d) => d.category || 'Autre'))];
    mount(box, visible.length ? groups.map((cat) => h('div', { class: 'doc-group' },
      h('h3', null, cat),
      h('ul', { class: 'doc-list' }, visible.filter((d) => (d.category || 'Autre') === cat).map((d) => h('li', { class: 'doc-row' },
        icon('doc', 22),
        previewable(d)
          ? h('a', { class: 'doc-main', href: inlineUrl(d), target: '_blank', rel: 'noopener', title: 'Afficher',
            onclick: (e) => { if (wantsModalPreview()) { e.preventDefault(); previewDocument(d); } } },
          h('strong', null, d.title), h('small', null, `${fileSize(d.size)} · ajouté par ${userName(d.created_by)} · ${fmtDayY(d.created_at)}`))
          : h('a', { class: 'doc-main', href: downloadUrl(d) },
            h('strong', null, d.title), h('small', null, `${fileSize(d.size)} · ajouté par ${userName(d.created_by)} · ${fmtDayY(d.created_at)}`)),
        previewable(d) ? h('a', { class: 'icon-btn', href: inlineUrl(d), target: '_blank', rel: 'noopener', 'aria-label': 'Afficher',
          onclick: (e) => { if (wantsModalPreview()) { e.preventDefault(); previewDocument(d); } } }, icon('eye', 18)) : null,
        h('a', { class: 'icon-btn', href: downloadUrl(d), download: d.filename, 'aria-label': 'Télécharger' }, icon('download', 18)),
        h('button', { class: 'icon-btn', 'aria-label': 'Supprimer', onclick: async () => { if (await confirmBox(`Supprimer « ${d.title} » ?`)) act(async () => { await del(`/documents/${d.id}`); load(); }); } }, icon('trash', 18))))))) :
      emptyState(filtered && inCircle.length ? 'Aucun document ne correspond à ces filtres.' : 'Aucun document pour le moment.'));
  }

  await load();
}

function contactForm(c, done) {
  const addrField = addressField(c ? c.address || '' : '', null, null, { placeholder: 'Adresse…' });
  const circles = myCircles();
  formModal(c ? 'Modifier le contact' : 'Nouveau contact', [
    { name: 'name', label: 'Nom', value: c ? c.name : '', required: true, maxlength: 200 },
    { name: 'category', label: 'Catégorie', value: c ? c.category || '' : '', placeholder: 'Médecin, École, Baby-sitter…' },
    { name: 'phone', label: 'Téléphone', value: c ? c.phone || '' : '', type: 'tel' },
    { name: 'email', label: 'E-mail', value: c ? c.email || '' : '', type: 'email' },
    { name: 'address', node: h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Adresse'), addrField.input, addrField.list), get: addrField.get },
    { name: 'child_id', label: 'Concerne (facultatif)', type: 'select', value: c ? (c.child_id ?? '') : '', options: [opt('', 'Toute la famille'), ...myEditableChildren().map((k) => opt(k.id, k.name))] },
    ...(circles.length > 1 ? [{ name: 'circle_ids', label: 'Cercles', type: 'checkboxes', value: c ? c.circle_ids : [activeCircleId()], options: circleSelectOptions() }] : []),
    { name: 'favorite', label: 'Favori (épinglé en haut de la liste)', type: 'checkbox', value: c ? !!c.favorite : false },
    { name: 'notes', label: 'Notes', type: 'textarea', value: c ? c.notes || '' : '' },
  ], {
    onSubmit: async (v, close) => {
      const body = { ...v, child_id: v.child_id ? Number(v.child_id) : null };
      body.circle_ids = circles.length > 1 ? (v.circle_ids || []).map(Number) : [activeCircleId()];
      if (c) await put(`/contacts/${c.id}`, body); else await post('/contacts', body);
      close(); toast(c ? 'Contact modifié' : 'Contact ajouté'); done();
    },
  });
}

export async function contacts(root) {
  let list = [];
  const chips = circleChips(() => draw());
  const box = h('div', { class: 'stack' });
  append(root, pageHead('Contacts', h('button', { class: 'btn primary', onclick: () => contactForm(null, load) }, icon('plus', 16), 'Contact')), chips, box);

  async function load() { list = await get('/contacts'); draw(); }
  onRefresh(['contacts'], load);

  function toggleFavorite(c, e) {
    e.stopPropagation();
    act(async () => { await put(`/contacts/${c.id}`, { favorite: !c.favorite }); });
  }

  function contactRow(c, multiCircle) {
    const kid = c.child_id ? childById(c.child_id) : null;
    return h('li', { class: 'contact-row', onclick: () => contactForm(c, load) },
      h('button', { class: 'icon-btn' + (c.favorite ? ' fav-on' : ''), 'aria-label': c.favorite ? 'Retirer des favoris' : 'Mettre en favori', title: c.favorite ? 'Retirer des favoris' : 'Mettre en favori', onclick: (e) => toggleFavorite(c, e) }, icon('star', 18)),
      h('div', { class: 'contact-main' },
        h('strong', null, c.name), c.category ? h('span', { class: 'tag' }, c.category) : null, kid ? h('span', { class: 'tag', style: { background: kid.color } }, kid.name) : null,
        multiCircle ? c.circle_ids.map((id) => { const circle = circleById(id); return circle ? h('span', { class: 'tag', style: { background: circle.color } }, circle.name) : null; }) : null,
        h('div', { class: 'muted' }, [c.phone, c.email, c.address].filter(Boolean).join(' · '))),
      c.phone ? h('a', { class: 'icon-btn', href: `tel:${c.phone}`, 'aria-label': 'Appeler', onclick: (e) => e.stopPropagation() }, icon('phone', 18)) : null,
      h('button', { class: 'icon-btn', 'aria-label': 'Supprimer', onclick: async (e) => { e.stopPropagation(); if (await confirmBox(`Supprimer « ${c.name} » ?`)) act(async () => { await del(`/contacts/${c.id}`); load(); }); } }, icon('trash', 18)));
  }

  function draw() {
    const visible = list.filter(inFilterIds);
    const multiCircle = myCircles().length > 1;
    const favorites = visible.filter((c) => c.favorite);
    const rest = visible.filter((c) => !c.favorite);
    const categories = [...new Set(rest.map((c) => c.category || 'Autre'))].sort((a, b) => (a === 'Autre' ? 1 : b === 'Autre' ? -1 : a.localeCompare(b, 'fr')));
    const group = (title, items) => (items.length ? h('div', { class: 'doc-group' }, h('h3', null, title), h('ul', { class: 'contact-list' }, items.map((c) => contactRow(c, multiCircle)))) : null);
    mount(box, visible.length
      ? [group('Favoris', favorites), ...categories.map((cat) => group(cat, rest.filter((c) => (c.category || 'Autre') === cat)))]
      : emptyState('Aucun contact pour le moment.'));
  }

  await load();
}
