-- RADIO MERCADO DON MANUEL — esquema inicial
-- Todas las marcas de tiempo se guardan como milisegundos UTC (INTEGER), sin ambigüedad de zona horaria.
-- Los archivos multimedia viven en disco (DATA_DIR/media); la base de datos solo guarda metadatos.

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at INTEGER NOT NULL,
  last_login_at INTEGER,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,               -- hash SHA-256 del token (el token en claro solo vive en la cookie)
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE schedule_hours (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),  -- 0 = domingo (hora local America/Bogota)
  start_min INTEGER NOT NULL CHECK (start_min BETWEEN 0 AND 1440),
  end_min INTEGER NOT NULL CHECK (end_min BETWEEN 0 AND 1440)
);

CREATE TABLE schedule_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  effective_at INTEGER NOT NULL,
  patch TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pendiente',
  created_at INTEGER NOT NULL,
  created_by TEXT,
  applied_at INTEGER
);

CREATE TABLE advertisers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact_name TEXT,
  phone TEXT,
  email TEXT,
  notes TEXT,
  valid_from INTEGER,
  valid_to INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE ads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  advertiser_id INTEGER REFERENCES advertisers(id),
  status TEXT NOT NULL DEFAULT 'procesando',   -- procesando | listo | rechazado | danado
  error TEXT,
  warnings TEXT,
  active INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 1,           -- frecuencia relativa (prioridad) dentro de la rotación
  valid_from INTEGER,
  valid_to INTEGER,
  original_name TEXT,
  original_sha256 TEXT,
  normalized_sha256 TEXT,
  backup_sha256 TEXT,
  size_bytes INTEGER,
  duration_ms INTEGER,
  width INTEGER,
  height INTEGER,
  video_codec TEXT,
  audio_codec TEXT,
  has_audio INTEGER,
  replaces_ad_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deactivated_at INTEGER
);

CREATE TABLE songs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  artist TEXT,
  status TEXT NOT NULL DEFAULT 'procesando',
  error TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  backup INTEGER NOT NULL DEFAULT 0,           -- autorizada para respaldo local en televisores
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  original_name TEXT,
  original_sha256 TEXT,
  normalized_sha256 TEXT,
  size_bytes INTEGER,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Registro "as-run": cada elemento que el motor central preparó o emitió.
CREATE TABLE program_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                 -- song | ad | slate
  media_id INTEGER,
  loop_ad_id INTEGER,
  loop_offset_ms INTEGER,
  slate TEXT,
  status TEXT NOT NULL,               -- preparando | listo | al_aire | emitido | interrumpido | descartado | fallido
  config_version INTEGER,
  decided_state TEXT,                 -- estado del planificador ANTES de decidir este elemento (para re-planificar)
  planned_start INTEGER,
  actual_start INTEGER,
  actual_end INTEGER,
  duration_ms INTEGER,
  segments TEXT,                      -- JSON [{file, dur}]
  published_count INTEGER NOT NULL DEFAULT 0,
  first_seq INTEGER,
  last_seq INTEGER,
  render_dir TEXT,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_program_items_status ON program_items(status);
CREATE INDEX idx_program_items_seq ON program_items(first_seq, last_seq);

-- Emisión central de cada comercial: UNA fila por emisión (no se multiplica por sedes).
CREATE TABLE ad_plays (
  id TEXT PRIMARY KEY,
  program_item_id INTEGER NOT NULL UNIQUE REFERENCES program_items(id),
  ad_id INTEGER NOT NULL REFERENCES ads(id),
  ad_name TEXT NOT NULL,
  advertiser_id INTEGER,
  advertiser_name TEXT,
  scheduled_at INTEGER,
  started_at INTEGER,
  ended_at INTEGER,
  expected_ms INTEGER,
  observed_ms INTEGER,
  status TEXT NOT NULL,               -- programado | emitiendo | completado | interrumpido | fallido | incierto
  interruption_reason TEXT,
  config_version INTEGER,
  first_seq INTEGER,
  last_seq INTEGER,
  sites_connected TEXT,               -- JSON: sedes con conexión activa durante la emisión
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ad_plays_started ON ad_plays(started_at);
CREATE INDEX idx_ad_plays_ad ON ad_plays(ad_id);

CREATE TABLE sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  last_state TEXT,
  last_config_version INTEGER,
  last_error TEXT,
  last_error_at INTEGER,
  last_reconnect_at INTEGER,
  last_disconnect_ms INTEGER,
  last_delay_ms INTEGER,
  last_sync_error_ms INTEGER,
  last_seq INTEGER,
  player_mode TEXT,
  user_agent TEXT,
  session_id TEXT,
  backup_status TEXT
);

-- Confirmación de reproducción por sede (telemetría del reproductor, segmento por segmento).
CREATE TABLE site_ad_confirmations (
  ad_play_id TEXT NOT NULL REFERENCES ad_plays(id),
  site_id INTEGER NOT NULL REFERENCES sites(id),
  first_seen_at INTEGER,
  last_seen_at INTEGER,
  segments_seen INTEGER NOT NULL DEFAULT 0,
  segments_expected INTEGER,
  source TEXT NOT NULL DEFAULT 'senal_central',
  PRIMARY KEY (ad_play_id, site_id)
);

CREATE TABLE site_segment_seen (
  site_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (site_id, seq)
);

-- Eventos enviados por los reproductores. El id lo genera el reproductor: reintentos no duplican.
CREATE TABLE site_events (
  id TEXT PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  type TEXT NOT NULL,
  at INTEGER NOT NULL,
  detail TEXT,
  received_at INTEGER NOT NULL
);
CREATE INDEX idx_site_events_site_at ON site_events(site_id, at);

-- Respaldo local: reproducciones de comerciales hechas SIN señal central (se reportan aparte).
CREATE TABLE backup_ad_plays (
  id TEXT PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  ad_id INTEGER,
  started_at INTEGER,
  ended_at INTEGER,
  completed INTEGER,
  received_at INTEGER NOT NULL
);

CREATE TABLE sync_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  delay_ms INTEGER,
  error_ms INTEGER,
  seq INTEGER
);
CREATE INDEX idx_sync_samples_at ON sync_samples(at);

CREATE TABLE diagnostics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER,
  at INTEGER NOT NULL,
  report TEXT NOT NULL,
  user_agent TEXT
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  user_id INTEGER,
  username TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  detail TEXT,
  ip TEXT
);
CREATE INDEX idx_audit_at ON audit_log(at);

CREATE TABLE engine_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX idx_engine_log_at ON engine_log(at);

CREATE TABLE engine_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
