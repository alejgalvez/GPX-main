const fs = require("fs");
const path = require("path");

/**
 * Tabla: usuarios
 * Seed: migra data/users.json si existe y la tabla está vacía.
 */
module.exports = function initializeUsuarios(db) {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      phone TEXT,
      country_code TEXT,
      frozen INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();

  // Acomodar migración en esquemas existentes: añadir columnas si faltan
  const cols = db.prepare("PRAGMA table_info('usuarios')").all().map(c => c.name);
  if (!cols.includes('phone')) {
    try { db.prepare("ALTER TABLE usuarios ADD COLUMN phone TEXT").run(); } catch (e) { }
  }
  if (!cols.includes('country_code')) {
    try { db.prepare("ALTER TABLE usuarios ADD COLUMN country_code TEXT").run(); } catch (e) { }
  }
  if (!cols.includes('frozen')) {
    try { db.prepare("ALTER TABLE usuarios ADD COLUMN frozen INTEGER NOT NULL DEFAULT 0").run(); } catch (e) { }
  }

  const total = db.prepare("SELECT COUNT(*) AS total FROM usuarios").get().total;
  if (total > 0) return;

  // Seed desde JSON (si existe)
  const usersPath = path.join(__dirname, "..", "data", "users.json");
  if (!fs.existsSync(usersPath)) return;

  let users = [];
  try {
    users = JSON.parse(fs.readFileSync(usersPath, "utf8"));
  } catch (e) {
    console.error("Error leyendo users.json para seed:", e);
    return;
  }

  const insert = db.prepare(
    "INSERT INTO usuarios (id, name, email, password, phone, country_code) VALUES (?, ?, ?, ?, ?, ?)"
  );

  const tx = db.transaction((rows) => {
    for (const u of rows) {
      insert.run(u.id, u.name, u.email, u.password, u.phone || null, u.country_code || null);
    }
  });

  try {
    tx(users);
  } catch (e) {
    console.error("Error haciendo seed de usuarios:", e);
  }
};
