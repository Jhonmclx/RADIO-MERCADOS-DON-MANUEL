// API privada del panel administrativo. Todas las rutas exigen sesión; los cambios exigen además token CSRF.
import fs from 'node:fs';
import { HttpError, json, send, readJson, sendFile } from './core.js';
import { str, int, bool, localDateTime, email } from './validate.js';
import { hashPassword, verifyPassword, validatePasswordStrength, csrfFor, RateLimiter, checkSameOrigin } from './security.js';
import { utcToLocalString, minToHHMM, parseHHMM, isWithinHours, localParts } from '../lib/time.js';
import { UploadError } from '../media/library.js';

const ENGINE_ACTIONS = {
  iniciar: { label: 'Iniciar la emisión' },
  detener: { label: 'Detener toda la señal', confirm: true },
  pausar_musica: { label: 'Pausar la música', patch: { music_paused: true } },
  reanudar_musica: { label: 'Reanudar la música', patch: { music_paused: false } },
  pausar_publicidad: { label: 'Pausar los bloques publicitarios', patch: { ads_paused: true } },
  reanudar_publicidad: { label: 'Reanudar los bloques publicitarios', patch: { ads_paused: false } },
  pausar_programacion: { label: 'Pausar la programación (música y publicidad)', patch: { music_paused: true, ads_paused: true } },
  reanudar_programacion: { label: 'Reanudar la programación', patch: { music_paused: false, ads_paused: false } },
};

export function registerAdminRoutes(router, app) {
  const { cfg, db, engine, library, sessions, reports } = app;
  const tz = cfg.timezone;
  const loginLimiter = new RateLimiter({ limit: cfg.rateLimit.loginPerWindow, windowMs: 15 * 60_000 });
  const local = (ms) => (ms == null ? null : utcToLocalString(ms, tz).slice(0, 16));

  // ---- middleware
  const auth = (req, res, ctx) => {
    const s = sessions.fromRequest(req);
    if (!s) throw new HttpError(401, 'Sesión no iniciada o vencida. Ingrese de nuevo.');
    ctx.user = s.user; ctx.token = s.token;
  };
  const mutate = (req, res, ctx) => {
    auth(req, res, ctx);
    checkSameOrigin(req, cfg);
    if (req.headers['x-csrf-token'] !== csrfFor(ctx.token)) throw new HttpError(403, 'Token de seguridad inválido. Recargue el panel.');
  };
  const changed = (ctx, action, entity, id, detail, reason) => {
    db.audit(ctx.user, action, entity, id, detail, ctx.ip);
    db.bumpConfigVersion();
    return engine.onConfigChanged(reason || action);
  };

  // ---- autenticación
  router.post('/api/auth/login', async (req, res, ctx) => {
    checkSameOrigin(req, cfg);
    const rl = loginLimiter.hit(ctx.ip);
    if (!rl.allowed) throw new HttpError(429, `Demasiados intentos. Espere ${Math.ceil(rl.retryAfterS / 60)} minuto(s).`);
    const body = await readJson(req, 10_000);
    const username = str(body.username, { name: 'usuario', max: 60, required: true });
    const password = String(body.password || '');
    const u = db.get('SELECT * FROM users WHERE username = ?', username);
    const now = Date.now();
    if (u?.locked_until && u.locked_until > now) throw new HttpError(429, 'La cuenta está bloqueada temporalmente por intentos fallidos. Intente más tarde.');
    if (!u || !verifyPassword(password, u.password_hash)) {
      if (u) {
        const fails = u.failed_attempts + 1;
        db.run('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?', fails, fails >= 10 ? now + 15 * 60_000 : null, u.id);
      }
      db.audit(null, 'login_fallido', 'user', username, null, ctx.ip);
      throw new HttpError(401, 'Usuario o contraseña incorrectos.');
    }
    db.run('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', now, u.id);
    loginLimiter.reset(ctx.ip);
    const token = sessions.create(u, req, ctx.ip);
    db.audit({ id: u.id, username: u.username }, 'login', 'user', u.id, null, ctx.ip);
    json(res, 200, { user: { id: u.id, username: u.username }, csrf: csrfFor(token) },
      { 'Set-Cookie': sessions.cookie(token, cfg.admin.sessionHours * 3600) });
  });

  router.post('/api/auth/logout', (req, res, ctx) => {
    const s = sessions.fromRequest(req);
    if (s) { sessions.destroy(s.token); db.audit(s.user, 'logout', 'user', s.user.id, null, ctx.ip); }
    json(res, 200, { ok: true }, { 'Set-Cookie': sessions.cookie('', 0) });
  });

  router.get('/api/auth/me', auth, (req, res, ctx) => {
    json(res, 200, { user: ctx.user, csrf: csrfFor(ctx.token), appName: cfg.appName, timezone: tz });
  });

  router.post('/api/auth/password', mutate, async (req, res, ctx) => {
    const body = await readJson(req);
    const u = db.get('SELECT * FROM users WHERE id = ?', ctx.user.id);
    if (!verifyPassword(String(body.current || ''), u.password_hash)) throw new HttpError(400, 'La contraseña actual no es correcta.');
    const err = validatePasswordStrength(body.next);
    if (err) throw new HttpError(400, err);
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(body.next), u.id);
    sessions.destroyAllFor(u.id, ctx.token);
    db.audit(ctx.user, 'cambiar_contrasena', 'user', u.id, null, ctx.ip);
    json(res, 200, { ok: true });
  });

  // ---- presentación
  const adView = (a, onAirId) => {
    const now = Date.now();
    let state = a.status;
    if (a.status === 'listo') {
      if (!a.active) state = 'inactivo';
      else if (a.valid_to != null && a.valid_to <= now) state = 'vencido';
      else if (a.valid_from != null && a.valid_from > now) state = 'programado';
      else state = 'en_rotacion';
      if (onAirId === a.id) state = 'al_aire';
    }
    return {
      id: a.id, name: a.name, advertiserId: a.advertiser_id, advertiserName: a.advertiser_name || null,
      status: a.status, state, error: a.error, warnings: a.warnings, active: !!a.active, activateOnReady: !!a.activate_on_ready,
      position: a.position, weight: a.weight, validFrom: local(a.valid_from), validTo: local(a.valid_to),
      durationMs: a.duration_ms, width: a.width, height: a.height, hasAudio: a.has_audio == null ? null : !!a.has_audio,
      originalName: a.original_name, sizeBytes: a.size_bytes, sha256: a.normalized_sha256 || a.original_sha256,
      createdAt: a.created_at, deactivatedAt: a.deactivated_at, replacesAdId: a.replaces_ad_id,
      plays: a.plays ?? 0, lastPlayedAt: a.last_played_at ?? null,
      thumbUrl: a.status === 'listo' ? `/api/admin/ads/${a.id}/thumb` : null,
      videoUrl: a.status === 'listo' ? `/api/admin/ads/${a.id}/video` : null,
    };
  };
  const loadAd = (id) => {
    const a = db.get('SELECT a.*, adv.name AS advertiser_name FROM ads a LEFT JOIN advertisers adv ON adv.id = a.advertiser_id WHERE a.id = ?', id);
    if (!a) throw new HttpError(404, 'Comercial no encontrado.');
    return a;
  };
  const songView = (s) => ({
    id: s.id, title: s.title, artist: s.artist, status: s.status, error: s.error, enabled: !!s.enabled, backup: !!s.backup,
    position: s.position, durationMs: s.duration_ms, originalName: s.original_name, sizeBytes: s.size_bytes, createdAt: s.created_at,
    audioUrl: s.status === 'listo' ? `/api/admin/music/${s.id}/audio` : null,
  });

  const siteView = (s) => {
    const now = Date.now();
    const online = s.last_seen_at && now - s.last_seen_at <= cfg.siteOfflineAfterSeconds * 1000;
    let connection = 'desconocido';
    if (s.last_seen_at) connection = online ? 'conectada' : 'desconectada';
    if (!s.enabled) connection = 'deshabilitada';
    const currentVersion = db.getSettings().config_version;
    return {
      id: s.id, slug: s.slug, name: s.name, description: s.description, enabled: !!s.enabled,
      path: `/player/${s.slug}`, url: `${cfg.publicBaseUrl || ''}/player/${s.slug}`,
      connection, playerState: online ? s.last_state || 'desconocido' : (s.last_seen_at ? 'sin_datos_recientes' : 'nunca_conectada'),
      lastSeenAt: s.last_seen_at, lastConfigVersion: s.last_config_version, configUpToDate: s.last_config_version === currentVersion,
      lastError: s.last_error, lastErrorAt: s.last_error_at, lastReconnectAt: s.last_reconnect_at, lastDisconnectMs: s.last_disconnect_ms,
      delayMs: online ? s.last_delay_ms : null, syncErrorMs: online ? s.last_sync_error_ms : null, playerMode: s.player_mode,
      userAgent: s.user_agent, backupStatus: s.backup_status, lastSeq: s.last_seq,
    };
  };

  // ---- inicio (tablero)
  router.get('/api/admin/dashboard', auth, (req, res) => {
    const st = engine.status();
    const sites = db.all('SELECT * FROM sites ORDER BY id').map(siteView);
    const alerts = [];
    if (st.mode !== 'running') alerts.push({ level: 'error', text: 'La señal central está DETENIDA. Las sedes muestran la pantalla de espera.' });
    if (st.lastError && Date.now() - st.lastError.at < 15 * 60_000) alerts.push({ level: 'warn', text: st.lastError.message });
    if (st.mode === 'running' && Date.now() - st.lastPlaylistWriteAt > 3 * cfg.hls.segmentSeconds * 1000) alerts.push({ level: 'error', text: 'La lista en vivo no se actualiza: revise el registro del motor.' });
    for (const s of sites) {
      if (s.enabled && s.connection === 'desconectada') alerts.push({ level: 'warn', text: `${s.name} sin conexión desde ${local(s.lastSeenAt)}.` });
      if (s.enabled && s.connection === 'conectada' && s.playerState === 'bloqueado_autoplay') alerts.push({ level: 'warn', text: `${s.name}: el televisor bloqueó el sonido automático; alguien debe pulsar OK en el control.` });
      if (s.enabled && s.connection === 'conectada' && !s.configUpToDate) alerts.push({ level: 'info', text: `${s.name} aún no confirma la última versión de configuración.` });
    }
    const songs = db.get("SELECT COUNT(*) AS n FROM songs WHERE status = 'listo' AND enabled = 1 AND archived = 0").n;
    const ads = engine.eligibleAds(Date.now()).length;
    if (!songs) alerts.push({ level: 'info', text: 'No hay canciones habilitadas: suba archivos MP3 en la sección Música.' });
    if (!ads) alerts.push({ level: 'info', text: 'No hay comerciales en rotación.' });
    const hours = db.all('SELECT weekday, start_min, end_min FROM schedule_hours');
    const delays = sites.filter((s) => s.connection === 'conectada' && s.delayMs != null).map((s) => s.delayMs);
    const events = db.all(`SELECT 'motor' AS origen, at, level AS tipo, message AS texto FROM engine_log
      UNION ALL SELECT s.name AS origen, e.at, e.type AS tipo, COALESCE(e.detail, '') AS texto FROM site_events e JOIN sites s ON s.id = e.site_id
      ORDER BY at DESC LIMIT 15`);
    json(res, 200, {
      engine: st, sites, alerts, inHours: isWithinHours(Date.now(), hours, tz),
      counts: { songs, adsInRotation: ads },
      sync: { measuredSites: delays.length, spreadMs: delays.length > 1 ? Math.max(...delays) - Math.min(...delays) : null, targetDelayMs: cfg.hls.targetDelayMs },
      events,
    });
  });

  // ---- motor / controles generales
  router.get('/api/admin/engine', auth, (req, res) => json(res, 200, { ...engine.status(), actions: ENGINE_ACTIONS }));
  router.post('/api/admin/engine/action', mutate, async (req, res, ctx) => {
    const body = await readJson(req);
    const action = String(body.action || '');
    const def = ENGINE_ACTIONS[action];
    if (!def) throw new HttpError(400, 'Acción desconocida.');
    if (def.confirm && body.confirm !== true) throw new HttpError(409, 'Esta acción interrumpe toda la señal y requiere confirmación.', { requiresConfirm: true });
    if (action === 'iniciar') await engine.setMode('running');
    else if (action === 'detener') await engine.setMode('stopped', { reason: `Señal detenida por ${ctx.user.username}` });
    else db.setSettings(def.patch, { bump: false });
    db.audit(ctx.user, `motor_${action}`, 'engine', null, def.patch || null, ctx.ip);
    db.bumpConfigVersion();
    const r = action === 'iniciar' || action === 'detener' ? { replanned: false } : engine.onConfigChanged(def.label);
    json(res, 200, { ok: true, status: engine.status(), appliedNow: r.replanned,
      message: action === 'detener' ? 'Señal detenida.' : action === 'iniciar' ? 'Señal iniciada.' : 'Cambio guardado: se aplica al terminar el contenido que está al aire.' });
  });

  // ---- sedes
  router.get('/api/admin/sites', auth, (req, res) => {
    const sites = db.all('SELECT * FROM sites ORDER BY id').map((s) => ({
      ...siteView(s),
      recentEvents: db.all('SELECT id, type, at, detail FROM site_events WHERE site_id = ? ORDER BY at DESC LIMIT 8', s.id),
      lastDiagnostic: db.get('SELECT at, report FROM diagnostics WHERE site_id = ? ORDER BY at DESC LIMIT 1', s.id) || null,
    }));
    json(res, 200, { sites, configVersion: db.getSettings().config_version });
  });
  router.put('/api/admin/sites/:id', mutate, async (req, res, ctx) => {
    const id = int(ctx.params.id, { name: 'id', min: 1 });
    const s = db.get('SELECT * FROM sites WHERE id = ?', id);
    if (!s) throw new HttpError(404, 'Sede no encontrada.');
    const b = await readJson(req);
    const name = str(b.name, { name: 'nombre', max: 80, required: true });
    db.run('UPDATE sites SET name = ?, description = ?, enabled = ? WHERE id = ?', name, str(b.description, { name: 'descripción', max: 300 }), b.enabled === false ? 0 : 1, id);
    db.audit(ctx.user, 'editar_sede', 'site', id, { name, enabled: b.enabled !== false }, ctx.ip);
    json(res, 200, { ok: true });
  });
  router.get('/api/admin/sites/:id/events', auth, (req, res, ctx) => {
    json(res, 200, { events: db.all('SELECT * FROM site_events WHERE site_id = ? ORDER BY at DESC LIMIT 200', Number(ctx.params.id)),
      sync: db.all('SELECT at, delay_ms, error_ms, seq FROM sync_samples WHERE site_id = ? ORDER BY at DESC LIMIT 120', Number(ctx.params.id)) });
  });

  // ---- anunciantes
  const advView = (a) => ({ id: a.id, name: a.name, contactName: a.contact_name, phone: a.phone, email: a.email, notes: a.notes,
    validFrom: local(a.valid_from), validTo: local(a.valid_to), active: !!a.active, ads: a.ads ?? 0, plays: a.plays ?? 0 });
  router.get('/api/admin/advertisers', auth, (req, res) => {
    json(res, 200, { advertisers: db.all(`SELECT a.*, (SELECT COUNT(*) FROM ads WHERE advertiser_id = a.id) AS ads,
      (SELECT COUNT(*) FROM ad_plays WHERE advertiser_id = a.id AND status = 'completado') AS plays FROM advertisers a ORDER BY a.name`).map(advView) });
  });
  const advFields = (b) => ({
    name: str(b.name, { name: 'nombre', max: 120, required: true }), contact: str(b.contactName, { name: 'contacto', max: 120 }),
    phone: str(b.phone, { name: 'teléfono', max: 40 }), email: email(b.email), notes: str(b.notes, { name: 'notas', max: 1000 }),
    from: localDateTime(b.validFrom, tz, 'Vigencia desde'), to: localDateTime(b.validTo, tz, 'Vigencia hasta'), active: b.active !== false,
  });
  router.post('/api/admin/advertisers', mutate, async (req, res, ctx) => {
    const f = advFields(await readJson(req));
    if (f.from && f.to && f.to <= f.from) throw new HttpError(400, 'La fecha final de vigencia debe ser posterior a la inicial.');
    const now = Date.now();
    const r = db.run('INSERT INTO advertisers (name, contact_name, phone, email, notes, valid_from, valid_to, active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      f.name, f.contact, f.phone, f.email, f.notes, f.from, f.to, f.active ? 1 : 0, now, now);
    changed(ctx, 'crear_anunciante', 'advertiser', r.lastInsertRowid, { name: f.name });
    json(res, 201, { id: Number(r.lastInsertRowid) });
  });
  router.put('/api/admin/advertisers/:id', mutate, async (req, res, ctx) => {
    const id = int(ctx.params.id, { name: 'id', min: 1 });
    if (!db.get('SELECT id FROM advertisers WHERE id = ?', id)) throw new HttpError(404, 'Anunciante no encontrado.');
    const f = advFields(await readJson(req));
    if (f.from && f.to && f.to <= f.from) throw new HttpError(400, 'La fecha final de vigencia debe ser posterior a la inicial.');
    db.run('UPDATE advertisers SET name=?, contact_name=?, phone=?, email=?, notes=?, valid_from=?, valid_to=?, active=?, updated_at=? WHERE id=?',
      f.name, f.contact, f.phone, f.email, f.notes, f.from, f.to, f.active ? 1 : 0, Date.now(), id);
    changed(ctx, 'editar_anunciante', 'advertiser', id, { name: f.name, active: f.active });
    json(res, 200, { ok: true });
  });

  // ---- comerciales
  router.get('/api/admin/ads', auth, (req, res, ctx) => {
    const q = ctx.query; const where = []; const args = [];
    if (q.get('q')) { where.push('(a.name LIKE ? OR adv.name LIKE ?)'); args.push(`%${q.get('q')}%`, `%${q.get('q')}%`); }
    if (q.get('advertiserId')) { where.push('a.advertiser_id = ?'); args.push(Number(q.get('advertiserId'))); }
    if (q.get('from')) { where.push('a.created_at >= ?'); args.push(localDateTime(`${q.get('from')}T00:00`, tz, 'Desde')); }
    if (q.get('to')) { where.push('a.created_at < ?'); args.push(localDateTime(`${q.get('to')}T00:00`, tz, 'Hasta') + 86_400_000); }
    const rows = db.all(`SELECT a.*, adv.name AS advertiser_name,
        (SELECT COUNT(*) FROM ad_plays p WHERE p.ad_id = a.id AND p.status = 'completado') AS plays,
        (SELECT MAX(started_at) FROM ad_plays p WHERE p.ad_id = a.id AND p.status IN ('completado','interrumpido')) AS last_played_at
      FROM ads a LEFT JOIN advertisers adv ON adv.id = a.advertiser_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY a.position, a.id`, ...args);
    const onAir = engine.current?.kind === 'ad' ? engine.current.mediaId : null;
    let ads = rows.map((a) => adView(a, onAir));
    if (q.get('state')) ads = ads.filter((a) => a.state === q.get('state') || a.status === q.get('state'));
    json(res, 200, { ads, nextAdId: engine.next?.kind === 'ad' ? engine.next.mediaId : null });
  });

  router.post('/api/admin/ads/upload', mutate, async (req, res, ctx) => {
    const q = ctx.query;
    const name = str(q.get('name'), { name: 'nombre', max: 120, required: true });
    const advertiserId = int(q.get('advertiserId'), { name: 'anunciante', min: 1 });
    if (advertiserId && !db.get('SELECT id FROM advertisers WHERE id = ?', advertiserId)) throw new HttpError(400, 'El anunciante no existe.');
    const filename = str(q.get('filename'), { name: 'archivo', max: 255, required: true });
    let received;
    try { received = await library.receive(req, { kind: 'ad', originalName: filename }); }
    catch (e) { if (e instanceof UploadError) throw new HttpError(e.status, e.message); throw e; }
    const id = library.createAd(received, { name, advertiserId, originalName: filename });
    const activate = bool(q.get('activate'));
    const placeFirst = q.get('position') === 'inicio';
    db.tx(() => {
      if (activate) db.run('UPDATE ads SET activate_on_ready = 1 WHERE id = ?', id);
      if (placeFirst) {
        db.run('UPDATE ads SET position = position + 1 WHERE id <> ?', id);
        db.run('UPDATE ads SET position = 1 WHERE id = ?', id);
      }
    });
    db.audit(ctx.user, 'subir_comercial', 'ad', id, { name, filename, size: received.size, sha256: received.sha256, activate }, ctx.ip);
    json(res, 202, { id, message: 'Archivo recibido. Se está validando y procesando; quedará disponible cuando termine.' });
  });

  router.put('/api/admin/ads/:id', mutate, async (req, res, ctx) => {
    const id = int(ctx.params.id, { name: 'id', min: 1 });
    loadAd(id);
    const b = await readJson(req);
    const name = str(b.name, { name: 'nombre', max: 120, required: true });
    const advertiserId = int(b.advertiserId, { name: 'anunciante', min: 1 });
    if (advertiserId && !db.get('SELECT id FROM advertisers WHERE id = ?', advertiserId)) throw new HttpError(400, 'El anunciante no existe.');
    const weight = int(b.weight ?? 1, { name: 'frecuencia', min: 1, max: 10 });
    const from = localDateTime(b.validFrom, tz, 'Vigencia desde');
    const to = localDateTime(b.validTo, tz, 'Vigencia hasta');
    if (from && to && to <= from) throw new HttpError(400, 'La fecha final de vigencia debe ser posterior a la inicial.');
    db.run('UPDATE ads SET name=?, advertiser_id=?, weight=?, valid_from=?, valid_to=?, updated_at=? WHERE id=?', name, advertiserId, weight, from, to, Date.now(), id);
    const r = changed(ctx, 'editar_comercial', 'ad', id, { name, advertiserId, weight, validFrom: b.validFrom || null, validTo: b.validTo || null });
    json(res, 200, { ok: true, appliedToNext: r.replanned });
  });

  router.post('/api/admin/ads/:id/activate', mutate, (req, res, ctx) => {
    const id = int(ctx.params.id, { name: 'id', min: 1 });
    const a = loadAd(id);
    if (a.status === 'procesando') {
      db.run('UPDATE ads SET activate_on_ready = 1 WHERE id = ?', id);
      db.audit(ctx.user, 'activar_al_terminar_validacion', 'ad', id, null, ctx.ip);
      return json(res, 200, { ok: true, message: 'Se activará automáticamente cuando termine la validación.' });
    }
    if (a.status !== 'listo') throw new HttpError(409, `No se puede activar: el comercial está "${a.status}". ${a.error || ''}`.trim());
    db.run('UPDATE ads SET active = 1, deactivated_at = NULL, updated_at = ? WHERE id = ?', Date.now(), id);
    const r = changed(ctx, 'activar_comercial', 'ad', id, { name: a.name });
    json(res, 200, { ok: true, appliedToNext: r.replanned, message: 'Comercial activado. Entra en la rotación en la siguiente transición segura.' });
  });

  router.post('/api/admin/ads/:id/deactivate', mutate, async (req, res, ctx) => {
    const id = int(ctx.params.id, { name: 'id', min: 1 });
    const a = loadAd(id);
    const b = await readJson(req);
    const immediate = b.mode === 'inmediato';
    db.run('UPDATE ads SET active = 0, activate_on_ready = 0, deactivated_at = ?, updated_at = ? WHERE id = ?', Date.now(), Date.now(), id);
    const r = changed(ctx, immediate ? 'desactivar_comercial_inmediato' : 'desactivar_comercial', 'ad', id, { name: a.name });
    let cut = false;
    if (immediate) cut = engine.cutCurrentAd(id, `Retirado de inmediato por ${ctx.user.username}`);
    const wasOnAir = !immediate && engine.current?.kind === 'ad' && engine.current.mediaId === id;
    json(res, 200, { ok: true, cut, appliedToNext: r.replanned,
      message: cut ? 'Comercial retirado y cortado al aire.' : wasOnAir ? 'El comercial terminará normalmente y luego saldrá de la rotación.' : 'Comercial desactivado.' });
  });

  router.post('/api/admin/ads/:id/replace', mutate, async (req, res, ctx) => {
    const id = int(ctx.params.id, { name: 'id', min: 1 });
    const old = loadAd(id);
    const b = await readJson(req);
    const withId = int(b.withAdId, { name: 'comercial de reemplazo', min: 1, required: true });
    const nw = loadAd(withId);
    if (withId === id) throw new HttpError(400, 'Elija un comercial distinto.');
    if (!['listo', 'procesando'].includes(nw.status)) throw new HttpError(409, 'El comercial de reemplazo no está disponible (fue rechazado o está dañado).');
    db.tx(() => {
      db.run('UPDATE ads SET position = position + 1 WHERE position > ? AND id <> ?', old.position, withId);
      db.run(`UPDATE ads SET position = ?, replaces_ad_id = ?, active = CASE WHEN status = 'listo' THEN 1 ELSE active END,
        activate_on_ready = CASE WHEN status = 'procesando' THEN 1 ELSE 0 END, weight = ?, updated_at = ? WHERE id = ?`, old.position + 1, id, old.weight, Date.now(), withId);
      db.run('UPDATE ads SET active = 0, deactivated_at = ?, updated_at = ? WHERE id = ?', Date.now(), Date.now(), id);
    });
    const r = changed(ctx, 'reemplazar_comercial', 'ad', id, { reemplazado: old.name, por: nw.name });
    json(res, 200, { ok: true, appliedToNext: r.replanned, message: `"${old.name}" termina normalmente si está al aire; "${nw.name}" toma su lugar en el siguiente ciclo.` });
  });

  router.post('/api/admin/ads/reorder', mutate, async (req, res, ctx) => {
    const b = await readJson(req);
    if (!Array.isArray(b.ids) || b.ids.length > 1000) throw new HttpError(400, 'Lista de orden inválida.');
    const ids = b.ids.map((x) => int(x, { name: 'id', min: 1 }));
    db.tx(() => ids.forEach((id, i) => db.run('UPDATE ads SET position = ? WHERE id = ?', i + 1, id)));
    const r = changed(ctx, 'ordenar_comerciales', 'ad', null, { orden: ids });
    json(res, 200, { ok: true, appliedToNext: r.replanned });
  });

  router.delete('/api/admin/ads/:id', mutate, (req, res, ctx) => {
    const id = int(ctx.params.id, { name: 'id', min: 1 });
    const a = loadAd(id);
    const plays = db.get('SELECT COUNT(*) AS n FROM ad_plays WHERE ad_id = ?', id).n;
    const used = db.get('SELECT COUNT(*) AS n FROM program_items WHERE (media_id = ? AND kind = \'ad\') OR loop_ad_id = ?', id, id).n;
    if (plays || used) throw new HttpError(409, 'Este comercial tiene historial de emisión: no se borra para conservar los reportes. Desactívelo en su lugar.');
    if (a.status === 'procesando') throw new HttpError(409, 'Espere a que termine la validación antes de borrarlo.');
    db.run('DELETE FROM ads WHERE id = ?', id);
    fs.rmSync(library.adDir(id), { recursive: true, force: true });
    changed(ctx, 'borrar_comercial_sin_historial', 'ad', id, { name: a.name });
    json(res, 200, { ok: true });
  });

  router.get('/api/admin/ads/:id/history', auth, (req, res, ctx) => {
    const id = int(ctx.params.id, { name: 'id', min: 1 });
    json(res, 200, reports.plays({ adId: id, limit: 300, includeAll: true }));
  });
  router.get('/api/admin/ads/:id/thumb', auth, (req, res, ctx) => sendFile(req, res, library.adFile(int(ctx.params.id, { name: 'id', min: 1 }), 'thumb'), { cacheControl: 'private, max-age=300' }));
  router.get('/api/admin/ads/:id/video', auth, (req, res, ctx) => sendFile(req, res, library.adFile(int(ctx.params.id, { name: 'id', min: 1 }), 'normalized'), { cacheControl: 'private, max-age=300' }));

  // ---- música
  router.get('/api/admin/music', auth, (req, res) => {
    const songs = db.all('SELECT * FROM songs WHERE archived = 0 ORDER BY position, id').map(songView);
    json(res, 200, { songs, onAirSongId: engine.current?.kind === 'song' ? engine.current.mediaId : null });
  });
  router.post('/api/admin/music/upload', mutate, async (req, res, ctx) => {
    const q = ctx.query;
    const filename = str(q.get('filename'), { name: 'archivo', max: 255, required: true });
    const title = str(q.get('title'), { name: 'título', max: 160 }) || filename.replace(/\.[^.]+$/, '');
    const artist = str(q.get('artist'), { name: 'artista', max: 160 });
    let received;
    try { received = await library.receive(req, { kind: 'song', originalName: filename }); }
    catch (e) { if (e instanceof UploadError) throw new HttpError(e.status, e.message); throw e; }
    const id = library.createSong(received, { title, artist, originalName: filename });
    db.audit(ctx.user, 'subir_cancion', 'song', id, { title, filename, sha256: received.sha256 }, ctx.ip);
    json(res, 202, { id });
  });
  router.put('/api/admin/music/:id', mutate, async (req, res, ctx) => {
    const id = int(ctx.params.id, { name: 'id', min: 1 });
    if (!db.get('SELECT id FROM songs WHERE id = ?', id)) throw new HttpError(404, 'Canción no encontrada.');
    const b = await readJson(req);
    db.run('UPDATE songs SET title=?, artist=?, enabled=?, backup=?, updated_at=? WHERE id=?',
      str(b.title, { name: 'título', max: 160, required: true }), str(b.artist, { name: 'artista', max: 160 }), b.enabled === false ? 0 : 1, b.backup ? 1 : 0, Date.now(), id);
    const r = changed(ctx, 'editar_cancion', 'song', id, { enabled: b.enabled !== false, backup: !!b.backup });
    json(res, 200, { ok: true, appliedToNext: r.replanned });
  });
  router.post('/api/admin/music/reorder', mutate, async (req, res, ctx) => {
    const b = await readJson(req);
    if (!Array.isArray(b.ids) || b.ids.length > 20000) throw new HttpError(400, 'Lista de orden inválida.');
    const ids = b.ids.map((x) => int(x, { name: 'id', min: 1 }));
    db.tx(() => ids.forEach((id, i) => db.run('UPDATE songs SET position = ? WHERE id = ?', i + 1, id)));
    const r = changed(ctx, 'ordenar_musica', 'song', null, { total: ids.length });
    json(res, 200, { ok: true, appliedToNext: r.replanned });
  });
  router.post('/api/admin/music/:id/archive', mutate, (req, res, ctx) => {
    const id = int(ctx.params.id, { name: 'id', min: 1 });
    db.run('UPDATE songs SET archived = 1, enabled = 0, updated_at = ? WHERE id = ?', Date.now(), id);
    const r = changed(ctx, 'archivar_cancion', 'song', id, null);
    json(res, 200, { ok: true, appliedToNext: r.replanned });
  });
  router.get('/api/admin/music/:id/audio', auth, (req, res, ctx) => sendFile(req, res, library.songFile(int(ctx.params.id, { name: 'id', min: 1 })), { cacheControl: 'private, max-age=300' }));

  // ---- ajustes de programación y horario
  const settingsView = () => {
    const s = db.getSettings();
    return { songsBetweenAds: s.songs_between_ads, adsPerBlock: s.ads_per_block, musicShuffle: !!s.music_shuffle,
      musicPaused: !!s.music_paused, adsPaused: !!s.ads_paused, engineMode: s.engine_mode, configVersion: s.config_version };
  };
  router.get('/api/admin/settings', auth, (req, res) => json(res, 200, settingsView()));
  router.put('/api/admin/settings', mutate, async (req, res, ctx) => {
    const b = await readJson(req);
    const patch = {
      songs_between_ads: int(b.songsBetweenAds, { name: 'canciones entre comerciales', min: 1, max: 20, required: true }),
      ads_per_block: int(b.adsPerBlock ?? 1, { name: 'comerciales por bloque', min: 1, max: 5 }),
      music_shuffle: bool(b.musicShuffle),
    };
    db.setSettings(patch, { bump: false });
    const r = changed(ctx, 'cambiar_reglas', 'settings', null, patch);
    json(res, 200, { ok: true, settings: settingsView(), appliedToNext: r.replanned,
      message: 'Regla guardada. Se aplica de forma segura cuando termine el contenido que está al aire.' });
  });

  router.get('/api/admin/schedule', auth, (req, res) => {
    const hours = db.all('SELECT * FROM schedule_hours ORDER BY weekday, start_min').map((h) => ({ weekday: h.weekday, start: minToHHMM(h.start_min), end: minToHHMM(h.end_min) }));
    const changes = db.all("SELECT * FROM schedule_changes ORDER BY effective_at DESC LIMIT 100").map((c) => ({
      id: c.id, effectiveAt: local(c.effective_at), patch: JSON.parse(c.patch), description: c.description, status: c.status, createdBy: c.created_by, appliedAt: local(c.applied_at) }));
    const p = localParts(Date.now(), tz);
    json(res, 200, { timezone: tz, hours, changes, nowLocal: local(Date.now()), weekdayNow: p.weekday });
  });
  router.put('/api/admin/schedule/hours', mutate, async (req, res, ctx) => {
    const b = await readJson(req);
    if (!Array.isArray(b.hours) || b.hours.length > 50) throw new HttpError(400, 'Horario inválido.');
    const rows = b.hours.map((h) => {
      const weekday = int(h.weekday, { name: 'día', min: 0, max: 6, required: true });
      let start; let end;
      try { start = parseHHMM(h.start); end = parseHHMM(h.end); } catch (e) { throw new HttpError(400, e.message); }
      if (start === end) throw new HttpError(400, 'Una franja no puede empezar y terminar a la misma hora.');
      return { weekday, start, end };
    });
    db.tx(() => {
      db.run('DELETE FROM schedule_hours');
      for (const r of rows) db.run('INSERT INTO schedule_hours (weekday, start_min, end_min) VALUES (?, ?, ?)', r.weekday, r.start, r.end);
    });
    const r = changed(ctx, 'cambiar_horario', 'schedule', null, { franjas: b.hours });
    json(res, 200, { ok: true, appliedToNext: r.replanned });
  });
  router.post('/api/admin/schedule/changes', mutate, async (req, res, ctx) => {
    const b = await readJson(req);
    const at = localDateTime(b.effectiveAt, tz, 'Fecha de aplicación');
    if (!at) throw new HttpError(400, 'Indique la fecha y hora en que debe aplicarse el cambio.');
    if (at <= Date.now()) throw new HttpError(400, 'La fecha del cambio debe ser futura.');
    const patch = {};
    if (b.songsBetweenAds != null && b.songsBetweenAds !== '') patch.songs_between_ads = int(b.songsBetweenAds, { name: 'canciones entre comerciales', min: 1, max: 20 });
    if (b.adsPerBlock != null && b.adsPerBlock !== '') patch.ads_per_block = int(b.adsPerBlock, { name: 'comerciales por bloque', min: 1, max: 5 });
    if (b.musicPaused != null && b.musicPaused !== '') patch.music_paused = bool(b.musicPaused);
    if (b.adsPaused != null && b.adsPaused !== '') patch.ads_paused = bool(b.adsPaused);
    if (!Object.keys(patch).length) throw new HttpError(400, 'Indique al menos un cambio.');
    const r = db.run("INSERT INTO schedule_changes (effective_at, patch, description, status, created_at, created_by) VALUES (?, ?, ?, 'pendiente', ?, ?)",
      at, JSON.stringify(patch), str(b.description, { name: 'descripción', max: 200 }), Date.now(), ctx.user.username);
    db.audit(ctx.user, 'programar_cambio', 'schedule_change', r.lastInsertRowid, { at: b.effectiveAt, patch }, ctx.ip);
    json(res, 201, { id: Number(r.lastInsertRowid) });
  });
  router.delete('/api/admin/schedule/changes/:id', mutate, (req, res, ctx) => {
    const id = int(ctx.params.id, { name: 'id', min: 1 });
    db.run("UPDATE schedule_changes SET status = 'cancelado' WHERE id = ? AND status = 'pendiente'", id);
    db.audit(ctx.user, 'cancelar_cambio_programado', 'schedule_change', id, null, ctx.ip);
    json(res, 200, { ok: true });
  });

  // ---- reportes
  const reportQuery = (q) => ({ from: q.get('from'), to: q.get('to'), adId: q.get('adId'), advertiserId: q.get('advertiserId'),
    siteId: q.get('siteId'), status: q.get('status'), limit: q.get('limit'), offset: q.get('offset') });
  const checkDates = (q) => { for (const k of ['from', 'to', 'date']) if (q.get(k) && !/^\d{4}-\d{2}-\d{2}$/.test(q.get(k))) throw new HttpError(400, 'Fecha inválida (use AAAA-MM-DD).'); };
  router.get('/api/admin/reports/plays', auth, (req, res, ctx) => { checkDates(ctx.query); json(res, 200, reports.plays(reportQuery(ctx.query))); });
  router.get('/api/admin/reports/summary', auth, (req, res, ctx) => {
    checkDates(ctx.query);
    const p = localParts(Date.now(), tz);
    const today = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
    json(res, 200, reports.summary(ctx.query.get('date') || today));
  });
  router.get('/api/admin/reports/plays.csv', auth, (req, res, ctx) => {
    checkDates(ctx.query);
    db.audit(ctx.user, 'exportar_reporte', 'report', null, Object.fromEntries(ctx.query), ctx.ip);
    send(res, 200, reports.csv(reportQuery(ctx.query)), { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="reporte-publicidad-${Date.now()}.csv"` });
  });
  router.get('/api/admin/reports/backup', auth, (req, res) => {
    json(res, 200, { items: db.all(`SELECT b.*, s.name AS site_name, a.name AS ad_name FROM backup_ad_plays b JOIN sites s ON s.id = b.site_id
      LEFT JOIN ads a ON a.id = b.ad_id ORDER BY b.started_at DESC LIMIT 300`) });
  });

  // ---- registros
  router.get('/api/admin/logs', auth, (req, res, ctx) => {
    const type = ctx.query.get('type') || 'engine';
    const limit = Math.min(Number(ctx.query.get('limit')) || 200, 1000);
    if (type === 'audit') return json(res, 200, { items: db.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', limit) });
    if (type === 'sites') return json(res, 200, { items: db.all('SELECT e.*, s.name AS site_name FROM site_events e JOIN sites s ON s.id = e.site_id ORDER BY e.at DESC LIMIT ?', limit) });
    if (type === 'asrun') return json(res, 200, { items: db.all(`SELECT p.id, p.kind, p.media_id, p.status, p.slate, p.actual_start, p.actual_end, p.duration_ms, p.first_seq, p.last_seq, p.note,
      CASE p.kind WHEN 'song' THEN (SELECT title FROM songs WHERE id = p.media_id) WHEN 'ad' THEN (SELECT name FROM ads WHERE id = p.media_id) END AS title
      FROM program_items p WHERE p.status NOT IN ('preparando','listo') ORDER BY p.id DESC LIMIT ?`, limit) });
    if (type === 'diagnostics') return json(res, 200, { items: db.all('SELECT d.*, s.name AS site_name FROM diagnostics d LEFT JOIN sites s ON s.id = d.site_id ORDER BY d.at DESC LIMIT ?', limit) });
    json(res, 200, { items: db.all('SELECT * FROM engine_log ORDER BY id DESC LIMIT ?', limit) });
  });
}
