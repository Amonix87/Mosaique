// Visionneuse plein écran pour les PDF et les images (factures, documents) : une barre toujours visible
// avec un bouton « Fermer ». Sur iPhone, l'appli installée sur l'écran d'accueil n'a ni barre
// d'adresse ni bouton retour : ouvrir un PDF dans un onglet (target=_blank) y enferme l'utilisateur.
// Ici on reste dans l'appli. Les PDF sont dessinés page par page par pdf.js (chargé à la demande, une
// seule fois), car l'iframe PDF d'iOS n'affiche que la première page, sans défilement.
import { h, icon } from './core.js';

const PDFJS = '/vendor/pdfjs/pdf.min.mjs';
const WORKER = '/vendor/pdfjs/pdf.worker.min.mjs';
let pdfjsPromise = null;
const loadPdfjs = () => (pdfjsPromise ||= import(PDFJS).then((m) => { m.GlobalWorkerOptions.workerSrc = WORKER; return m; }).catch((e) => { pdfjsPromise = null; throw e; }));

const ZOOMS = [1, 1.5, 2, 3];

// { url, title, filename, downloadUrl, isPdf } — `url` sert le fichier en ligne (?inline=1).
export function openViewer({ url, title, filename, downloadUrl, isPdf }) {
  const body = h('div', { class: 'viewer-body' });
  const status = h('p', { class: 'viewer-status' }, 'Chargement…');
  body.append(status);
  let zoom = 0; let pdf = null; let token = 0;

  const zoomOut = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Zoom arrière', disabled: true, onclick: () => setZoom(zoom - 1) }, '−');
  const zoomIn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Zoom avant', onclick: () => setZoom(zoom + 1) }, '+');
  const close = h('button', { class: 'btn viewer-close', type: 'button', 'aria-label': 'Fermer', onclick: () => dlg.close() }, icon('x', 18), 'Fermer');
  const bar = h('div', { class: 'viewer-bar' },
    close,
    h('strong', { class: 'viewer-title' }, title || filename || ''),
    isPdf ? h('span', { class: 'viewer-zoom' }, zoomOut, zoomIn) : null,
    h('a', { class: 'icon-btn', href: downloadUrl || url, download: filename || '', 'aria-label': 'Télécharger' }, icon('download', 18)));
  const dlg = h('dialog', { class: 'viewer' }, bar, body);
  document.body.append(dlg);
  dlg.addEventListener('close', () => { token++; if (pdf) pdf.destroy(); dlg.remove(); });
  dlg.showModal();

  function fail(msg) {
    body.replaceChildren(h('div', { class: 'viewer-status' },
      h('p', null, msg),
      h('p', null, h('a', { class: 'btn', href: downloadUrl || url, download: filename || '' }, icon('download', 16), 'Télécharger le fichier'))));
  }

  async function draw() {
    const mine = ++token;
    const width = Math.max(body.clientWidth - 16, 200) * ZOOMS[zoom];
    const ratio = Math.min(window.devicePixelRatio || 1, 2.5);
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      if (mine !== token) return;
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: (width * ratio) / base.width });
      const canvas = h('canvas', { class: 'viewer-page' });
      canvas.width = Math.floor(viewport.width); canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(width)}px`; canvas.style.height = `${Math.floor(viewport.height / ratio)}px`;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      if (mine !== token) return;
      pages.push(canvas);
      if (n === 1) body.replaceChildren(...pages); else body.append(canvas); // la 1re page s'affiche sans attendre les autres
    }
  }
  function setZoom(z) {
    if (!pdf || z < 0 || z >= ZOOMS.length) return;
    zoom = z; zoomOut.disabled = z === 0; zoomIn.disabled = z === ZOOMS.length - 1;
    draw().catch(() => fail("Impossible d'afficher ce PDF."));
  }

  if (!isPdf) {
    body.replaceChildren(h('img', { class: 'viewer-img', src: url, alt: title || '' }));
    return;
  }
  loadPdfjs()
    .then((lib) => lib.getDocument({ url, withCredentials: true }).promise)
    .then((doc) => { pdf = doc; return draw(); })
    .catch(() => fail("Impossible d'afficher ce PDF dans l'application."));
}

// Raccourci pour un lien « Voir la facture » : garde le href (clic droit, nouvel onglet sur ordinateur)
// mais ouvre la visionneuse au clic normal.
export function viewerLink(attrs, spec, ...children) {
  return h('a', {
    ...attrs, href: spec.url,
    onclick: (e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return; e.preventDefault(); openViewer(spec); },
  }, ...children);
}
