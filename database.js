/**
 * VOOAR — database.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Banco de dados SQLite usando better-sqlite3.
 *
 * • Cria o banco em data/vooar.db (persistente entre reinicializações)
 * • Migra dados existentes dos arquivos JSON legados automaticamente
 * • Expõe API síncrona para users e projects
 * • Garante conta do admin (Joabe Soares) sempre presente
 * ─────────────────────────────────────────────────────────────────────────────
 */

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

// ── Diretório de dados (usa STORAGE_DIR em produção na nuvem) ────────────────
const STORAGE_DIR = process.env.STORAGE_DIR || __dirname;
const DATA_DIR    = path.join(STORAGE_DIR, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'vooar.db');

// ── Abre / cria banco ─────────────────────────────────────────────────────────
const db = new Database(DB_PATH);

// Performance: WAL mode para leituras concorrentes mais rápidas
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    email      TEXT    UNIQUE NOT NULL,
    password   TEXT,
    is_admin   INTEGER DEFAULT 0,
    role       TEXT    DEFAULT 'user',
    plan       TEXT    DEFAULT 'Free',
    avatar     TEXT,
    created_at TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    name        TEXT    NOT NULL DEFAULT 'Sem nome',
    views       INTEGER DEFAULT 0,
    data        TEXT    NOT NULL DEFAULT '{}',
    created_at  TEXT    DEFAULT (datetime('now')),
    updated_at  TEXT    DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
  CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at DESC);
`);

// ── Helpers internos ──────────────────────────────────────────────────────────
function readJSON(file, fallback = []) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

// ── Migração de JSON → SQLite ─────────────────────────────────────────────────
function migrateFromJSON() {
  const migrated = db.prepare(`SELECT COUNT(*) as n FROM users`).get().n > 0;
  if (migrated) return; // já migrado

  console.log('[DB] Migrando dados JSON para SQLite...');

  // Users
  const usersFile = path.join(DATA_DIR, 'users.json');
  const users     = readJSON(usersFile, []);

  const insertUser = db.prepare(`
    INSERT OR IGNORE INTO users (id, name, email, password, is_admin, role, plan, avatar, created_at)
    VALUES (@id, @name, @email, @password, @is_admin, @role, @plan, @avatar, @created_at)
  `);

  const migrateUsers = db.transaction((list) => {
    for (const u of list) {
      insertUser.run({
        id:         u.id,
        name:       u.name       || 'Usuário',
        email:      u.email      || `user_${u.id}@vooar.dev`,
        password:   u.password   || null,
        is_admin:   u.isAdmin    ? 1 : 0,
        role:       u.role       || 'user',
        plan:       u.plan       || 'Free',
        avatar:     u.avatar     || null,
        created_at: u.createdAt  || new Date().toISOString(),
      });
    }
  });
  migrateUsers(users);

  // Projects (por usuário)
  const insertProject = db.prepare(`
    INSERT OR IGNORE INTO projects (id, user_id, name, views, data, created_at, updated_at)
    VALUES (@id, @user_id, @name, @views, @data, @created_at, @updated_at)
  `);

  const migrateProjects = db.transaction((list, userId) => {
    for (const p of list) {
      insertProject.run({
        id:         p.id,
        user_id:    userId,
        name:       p.name      || 'Sem nome',
        views:      p.views     || 0,
        data:       JSON.stringify(p),
        created_at: p.createdAt || new Date().toISOString(),
        updated_at: p.updatedAt || new Date().toISOString(),
      });
    }
  });

  for (const u of users) {
    const projFile = path.join(DATA_DIR, `projects_${u.id}.json`);
    const projects = readJSON(projFile, []);
    if (projects.length > 0) migrateProjects(projects, u.id);
  }

  console.log(`[DB] Migração concluída: ${users.length} usuários`);
}

// ── Admin padrão (Joabe Soares) ───────────────────────────────────────────────
const ADMIN = {
  id:         1,
  name:       'Joabe Soares',
  email:      'joabe@vooar.dev',
  password:   'VooarDev@2025',
  is_admin:   1,
  role:       'Desenvolvedor',
  plan:       'Developer',
  avatar:     null,
  created_at: '2025-01-01T00:00:00.000Z',
};

function ensureAdmin() {
  const exists = db.prepare(`SELECT id FROM users WHERE id = ?`).get(ADMIN.id);
  if (!exists) {
    db.prepare(`
      INSERT INTO users (id, name, email, password, is_admin, role, plan, avatar, created_at)
      VALUES (@id, @name, @email, @password, @is_admin, @role, @plan, @avatar, @created_at)
    `).run(ADMIN);
  } else {
    // Garante que campos do admin estão atualizados
    db.prepare(`
      UPDATE users SET name=@name, email=@email, password=@password,
        is_admin=@is_admin, role=@role, plan=@plan
      WHERE id=@id
    `).run(ADMIN);
  }
}

// Executa migração e garante admin
migrateFromJSON();
ensureAdmin();

// ── Limites por plano ─────────────────────────────────────────────────────────
const PLAN_LIMITS = {
  'Free':      1,
  'Starter':   10,
  'Standard':  10,
  'Pro':       20,
  'Business':  100,
  'Developer': Infinity,
};

function getProjectLimit(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS['Free'];
}

// ═════════════════════════════════════════════════════════════════════════════
//  API USERS
// ═════════════════════════════════════════════════════════════════════════════

function getAllUsers() {
  return db.prepare(`SELECT * FROM users ORDER BY created_at DESC`).all()
    .map(dbUserToObj);
}

function getUserById(id) {
  const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get(Number(id));
  return row ? dbUserToObj(row) : null;
}

function getUserByEmail(email) {
  const row = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);
  return row ? dbUserToObj(row) : null;
}

function createUser(data) {
  const info = db.prepare(`
    INSERT INTO users (id, name, email, password, is_admin, role, plan, avatar, created_at)
    VALUES (@id, @name, @email, @password, @is_admin, @role, @plan, @avatar, @created_at)
  `).run({
    id:         data.id         || Date.now(),
    name:       data.name,
    email:      data.email,
    password:   data.password   || null,
    is_admin:   data.isAdmin    ? 1 : 0,
    role:       data.role       || 'user',
    plan:       data.plan       || 'Free',
    avatar:     data.avatar     || null,
    created_at: data.createdAt  || new Date().toISOString(),
  });
  return getUserById(info.lastInsertRowid || data.id);
}

function updateUser(id, data) {
  const current = getUserById(id);
  if (!current) return null;
  const merged = { ...current, ...data, id };
  db.prepare(`
    UPDATE users SET name=@name, email=@email, password=@password,
      is_admin=@is_admin, role=@role, plan=@plan, avatar=@avatar
    WHERE id=@id
  `).run({
    id:       Number(id),
    name:     merged.name,
    email:    merged.email,
    password: merged.password,
    is_admin: merged.isAdmin ? 1 : 0,
    role:     merged.role     || 'user',
    plan:     merged.plan     || 'Free',
    avatar:   merged.avatar   || null,
  });
  return getUserById(id);
}

function deleteUser(id) {
  // Cascade deleta projetos automaticamente (FK + ON DELETE CASCADE)
  db.prepare(`DELETE FROM users WHERE id = ?`).run(Number(id));
}

function dbUserToObj(row) {
  return {
    id:        row.id,
    name:      row.name,
    email:     row.email,
    password:  row.password,
    isAdmin:   row.is_admin === 1,
    role:      row.role,
    plan:      row.plan,
    avatar:    row.avatar,
    createdAt: row.created_at,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
//  API PROJECTS
// ═════════════════════════════════════════════════════════════════════════════

function getProjectsByUser(userId) {
  return db.prepare(`
    SELECT * FROM projects WHERE user_id = ? ORDER BY updated_at DESC
  `).all(Number(userId)).map(dbProjectToObj);
}

function getProjectById(userId, projectId) {
  const row = db.prepare(`
    SELECT * FROM projects WHERE user_id = ? AND id = ?
  `).get(Number(userId), Number(projectId));
  return row ? dbProjectToObj(row) : null;
}

function getAllProjects() {
  return db.prepare(`
    SELECT p.*, u.name as owner_name, u.email as owner_email
    FROM projects p
    JOIN users u ON u.id = p.user_id
    ORDER BY p.updated_at DESC
  `).all().map(row => ({
    ...dbProjectToObj(row),
    _ownerName:  row.owner_name,
    _ownerEmail: row.owner_email,
    _ownerId:    row.user_id,
  }));
}

function upsertProject(userId, project) {
  // Garante que o usuário existe — caso o usuário tenha dados só no localStorage
  // e nunca tenha feito registro via /api/register no servidor atual.
  db.prepare(`
    INSERT OR IGNORE INTO users (id, name, email, plan)
    VALUES (?, ?, ?, ?)
  `).run(
    Number(userId),
    project.userName || 'Usuário',
    project.userEmail || `user_${userId}@vooar.dev`,
    'Free'
  );

  const existing = db.prepare(
    `SELECT id FROM projects WHERE user_id = ? AND id = ?`
  ).get(Number(userId), Number(project.id));

  const data = JSON.stringify(project);

  if (existing) {
    db.prepare(`
      UPDATE projects
      SET name=@name, views=@views, data=@data, updated_at=@updated_at
      WHERE user_id=@user_id AND id=@id
    `).run({
      id:         Number(project.id),
      user_id:    Number(userId),
      name:       project.name        || 'Sem nome',
      views:      project.views       || 0,
      data,
      updated_at: project.updatedAt   || new Date().toISOString(),
    });
  } else {
    db.prepare(`
      INSERT INTO projects (id, user_id, name, views, data, created_at, updated_at)
      VALUES (@id, @user_id, @name, @views, @data, @created_at, @updated_at)
    `).run({
      id:         Number(project.id),
      user_id:    Number(userId),
      name:       project.name        || 'Sem nome',
      views:      project.views       || 0,
      data,
      created_at: project.createdAt   || new Date().toISOString(),
      updated_at: project.updatedAt   || new Date().toISOString(),
    });
  }
  return getProjectById(userId, project.id);
}

function deleteProject(userId, projectId) {
  db.prepare(`DELETE FROM projects WHERE user_id = ? AND id = ?`)
    .run(Number(userId), Number(projectId));
}

function incrementProjectViews(userId, projectId) {
  db.prepare(`UPDATE projects SET views = views + 1 WHERE user_id = ? AND id = ?`)
    .run(Number(userId), Number(projectId));
}

function dbProjectToObj(row) {
  let data = {};
  try { data = JSON.parse(row.data || '{}'); } catch {}
  return {
    ...data,
    id:        row.id,
    user_id:   row.user_id,
    name:      row.name,
    views:     row.views,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function countProjectsByUser(userId) {
  return db.prepare(`SELECT COUNT(*) as n FROM projects WHERE user_id = ?`)
    .get(Number(userId)).n;
}

// ═════════════════════════════════════════════════════════════════════════════
//  STATS
// ═════════════════════════════════════════════════════════════════════════════

function getStats() {
  const users    = db.prepare(`SELECT COUNT(*) as n FROM users`).get().n;
  const projects = db.prepare(`SELECT COUNT(*) as n FROM projects`).get().n;
  const views    = db.prepare(`SELECT COALESCE(SUM(views), 0) as n FROM projects`).get().n;
  // Tamanho pasta uploads
  let storageBytes = 0;
  const uploadsDir = path.join(__dirname, 'uploads');
  function dirSize(dir) {
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).reduce((acc, f) => {
      try {
        const fp = path.join(dir, f);
        const st = fs.statSync(fp);
        return acc + (st.isDirectory() ? dirSize(fp) : st.size);
      } catch { return acc; }
    }, 0);
  }
  storageBytes = dirSize(uploadsDir);
  return { users, projects, views, storageBytes };
}

// ═════════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ═════════════════════════════════════════════════════════════════════════════

module.exports = {
  db,
  // Users
  getAllUsers, getUserById, getUserByEmail,
  createUser, updateUser, deleteUser,
  // Projects
  getProjectsByUser, getProjectById, getAllProjects,
  upsertProject, deleteProject, incrementProjectViews,
  countProjectsByUser,
  // Plans
  getProjectLimit, PLAN_LIMITS,
  // Stats
  getStats,
  // Admin
  ADMIN_ID:    ADMIN.id,
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || 'jvooardev25',
};
