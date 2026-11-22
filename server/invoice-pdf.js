'use strict';
/* Lecture du détail d'une facture périscolaire PDF (portail Berger-Levrault / JasperReports).
   Le PDF est un vrai PDF texte : chaque ligne de facture porte son service, son prix unitaire, sa
   quantité, son total, et sous elle la liste exacte des jours concernés (« 09 - ma08 ve04 » = le mardi 8
   et le vendredi 4 du mois 09). Aucune dépendance : zlib de Node et quelques expressions régulières.

   parseInvoicePdf(buffer) → {
     total_cents, period: {from, to}, range: {from, to}, child_name,
     lines: [{ label, kind, absence, pu_cents, qty, total_cents, dates: ['2026-09-08', …] }],
     warnings: [...]
   } ou null si le fichier n'a pas la forme attendue (on ne devine alors rien). */
const zlib = require('zlib');

const DAYS = ['di', 'lu', 'ma', 'me', 'je', 've', 'sa'];

function streamsOf(buf) {
  const s = buf.toString('latin1');
  const out = [];
  const re = /<<([^<>]*?)>>\s*stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const len = /\/Length (\d+)/.exec(m[1]);
    const end = len ? start + Number(len[1]) : s.indexOf('endstream', start);
    if (end < start) break;
    if (/FlateDecode/.test(m[1])) {
      for (const stop of [end, end - 1, end - 2]) {
        try { out.push(zlib.inflateSync(buf.subarray(start, stop)).toString('latin1').replace(/\x80/g, '€')); break; } catch { /* essai suivant */ }
      }
    }
    re.lastIndex = Math.max(end, start);
  }
  return out;
}

const unescapePdf = (t) => t
  .replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
  .replace(/\\([()\\nrtbf])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[c] || c));

// Les lignes de texte d'une page, de haut en bas ; chacune est la liste de ses morceaux, de gauche à droite.
function rowsOf(content) {
  const items = [];
  for (const mm of content.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm\s*\/F\d+ [\d.]+ Tf[\s\S]*?\(((?:[^()\\]|\\.)*)\)Tj/g)) {
    const t = unescapePdf(mm[3]);
    if (!t.trim() || t.includes('\u0000')) continue; // l'adresse du destinataire utilise une police encodée : sans intérêt ici
    items.push({ x: Number(mm[1]), y: Number(mm[2]), t });
  }
  items.sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const it of items) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - it.y) < 2) last.cells.push(it); else rows.push({ y: it.y, cells: [it] });
  }
  return rows.map((r) => r.cells.sort((a, b) => a.x - b.x).map((c) => c.t));
}

const cents = (txt) => Math.round(parseFloat(String(txt).replace(',', '.').replace(/[^\d.\-]/g, '')) * 100);
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const frDate = (s) => { const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(s); return m ? iso(m[3], m[2], m[1]) : null; };

function kindOf(label) {
  const l = label.toUpperCase();
  if (l.includes('REPAS')) return 'cantine';
  if (l.includes('ALSH') || l.includes('ACCUEIL DE LOISIRS')) return 'alsh';
  if (l.includes('GARDERIE MATIN')) return 'garderie_matin';
  if (l.includes('GARDERIE SOIR')) return 'garderie_soir';
  if (l.includes('MERCREDI MATIN')) return 'mercredi_matin';
  if (l.includes('MERCREDI APRES') || l.includes('MERCREDI APRÈS')) return 'mercredi_apres_midi';
  return 'autre';
}

// Les dates d'une rangée « 09  -  ma08 ve04 » n'ont pas d'année. Le jour de la semaine (« ma ») la donne :
// parmi les années couvertes par la facture, on garde celle où ce jour tombe bien un mardi.
function datesOfRow(row, years, warnings) {
  const m = /^(\d{2})\s+-\s+(.+)$/.exec(row);
  if (!m) return [];
  const month = Number(m[1]);
  const out = [];
  for (const tok of m[2].trim().split(/\s+/)) {
    const t = /^([a-z]{2})(\d{1,2})$/.exec(tok);
    if (!t) { warnings.push(`jour illisible « ${tok} »`); continue; }
    const year = years.find((y) => DAYS[new Date(Date.UTC(y, month - 1, Number(t[2]))).getUTCDay()] === t[1]);
    if (year === undefined) { warnings.push(`jour incohérent « ${tok} » (mois ${m[1]})`); continue; }
    out.push(iso(year, month, Number(t[2])));
  }
  return out;
}

function parseInvoicePdf(buf) {
  if (!Buffer.isBuffer(buf) || buf.subarray(0, 5).toString() !== '%PDF-') return null;
  const rows = streamsOf(buf).filter((c) => /\bTj\b/.test(c)).flatMap(rowsOf);
  const flat = rows.map((r) => r.join(' | '));
  const warnings = [];
  const head = flat.find((l) => /^Période du/.test(l));
  const pm = head && /Période du (\d{2}\/\d{2}\/\d{4}) au (\d{2}\/\d{2}\/\d{4})/.exec(head);
  if (!pm) return null;
  const period = { from: frDate(pm[1]), to: frDate(pm[2]) };
  const rm = /Régularisation du (\d{2}\/\d{2}\/\d{4}) au (\d{2}\/\d{2}\/\d{4})/.exec(head);
  const reg = rm ? { from: frDate(rm[1]), to: frDate(rm[2]) } : null;
  const range = { from: reg && reg.from < period.from ? reg.from : period.from, to: reg && reg.to > period.to ? reg.to : period.to };
  const years = [];
  for (let y = Number(range.from.slice(0, 4)); y <= Number(range.to.slice(0, 4)); y++) years.push(y);
  const ti = flat.indexOf('Total TTC');
  if (ti < 0 || !flat[ti + 1]) return null;
  const total = cents(flat[ti + 1]);
  const childRow = flat.filter((l) => /né\(?e?\)? le \d{2}\/\d{2}\/\d{4}/.test(l));
  if (childRow.length !== 1) return null; // plusieurs enfants sur une même facture : pas de devinette
  const lines = [];
  let cur = null;
  for (let i = 0; i < rows.length; i++) {
    const c = rows[i];
    if (c.length === 4 && /€\s*$/.test(c[3]) && /^[\d.,]+$/.test(c[1]) && /^\d+$/.test(c[2])) {
      cur = { label: c[0].trim(), kind: kindOf(c[0]), absence: /absence/i.test(c[0]), pu_cents: cents(c[1]), qty: Number(c[2]), total_cents: cents(c[3]), dates: [] };
      lines.push(cur);
    } else if (cur && /^\d{2}\s+-\s+/.test(flat[i])) {
      cur.dates.push(...datesOfRow(flat[i], years, warnings));
    } else if (flat[i] === 'Total TTC') cur = null;
  }
  if (!lines.length) return null;
  for (const l of lines) {
    if (l.dates.length !== l.qty) warnings.push(`« ${l.label} » : ${l.dates.length} jour(s) lus pour une quantité de ${l.qty}`);
  }
  const sum = lines.reduce((a, l) => a + l.total_cents, 0);
  if (sum !== total) warnings.push(`somme des lignes ${sum / 100} différente du total ${total / 100}`);
  return { total_cents: total, period, range, child_name: childRow[0].replace(/\s*né\(?e?\)? le .*$/, '').trim(), lines, warnings };
}

module.exports = { parseInvoicePdf, kindOf, _datesOfRow: datesOfRow };
