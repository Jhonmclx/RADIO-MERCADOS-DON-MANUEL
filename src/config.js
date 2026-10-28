// Configuración central de RADIO MERCADO DON MANUEL.
// Todo valor sensible llega por variables de entorno (o un archivo .env que NO se versiona).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Carga un archivo .env sencillo (CLAVE=valor). Las variables ya definidas tienen prioridad. */
export function loadEnvFile(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'si', 'sí'].includes(String(v).toLowerCase()));

export function buildConfig(env = process.env) {
  const dataDir = path.resolve(env.DATA_DIR || path.join(ROOT, 'data'));
  const segment = num(env.HLS_SEGMENT_SECONDS, 4);
  const cfg = {
    root: ROOT,
    appName: 'RADIO MERCADO DON MANUEL',
    nodeEnv: env.NODE_ENV || 'development',
    host: env.HOST || '0.0.0.0',
    port: num(env.PORT, 8080),
    publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
    trustProxy: bool(env.TRUST_PROXY, false),
    cookieSecure: bool(env.COOKIE_SECURE, env.NODE_ENV === 'production'),
    timezone: env.TIMEZONE || 'America/Bogota',
    dataDir,
    dbFile: path.join(dataDir, 'db', 'radio.sqlite'),
    mediaDir: path.join(dataDir, 'media'),
    liveDir: path.join(dataDir, 'live'),
    renderDir: path.join(dataDir, 'render'),
    slateDir: path.resolve(env.SLATE_DIR || path.join(dataDir, 'slates')),
    tmpDir: path.join(dataDir, 'tmp'),
    backupDir: path.resolve(env.BACKUP_DIR || path.join(dataDir, 'backups')),
    ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
    ffprobe: env.FFPROBE_PATH || 'ffprobe',
    fontFile: env.FONT_FILE || '',
    video: {
      width: num(env.VIDEO_WIDTH, 1280),
      height: num(env.VIDEO_HEIGHT, 720),
      fps: num(env.VIDEO_FPS, 30),
      bitrateK: num(env.VIDEO_BITRATE_KBPS, 1800),
      audioBitrateK: num(env.AUDIO_BITRATE_KBPS, 128),
      preset: env.X264_PRESET || 'veryfast',
      backupHeight: num(env.BACKUP_VIDEO_HEIGHT, 480),
      backupBitrateK: num(env.BACKUP_VIDEO_BITRATE_KBPS, 700),
    },
    hls: {
      segmentSeconds: segment,
      windowSegments: num(env.HLS_WINDOW_SEGMENTS, 8),
      keepExtraSegments: num(env.HLS_KEEP_EXTRA_SEGMENTS, 12),
      // Retraso objetivo común (ms) entre la hora oficial de emisión y lo que suena en cada televisor.
      targetDelayMs: num(env.SYNC_TARGET_DELAY_MS, Math.round((segment * 4 + 2) * 1000)),
    },
    renderMode: env.RENDER_MODE === 'encode' ? 'encode' : 'copy',
    engineAutostart: bool(env.ENGINE_AUTOSTART, true),
    engineTickMs: num(env.ENGINE_TICK_MS, 250),
    uploads: {
      maxAdMB: num(env.MAX_AD_UPLOAD_MB, 2048),
      maxMusicMB: num(env.MAX_MUSIC_UPLOAD_MB, 60),
    },
    admin: {
      initialUser: env.ADMIN_USER || '',
      initialPassword: env.ADMIN_PASSWORD || '',
      sessionHours: num(env.SESSION_HOURS, 12),
    },
    heartbeatSeconds: num(env.PLAYER_HEARTBEAT_SECONDS, 5),
    player: {
      backupDownloadDelaySeconds: num(env.PLAYER_BACKUP_DOWNLOAD_DELAY_SECONDS, 60),
      backupAfterSeconds: num(env.PLAYER_BACKUP_AFTER_SECONDS, 20),
    },
    siteOfflineAfterSeconds: num(env.SITE_OFFLINE_AFTER_SECONDS, 30),
    rateLimit: {
      publicPerMinute: num(env.PUBLIC_RATE_PER_MINUTE, 600),
      loginPerWindow: num(env.LOGIN_ATTEMPTS_PER_15MIN, 8),
    },
  };
  cfg.hls.targetDuration = Math.ceil(segment * 2);
  return cfg;
}

export const ROOT_DIR = ROOT;
