import { h, icon, get, post, del, act, toast, confirmBox, onRefresh, pageHead, circleChips, inFilter, emptyState, onChat, emitChat, ago, avatar, userName, circleById, myCircles, activeCircleId, state, mount, append } from './core.js';

export async function fil(root) {
  let posts = [];
  const chips = circleChips(() => draw());
  const box = h('div', { class: 'stack' });
  const text = h('textarea', { placeholder: 'Partager une nouvelle avec la famille…', rows: 2, maxlength: 4000 });
  const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', 'aria-label': 'Ajouter une photo' });
  const preview = h('div', { class: 'photo-preview' });
  fileInput.onchange = () => {
    mount(preview, );
    const f = fileInput.files[0];
    if (f) append(preview, h('img', { src: URL.createObjectURL(f), alt: '' }), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Retirer la photo', onclick: () => { fileInput.value = ''; mount(preview, ); } }, icon('x', 14)));
  };
  const composer = h('form', { class: 'composer', onsubmit: (e) => {
    e.preventDefault();
    act(async () => {
      const body = text.value.trim();
      const file = fileInput.files[0];
      if (!body && !file) return;
      const fd = new FormData();
      fd.append('circle_id', activeCircleId()); fd.append('body', body); if (file) fd.append('photo', file);
      await post('/posts', fd);
      text.value = ''; fileInput.value = ''; mount(preview, ); load();
    });
  } }, text, h('div', { class: 'row between center' }, h('label', { class: 'btn small' }, icon('image', 16), ' Photo', fileInput), h('button', { class: 'btn primary', type: 'submit' }, 'Publier')), preview);

  append(root, pageHead('Fil familial'), chips, composer, box);

  async function load() { posts = await get('/posts'); draw(); }
  onRefresh(['posts'], load);

  function draw() {
    const visible = posts.filter(inFilter);
    mount(box, visible.length ? h('ul', { class: 'post-list' }, visible.map((p) => h('li', { class: 'post' },
      h('div', { class: 'post-head' }, avatar(p.created_by, 32), h('div', null, h('strong', null, userName(p.created_by)), h('small', { class: 'muted' }, ` · ${ago(p.created_at)}${myCircles().length > 1 ? ' · ' + ((circleById(p.circle_id) || {}).name || '') : ''}`)),
        (p.created_by === state.me.user.id || state.me.user.is_admin) ? h('button', { class: 'icon-btn', 'aria-label': 'Supprimer', onclick: async () => { if (await confirmBox('Supprimer cette publication ?')) act(async () => { await del(`/posts/${p.id}`); load(); }); } }, icon('trash', 16)) : null),
      p.body ? h('p', { class: 'post-body' }, p.body) : null,
      p.has_photo ? h('img', { class: 'post-photo', src: `/api/posts/${p.id}/photo`, alt: '', loading: 'lazy' }) : null))) : emptyState('Aucune publication pour le moment. Partagez la première !'));
  }

  await load();
}

export async function chat(root) {
  const circles = myCircles();
  if (!circles.length) { append(root, pageHead('Messages'), emptyState('Aucun cercle disponible.')); return; }
  let circleId;
  let messages = [];
  const chips = circleChips(() => { circleId = activeCircleId(); load(); }, { all: false });
  circleId = activeCircleId();
  const list = h('div', { class: 'chat-list' });
  const form = h('form', { class: 'chat-compose', onsubmit: (e) => { e.preventDefault(); const inp = e.target.elements.body; const v = inp.value.trim(); if (!v) return; inp.value = ''; act(async () => { await post('/messages', { circle_id: circleId, body: v }); }); } },
    h('input', { name: 'body', placeholder: 'Écrire un message…', maxlength: 2000, autocomplete: 'off' }),
    h('button', { class: 'btn primary', type: 'submit' }, 'Envoyer'));
  append(root, pageHead('Messages'), chips, list, form);

  async function load() { messages = await get(`/messages?circle_id=${circleId}`); draw(); }
  onChat((m) => { if (m.circle_id === circleId) { messages.push(m); draw(); } });

  function draw() {
    mount(list, messages.length ? messages.map((m) => h('div', { class: 'chat-msg' + (m.created_by === state.me.user.id ? ' mine' : '') },
      avatar(m.created_by, 26), h('div', null, h('div', { class: 'chat-bubble' }, m.body), h('small', { class: 'muted' }, `${userName(m.created_by)} · ${ago(m.created_at)}`))))
      : emptyState('Aucun message. Dites bonjour !'));
    list.scrollTop = list.scrollHeight;
  }

  await load();
}
