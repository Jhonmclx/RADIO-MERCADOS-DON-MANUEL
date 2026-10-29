// Rutas PÚBLICAS: reproductores de las sedes, señal en vivo, telemetría y diagnóstico.
// Ninguna de estas rutas permite cambiar la programación, subir o borrar archivos ni ver datos de anunciantes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, json, readJson, sendFile, safeJoin } from './core.js';
import { securityHeaders } from './security.js';

const SLUG = /^[a-z0-9][a-z0-9-]{0,40}$/;
const SITE_STATES = new Set(['reproduciendo', 'cargando', 'bloqueado_autoplay', 'sin_senal', 'respaldo', 'reconectando', 'error', 'en_espera', 'pausado']);
const EVENT_TYPES = new Set(['desconexion', 'reconexion', 'error', 'respaldo_inicio', 'respaldo_fin', 'autoplay_bloqueado', 'sonido_activado',
  'retraso_excesivo', 'resincronizacion', 'recarga', 'senal_detenida', 'respaldo_descargado', 'respaldo_no_disponible', 'inicio']);

export function registerPublicRoutes(router, app) {
  const { cfg, db, engine, library } = app;
  const lastSample = new Map();

  const siteBySlug = (slug) => {
    if (!SLUG.test(slug)) throw new HttpError(404, 'Sede no encontrada.');
    const s = db.get('SELECT * FROM sites WHERE slug = ?', slug);
    if (!s) throw new HttpError(404, 'Sede no encontrada.');
    return s;
  };

  router.get('/healthz', (req, res) => {
    const st = engine.status();
    const stale = st.mode === 'running' && Date.now() - st.lastPlaylistWriteAt > 4 * cfg.hls.segmentSeconds * 1000;
    json(res, stale ? 503 : 200, { ok: !stale, mode: st.mode, lastPlaylistWriteAt: st.lastPlaylistWriteAt });
  });

  router.get('/api/public/time', (req, res) => json(res, 200, { now: Date.now() }));

  // Página del reproductor (una por sede).
  router.get('/player/:slug', (req, res, ctx) => {
    // Enlaces antiguos /player/sede-N: redirigen a la sede correspondiente por su número.
    const old = /^sede-(\d)$/.exec(ctx.params.slug);
    if (old && !db.get('SELECT id FROM sites WHERE slug = ?', ctx.params.slug)) {
      const s = db.get('SELECT slug FROM sites WHERE id = ?', Number(old[1]));
      if (s) { res.writeHead(302, { Location: `/player/${s.slug}` }); res.end(); return; }
    }
    const s = siteBySlug(ctx.params.slug);
    if (!s.enabled) throw new HttpError(404, 'Esta sede está deshabilitada.');
    sendFile(req, res, path.join(cfg.root, 'public', 'player', 'player.html'), { headers: securityHeaders('player') });
  });
  // Service worker con alcance /player/ (el nombre contiene un punto, por lo que nunca choca con una sede).
  router.get('/player/sw.js', (req, res) => sendFile(req, res, path.join(cfg.root, 'public', 'player', 'sw.js'),
    { headers: { 'Service-Worker-Allowed': '/player/', 'Content-Type': 'text/javascript; charset=utf-8' } }));

  router.get('/diagnostico', (req, res) => sendFile(req, res, path.join(cfg.root, 'public', 'diagnostico', 'index.html'), { headers: securityHeaders('player') }));

  router.get('/api/public/sites/:slug/state', (req, res, ctx) => {
    const s = siteBySlug(ctx.params.slug);
    const st = engine.status();
    json(res, 200, {
      appName: cfg.appName,
      site: { slug: s.slug, name: s.name, enabled: !!s.enabled },
      serverNow: Date.now(),
      engine: { mode: st.mode, onAirKind: st.onAir?.kind || null },
      stream: { url: '/live/index.m3u8', targetDelayMs: cfg.hls.targetDelayMs, segmentSeconds: cfg.hls.segmentSeconds },
      configVersion: st.configVersion,
      heartbeatSeconds: cfg.heartbeatSeconds,
      player: cfg.player,
      backupManifestUrl: `/api/public/sites/${s.slug}/backup-manifest`,
    });
  });

  router.post('/api/public/sites/:slug/heartbeat', async (req, res, ctx) => {
    const s = siteBySlug(ctx.params.slug);
    if (!s.enabled) throw new HttpError(403, 'Sede deshabilitada.');
    const b = await readJson(req, 64 * 1024);
    const now = Date.now();
    const state = SITE_STATES.has(b.state) ? b.state : 'desconocido';
    const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.round(Number(v)) : null);
    const wasOffline = s.last_seen_at && now - s.last_seen_at > cfg.siteOfflineAfterSeconds * 1000;
    const sets = {
      last_seen_at: now, last_state: state, last_config_version: num(b.configVersion),
      last_delay_ms: num(b.delayMs), last_sync_error_ms: num(b.syncErrorMs), last_seq: num(b.seq),
      player_mode: String(b.mode || '').slice(0, 30) || null, user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
      session_id: String(b.sessionId || '').slice(0, 64) || null, backup_status: String(b.backupStatus || '').slice(0, 120) || null,
    };
    if (b.error) { sets.last_error = String(b.error).slice(0, 300); sets.last_error_at = now; }
    if (wasOffline) {
      sets.last_reconnect_at = now; sets.last_disconnect_ms = now - s.last_seen_at;
      db.run('INSERT OR IGNORE INTO site_events (id, site_id, type, at, detail, received_at) VALUES (?, ?, ?, ?, ?, ?)',
        `srv-${s.id}-${now}`, s.id, 'reconexion', now, JSON.stringify({ origen: 'servidor', sinContactoMs: now - s.last_seen_at }), now);
    }
    db.run(`UPDATE sites SET ${Object.keys(sets).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(sets), s.id);
    // Historial de sincronización: una muestra cada 30 s por sede (el valor actual siempre queda en la tabla sites).
    if (sets.last_delay_ms != null && now - (lastSample.get(s.id) || 0) >= 30_000) {
      lastSample.set(s.id, now);
      db.run('INSERT INTO sync_samples (site_id, at, delay_ms, error_ms, seq) VALUES (?, ?, ?, ?, ?)', s.id, now, sets.last_delay_ms, sets.last_sync_error_ms, sets.last_seq);
    }

    // Eventos del reproductor: el identificador lo genera el televisor, por eso un reintento NO duplica el evento.
    let accepted = 0;
    for (const e of (Array.isArray(b.events) ? b.events.slice(0, 100) : [])) {
      if (!e || typeof e.id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(e.id) || !EVENT_TYPES.has(e.type)) continue;
      const at = num(e.at); if (!at || at > now + 60_000 || at < now - 30 * 86_400_000) continue;
      const r = db.run('INSERT OR IGNORE INTO site_events (id, site_id, type, at, detail, received_at) VALUES (?, ?, ?, ?, ?, ?)',
        e.id, s.id, e.type, at, e.detail == null ? null : JSON.stringify(e.detail).slice(0, 2000), now);
      accepted += Number(r.changes);
    }
    // Reproducciones de comerciales hechas con el RESPALDO LOCAL (sin señal central): se guardan aparte.
    for (const p of (Array.isArray(b.backupPlays) ? b.backupPlays.slice(0, 100) : [])) {
      if (!p || typeof p.id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(p.id)) continue;
      db.run('INSERT OR IGNORE INTO backup_ad_plays (id, site_id, ad_id, started_at, ended_at, completed, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        p.id, s.id, num(p.adId), num(p.startedAt), num(p.endedAt), p.completed ? 1 : 0, now);
    }
    // Confirmación segmento a segmento de la señal central (solo segmentos de comerciales).
    const seqs = [...new Set((Array.isArray(b.seqs) ? b.seqs.slice(0, 300) : []).map(num).filter((x) => x != null && x >= 0))];
    if (state === 'reproduciendo' || state === 'bloqueado_autoplay') {
      for (const seq of seqs) {
        const info = engine.seqInfo(seq);
        if (!info?.adPlayId) continue;
        const ins = db.run('INSERT OR IGNORE INTO site_segment_seen (site_id, seq, at) VALUES (?, ?, ?)', s.id, seq, now);
        if (!ins.changes) continue;
        db.run(`INSERT INTO site_ad_confirmations (ad_play_id, site_id, first_seen_at, last_seen_at, segments_seen, source)
          VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT(ad_play_id, site_id) DO UPDATE SET segments_seen = segments_seen + 1, last_seen_at = excluded.last_seen_at`,
          info.adPlayId, s.id, now, now, state === 'bloqueado_autoplay' ? 'senal_central_sin_sonido' : 'senal_central');
      }
    }
    const st = engine.status();
    json(res, 200, { ok: true, accepted, serverNow: now, configVersion: st.configVersion, engineMode: st.mode, targetDelayMs: cfg.hls.targetDelayMs });
  });

  const backupAds = () => engine.eligibleAds(Date.now()).filter((a) => {
    const r = db.get('SELECT backup_sha256 FROM ads WHERE id = ?', a.id);
    return r?.backup_sha256;
  });

  router.get('/api/public/sites/:slug/backup-manifest', (req, res, ctx) => {
    siteBySlug(ctx.params.slug);
    // Modo local (?modo=local): el televisor descarga TODA la programación una vez y la reproduce él mismo,
    // con los comerciales en calidad normal. Así casi no consume Internet del servidor.
    const local = new URL(req.url, 'http://x').searchParams.get('modo') === 'local';
    const size = (f) => { try { return fs.statSync(f).size; } catch { return null; } };
    let ads;
    if (local) {
      ads = engine.eligibleAds(Date.now()).map((a) => {
        const r = db.get('SELECT normalized_sha256, duration_ms FROM ads WHERE id = ?', a.id);
        if (!r?.normalized_sha256) return null;
        return { id: a.id, url: `/media/local/ad/${a.id}/${r.normalized_sha256.slice(0, 16)}.mp4`, durationMs: r.duration_ms, sha256: r.normalized_sha256, bytes: size(library.adFile(a.id)) };
      }).filter(Boolean);
    } else {
      ads = backupAds().slice(0, 6).map((a) => {
        const r = db.get('SELECT backup_sha256, duration_ms FROM ads WHERE id = ?', a.id);
        return { id: a.id, url: `/media/backup/ad/${a.id}/${r.backup_sha256.slice(0, 16)}.mp4`, durationMs: r.duration_ms, sha256: r.backup_sha256, bytes: size(library.adFile(a.id, 'backup')) };
      });
    }
    const songSql = local
      ? "SELECT id, normalized_sha256, duration_ms FROM songs WHERE status = 'listo' AND enabled = 1 AND archived = 0 AND normalized_sha256 IS NOT NULL ORDER BY position LIMIT 400"
      : "SELECT id, normalized_sha256, duration_ms FROM songs WHERE status = 'listo' AND enabled = 1 AND backup = 1 AND archived = 0 ORDER BY position LIMIT 60";
    const songBase = local ? '/media/local/song' : '/media/backup/song';
    const songs = db.all(songSql)
      .map((x) => ({ id: x.id, url: `${songBase}/${x.id}/${x.normalized_sha256.slice(0, 16)}.m4a`, durationMs: x.duration_ms, sha256: x.normalized_sha256, bytes: size(library.songFile(x.id)) }));
    const s = db.getSettings();
    const musicPaused = !!s.music_paused; const adsPaused = !!s.ads_paused;
    const version = crypto.createHash('sha256').update(JSON.stringify([ads.map((a) => a.sha256), songs.map((x) => x.sha256), s.songs_between_ads, musicPaused, adsPaused])).digest('hex').slice(0, 16);
    json(res, 200, { version, local, songsBetweenAds: s.songs_between_ads, musicPaused, adsPaused, configVersion: s.config_version, ads, songs });
  });

  router.get('/media/local/ad/:id/:file', (req, res, ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || !engine.eligibleAds(Date.now()).some((a) => a.id === id)) throw new HttpError(404, 'No disponible.');
    sendFile(req, res, library.adFile(id), { cacheControl: 'public, max-age=86400, immutable' });
  });
  router.get('/media/local/song/:id/:file', (req, res, ctx) => {
    const id = Number(ctx.params.id);
    const ok = Number.isInteger(id) && db.get("SELECT id FROM songs WHERE id = ? AND status = 'listo' AND enabled = 1 AND archived = 0", id);
    if (!ok) throw new HttpError(404, 'No disponible.');
    sendFile(req, res, library.songFile(id), { cacheControl: 'public, max-age=86400, immutable' });
  });

  router.get('/media/backup/ad/:id/:file', (req, res, ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || !backupAds().some((a) => a.id === id)) throw new HttpError(404, 'No disponible.');
    sendFile(req, res, library.adFile(id, 'backup'), { cacheControl: 'public, max-age=86400, immutable' });
  });
  router.get('/media/backup/song/:id/:file', (req, res, ctx) => {
    const id = Number(ctx.params.id);
    const ok = Number.isInteger(id) && db.get("SELECT id FROM songs WHERE id = ? AND status = 'listo' AND enabled = 1 AND backup = 1 AND archived = 0", id);
    if (!ok) throw new HttpError(404, 'No disponible.');
    sendFile(req, res, library.songFile(id), { cacheControl: 'public, max-age=86400, immutable' });
  });

  router.post('/api/public/diagnostics', async (req, res) => {
    const b = await readJson(req, 64 * 1024);
    let siteId = null;
    if (typeof b.site === 'string' && SLUG.test(b.site)) siteId = db.get('SELECT id FROM sites WHERE slug = ?', b.site)?.id ?? null;
    db.run('INSERT INTO diagnostics (site_id, at, report, user_agent) VALUES (?, ?, ?, ?)', siteId, Date.now(),
      JSON.stringify(b.report ?? {}).slice(0, 30_000), String(req.headers['user-agent'] || '').slice(0, 300));
    db.run('DELETE FROM diagnostics WHERE id NOT IN (SELECT id FROM diagnostics ORDER BY id DESC LIMIT 500)');
    json(res, 201, { ok: true });
  });

  // Señal en vivo (HLS). La lista nunca se guarda en caché; los segmentos son inmutables.
  router.get('/live/:file', (req, res, ctx) => {
    const f = ctx.params.file;
    if (f === 'index.m3u8') {
      return sendFile(req, res, path.join(cfg.liveDir, 'index.m3u8'), { cacheControl: 'no-cache, no-store', headers: { 'Access-Control-Allow-Origin': '*' } });
    }
    if (!/^s\d+\.ts$/.test(f)) throw new HttpError(404, 'Segmento no encontrado.');
    sendFile(req, res, safeJoin(cfg.liveDir, f), { cacheControl: 'public, max-age=300, immutable', headers: { 'Access-Control-Allow-Origin': '*' } });
  });
}
