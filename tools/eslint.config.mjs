// Vérification statique, sans aucune dépendance ajoutée au projet (voir tools/lint.sh).
// Elle détecte les identifiants non définis — imports oubliés, fautes de frappe — que « node --check »
// ne voit pas parce qu'ils ne cassent qu'à l'exécution, en ouvrant la page concernée.
const readonly = (names) => Object.fromEntries(names.split(/\s+/).filter(Boolean).map((n) => [n, 'readonly']));
const common = 'console setTimeout clearTimeout setInterval clearInterval Promise Intl URL URLSearchParams FormData Blob AbortController TextEncoder TextDecoder structuredClone fetch Response Request Headers Uint8Array ArrayBuffer atob btoa';
const browser = readonly(`${common} window document navigator location history localStorage sessionStorage File FileReader EventSource Notification PushManager ServiceWorkerRegistration requestAnimationFrame cancelAnimationFrame Node Event CustomEvent HTMLElement matchMedia performance self caches clients registration confirm alert prompt CSS getComputedStyle`);
const node = readonly(`${common} require module exports process __dirname __filename Buffer setImmediate`);
const rules = { 'no-undef': 'error', 'no-redeclare': 'error', 'no-dupe-keys': 'error' };

export default [
  { files: ['public/**/*.js'], languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: browser }, rules },
  { files: ['server/**/*.js', 'test/**/*.js'], languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: node }, rules },
];
