// Acceso a datos con SQLite integrado en Node.js (node:sqlite): sin dependencias externas.
// Un único servidor => SQLite en modo WAL es suficiente, robusto y fácil de respaldar.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export const SEDES = [['alto-del-espino', 'Alto del Espino'], ['gourmet', 'Gourmet'], ['parque-narino', 'Parque Nariño'], ['terminal', 'Terminal'], ['sachica', 'Sáchica']];

export const DEFAULT_SETTINGS = {
  songs_between_ads: 2,
  ads_per_block: 1,
  music_shuffle: false,
  music_paused: false,
  ads_paused: false,
  engine_mode: 'running', // running | stopped
  config_version: 1,
};

export class Database {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
    this._stmts = new Map();
  }

  stmt(sql) {
    let s = this._stmts.get(sql);
    if (!s) { s = this.db.prepare(sql); this._stmts.set(sql, s); }
    return s;
  }
  get(sql, ...p) { return this.stmt(sql).get(...p); }
  all(sql, ...p) { return this.stmt(sql).all(...p); }
  run(sql, ...p) { return this.stmt(sql).run(...p); }
  exec(sql) { return this.db.exec(sql); }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { try { this.db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
  }

  migrate() {
    this.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    const done = new Set(this.all('SELECT version FROM schema_migrations').map((r) => r.version));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const applied = [];
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      this.tx(() => { this.exec(sql); this.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', f, Date.now()); });
      applied.push(f);
    }
    return applied;
  }

  /** Datos iniciales: cinco sedes, ajustes por defecto y horario 7:00–21:00 todos los días. Idempotente. */
  seed() {
    const now = Date.now();
    // Sedes iniciales (solo se crean si la tabla está vacía; después se administran desde el panel).
    if (!this.get('SELECT COUNT(*) AS n FROM sites').n) {
      for (const [slug, name] of SEDES) this.run('INSERT INTO sites (slug, name, description, created_at) VALUES (?, ?, ?, ?)', slug, name, null, now);
    }
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      this.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', k, JSON.stringify(v));
    }
    const hasHours = this.get('SELECT COUNT(*) AS n FROM schedule_hours').n;
    if (!hasHours) {
      for (let d = 0; d < 7; d++) this.run('INSERT INTO schedule_hours (weekday, start_min, end_min) VALUES (?, ?, ?)', d, 7 * 60, 21 * 60);
    }
  }

  getSettings() {
    const out = { ...DEFAULT_SETTINGS };
    for (const r of this.all('SELECT key, value FROM settings')) {
      try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
    }
    return out;
  }

  setSettings(patch, { bump = true } = {}) {
    return this.tx(() => {
      for (const [k, v] of Object.entries(patch)) {
        this.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, JSON.stringify(v));
      }
      if (bump) this.bumpConfigVersionNoTx();
      return this.getSettings();
    });
  }

  bumpConfigVersionNoTx() {
    const cur = this.get("SELECT value FROM settings WHERE key = 'config_version'");
    const next = (cur ? Number(JSON.parse(cur.value)) : 0) + 1;
    this.run("INSERT INTO settings (key, value) VALUES ('config_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(next));
    return next;
  }

  bumpConfigVersion() { return this.tx(() => this.bumpConfigVersionNoTx()); }

  audit(user, action, entity, entityId, detail, ip) {
    this.run('INSERT INTO audit_log (at, user_id, username, action, entity, entity_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      Date.now(), user?.id ?? null, user?.username ?? null, action, entity ?? null, entityId == null ? null : String(entityId),
      detail == null ? null : JSON.stringify(detail), ip ?? null);
  }

  engineLog(level, message, detail) {
    this.run('INSERT INTO engine_log (at, level, message, detail) VALUES (?, ?, ?, ?)', Date.now(), level, message, detail == null ? null : JSON.stringify(detail));
  }

  close() { try { this.db.close(); } catch { /* ignore */ } }
}

export function openDatabase(file) {
  const db = new Database(file);
  db.migrate();
  db.seed();
  return db;
}
