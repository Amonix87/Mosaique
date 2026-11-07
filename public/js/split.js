// Répartition d'une dépense entre des personnes, en pourcentages — toujours égale à 100 % au total.
//
// Aucune dépendance au navigateur : ces fonctions sont aussi chargées par les tests (test/smoke.js).
// Les calculs se font en dixièmes de pour cent (entiers), pour que la somme tombe juste à tous les
// coups, sans erreur d'arrondi flottant. Chaque fonction renvoie un NOUVEL objet { idPersonne: pourcentage },
// sans modifier celui qu'on lui passe ; les `ids` donnent l'ordre des personnes (celui de la barre).

const T = 10; // résolution : 10 = un dixième de pour cent
const FULL = 100 * T;

const tenths = (p) => Math.round((Number(p) || 0) * T);

// Partage à égalité : 3 personnes → 33,3 / 33,3 / 33,4 (la dernière absorbe le reste).
export function equalSplit(ids) {
  const n = ids.length;
  const out = {};
  if (!n) return out;
  const base = Math.floor(FULL / n);
  ids.forEach((id, i) => { out[id] = (i === n - 1 ? FULL - base * (n - 1) : base) / T; });
  return out;
}

export const total = (split) => Object.values(split).reduce((a, b) => a + b, 0);
export const isFull = (split) => Math.abs(total(split) - 100) <= 0.01;

// Positions (en dixièmes de %) des n-1 limites entre deux personnes consécutives de la barre.
export function boundaries(ids, split) {
  const out = [];
  let acc = 0;
  for (let k = 0; k < ids.length - 1; k++) {
    acc += (Number(split[ids[k]]) || 0) * T;
    out.push(Math.round(acc));
  }
  return out;
}

// Déplace la limite située juste après ids[index] à `pct` % de la barre. Elle ne peut pas franchir
// les limites voisines : seules les deux parts qu'elle sépare changent, les autres restent intactes.
export function moveBoundary(ids, split, index, pct) {
  const b = boundaries(ids, split);
  if (index < 0 || index >= b.length) return { ...split };
  const lo = index > 0 ? b[index - 1] : 0;
  const hi = index < b.length - 1 ? b[index + 1] : FULL;
  b[index] = Math.min(hi, Math.max(lo, tenths(pct)));
  const out = {};
  ids.forEach((id, k) => { out[id] = ((k < b.length ? b[k] : FULL) - (k > 0 ? b[k - 1] : 0)) / T; });
  return out;
}

// Fixe la part d'une personne à `pct` % ; les autres se partagent le reste, au prorata de ce qu'elles
// avaient (à égalité si elles étaient toutes à 0).
export function setShare(ids, split, id, pct) {
  const others = ids.filter((x) => x !== id);
  if (!others.length) return { [id]: 100 };
  const mine = Math.min(FULL, Math.max(0, tenths(pct)));
  const rest = FULL - mine;
  const cur = others.map((x) => tenths(split[x]));
  const curSum = cur.reduce((a, b) => a + b, 0);
  const next = curSum > 0
    ? cur.map((t) => Math.floor((t * rest) / curSum))
    : others.map(() => Math.floor(rest / others.length));
  // Le reliquat des arrondis (quelques dixièmes) va à la part la plus grande, là où il se remarque le moins.
  let left = rest - next.reduce((a, b) => a + b, 0);
  const order = next.map((t, i) => i).sort((a, b) => next[b] - next[a]);
  for (let i = 0; left > 0; i = (i + 1) % order.length, left--) next[order[i]]++;
  const out = { [id]: mine / T };
  others.forEach((x, i) => { out[x] = next[i] / T; });
  // Rend l'objet dans l'ordre de `ids`, comme les autres fonctions.
  return Object.fromEntries(ids.map((x) => [x, out[x]]));
}

// « 33,3 » / « 50 » — pourcentage à la française, sans décimale inutile.
export const fmtPct = (v) => String(Math.round(v * T) / T).replace('.', ',');
