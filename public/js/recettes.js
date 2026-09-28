import { h, icon, state, get, post, put, del, act, toast, formModal, confirmBox, modal, opt, onRefresh, pageHead, circleChips, inFilter, emptyState, activeCircleId, circleSelectOptions, myCircles, mount, append, GROCERY_CATEGORIES, today, ymd, addDays, toDate, childById } from './core.js';

function stars(value, onPick) {
  const n = value || 0;
  return h('span', { class: 'stars' + (onPick ? ' interactive' : '') }, [1, 2, 3, 4, 5].map((i) => onPick
    ? h('button', { type: 'button', class: 'star-btn', 'aria-label': `${i} étoile${i > 1 ? 's' : ''}`, onclick: () => onPick(i === n ? null : i) }, i <= n ? '★' : '☆')
    : h('span', { class: 'star' }, i <= n ? '★' : '☆')));
}

// Éditeur d'ingrédients structurés (nom, quantité, unité, catégorie) : sert à la fois à l'affichage
// de la recette et à la génération de la liste de courses depuis le planificateur de repas.
function ingredientsField(initial) {
  let rows = (initial && initial.length ? initial : [{}]).map((r) => ({ name: r.name || '', amount: r.amount ?? '', unit: r.unit || '', category: r.category || 'Autre' }));
  const box = h('div', { class: 'ingredient-rows' });
  function render() {
    mount(box, rows.map((row, i) => h('div', { class: 'ingredient-row' },
      h('input', { placeholder: 'Ingrédient', value: row.name, oninput: (e) => { row.name = e.target.value; } }),
      h('input', { placeholder: 'Qté', type: 'number', step: 'any', min: 0, value: row.amount, oninput: (e) => { row.amount = e.target.value; } }),
      h('input', { placeholder: 'Unité', value: row.unit, oninput: (e) => { row.unit = e.target.value; } }),
      h('select', { onchange: (e) => { row.category = e.target.value; } }, GROCERY_CATEGORIES.map((c) => h('option', { value: c, selected: c === row.category }, c))),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Retirer cet ingrédient', onclick: () => { rows.splice(i, 1); if (!rows.length) rows.push({ name: '', amount: '', unit: '', category: 'Autre' }); render(); } }, icon('x', 16)))));
  }
  render();
  const node = h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Ingrédients'), box,
    h('button', { type: 'button', class: 'btn small', style: { marginTop: '.4rem' }, onclick: () => { rows.push({ name: '', amount: '', unit: '', category: 'Autre' }); render(); } }, icon('plus', 14), ' Ajouter un ingrédient'),
    h('p', { class: 'hint' }, "La quantité et l'unité sont facultatives, mais nécessaires pour que le planificateur de repas puisse générer une liste de courses correctement dosée."));
  return { node, get: () => rows.filter((r) => r.name.trim()).map((r) => ({ name: r.name.trim(), amount: r.amount === '' ? null : Number(r.amount), unit: r.unit.trim() || null, category: r.category })) };
}

function recipeForm(r, done) {
  const circles = myCircles();
  const ing = ingredientsField(r ? r.ingredients_json : []);
  formModal(r ? 'Modifier la recette' : 'Nouvelle recette', [
    { name: 'title', label: 'Titre', value: r ? r.title : '', required: true, maxlength: 150 },
    ...(circles.length > 1 && !r ? [{ name: 'circle_id', label: 'Cercle', type: 'select', value: activeCircleId(), options: circleSelectOptions() }] : []),
    { name: 'description', label: 'Description (facultatif)', type: 'textarea', value: r ? r.description || '' : '' },
    { name: 'servings', label: 'Nombre de portions', type: 'number', min: 1, max: 100, value: r ? r.servings || 4 : 4 },
    { name: 'ingredients_json', node: ing.node, get: ing.get },
    { name: 'instructions', label: 'Préparation', type: 'textarea', value: r ? r.instructions || '' : '' },
  ], {
    onSubmit: async (v, close) => {
      if (r) await put(`/recipes/${r.id}`, v);
      else await post('/recipes', { ...v, circle_id: Number(v.circle_id || activeCircleId()) });
      close(); toast(r ? 'Recette modifiée' : 'Recette ajoutée'); done();
    },
  });
}

function openRecipe(r, load) {
  let close;
  const body = h('div', { class: 'stack' },
    r.description ? h('p', null, r.description) : null,
    h('div', { class: 'row gap center' }, h('strong', null, 'Note globale : '), stars(r.rating_global, (v) => act(async () => { await put(`/recipes/${r.id}`, { rating_global: v }); toast('Note enregistrée'); close(); load(); }))),
    state.children.length ? h('div', { class: 'stack' }, h('strong', null, 'Note par enfant'),
      h('ul', { class: 'child-ratings' }, state.children.map((c) => h('li', { class: 'row between center' },
        h('span', { class: 'row gap center' }, h('span', { class: 'dot', style: { background: c.color } }), c.name),
        stars(r.child_ratings[c.id], (v) => act(async () => { await put(`/recipes/${r.id}/child-rating`, { child_id: c.id, rating: v }); toast('Note enregistrée'); close(); load(); })))))) : null,
    r.ingredients_json.length ? h('div', null, h('strong', null, `Ingrédients (pour ${r.servings || 4} portions)`),
      h('ul', { class: 'ingredient-list' }, r.ingredients_json.map((i) => h('li', null, [i.amount, i.unit, i.name].filter(Boolean).join(' ')))))
      : (r.ingredients ? h('div', null, h('strong', null, 'Ingrédients'), h('p', { class: 'notes' }, r.ingredients)) : null),
    r.instructions ? h('div', null, h('strong', null, 'Préparation'), h('p', { class: 'notes' }, r.instructions)) : null,
    h('div', { class: 'row gap wrap end' },
      h('button', { class: 'btn', type: 'button', onclick: () => { close(); recipeForm(r, load); } }, icon('edit', 16), 'Modifier'),
      h('button', { class: 'btn danger', type: 'button', onclick: async () => { close(); if (await confirmBox(`Supprimer « ${r.title} » ?`)) act(async () => { await del(`/recipes/${r.id}`); toast('Recette supprimée'); load(); }); } }, icon('trash', 16), 'Supprimer')));
  close = modal(r.title, body, { wide: true });
}

export async function recettes(root) {
  let recipes = [];
  const chips = circleChips(() => draw());
  const box = h('div', { class: 'stack' });
  append(root, pageHead('Recettes', h('button', { class: 'btn primary', onclick: () => recipeForm(null, load) }, icon('plus', 16), 'Recette')), chips, box);

  async function load() { recipes = await get('/recipes'); draw(); }
  onRefresh(['recipes'], load);

  function draw() {
    const visible = recipes.filter(inFilter);
    mount(box, visible.length ? h('div', { class: 'recipe-grid' }, visible.map((r) => h('button', { type: 'button', class: 'recipe-card', onclick: () => openRecipe(r, load) },
      h('strong', null, r.title),
      r.description ? h('p', { class: 'muted' }, r.description) : null,
      h('div', { class: 'row gap center' }, stars(r.rating_global))))) : emptyState('Aucune recette pour le moment.'));
  }

  await load();
}

/* ───────────────────────── Planificateur de repas ───────────────────────── */
const SLOTS = [opt('dejeuner', 'Déjeuner'), opt('diner', 'Dîner')];
const mondayOf = (d) => { const dow = toDate(d).getDay(); return addDays(d, dow === 0 ? -6 : 1 - dow); };

function mealForm(circleId, date, slot, recipes, existing, done) {
  let recipeId = existing ? existing.recipe_id : null;
  const servingsInput = h('input', { type: 'number', min: 1, max: 100, value: existing ? existing.servings || '' : '' });
  const titleInput = h('input', { value: existing && !existing.recipe_id ? existing.title || '' : '', placeholder: 'Ex. : Restes, Pizza…' });
  const recipeSelect = h('select', {
    onchange: (e) => {
      recipeId = e.target.value ? Number(e.target.value) : null;
      const r = recipes.find((x) => x.id === recipeId);
      titleInput.closest('.field').style.display = recipeId ? 'none' : '';
      if (r && !servingsInput.value) servingsInput.value = r.servings || 4;
    },
  }, h('option', { value: '' }, 'Aucune (titre libre ci-dessous)'), recipes.map((r) => h('option', { value: r.id }, r.title)));
  if (existing && existing.recipe_id) recipeSelect.value = existing.recipe_id;
  const close = modal(existing ? 'Modifier ce repas' : 'Ajouter un repas', h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); act(async () => {
    await put('/meal-plans', {
      circle_id: circleId, date, slot, recipe_id: recipeId,
      title: recipeId ? null : titleInput.value.trim(), servings: servingsInput.value ? Number(servingsInput.value) : null,
    });
    close(); toast('Repas enregistré'); done();
  }); } },
    h('p', { class: 'muted' }, `${date.split('-').reverse().join('/')} · ${slot === 'dejeuner' ? 'Déjeuner' : 'Dîner'}`),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Recette'), recipeSelect),
    h('label', { class: 'field', style: { display: recipeId ? 'none' : '' } }, h('span', { class: 'field-label' }, 'Ou titre libre'), titleInput),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Portions prévues'), servingsInput),
    h('div', { class: 'row gap wrap end' },
      existing ? h('button', { class: 'btn danger', type: 'button', onclick: () => act(async () => { close(); await del(`/meal-plans/${existing.id}`); toast('Repas retiré'); done(); }) }, 'Retirer') : null,
      h('button', { class: 'btn primary', type: 'submit' }, 'Enregistrer'))));
}

export async function planificateur(root) {
  let weekStart = mondayOf(today());
  let plans = []; let recipes = []; let custodyCount = {};
  const chips = circleChips(() => load(), { all: false });
  const grid = h('div', { class: 'meal-grid' });
  const nav = h('div', { class: 'row between center' },
    h('button', { class: 'btn small', onclick: () => { weekStart = addDays(weekStart, -7); load(); } }, '←'),
    h('strong', {}, ''),
    h('button', { class: 'btn small', onclick: () => { weekStart = addDays(weekStart, 7); load(); } }, '→'));
  const genBtn = h('button', { class: 'btn', onclick: () => act(async () => {
    const r = await post('/meal-plans/shopping-list', { circle_id: activeCircleId(), from: weekStart, to: addDays(weekStart, 6) });
    toast(r.meals ? `Liste de courses mise à jour depuis ${r.meals} repas planifié(s)` : "Aucun repas avec recette planifié cette semaine — rien à ajouter.");
  }) }, icon('cart', 16), ' Générer la liste de courses');
  append(root, pageHead('Repas', genBtn), chips, nav, grid);

  async function load() {
    const circleId = activeCircleId();
    if (!circleId) { mount(grid, emptyState('Créez un cercle pour planifier des repas.')); return; }
    const to = addDays(weekStart, 6);
    [plans, recipes] = await Promise.all([get(`/meal-plans?from=${weekStart}&to=${to}`), get('/recipes')]);
    plans = plans.filter((p) => p.circle_id === circleId);
    recipes = recipes.filter((r) => r.circle_id === circleId);
    let custody = [];
    try { custody = await get(`/custody?from=${weekStart}&to=${to}`); } catch { custody = []; }
    custodyCount = {};
    for (const n of custody) (custodyCount[n.date] ||= new Set()).add(n.child_id);
    draw();
  }
  onRefresh(['meal-plans', 'recipes'], load);

  function draw() {
    nav.querySelector('strong').textContent = `Semaine du ${weekStart.split('-').reverse().join('/')}`;
    const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    mount(grid,
      h('div', { class: 'meal-row meal-head' }, h('div', null), days.map((d) => h('div', { class: 'meal-day-head' },
        ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'][toDate(d).getDay() === 0 ? 6 : toDate(d).getDay() - 1], ' ', d.slice(8, 10),
        custodyCount[d] ? h('small', { class: 'muted' }, ` · ${custodyCount[d].size} enfant(s)`) : null))),
      SLOTS.map((s) => h('div', { class: 'meal-row' }, h('div', { class: 'meal-slot-label' }, s.label),
        days.map((d) => {
          const meal = plans.find((p) => p.date === d && p.slot === s.value);
          const recipe = meal && meal.recipe_id ? recipes.find((r) => r.id === meal.recipe_id) : null;
          return h('button', { type: 'button', class: 'meal-cell' + (meal ? ' filled' : ''), onclick: () => mealForm(activeCircleId(), d, s.value, recipes, meal, load) },
            meal ? h('div', null, h('strong', null, recipe ? recipe.title : meal.title || '—'), meal.servings ? h('small', { class: 'muted' }, ` ${meal.servings} pers.`) : null) : icon('plus', 14));
        }))));
  }

  await load();
}
