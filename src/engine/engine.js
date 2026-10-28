// MOTOR CENTRAL DE REPRODUCCIÓN — fuente única de verdad de lo que está al aire.
//
// Funciona íntegramente en el servidor: no depende del panel ni del computador del administrador.
// Ciclo: decide el siguiente elemento (planificador puro) -> lo renderiza a segmentos HLS por adelantado ->
// el publicador los libera en la lista en vivo según el reloj del servidor, con hora oficial por segmento.
// Todo el estado necesario para reanudar (canción en curso, posición, contadores, rotación de comerciales,
// número de secuencia) se guarda en la base de datos después de cada segmento publicado.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { decideNext, initialSchedulerState, clone } from './scheduler.js';
import { Renderer } from './renderer.js';
import { Publisher } from './publisher.js';
import { isWithinHours } from '../lib/time.js';

const PATCHABLE = ['songs_between_ads', 'ads_per_block', 'music_shuffle', 'music_paused', 'ads_paused'];

export class Engine extends EventEmitter {
  constructor({ cfg, db, library, log }) {
    super();
    this.cfg = cfg; this.db = db; this.library = library;
    this.log = log || ((level, msg, detail) => db.engineLog(level, msg, detail));
    this.renderer = new Renderer({ cfg, library, log: this.log });
    this.publisher = new Publisher({ cfg, log: this.log });
    this.sched = initialSchedulerState();
    this.current = null; this.next = null;
    this.timer = null; this.ticking = false;
    this.mode = 'stopped';
    this.planFailures = 0; this.planBlockedUntil = 0;
    this.seqMap = new Map();
    this.startedAt = Date.now();
    this.lastError = null;
    this.lastScheduleCheck = 0;
    this.now = () => Date.now();
  }

  segMs() { return this.cfg.hls.segmentSeconds * 1000; }

  async init() {
    for (const d of [this.cfg.renderDir, this.cfg.liveDir]) fs.mkdirSync(d, { recursive: true });
    await this.renderer.prepareSlates();
    this.recover();
    this.mode = this.db.getSettings().engine_mode === 'stopped' ? 'stopped' : 'running';
    if (this.mode === 'stopped') this.publisher.end();
  }

  // ---------------------------------------------------------------- recuperación tras reinicio
  recover() {
    const row = this.db.get('SELECT state FROM engine_state WHERE id = 1');
    const saved = row ? JSON.parse(row.state) : null;
    if (saved) {
      this.publisher.restore(saved.publisher);
      this.sched = saved.sched || initialSchedulerState();
    }
    const now = this.now();
    // 1) Elemento que estaba al aire cuando se detuvo el servicio.
    const airing = this.db.all("SELECT * FROM program_items WHERE status = 'al_aire' ORDER BY id");
    for (let i = 0; i < airing.length; i++) {
      const r = airing[i];
      const isLast = i === airing.length - 1;
      const segments = r.segments ? JSON.parse(r.segments) : [];
      const filesOk = segments.length > 0 && segments.every((s) => fs.existsSync(s.file));
      if (!isLast || !filesOk || r.kind === 'slate') {
        this._closeRow(r, r.kind === 'slate' ? 'emitido' : 'interrumpido', 'Reinicio del servicio: el elemento no se pudo reanudar', r.published_count);
        continue;
      }
      let t = r.actual_start; let idx = 0;
      while (idx < segments.length && t + segments[idx].dur * 1000 <= now) { t += segments[idx].dur * 1000; idx++; }
      const resumeAt = Math.max(idx, r.published_count);
      const skipped = Math.max(0, idx - r.published_count);
      if (resumeAt >= segments.length) {
        this._closeRow(r, skipped > 0 ? 'interrumpido' : 'emitido', skipped > 0 ? `Reinicio del servicio: ${skipped} segmento(s) sin emitir` : null, r.published_count);
        continue;
      }
      this.current = this._itemFromRow(r, segments);
      this.current.published = resumeAt;
      this.current.publishedMs = segments.slice(0, r.published_count).reduce((a, s) => a + s.dur * 1000, 0);
      if (skipped > 0) {
        this.current.interruptedReason = `Reinicio del servicio: ${skipped} segmento(s) (${Math.round(skipped * this.cfg.hls.segmentSeconds)} s) no se emitieron`;
      }
      this.publisher.markDiscontinuity();
      this.log('warn', `Motor recuperado tras reinicio: se reanuda "${this.current.title}" en el segmento ${resumeAt + 1} de ${segments.length}.`, { omitidos: skipped });
    }
    // 2) Elementos preparados pero no emitidos: se descartan y el planificador vuelve al estado previo.
    const pending = this.db.all("SELECT * FROM program_items WHERE status IN ('preparando', 'listo') ORDER BY id");
    if (pending.length) {
      const first = pending[0];
      if (first.decided_state) this.sched = JSON.parse(first.decided_state);
      for (const p of pending) this._discardRow(p, 'Reinicio del servicio antes de salir al aire');
    }
    this.saveState();
  }

  _itemFromRow(r, segments) {
    const it = {
      id: r.id, kind: r.kind, mediaId: r.media_id, slate: r.slate, loopAdId: r.loop_ad_id,
      segments, start: r.actual_start, published: r.published_count, publishedMs: 0,
      firstSeq: r.first_seq, renderDir: r.render_dir, title: this._title(r.kind, r.media_id, r.slate),
      adPlayId: null, configVersion: r.config_version,
    };
    if (r.kind === 'ad') it.adPlayId = this.db.get('SELECT id FROM ad_plays WHERE program_item_id = ?', r.id)?.id || null;
    return it;
  }

  _title(kind, mediaId, slate) {
    if (kind === 'song') { const s = this.db.get('SELECT title, artist FROM songs WHERE id = ?', mediaId); return s ? (s.artist ? `${s.title} — ${s.artist}` : s.title) : `Canción #${mediaId}`; }
    if (kind === 'ad') { const a = this.db.get('SELECT name FROM ads WHERE id = ?', mediaId); return a ? a.name : `Comercial #${mediaId}`; }
    return { espera: 'Cortinilla de espera', pausa: 'Programación en pausa', fuera_horario: 'Fuera del horario de emisión', sin_contenido: 'Sin contenido programado' }[slate] || 'Cortinilla';
  }

  saveState() {
    const state = JSON.stringify({ publisher: this.publisher.snapshot(), sched: this.sched });
    this.db.run('INSERT INTO engine_state (id, state, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at', state, this.now());
  }

  // ---------------------------------------------------------------- ciclo principal
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch((e) => this._error('Error en el ciclo del motor', e)); }, this.cfg.engineTickMs);
    this.tick().catch((e) => this._error('Error en el ciclo del motor', e));
  }

  async stopLoop() {
    clearInterval(this.timer); this.timer = null;
    while (this.ticking) await new Promise((r) => setTimeout(r, 20));
    if (this.next && !this.next.ready) this.renderer.cancel(this.next.id);
  }

  _error(msg, e) {
    this.lastError = { at: this.now(), message: `${msg}: ${e?.message || e}` };
    this.log('error', msg, { error: e?.message || String(e) });
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      if (now - this.lastScheduleCheck >= 1000) { this.lastScheduleCheck = now; this.applyDueScheduleChanges(now); }
      if (this.mode !== 'running') return;

      if (this.current) {
        // Publica los segmentos cuya hora de salida al aire ya llegó.
        while (this.current && this.current.published < this.current.segments.length && now >= this._segStart(this.current, this.current.published)) {
          if (this.current.kind === 'slate' && this.current.published > 0 && this._slateShouldEnd(now)) {
            this._finishCurrent('emitido');
            break;
          }
          this._publishNext();
        }
        if (this.current && this.current.published >= this.current.segments.length && now >= this._itemEnd(this.current)) {
          const prevEnd = this._itemEnd(this.current);
          if (this.current.kind === 'slate' && this.next?.ready && this.next.kind === 'slate' && this.next.slate === this.current.slate) {
            this._extendSlate(this.current, this.next); // misma cortinilla: se prolonga sin crear otro registro
            this.next = null;
          } else {
            this._finishCurrent('emitido');
            this._transition(now, prevEnd);
          }
        }
      } else {
        this._transition(now, null);
      }
      // Prepara con antelación el elemento siguiente.
      if (this.current && !this.next && now >= this.planBlockedUntil) this.planNext(this._itemEnd(this.current));
    } finally {
      this.ticking = false;
    }
  }

  _segStart(item, k) {
    let t = item.start;
    for (let i = 0; i < k; i++) t += item.segments[i].dur * 1000;
    return Math.round(t);
  }
  _itemEnd(item) { return this._segStart(item, item.segments.length); }

  _transition(now, prevEnd) {
    if (!this.next && now >= this.planBlockedUntil) this.planNext(now);
    // Continuidad: el siguiente elemento empieza exactamente donde terminó el anterior, salvo que haya retraso.
    const startAt = prevEnd != null && now - prevEnd < this.segMs() ? prevEnd : now;
    if (this.next?.ready) {
      this.waitingSince = 0;
      const it = this.next; this.next = null;
      this._startItem(it, startAt);
      this._publishDue(now);
      return;
    }
    // El siguiente no está listo: cortinilla de espera (nunca se deja la señal sin segmentos).
    // Al arrancar se espera un momento a que el primer elemento esté listo.
    if (prevEnd == null) {
      if (!this.waitingSince) this.waitingSince = now;
      if (now - this.waitingSince < 3000 && now >= this.planBlockedUntil) return;
    }
    this.waitingSince = 0;
    if (!this.current) {
      this._startItem(this._slateItem('espera', clone(this.sched)), startAt, 'Relleno: el siguiente elemento aún se estaba preparando');
      this._publishDue(now);
    }
  }

  _publishDue(now) {
    while (this.current && this.current.published < this.current.segments.length && now >= this._segStart(this.current, this.current.published)) this._publishNext();
  }

  _slateItem(slate, decidedState) {
    const seg = this.renderer.slates[slate] || this.renderer.slates.espera;
    return { kind: 'slate', slate, ready: true, segments: seg.segments.slice(), decidedState, title: this._title('slate', null, slate) };
  }

  _extendSlate(cur, nxt) {
    for (const s of nxt.segments) cur.segments.push(s);
    this.publisher.markDiscontinuity();
  }

  /** Una cortinilla se interrumpe en cuanto cambia la situación (vuelve el horario, se reanuda, hay contenido). */
  _slateShouldEnd(now) {
    const cur = this.current;
    if (cur.slate === 'espera') return !!(this.next?.ready && !(this.next.kind === 'slate' && this.next.slate === 'espera'));
    const { item } = decideNext(this.sched, this._ctx(now));
    if (item.kind === 'slate' && item.slate === cur.slate) return false;
    if (this.next && !(this.next.kind === 'slate' && this.next.slate === cur.slate) && this.next.ready) return true;
    // La decisión cambió: se descarta lo planificado y se vuelve a decidir.
    if (this.next) this._discardNext('La situación cambió durante la cortinilla');
    if (now >= this.planBlockedUntil) this.planNext(now);
    return true;
  }

  _startItem(it, startAt, note) {
    it.start = startAt; it.published = 0; it.publishedMs = 0;
    this.publisher.markDiscontinuity();
    if (it.kind === 'slate') {
      const r = this.db.run(`INSERT INTO program_items (kind, slate, status, config_version, planned_start, actual_start, segments, created_at, note)
        VALUES ('slate', ?, 'al_aire', ?, ?, ?, ?, ?, ?)`, it.slate, this.db.getSettings().config_version, startAt, startAt, JSON.stringify(it.segments), this.now(), note || null);
      it.id = Number(r.lastInsertRowid);
    } else {
      this.db.run("UPDATE program_items SET status = 'al_aire', actual_start = ? WHERE id = ?", startAt, it.id);
      if (it.adPlayId) {
        const connected = this.connectedSiteIds();
        this.db.run("UPDATE ad_plays SET status = 'emitiendo', started_at = ?, sites_connected = ? WHERE id = ?",
          startAt, JSON.stringify({ alInicio: connected }), it.adPlayId);
      }
    }
    this.current = it;
    this.emit('item-start', { id: it.id, kind: it.kind, title: it.title });
  }

  _publishNext() {
    const it = this.current;
    const k = it.published;
    const seg = it.segments[k];
    const pdt = this._segStart(it, k);
    let seq;
    try { seq = this.publisher.publish(seg.file, seg.dur, pdt, it.id); }
    catch (e) {
      // Archivo preparado perdido o ilegible: se cierra el elemento como interrumpido y la señal continúa.
      this._error(`No se pudo publicar un segmento de "${it.title}"`, e);
      this._finishCurrent('interrumpido', `Error al publicar el segmento ${k + 1}: ${e.code || e.message}`);
      return;
    }
    it.published += 1; it.publishedMs += seg.dur * 1000;
    if (it.firstSeq == null) it.firstSeq = seq;
    it.lastSeq = seq;
    this.seqMap.set(seq, { itemId: it.id, kind: it.kind, adPlayId: it.adPlayId || null, mediaId: it.mediaId ?? null });
    if (this.seqMap.size > 500) this.seqMap.delete(this.seqMap.keys().next().value);
    this.db.run('UPDATE program_items SET published_count = ?, first_seq = COALESCE(first_seq, ?), last_seq = ?, segments = CASE WHEN kind = \'slate\' THEN ? ELSE segments END WHERE id = ?',
      it.published, seq, seq, it.kind === 'slate' ? JSON.stringify(it.segments) : null, it.id);
    if (it.adPlayId) this.db.run('UPDATE ad_plays SET first_seq = COALESCE(first_seq, ?), last_seq = ? WHERE id = ?', seq, seq, it.adPlayId);
    this.saveState();
  }

  /** Cierra el elemento actual. status: emitido | interrumpido */
  _finishCurrent(status, reason) {
    const it = this.current;
    if (!it) return;
    this.current = null;
    const finalStatus = it.interruptedReason ? 'interrumpido' : status;
    const finalReason = reason || it.interruptedReason || null;
    const end = this._segStart(it, it.published);
    this.db.run('UPDATE program_items SET status = ?, actual_end = ?, duration_ms = ?, published_count = ?, note = COALESCE(?, note) WHERE id = ?',
      finalStatus, end, Math.round(it.publishedMs), it.published, finalReason, it.id);
    if (it.adPlayId) {
      const play = this.db.get('SELECT sites_connected FROM ad_plays WHERE id = ?', it.adPlayId);
      const sc = play?.sites_connected ? JSON.parse(play.sites_connected) : {};
      sc.alFinal = this.connectedSiteIds();
      this.db.run('UPDATE ad_plays SET status = ?, ended_at = ?, observed_ms = ?, interruption_reason = ?, sites_connected = ? WHERE id = ?',
        finalStatus === 'emitido' ? 'completado' : 'interrumpido', end, Math.round(it.publishedMs), finalReason, JSON.stringify(sc), it.adPlayId);
    }
    if (it.renderDir) {
      const dir = it.renderDir;
      // Los segmentos publicados son enlaces/copias en la carpeta en vivo: la carpeta de render ya no se necesita.
      setTimeout(() => fs.rm(dir, { recursive: true, force: true }, () => {}), 1000).unref?.();
    }
    this.emit('item-end', { id: it.id, kind: it.kind, status: finalStatus });
  }

  _closeRow(r, status, reason, published) {
    const segs = r.segments ? JSON.parse(r.segments) : [];
    const ms = Math.round(segs.slice(0, published || 0).reduce((a, s) => a + s.dur * 1000, 0));
    this.db.run('UPDATE program_items SET status = ?, actual_end = ?, duration_ms = ?, note = COALESCE(?, note) WHERE id = ?',
      status, r.actual_start ? r.actual_start + ms : null, ms, reason, r.id);
    if (r.kind === 'ad') {
      this.db.run("UPDATE ad_plays SET status = ?, ended_at = ?, observed_ms = ?, interruption_reason = ? WHERE program_item_id = ? AND status IN ('emitiendo','programado')",
        status === 'emitido' ? 'completado' : 'interrumpido', r.actual_start ? r.actual_start + ms : null, ms, reason, r.id);
    }
    if (r.render_dir) fs.rm(r.render_dir, { recursive: true, force: true }, () => {});
  }

  _discardRow(r, reason) {
    this.db.run("UPDATE program_items SET status = 'descartado', note = ? WHERE id = ?", reason, r.id);
    if (r.kind === 'ad') this.db.run("UPDATE ad_plays SET status = 'descartado', interruption_reason = ? WHERE program_item_id = ? AND status = 'programado'", reason, r.id);
    if (r.render_dir) fs.rm(r.render_dir, { recursive: true, force: true }, () => {});
  }

  _discardNext(reason) {
    const n = this.next;
    if (!n) return;
    this.next = null;
    if (n.kind !== 'slate') {
      this.renderer.cancel(n.id);
      const r = this.db.get('SELECT * FROM program_items WHERE id = ?', n.id);
      if (r) this._discardRow({ ...r, render_dir: n.renderDir || r.render_dir }, reason);
    }
    if (n.decidedState) this.sched = n.decidedState;
    this.saveState();
  }

  // ---------------------------------------------------------------- planificación
  eligibleAds(at) {
    return this.db.all(`SELECT a.id, a.name, a.weight, a.duration_ms, a.position, a.normalized_sha256, a.advertiser_id, adv.name AS advertiser_name
      FROM ads a LEFT JOIN advertisers adv ON adv.id = a.advertiser_id
      WHERE a.status = 'listo' AND a.active = 1
        AND (a.valid_from IS NULL OR a.valid_from <= ?) AND (a.valid_to IS NULL OR a.valid_to > ?)
        AND (a.advertiser_id IS NULL OR (adv.active = 1 AND (adv.valid_from IS NULL OR adv.valid_from <= ?) AND (adv.valid_to IS NULL OR adv.valid_to > ?)))
      ORDER BY a.position, a.id`, at, at, at, at);
  }

  eligibleSongs() {
    return this.db.all("SELECT id, title, artist, duration_ms, normalized_sha256 FROM songs WHERE status = 'listo' AND enabled = 1 AND archived = 0 ORDER BY position, id");
  }

  _ctx(at) {
    const hours = this.db.all('SELECT weekday, start_min, end_min FROM schedule_hours');
    return { settings: this.db.getSettings(), ads: this.eligibleAds(at), songs: this.eligibleSongs(), inHours: isWithinHours(at, hours, this.cfg.timezone) };
  }

  planNext(expectedStart) {
    if (this.planning || this.next) return;
    this.planning = true;
    this._plan(expectedStart).catch((e) => this._error('Error al planificar', e)).finally(() => { this.planning = false; });
  }

  async _plan(expectedStart) {
    const before = clone(this.sched);
    const ctx = this._ctx(expectedStart);
    const { item, state } = decideNext(before, ctx);
    if (item.kind === 'slate') {
      this.next = this._slateItem(item.slate, before);
      this.sched = state;
      return;
    }
    // Integridad: la prioridad comercial nunca salta una verificación fallida.
    const checks = [];
    if (item.kind === 'ad') checks.push(['ad', ctx.ads.find((a) => a.id === item.adId)]);
    if (item.kind === 'song') {
      checks.push(['song', ctx.songs.find((s) => s.id === item.songId)]);
      if (item.loopAdId) checks.push(['ad', ctx.ads.find((a) => a.id === item.loopAdId)]);
    }
    for (const [kind, row] of checks) {
      const v = await this.library.verifyIntegrity(kind, row);
      if (!v.ok) {
        if (kind === 'ad') this.db.run("UPDATE ads SET status = 'danado', active = 0, error = ?, updated_at = ? WHERE id = ?", v.reason, this.now(), row.id);
        else this.db.run("UPDATE songs SET status = 'danado', enabled = 0, error = ?, updated_at = ? WHERE id = ?", v.reason, this.now(), row.id);
        this.log('error', `${kind === 'ad' ? 'Comercial' : 'Canción'} #${row.id} retirado de la programación: ${v.reason}`);
        this.db.bumpConfigVersion();
        this._planFailed();
        return;
      }
    }
    const settings = ctx.settings;
    const mediaId = item.kind === 'ad' ? item.adId : item.songId;
    const r = this.db.run(`INSERT INTO program_items (kind, media_id, loop_ad_id, loop_offset_ms, status, config_version, decided_state, planned_start, duration_ms, created_at)
      VALUES (?, ?, ?, ?, 'preparando', ?, ?, ?, ?, ?)`, item.kind, mediaId, item.loopAdId ?? null, item.loopOffsetMs ?? null,
      settings.config_version, JSON.stringify(before), expectedStart, item.durationMs ?? null, this.now());
    const id = Number(r.lastInsertRowid);
    const nx = { id, kind: item.kind, mediaId, loopAdId: item.loopAdId ?? null, loopOffsetMs: item.loopOffsetMs ?? 0, durationMs: item.durationMs,
      ready: false, decidedState: before, configVersion: settings.config_version, title: this._title(item.kind, mediaId), adPlayId: null };
    if (item.kind === 'ad') {
      const ad = ctx.ads.find((a) => a.id === item.adId);
      nx.adPlayId = crypto.randomUUID();
      this.db.run(`INSERT INTO ad_plays (id, program_item_id, ad_id, ad_name, advertiser_id, advertiser_name, scheduled_at, expected_ms, status, config_version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'programado', ?, ?)`, nx.adPlayId, id, ad.id, ad.name, ad.advertiser_id ?? null, ad.advertiser_name ?? null,
        expectedStart, ad.duration_ms, settings.config_version, this.now());
    }
    this.sched = state;
    this.next = nx;
    this.saveState();
    try {
      const out = await this.renderer.render(nx);
      if (this.next !== nx) { if (out.dir) fs.rm(out.dir, { recursive: true, force: true }, () => {}); return; } // fue descartado mientras se preparaba
      nx.segments = out.segments; nx.renderDir = out.dir; nx.ready = true;
      this.db.run("UPDATE program_items SET status = 'listo', segments = ?, render_dir = ?, duration_ms = ? WHERE id = ?",
        JSON.stringify(out.segments), out.dir, out.durationMs, id);
      this.planFailures = 0;
    } catch (e) {
      if (this.next !== nx) return;
      this.next = null;
      this.sched = before;
      this.db.run("UPDATE program_items SET status = 'fallido', note = ? WHERE id = ?", `Error al preparar: ${e.message}`, id);
      if (nx.adPlayId) this.db.run("UPDATE ad_plays SET status = 'fallido', interruption_reason = ? WHERE id = ?", `No se pudo preparar el comercial: ${e.message}`, nx.adPlayId);
      this._error(`No se pudo preparar "${nx.title}"`, e);
      this.saveState();
      this._planFailed();
    }
  }

  _planFailed() {
    this.planFailures += 1;
    this.planBlockedUntil = this.now() + Math.min(30_000, 500 * 2 ** this.planFailures);
  }

  // ---------------------------------------------------------------- cambios en vivo
  /**
   * Se llama cuando el administrador cambia comerciales, música, ajustes u horarios.
   * El elemento AL AIRE nunca se corta por esto; el siguiente se vuelve a decidir si da tiempo de prepararlo.
   */
  onConfigChanged(reason) {
    if (this.mode !== 'running' || !this.next) return { replanned: false };
    if (this.next.kind === 'slate') { this._discardNext(reason); return { replanned: true }; }
    const remaining = this.current ? this._itemEnd(this.current) - this.now() : 0;
    const estimate = this.cfg.renderMode === 'encode' && this.next.durationMs
      ? 3000 + this.next.durationMs / Math.max(1, this.renderer.stats.lastSpeed || 2) : 4000;
    if (remaining > estimate + this.segMs()) {
      this._discardNext(`Replanificado: ${reason}`);
      this.planNext(this._itemEnd(this.current));
      return { replanned: true };
    }
    this.log('info', `Cambio registrado (${reason}); se aplicará después del siguiente elemento porque ya está listo para salir.`);
    return { replanned: false };
  }

  /** Corta de inmediato el comercial al aire (solo cuando el administrador lo pide expresamente). */
  cutCurrentAd(adId, reason) {
    if (this.current?.kind === 'ad' && this.current.mediaId === adId) {
      this._finishCurrent('interrumpido', reason);
      return true;
    }
    return false;
  }

  async setMode(mode, { reason } = {}) {
    if (mode === this.mode) return;
    this.db.setSettings({ engine_mode: mode });
    if (mode === 'stopped') {
      this.mode = 'stopped';
      if (this.current) this._finishCurrent('interrumpido', reason || 'Señal detenida por el administrador');
      this._discardNext('Señal detenida');
      this.publisher.end();
      this.saveState();
      this.log('warn', 'Señal central DETENIDA por el administrador.');
    } else {
      this.mode = 'running';
      this.planBlockedUntil = 0;
      this.log('info', 'Señal central iniciada.');
      await this.tick();
    }
  }

  applyDueScheduleChanges(now) {
    const due = this.db.all("SELECT * FROM schedule_changes WHERE status = 'pendiente' AND effective_at <= ? ORDER BY effective_at, id", now);
    for (const c of due) {
      let patch = {};
      try { patch = JSON.parse(c.patch); } catch { /* ignore */ }
      const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => PATCHABLE.includes(k)));
      this.db.setSettings(clean);
      this.db.run("UPDATE schedule_changes SET status = 'aplicado', applied_at = ? WHERE id = ?", now, c.id);
      this.db.audit({ username: 'sistema' }, 'aplicar_cambio_programado', 'schedule_change', c.id, clean);
      this.log('info', `Cambio de programación #${c.id} aplicado automáticamente.`, clean);
      this.onConfigChanged('cambio programado aplicado');
    }
  }

  // ---------------------------------------------------------------- consultas
  connectedSiteIds() {
    const since = this.now() - this.cfg.siteOfflineAfterSeconds * 1000;
    return this.db.all('SELECT id FROM sites WHERE enabled = 1 AND last_seen_at >= ?', since).map((r) => r.id);
  }

  seqInfo(seq) {
    const m = this.seqMap.get(seq);
    if (m) return m;
    const r = this.db.get('SELECT id, kind, media_id FROM program_items WHERE first_seq <= ? AND last_seq >= ? ORDER BY id DESC LIMIT 1', seq, seq);
    if (!r) return null;
    const adPlayId = r.kind === 'ad' ? this.db.get('SELECT id FROM ad_plays WHERE program_item_id = ?', r.id)?.id : null;
    return { itemId: r.id, kind: r.kind, adPlayId, mediaId: r.media_id };
  }

  status() {
    const now = this.now();
    const view = (it) => it && ({
      id: it.id ?? null, kind: it.kind, title: it.title, slate: it.slate || null, mediaId: it.mediaId ?? null,
      startedAt: it.start ?? null, endsAt: it.start != null ? this._itemEnd(it) : null,
      durationMs: it.segments ? Math.round(it.segments.reduce((a, s) => a + s.dur * 1000, 0)) : it.durationMs ?? null,
      ready: it.ready ?? true, loopAdId: it.loopAdId ?? null,
    });
    const s = this.db.getSettings();
    return {
      mode: this.mode,
      now,
      uptimeMs: now - this.startedAt,
      onAir: view(this.current),
      next: view(this.next),
      mediaSequence: this.publisher.nextSeq,
      lastPlaylistWriteAt: this.publisher.lastWriteAt,
      songsSinceAd: this.sched.songsSinceAd,
      songsBetweenAds: s.songs_between_ads,
      musicPaused: !!s.music_paused,
      adsPaused: !!s.ads_paused,
      configVersion: s.config_version,
      lastError: this.lastError,
      renderStats: this.renderer.stats,
      segmentSeconds: this.cfg.hls.segmentSeconds,
      targetDelayMs: this.cfg.hls.targetDelayMs,
    };
  }
}
