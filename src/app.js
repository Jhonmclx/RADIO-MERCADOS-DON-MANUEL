// Ensambla la aplicación: base de datos, biblioteca multimedia, motor central y servidor HTTP.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase } from './db/index.js';
import { MediaLibrary } from './media/library.js';
import { Engine } from './engine/engine.js';
import { Reports } from './reports/reports.js';
import { Router, HttpError, json, send, sendFile, safeJoin, clientIp } from './http/core.js';
import { Sessions, RateLimiter, securityHeaders, hashPassword, validatePasswordStrength } from './http/security.js';
import { registerAdminRoutes } from './http/admin-routes.js';
import { registerPublicRoutes } from './http/public-routes.js';
import { runProcess } from './media/ffmpeg.js';
import { seedDemo } from './demo-seed.js';
import { Persist } from './persist.js';

export async function createApp(cfg, { logToConsole = true } = {}) {
  for (const d of [cfg.dataDir, cfg.mediaDir, cfg.liveDir, cfg.renderDir, cfg.tmpDir]) fs.mkdirSync(d, { recursive: true });
  // Comprobación temprana de FFmpeg: sin él no hay señal, mejor fallar con un mensaje claro.
  try { await runProcess(cfg.ffmpeg, ['-hide_banner', '-version'], { timeoutMs: 15_000 }); await runProcess(cfg.ffprobe, ['-hide_banner', '-version'], { timeoutMs: 15_000 }); }
  catch (e) { throw new Error(`No se encontró FFmpeg/FFprobe (${cfg.ffmpeg}). Instálelo o configure FFMPEG_PATH y FFPROBE_PATH. Detalle: ${e.message}`); }

  // Guardado permanente (Supabase): se recupera la base de datos ANTES de abrirla.
  const persist = new Persist({ cfg, log: (l, m, d) => logToConsole && console.log(`[${new Date().toISOString()}] ${l.toUpperCase()} ${m}${d ? ' ' + JSON.stringify(d) : ''}`) });
  if (persist.enabled) {
    try { await persist.restoreDatabase(); }
    catch (e) { console.error(`Almacenamiento permanente no disponible al iniciar: ${e.message}`); persist.status.lastError = e.message; }
  }
  const db = openDatabase(cfg.dbFile);
  const log = (level, message, detail) => {
    db.engineLog(level, message, detail);
    if (logToConsole) console.log(`[${new Date().toISOString()}] ${level.toUpperCase()} ${message}${detail ? ' ' + JSON.stringify(detail) : ''}`);
  };

  // Primer administrador desde variables de entorno (solo si no existe ninguno).
  if (!db.get('SELECT COUNT(*) AS n FROM users').n) {
    if (cfg.admin.initialUser && cfg.admin.initialPassword) {
      const err = validatePasswordStrength(cfg.admin.initialPassword);
      if (err) throw new Error(`ADMIN_PASSWORD no es segura: ${err}`);
      db.run('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)', cfg.admin.initialUser, hashPassword(cfg.admin.initialPassword), 'admin', Date.now());
      log('info', `Administrador inicial "${cfg.admin.initialUser}" creado.`);
    } else {
      log('warn', 'No existe ningún administrador. Ejecute "npm run create-admin" o defina ADMIN_USER y ADMIN_PASSWORD.');
    }
  }

  persist.log = log;
  if (persist.enabled) { try { await persist.restoreMedia(db); } catch (e) { log('warn', 'No se pudieron recuperar los archivos guardados', { error: e.message }); } }
  const library = new MediaLibrary({ cfg, db, log });
  const engine = new Engine({ cfg, db, library, log });
  const reports = new Reports({ db, cfg, engine });
  const sessions = new Sessions({ db, cfg });
  library.on('changed', (e) => {
    if (e.status === 'listo') { db.bumpConfigVersion(); engine.onConfigChanged(`${e.kind === 'ad' ? 'comercial' : 'canción'} #${e.id} disponible`); }
    if (persist.enabled) persist.saveMedia(e.kind, e.id, db).then(() => persist.snapshot(db)).catch(() => {});
  });
  // Cada acción del administrador deja una copia de la base de datos a los pocos segundos.
  let snapTimer = null;
  const origAudit = db.audit.bind(db);
  db.audit = (...a) => { origAudit(...a); if (persist.enabled) { clearTimeout(snapTimer); snapTimer = setTimeout(() => persist.snapshot(db), 4000); } };
  await engine.init();
  library.persist = persist.enabled ? persist : null;
  await library.resumePending();
  if (process.env.DEMO_SEED === 'true') seedDemo({ cfg, db, library, log });

  const router = new Router();
  const app = { cfg, db, engine, library, reports, sessions, log, persist };
  // Copia periódica cada hora (los cambios del administrador se guardan al momento). Cada copia sube datos y Render gratis
  // cobra el tráfico de salida: cada 3 minutos llegaba a ~1,8 GB al día.
  const snapInterval = persist.enabled ? setInterval(() => persist.snapshot(db), 60 * 60_000) : null;
  if (persist.enabled) setTimeout(() => persist.snapshot(db), 15_000);
  registerAdminRoutes(router, app);
  registerPublicRoutes(router, app);

  const publicLimiter = new RateLimiter({ limit: cfg.rateLimit.publicPerMinute, windowMs: 60_000 });
  const mediaLimiter = new RateLimiter({ limit: cfg.rateLimit.publicPerMinute * 2, windowMs: 60_000 });
  const pub = path.join(cfg.root, 'public');

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const ip = clientIp(req, cfg.trustProxy);
    const isApi = pathname.startsWith('/api/');
    try {
      if (pathname.startsWith('/api/public/') || pathname.startsWith('/player/')) {
        const r = publicLimiter.hit(ip);
        if (!r.allowed) throw new HttpError(429, 'Demasiadas solicitudes. Intente de nuevo en un momento.');
      } else if (pathname.startsWith('/live/') || pathname.startsWith('/media/')) {
        const r = mediaLimiter.hit(ip);
        if (!r.allowed) throw new HttpError(429, 'Demasiadas solicitudes de video desde esta conexión.');
      }
      for (const [k, v] of Object.entries(securityHeaders('base'))) res.setHeader(k, v);

      if (pathname === '/') { res.writeHead(302, { Location: '/admin/' }); res.end(); return; }
      if (pathname === '/admin' || pathname === '/admin/') {
        return sendFile(req, res, path.join(pub, 'admin', 'index.html'), { headers: securityHeaders('admin') });
      }
      if (pathname.startsWith('/admin/') || pathname.startsWith('/static/')) {
        const rel = pathname.startsWith('/admin/') ? pathname : pathname.slice('/static'.length);
        return sendFile(req, res, safeJoin(pub, rel), { cacheControl: 'no-cache' });
      }
      const m = router.match(req.method, pathname);
      if (!m) throw new HttpError(404, 'Recurso no encontrado.');
      if (m.methodMismatch) throw new HttpError(405, 'Método no permitido.');
      const ctx = { params: m.params, query: url.searchParams, ip, url };
      for (const h of m.route.handlers) {
        await h(req, res, ctx);
        if (res.writableEnded || res.headersSent) break;
      }
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log('error', `Error interno en ${req.method} ${pathname}`, { error: e.message });
      const msg = status === 500 ? 'Error interno del servidor. Revise el registro de errores.' : e.message;
      if (res.headersSent) { res.destroy(); return; }
      if (isApi || req.headers.accept?.includes('application/json')) json(res, status, { error: msg, ...(e.extra || {}) });
      else send(res, status, `${status} — ${msg}`, { 'Content-Type': 'text/plain; charset=utf-8' });
      // Si el cliente sigue enviando un archivo rechazado, se cierra la conexión.
      if (!req.complete) req.on('data', () => {}).on('end', () => {});
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.requestTimeout = 0; // las cargas de video grandes pueden tardar
  server.headersTimeout = 60_000;

  const maintenance = setInterval(() => {
    const now = Date.now();
    try {
      db.run('DELETE FROM sync_samples WHERE at < ?', now - 14 * 86_400_000);
      db.run('DELETE FROM site_segment_seen WHERE at < ?', now - 60 * 86_400_000);
      db.run('DELETE FROM sessions WHERE expires_at < ?', now);
      db.run('DELETE FROM engine_log WHERE at < ?', now - 90 * 86_400_000);
      for (const f of fs.readdirSync(cfg.tmpDir)) {
        const p = path.join(cfg.tmpDir, f);
        if (now - fs.statSync(p).mtimeMs > 6 * 3600_000) fs.rmSync(p, { force: true, recursive: true });
      }
    } catch (e) { log('warn', 'Mantenimiento periódico con errores', { error: e.message }); }
  }, 3600_000);
  maintenance.unref();

  async function close() {
    clearInterval(maintenance);
    clearInterval(snapInterval); clearTimeout(snapTimer);
    await engine.stopLoop();
    engine.saveState();
    if (persist.enabled) await persist.snapshot(db, { force: true });
    const closed = new Promise((r) => server.close(() => r()));
    server.closeAllConnections?.();
    await closed;
    db.close();
  }

  return { ...app, server, close, start: () => engine.start() };
}
