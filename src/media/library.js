// Biblioteca multimedia: recepción de archivos, validación, normalización e integridad.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { probe, normalizeAd, makeBackupVideo, makeThumbnail, normalizeSong, sha256File } from './ffmpeg.js';

const AD_FORMATS = ['mov', 'mp4', 'm4a', '3gp', 'matroska', 'webm', 'avi', 'mpegts', 'mpeg', 'flv'];
const SONG_FORMATS = ['mp3', 'mov', 'mp4', 'm4a', 'aac', 'wav', 'ogg', 'flac', 'matroska', 'webm', 'asf', 'amr', '3gp', 'aiff', 'adts'];
const AD_EXT = ['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.ts', '.mpg', '.mpeg', '.3gp'];
const SONG_EXT = ['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.flac', '.wma', '.amr', '.3gp', '.mp4', '.webm', '.weba', '.aif', '.aiff', '.m4b'];
// Tipos MIME que envía el navegador (los celulares a veces entregan archivos sin extensión en el nombre).
const MIME_EXT = {
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac', 'audio/wav': '.wav',
  'audio/x-wav': '.wav', 'audio/ogg': '.ogg', 'audio/opus': '.opus', 'audio/flac': '.flac', 'audio/x-flac': '.flac', 'audio/webm': '.webm',
  'audio/amr': '.amr', 'audio/3gpp': '.3gp', 'audio/x-ms-wma': '.wma', 'audio/aiff': '.aiff', 'audio/x-aiff': '.aiff',
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'video/x-matroska': '.mkv', 'video/3gpp': '.3gp', 'video/x-msvideo': '.avi', 'video/mpeg': '.mpg',
};

export class UploadError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export class MediaLibrary extends EventEmitter {
  constructor({ cfg, db, log = () => {} }) {
    super();
    this.cfg = cfg; this.db = db; this.log = log;
    this.queue = []; this.busy = false;
    this.verified = new Map();
    for (const d of ['ads', 'music']) fs.mkdirSync(path.join(cfg.mediaDir, d), { recursive: true });
    fs.mkdirSync(cfg.tmpDir, { recursive: true });
  }

  adDir(id) { return path.join(this.cfg.mediaDir, 'ads', String(id)); }
  songDir(id) { return path.join(this.cfg.mediaDir, 'music', String(id)); }
  adFile(id, kind = 'normalized') {
    const f = { normalized: 'normalized.mp4', backup: 'backup.mp4', thumb: 'thumb.jpg' }[kind];
    return path.join(this.adDir(id), f);
  }
  songFile(id) { return path.join(this.songDir(id), 'normalized.m4a'); }

  /** Recupera trabajos interrumpidos por un reinicio (archivos que quedaron "procesando"). */
  resumePending() {
    for (const a of this.db.all("SELECT id FROM ads WHERE status = 'procesando'")) this._enqueue('ad', a.id);
    for (const s of this.db.all("SELECT id FROM songs WHERE status = 'procesando'")) this._enqueue('song', s.id);
  }

  /**
   * Guarda el cuerpo de la petición en disco limitando el tamaño y calculando la huella SHA-256 al vuelo.
   * El archivo se guarda con un nombre generado por el servidor (nunca con el nombre del usuario).
   */
  async receive(req, { kind, originalName, mimeType }) {
    const maxBytes = (kind === 'ad' ? this.cfg.uploads.maxAdMB : this.cfg.uploads.maxMusicMB) * 1024 * 1024;
    const allowed = kind === 'ad' ? AD_EXT : SONG_EXT;
    let ext = path.extname(String(originalName || '')).toLowerCase();
    if (ext && !/^\.[a-z0-9]{1,5}$/.test(ext)) ext = '';
    if (!allowed.includes(ext)) {
      const mime = String(mimeType || '').toLowerCase().split(';')[0].trim();
      const fromMime = MIME_EXT[mime];
      const mediaMime = kind === 'ad' ? mime.startsWith('video/') : (mime.startsWith('audio/') || mime.startsWith('video/'));
      if (fromMime && allowed.includes(fromMime)) ext = fromMime;
      else if (!ext || mediaMime) ext = '.bin'; // sin extensión reconocible: FFprobe decide si es audio/video válido
      else throw new UploadError(`Formato de archivo no permitido (${ext}). Permitidos: ${allowed.join(', ')}.`, 415);
    }
    const declared = Number(req.headers['content-length'] || 0);
    if (declared && declared > maxBytes) throw new UploadError(`El archivo supera el tamaño máximo de ${Math.round(maxBytes / 1048576)} MB.`, 413);
    const tmp = path.join(this.cfg.tmpDir, `up-${crypto.randomUUID()}${ext}`);
    const hash = crypto.createHash('sha256');
    let size = 0;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp, { flags: 'wx' });
      let failed = false;
      const fail = (e) => { if (failed) return; failed = true; req.unpipe?.(out); out.destroy(); fs.rm(tmp, { force: true }, () => {}); reject(e); };
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) { req.pause(); fail(new UploadError(`El archivo supera el tamaño máximo de ${Math.round(maxBytes / 1048576)} MB.`, 413)); return; }
        hash.update(chunk);
        if (!out.write(chunk)) { req.pause(); out.once('drain', () => req.resume()); }
      });
      req.on('end', () => { if (!failed) out.end(); });
      req.on('error', fail);
      req.on('aborted', () => fail(new UploadError('La carga se interrumpió antes de terminar.', 400)));
      out.on('finish', () => { if (!failed) resolve(); });
      out.on('error', fail);
    });
    if (size === 0) { fs.rmSync(tmp, { force: true }); throw new UploadError('El archivo está vacío.'); }
    return { tmp, size, sha256: hash.digest('hex'), ext };
  }

  createAd({ tmp, size, sha256, ext }, { name, advertiserId, originalName }) {
    const now = Date.now();
    const pos = (this.db.get('SELECT COALESCE(MAX(position), 0) AS p FROM ads').p || 0) + 1;
    const r = this.db.run(`INSERT INTO ads (name, advertiser_id, status, active, position, original_name, original_sha256, size_bytes, created_at, updated_at)
      VALUES (?, ?, 'procesando', 0, ?, ?, ?, ?, ?, ?)`, name, advertiserId ?? null, pos, originalName ?? null, sha256, size, now, now);
    const id = Number(r.lastInsertRowid);
    const dir = this.adDir(id);
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(tmp, path.join(dir, `original${ext}`));
    const dup = this.db.get("SELECT id, name FROM ads WHERE original_sha256 = ? AND id <> ? AND status <> 'rechazado' AND archived = 0", sha256, id);
    if (dup) this.db.run('UPDATE ads SET warnings = ? WHERE id = ?', `Este archivo es idéntico al comercial #${dup.id} (${dup.name}).`, id);
    this._enqueue('ad', id);
    return id;
  }

  createSong({ tmp, size, sha256, ext }, { title, artist, originalName }) {
    const now = Date.now();
    const pos = (this.db.get('SELECT COALESCE(MAX(position), 0) AS p FROM songs').p || 0) + 1;
    const r = this.db.run(`INSERT INTO songs (title, artist, status, enabled, position, original_name, original_sha256, size_bytes, created_at, updated_at)
      VALUES (?, ?, 'procesando', 1, ?, ?, ?, ?, ?, ?)`, title, artist ?? null, pos, originalName ?? null, sha256, size, now, now);
    const id = Number(r.lastInsertRowid);
    const dir = this.songDir(id);
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(tmp, path.join(dir, `original${ext}`));
    this._enqueue('song', id);
    return id;
  }

  _enqueue(kind, id) {
    this.queue.push({ kind, id });
    this._pump();
  }

  /** Espera a que la cola de procesamiento quede vacía (útil en pruebas y apagado ordenado). */
  async idle() {
    while (this.busy || this.queue.length) await new Promise((r) => setTimeout(r, 100));
  }

  async _pump() {
    if (this.busy) return;
    const job = this.queue.shift();
    if (!job) return;
    this.busy = true;
    try {
      if (job.kind === 'ad') await this._processAd(job.id);
      else await this._processSong(job.id);
    } catch (e) {
      this.log('error', `Error inesperado procesando ${job.kind} #${job.id}`, { error: e.message });
    } finally {
      this.busy = false;
      setImmediate(() => this._pump());
    }
  }

  _original(dir) {
    const f = fs.readdirSync(dir).find((n) => n.startsWith('original'));
    return f ? path.join(dir, f) : null;
  }

  async _processAd(id) {
    const dir = this.adDir(id);
    const src = this._original(dir);
    const reject = (msg, err) => {
      this.db.run("UPDATE ads SET status = 'rechazado', error = ?, active = 0, updated_at = ? WHERE id = ?", msg, Date.now(), id);
      this.log('warn', `Comercial #${id} rechazado: ${msg}`, err ? { detalle: String(err).slice(-500) } : undefined);
      this.emit('changed', { kind: 'ad', id, status: 'rechazado' });
    };
    if (!src) return reject('No se encontró el archivo original.');
    let info;
    try { info = await probe(this.cfg, src); } catch (e) { return reject('El archivo está dañado o no es un video reconocible.', e.stderr || e.message); }
    if (!AD_FORMATS.some((f) => info.formatName.split(',').includes(f))) return reject(`Formato de contenedor no admitido (${info.formatName}).`);
    if (!info.video) return reject('El archivo no contiene una pista de video.');
    if (!info.durationMs || info.durationMs < 1000) return reject('El video dura menos de un segundo o su duración no se puede leer.');
    const warnings = [];
    const prev = this.db.get('SELECT warnings FROM ads WHERE id = ?', id)?.warnings;
    if (prev) warnings.push(prev);
    if (!info.audio) warnings.push('El video no tiene audio: el bloque comercial sonará en silencio.');
    const norm = path.join(dir, 'normalized.mp4');
    try {
      await normalizeAd(this.cfg, src, norm + '.part.mp4', { hasAudio: !!info.audio });
      fs.renameSync(norm + '.part.mp4', norm);
    } catch (e) { fs.rmSync(norm + '.part.mp4', { force: true }); return reject('FFmpeg no pudo procesar el video (archivo dañado o códec no compatible).', e.stderr || e.message); }
    let normInfo;
    try { normInfo = await probe(this.cfg, norm); } catch (e) { return reject('El video procesado no se pudo verificar.', e.message); }
    if (Math.abs(normInfo.durationMs - info.durationMs) > 2000) warnings.push(`La duración cambió al procesar (${info.durationMs} → ${normInfo.durationMs} ms).`);
    try { await makeThumbnail(this.cfg, norm, path.join(dir, 'thumb.jpg'), normInfo.durationMs); } catch (e) { warnings.push('No se pudo generar la miniatura.'); }
    let backupSha = null;
    try { await makeBackupVideo(this.cfg, norm, path.join(dir, 'backup.mp4')); backupSha = await sha256File(path.join(dir, 'backup.mp4')); }
    catch (e) { warnings.push('No se pudo generar la copia liviana para respaldo local.'); }
    const normSha = await sha256File(norm);
    this.db.run(`UPDATE ads SET status = 'listo', error = NULL, warnings = ?, duration_ms = ?, width = ?, height = ?, video_codec = ?, audio_codec = ?,
      has_audio = ?, normalized_sha256 = ?, backup_sha256 = ?, active = CASE WHEN activate_on_ready = 1 THEN 1 ELSE active END,
      activate_on_ready = 0, updated_at = ? WHERE id = ?`,
      warnings.length ? warnings.join(' ') : null, normInfo.durationMs, info.video.width, info.video.height, info.video.codec,
      info.audio?.codec ?? null, info.audio ? 1 : 0, normSha, backupSha, Date.now(), id);
    this.log('info', `Comercial #${id} validado y listo (${Math.round(normInfo.durationMs / 1000)} s).`);
    this.emit('changed', { kind: 'ad', id, status: 'listo' });
  }

  async _processSong(id) {
    const dir = this.songDir(id);
    const src = this._original(dir);
    const reject = (msg, err) => {
      this.db.run("UPDATE songs SET status = 'rechazado', error = ?, updated_at = ? WHERE id = ?", msg, Date.now(), id);
      this.log('warn', `Canción #${id} rechazada: ${msg}`, err ? { detalle: String(err).slice(-500) } : undefined);
      this.emit('changed', { kind: 'song', id, status: 'rechazado' });
    };
    if (!src) return reject('No se encontró el archivo original.');
    let info;
    try { info = await probe(this.cfg, src); } catch (e) { return reject('El archivo está dañado o no es un audio reconocible.', e.stderr || e.message); }
    if (!SONG_FORMATS.some((f) => info.formatName.split(',').includes(f))) return reject(`Formato no admitido (${info.formatName}).`);
    if (!info.audio) return reject('El archivo no contiene audio.');
    if (!info.durationMs || info.durationMs < 1000) return reject('El audio dura menos de un segundo o su duración no se puede leer.');
    const norm = this.songFile(id);
    try { await normalizeSong(this.cfg, src, norm + '.part.m4a'); fs.renameSync(norm + '.part.m4a', norm); }
    catch (e) { fs.rmSync(norm + '.part.m4a', { force: true }); return reject('FFmpeg no pudo procesar el audio.', e.stderr || e.message); }
    const normInfo = await probe(this.cfg, norm);
    const sha = await sha256File(norm);
    this.db.run("UPDATE songs SET status = 'listo', error = NULL, duration_ms = ?, normalized_sha256 = ?, updated_at = ? WHERE id = ?",
      normInfo.durationMs, sha, Date.now(), id);
    this.emit('changed', { kind: 'song', id, status: 'listo' });
  }

  /**
   * Verifica la huella del archivo normalizado antes de emitirlo. El resultado se guarda en memoria
   * mientras el archivo no cambie de tamaño ni de fecha (evita recalcular en cada ciclo).
   */
  async verifyIntegrity(kind, row) {
    const file = kind === 'ad' ? this.adFile(row.id) : this.songFile(row.id);
    const expected = row.normalized_sha256;
    let st;
    try { st = fs.statSync(file); } catch { return { ok: false, reason: 'El archivo no existe en el almacenamiento.' }; }
    const key = `${file}|${st.size}|${st.mtimeMs}`;
    if (this.verified.get(file) === key) return { ok: true, file };
    const sha = await sha256File(file);
    if (sha !== expected) return { ok: false, reason: 'La huella SHA-256 no coincide (archivo alterado o dañado).' };
    this.verified.set(file, key);
    return { ok: true, file };
  }
}
