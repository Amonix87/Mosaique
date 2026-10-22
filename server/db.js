'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR || path.join(DATA_DIR, 'uploads', 'posts'));
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'mosaique.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#2C3E9F',
  is_admin INTEGER NOT NULL DEFAULT 0,
  ical_token TEXT NOT NULL,
  email_notify INTEGER NOT NULL DEFAULT 0,
  claimed INTEGER NOT NULL DEFAULT 1,
  partner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  app_installed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  token TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  circle_ids TEXT NOT NULL DEFAULT '[]',
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS circles (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#17A2A2'
);

CREATE TABLE IF NOT EXISTS circle_members (
  circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (circle_id, user_id)
);

CREATE TABLE IF NOT EXISTS children (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#E4572E',
  birthdate TEXT,
  parent_ids TEXT NOT NULL DEFAULT '[]',
  viewer_ids TEXT NOT NULL DEFAULT '[]',
  shared_custody INTEGER NOT NULL DEFAULT 1,
  handover_location TEXT,
  handover_time TEXT,
  zone TEXT NOT NULL DEFAULT 'B'
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  all_day INTEGER NOT NULL DEFAULT 0,
  location TEXT,
  location_lat REAL,
  location_lon REAL,
  notes TEXT,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  owner_mode TEXT NOT NULL DEFAULT 'manual',
  child_ids TEXT NOT NULL DEFAULT '[]',
  repeat TEXT NOT NULL DEFAULT 'none',
  repeat_until TEXT,
  exdates TEXT NOT NULL DEFAULT '[]',
  reminder_minutes INTEGER,
  category TEXT,
  price_cents INTEGER,
  price_paid_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS custody_nights (
  date TEXT NOT NULL,
  child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  parent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (date, child_id)
);

CREATE TABLE IF NOT EXISTS swap_requests (
  id INTEGER PRIMARY KEY,
  requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  child_ids TEXT NOT NULL,
  date_from TEXT NOT NULL,
  date_to TEXT NOT NULL,
  new_parent_id INTEGER NOT NULL,
  message TEXT,
  location TEXT,
  time TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at TEXT
);

CREATE TABLE IF NOT EXISTS sos (
  id INTEGER PRIMARY KEY,
  circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  event_id INTEGER,
  title TEXT NOT NULL,
  note TEXT,
  requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open',
  taken_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  taken_at TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  due TEXT,
  assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  done INTEGER NOT NULL DEFAULT 0,
  done_at TEXT,
  remind_at TEXT,
  reminded INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shopping_items (
  id INTEGER PRIMARY KEY,
  circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  list TEXT NOT NULL DEFAULT 'Courses',
  label TEXT NOT NULL,
  qty TEXT,
  category TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY,
  circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  category TEXT,
  date TEXT NOT NULL,
  paid_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  split TEXT NOT NULL,
  child_id INTEGER REFERENCES children(id) ON DELETE SET NULL,
  document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  recurring_id INTEGER REFERENCES recurring_expenses(id) ON DELETE SET NULL,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Dépenses récurrentes : un « modèle » qui génère une vraie dépense à chaque échéance
-- (voir generateRecurringExpenses dans index.js). « generated » = nombre d'échéances déjà créées.
CREATE TABLE IF NOT EXISTS recurring_expenses (
  id INTEGER PRIMARY KEY,
  circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  category TEXT,
  paid_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  split TEXT NOT NULL,
  child_id INTEGER REFERENCES children(id) ON DELETE SET NULL,
  repeat TEXT NOT NULL,
  start_date TEXT NOT NULL,
  repeat_until TEXT,
  generated INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settlements (
  id INTEGER PRIMARY KEY,
  circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  from_user INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  date TEXT NOT NULL,
  note TEXT,
  created_by INTEGER
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  category TEXT,
  filename TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT,
  size INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS homework (
  id INTEGER PRIMARY KEY,
  child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  subject TEXT,
  title TEXT NOT NULL,
  description TEXT,
  due_date TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'pronote',
  external_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_homework_ext ON homework(child_id, source, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS school_notes (
  id INTEGER PRIMARY KEY,
  child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT,
  date TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'pronote',
  external_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_ext ON school_notes(child_id, source, external_id) WHERE external_id IS NOT NULL;

-- Réservations périscolaires (garderie, cantine, ALSH...) : même principe que les devoirs/mots,
-- reçues depuis l'extérieur (ex. portail e-portail Berger-Levrault via un script de synchronisation),
-- jamais saisies à la main dans Mosaïque.
CREATE TABLE IF NOT EXISTS school_reservations (
  id INTEGER PRIMARY KEY,
  child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  status TEXT,
  source TEXT NOT NULL DEFAULT 'eportail',
  external_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reservations_ext ON school_reservations(child_id, source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reservations_child_date ON school_reservations(child_id, date);

-- Factures périscolaires (cantine, ALSH...) : reçues de la même façon. Rattachées à un cercle (pas à
-- un enfant) car une facture de collectivité couvre généralement plusieurs prestations à la fois.
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  due_date TEXT,
  amount_cents INTEGER NOT NULL,
  status TEXT,
  source TEXT NOT NULL DEFAULT 'eportail',
  external_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_ext ON invoices(circle_id, source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_circle_date ON invoices(circle_id, date);

CREATE TABLE IF NOT EXISTS recipes (
  id INTEGER PRIMARY KEY,
  circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  ingredients TEXT,
  ingredients_json TEXT NOT NULL DEFAULT '[]',
  servings INTEGER,
  instructions TEXT,
  rating_global INTEGER,
  child_ratings TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meal_plans (
  id INTEGER PRIMARY KEY,
  circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  slot TEXT NOT NULL DEFAULT 'diner',
  recipe_id INTEGER REFERENCES recipes(id) ON DELETE SET NULL,
  title TEXT,
  servings INTEGER,
  notes TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_meal_plans_slot ON meal_plans(circle_id, date, slot);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  notes TEXT,
  child_id INTEGER REFERENCES children(id) ON DELETE SET NULL,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  body TEXT,
  photo_name TEXT,
  photo_mime TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_circle ON events(circle_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_custody_date ON custody_nights(date);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read);
CREATE INDEX IF NOT EXISTS idx_messages_circle ON messages(circle_id, id);

-- SQLite n'indexe pas les clés étrangères par défaut : chaque écran filtre ses listes par
-- circle_id, donc sans ces index chaque chargement fait un scan complet de la table.
CREATE INDEX IF NOT EXISTS idx_expenses_circle ON expenses(circle_id, date);
CREATE INDEX IF NOT EXISTS idx_tasks_circle ON tasks(circle_id);
CREATE INDEX IF NOT EXISTS idx_shopping_circle ON shopping_items(circle_id);
CREATE INDEX IF NOT EXISTS idx_documents_circle ON documents(circle_id);
CREATE INDEX IF NOT EXISTS idx_sos_circle ON sos(circle_id);
CREATE INDEX IF NOT EXISTS idx_recurring_expenses_circle ON recurring_expenses(circle_id);
CREATE INDEX IF NOT EXISTS idx_recipes_circle ON recipes(circle_id);
CREATE INDEX IF NOT EXISTS idx_posts_circle ON posts(circle_id, id);
CREATE INDEX IF NOT EXISTS idx_homework_child ON homework(child_id);
CREATE INDEX IF NOT EXISTS idx_notes_child ON school_notes(child_id);
`);

// Migration légère pour les bases créées avant l'ajout de parent_ids (ne recrée jamais une table existante).
const childCols = db.prepare("PRAGMA table_info(children)").all().map((c) => c.name);
if (!childCols.includes('parent_ids')) {
  db.exec("ALTER TABLE children ADD COLUMN parent_ids TEXT NOT NULL DEFAULT '[]'");
}
if (!childCols.includes('viewer_ids')) {
  db.exec("ALTER TABLE children ADD COLUMN viewer_ids TEXT NOT NULL DEFAULT '[]'");
}
if (!childCols.includes('shared_custody')) {
  db.exec('ALTER TABLE children ADD COLUMN shared_custody INTEGER NOT NULL DEFAULT 1');
}
if (!childCols.includes('handover_location')) {
  db.exec('ALTER TABLE children ADD COLUMN handover_location TEXT');
  db.exec('ALTER TABLE children ADD COLUMN handover_time TEXT');
}
const eventCols = db.prepare("PRAGMA table_info(events)").all().map((c) => c.name);
if (!eventCols.includes('owner_mode')) {
  db.exec("ALTER TABLE events ADD COLUMN owner_mode TEXT NOT NULL DEFAULT 'manual'");
}
if (!childCols.includes('zone')) {
  db.exec("ALTER TABLE children ADD COLUMN zone TEXT NOT NULL DEFAULT 'B'");
  // Reprend l'ancienne zone unique de la famille (si réglée) comme valeur de départ pour chaque enfant existant.
  const prevZone = db.prepare("SELECT value FROM settings WHERE key='zone'").get();
  if (prevZone && ['A', 'B', 'C'].includes(prevZone.value)) {
    db.prepare('UPDATE children SET zone=?').run(prevZone.value);
  }
}
const userCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
if (!userCols.includes('email_notify')) {
  db.exec('ALTER TABLE users ADD COLUMN email_notify INTEGER NOT NULL DEFAULT 0');
}
if (!userCols.includes('claimed')) {
  db.exec('ALTER TABLE users ADD COLUMN claimed INTEGER NOT NULL DEFAULT 1');
}
if (!userCols.includes('homework_recap')) {
  db.exec('ALTER TABLE users ADD COLUMN homework_recap INTEGER NOT NULL DEFAULT 0');
}
const inviteCols = db.prepare("PRAGMA table_info(invites)").all().map((c) => c.name);
if (!inviteCols.includes('user_id')) {
  db.exec('ALTER TABLE invites ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
  // Les invitations en attente créées avant cette mise à jour n'ont pas de compte associé : elles sont invalidées.
  db.exec('DELETE FROM invites WHERE user_id IS NULL');
}
const expenseCols = db.prepare("PRAGMA table_info(expenses)").all().map((c) => c.name);
if (!expenseCols.includes('child_id')) {
  db.exec('ALTER TABLE expenses ADD COLUMN child_id INTEGER REFERENCES children(id) ON DELETE SET NULL');
}
if (!expenseCols.includes('document_id')) {
  db.exec('ALTER TABLE expenses ADD COLUMN document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL');
}
const swapCols = db.prepare("PRAGMA table_info(swap_requests)").all().map((c) => c.name);
if (!swapCols.includes('location')) {
  db.exec('ALTER TABLE swap_requests ADD COLUMN location TEXT');
  db.exec('ALTER TABLE swap_requests ADD COLUMN time TEXT');
}
if (!eventCols.includes('exdates')) {
  db.exec("ALTER TABLE events ADD COLUMN exdates TEXT NOT NULL DEFAULT '[]'");
}
if (!eventCols.includes('location_lat')) {
  db.exec('ALTER TABLE events ADD COLUMN location_lat REAL');
  db.exec('ALTER TABLE events ADD COLUMN location_lon REAL');
}
if (!userCols.includes('app_installed_at')) {
  db.exec('ALTER TABLE users ADD COLUMN app_installed_at TEXT');
}
if (!userCols.includes('partner_id')) {
  db.exec('ALTER TABLE users ADD COLUMN partner_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
}
if (!eventCols.includes('reminder_minutes')) {
  db.exec('ALTER TABLE events ADD COLUMN reminder_minutes INTEGER');
}
if (!eventCols.includes('category')) {
  db.exec('ALTER TABLE events ADD COLUMN category TEXT');
  db.exec('ALTER TABLE events ADD COLUMN price_cents INTEGER');
}
if (!expenseCols.includes('event_id')) {
  db.exec('ALTER TABLE expenses ADD COLUMN event_id INTEGER REFERENCES events(id) ON DELETE SET NULL');
  db.exec('ALTER TABLE expenses ADD COLUMN recurring_id INTEGER REFERENCES recurring_expenses(id) ON DELETE SET NULL');
}
if (!eventCols.includes('price_paid_by')) {
  db.exec('ALTER TABLE events ADD COLUMN price_paid_by INTEGER REFERENCES users(id) ON DELETE SET NULL');
  // Les prix saisis avant l'existence de ce champ : le payeur est celui de la dépense déjà créée.
  db.exec('UPDATE events SET price_paid_by=(SELECT paid_by FROM expenses WHERE expenses.event_id=events.id) WHERE price_cents IS NOT NULL');
}
const settlementCols = db.prepare("PRAGMA table_info(settlements)").all().map((c) => c.name);
if (!settlementCols.includes('created_by')) {
  db.exec('ALTER TABLE settlements ADD COLUMN created_by INTEGER');
}
db.exec(`CREATE TABLE IF NOT EXISTS event_reminders_sent (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  occurrence_date TEXT NOT NULL,
  PRIMARY KEY (event_id, occurrence_date)
)`);
const shoppingCols = db.prepare("PRAGMA table_info(shopping_items)").all().map((c) => c.name);
if (!shoppingCols.includes('category')) {
  db.exec('ALTER TABLE shopping_items ADD COLUMN category TEXT');
}
const recipeCols2 = db.prepare("PRAGMA table_info(recipes)").all().map((c) => c.name);
if (!recipeCols2.includes('servings')) {
  db.exec("ALTER TABLE recipes ADD COLUMN ingredients_json TEXT NOT NULL DEFAULT '[]'");
  db.exec('ALTER TABLE recipes ADD COLUMN servings INTEGER');
}

// Pour un événement ponctuel où le dépôt et la récupération ne sont pas faits par la même
// personne (ex. : vous amenez l'enfant à son sport, mais c'est sa mère qui vient le rechercher) —
// par défaut (NULL), les deux restent celles du responsable habituel de l'événement.
const eventCols3 = db.prepare("PRAGMA table_info(events)").all().map((c) => c.name);
if (!eventCols3.includes('dropoff_by')) {
  db.exec('ALTER TABLE events ADD COLUMN dropoff_by INTEGER REFERENCES users(id) ON DELETE SET NULL');
  db.exec('ALTER TABLE events ADD COLUMN pickup_by INTEGER REFERENCES users(id) ON DELETE SET NULL');
}

// Un contact peut désormais appartenir à plusieurs cercles à la fois (ex. partagé entre « Famille »
// et « Coparents »). On reconstruit la table plutôt qu'un simple ADD COLUMN, pour retirer la clé
// étrangère circle_id -> circles : avec elle, supprimer UN SEUL des cercles d'un contact aurait
// supprimé tout le contact (cascade), même s'il restait rattaché à d'autres cercles.
const contactCols = db.prepare("PRAGMA table_info(contacts)").all().map((c) => c.name);
if (contactCols.includes('circle_id')) {
  db.exec(`
    CREATE TABLE contacts_new (
      id INTEGER PRIMARY KEY,
      circle_ids TEXT NOT NULL DEFAULT '[]',
      name TEXT NOT NULL,
      category TEXT,
      phone TEXT,
      email TEXT,
      address TEXT,
      notes TEXT,
      child_id INTEGER REFERENCES children(id) ON DELETE SET NULL,
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO contacts_new (id, circle_ids, name, category, phone, email, address, notes, child_id, created_by, created_at)
      SELECT id, '[' || circle_id || ']', name, category, phone, email, address, notes, child_id, created_by, created_at FROM contacts;
    DROP TABLE contacts;
    ALTER TABLE contacts_new RENAME TO contacts;
  `);
}
const contactCols2 = db.prepare("PRAGMA table_info(contacts)").all().map((c) => c.name);
if (!contactCols2.includes('favorite')) {
  db.exec('ALTER TABLE contacts ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0');
}

// Petite fiche santé par enfant (groupe sanguin, allergies, médecin traitant) : utile à retrouver
// vite (babysitter, urgence) sans avoir à fouiller les notes éparpillées dans Contacts.
const childCols2 = db.prepare("PRAGMA table_info(children)").all().map((c) => c.name);
if (!childCols2.includes('blood_type')) {
  db.exec('ALTER TABLE children ADD COLUMN blood_type TEXT');
  db.exec('ALTER TABLE children ADD COLUMN allergies TEXT');
  db.exec('ALTER TABLE children ADD COLUMN doctor_name TEXT');
  db.exec('ALTER TABLE children ADD COLUMN doctor_phone TEXT');
}

// Les factures périscolaires (reçues par addon) vivent désormais dans Budget plutôt que comme une
// simple liste passive dans École : elles apparaissent « en attente » jusqu'à ce qu'on les attribue
// à quelqu'un qui va les payer (assigned_to) ou qu'on les marque payées, ce qui crée une vraie
// dépense partagée (expense_id) — supprimer cette dépense redonne automatiquement la facture en
// attente (ON DELETE SET NULL).
const invoiceCols = db.prepare("PRAGMA table_info(invoices)").all().map((c) => c.name);
if (!invoiceCols.includes('assigned_to')) {
  db.exec('ALTER TABLE invoices ADD COLUMN assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL');
  db.exec('ALTER TABLE invoices ADD COLUMN expense_id INTEGER REFERENCES expenses(id) ON DELETE SET NULL');
}

// Journal des notifications « vacances réservables » déjà envoyées (une ligne par enfant, période de
// vacances et étape — ouverture estimée / rappel une semaine après), pour ne jamais en envoyer deux
// fois pour la même période. period_key identifie la période de façon stable (ex. "Printemps-2027-04-17").
db.exec(`
  CREATE TABLE IF NOT EXISTS holiday_notices (
    id INTEGER PRIMARY KEY,
    child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
    period_key TEXT NOT NULL,
    stage TEXT NOT NULL,
    sent_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_holiday_notices ON holiday_notices(child_id, period_key, stage);
`);

// Une facture importée dit à quel enfant elle correspond (child_id, pour les familles avec plusieurs
// enfants suivis) et peut rester SANS cercle (circle_id devient facultatif) : avec plusieurs cercles
// (familles recomposées, garde partagée...), un addon ne peut pas toujours deviner le bon cercle tout
// seul — mieux vaut la garder « en attente d'attribution » (visible des administrateurs, voir
// GET /invoices) que de la perdre silencieusement comme avant. On reconstruit la table pour retirer
// le NOT NULL sur circle_id (SQLite ne permet pas de l'enlever par un simple ALTER TABLE).
const invoiceCols2 = db.prepare("PRAGMA table_info(invoices)").all();
if (invoiceCols2.find((c) => c.name === 'circle_id')?.notnull) {
  db.exec(`
    CREATE TABLE invoices_new (
      id INTEGER PRIMARY KEY,
      circle_id INTEGER REFERENCES circles(id) ON DELETE CASCADE,
      child_id INTEGER REFERENCES children(id) ON DELETE SET NULL,
      label TEXT NOT NULL,
      number TEXT NOT NULL,
      date TEXT NOT NULL,
      due_date TEXT,
      amount_cents INTEGER NOT NULL,
      status TEXT,
      source TEXT NOT NULL DEFAULT 'eportail',
      external_id TEXT,
      assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
      expense_id INTEGER REFERENCES expenses(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO invoices_new (id, circle_id, label, number, date, due_date, amount_cents, status, source, external_id, assigned_to, expense_id, created_at, updated_at)
      SELECT id, circle_id, label, number, date, due_date, amount_cents, status, source, external_id, assigned_to, expense_id, created_at, updated_at FROM invoices;
    DROP TABLE invoices;
    ALTER TABLE invoices_new RENAME TO invoices;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_ext ON invoices(circle_id, source, external_id) WHERE external_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_invoices_circle_date ON invoices(circle_id, date);
  `);
}

module.exports = { db, DATA_DIR, MEDIA_DIR };
