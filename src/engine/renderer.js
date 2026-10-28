// Renderizado de elementos de la programación en segmentos HLS (MPEG-TS) listos para publicar.
// Cada elemento (canción con el video del comercial en ciclo silencioso, comercial completo o cortinilla)
// se prepara ANTES de salir al aire; el publicador los libera según el reloj del servidor.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runProcess, makeSlateImage, makeSlateVideo } from '../media/ffmpeg.js';

export const SLATES = {
  espera: { title: 'En un momento continuamos', subtitle: 'Su emisora del mercado' },
  pausa: { title: 'Programación en pausa', subtitle: 'Volvemos enseguida' },
  fuera_horario: { title: 'Fuera del horario de emisión', subtitle: 'Gracias por preferirnos' },
  sin_contenido: { title: 'Sin contenido programado', subtitle: 'Su emisora del mercado' },
  musica: { title: 'Música para su compra', subtitle: 'La radio de su mercado' },
};

export function parseMediaPlaylist(text) {
  const segs = []; let dur = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#EXTINF:')) dur = parseFloat(line.slice(8));
    else if (line && !line.startsWith('#') && dur != null) { segs.push({ file: line.trim(), dur }); dur = null; }
  }
  return segs;
}

export class Renderer {
  constructor({ cfg, library, log }) {
    this.cfg = cfg; this.library = library; this.log = log;
    this.slates = {}; // tipo -> { file (ts), dur }
    this.running = new Map(); // itemId -> child process
    this.cancelled = new Set();
    this.stats = { renders: 0, lastSpeed: null };
  }

  paramsKey() {
    const { width, height, fps, bitrateK, audioBitrateK } = this.cfg.video;
    return `${width}x${height}@${fps}|${bitrateK}|${audioBitrateK}|seg${this.cfg.hls.segmentSeconds}|v4`;
  }

  /** Genera (una sola vez por configuración de video) las cortinillas institucionales. */
  async prepareSlates() {
    const dir = this.cfg.slateDir;
    fs.mkdirSync(dir, { recursive: true });
    const keyFile = path.join(dir, 'params.txt');
    const key = this.paramsKey();
    const fresh = fs.existsSync(keyFile) && fs.readFileSync(keyFile, 'utf8') === key;
    const seg = this.cfg.hls.segmentSeconds;
    for (const [type, text] of Object.entries(SLATES)) {
      const sdir = path.join(dir, type);
      const ts = path.join(sdir, 'seg_00000.ts');
      const mp4 = path.join(sdir, 'slate.mp4');
      if (!fresh || !fs.existsSync(ts) || !fs.existsSync(mp4)) {
        fs.mkdirSync(sdir, { recursive: true });
        const png = path.join(sdir, 'slate.png');
        const r = await makeSlateImage(this.cfg, png, text);
        if (!r.withText) this.log('warn', `Cortinilla "${type}" generada sin texto (FFmpeg sin drawtext o sin fuente).`, r.error ? { error: r.error } : undefined);
        // Ocho segmentos con marcas de tiempo continuas: menos discontinuidades mientras dura una cortinilla.
        await makeSlateVideo(this.cfg, png, mp4, seg * 8);
        await this._segment(mp4, sdir, ['-c', 'copy']);
      }
      const segs = parseMediaPlaylist(fs.readFileSync(path.join(sdir, 'item.m3u8'), 'utf8'));
      this.slates[type] = { segments: segs.map((s) => ({ file: path.join(sdir, s.file), dur: s.dur, absolute: true })), mp4 };
    }
    fs.writeFileSync(keyFile, key);
  }

  async _segment(input, outDir, codecArgs, pre = []) {
    const seg = this.cfg.hls.segmentSeconds;
    await runProcess(this.cfg.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...pre, '-i', input, ...codecArgs,
      '-f', 'hls', '-hls_time', String(seg), '-hls_list_size', '0', '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(outDir, 'seg_%05d.ts'), path.join(outDir, 'item.m3u8')]);
  }

  cancel(itemId) {
    this.cancelled.add(itemId);
    if (this.cancelled.size > 200) this.cancelled.delete(this.cancelled.values().next().value);
    const child = this.running.get(itemId);
    if (child) { try { child.kill('SIGKILL'); } catch { /* ignore */ } this.running.delete(itemId); }
  }

  /**
   * Renderiza un elemento. Devuelve { dir, segments:[{file,dur}], durationMs }.
   * item: { id, kind, mediaId, loopAdId, loopOffsetMs, slate, durationMs }
   */
  async render(item) {
    if (item.kind === 'slate') {
      const s = this.slates[item.slate] || this.slates.espera;
      return { dir: null, segments: s.segments.slice(), durationMs: Math.round(s.segments.reduce((a, x) => a + x.dur, 0) * 1000) };
    }
    const dir = path.join(this.cfg.renderDir, `item-${item.id}-${crypto.randomBytes(3).toString('hex')}`);
    fs.mkdirSync(dir, { recursive: true });
    const t0 = Date.now();
    const onSpawn = (child) => this.running.set(item.id, child);
    const seg = this.cfg.hls.segmentSeconds;
    const hlsOut = ['-f', 'hls', '-hls_time', String(seg), '-hls_list_size', '0', '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(dir, 'seg_%05d.ts'), path.join(dir, 'item.m3u8')];
    try {
      if (item.kind === 'ad') {
        const file = this.library.adFile(item.mediaId);
        // Comercial completo desde el primer segundo, con su audio. Ya está normalizado: se copia sin recodificar.
        await runProcess(this.cfg.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', ...hlsOut], { onSpawn });
      } else if (item.kind === 'song') {
        await this._renderSong(item, hlsOut, onSpawn);
      } else {
        throw new Error(`Tipo de elemento desconocido: ${item.kind}`);
      }
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    } finally {
      this.running.delete(item.id);
    }
    const segments = parseMediaPlaylist(fs.readFileSync(path.join(dir, 'item.m3u8'), 'utf8'))
      .map((s) => ({ file: path.join(dir, s.file), dur: s.dur, absolute: true }));
    if (!segments.length) throw new Error('El renderizado no produjo segmentos.');
    const durationMs = Math.round(segments.reduce((a, s) => a + s.dur, 0) * 1000);
    const took = Date.now() - t0;
    this.stats.renders += 1;
    this.stats.lastSpeed = took > 0 ? durationMs / took : null;
    return { dir, segments, durationMs, renderMs: took };
  }

  /**
   * Canción: audio de la canción + video del comercial activo en ciclo y SIN su audio (se descarta la pista).
   * Modo "copy": el video ya normalizado se copia sin recodificar (bajo consumo de CPU); el desplazamiento
   * del ciclo se ajusta al fotograma clave anterior (múltiplo de la duración de segmento).
   * Modo "encode": recodifica el video (más CPU, cortes exactos). Si "copy" falla se reintenta en "encode".
   */
  async _renderSong(item, hlsOut, onSpawn) {
    const songFile = this.library.songFile(item.mediaId);
    const seg = this.cfg.hls.segmentSeconds;
    const durS = (item.durationMs / 1000).toFixed(3);
    let videoSrc; let offsetS = 0;
    if (item.loopAdId) {
      videoSrc = this.library.adFile(item.loopAdId);
      offsetS = Math.floor((item.loopOffsetMs || 0) / 1000 / seg) * seg;
    } else {
      videoSrc = this.slates.musica.mp4;
    }
    const base = ['-y', '-hide_banner', '-loglevel', 'error', '-stream_loop', '-1'];
    if (offsetS > 0) base.push('-ss', String(offsetS));
    base.push('-i', videoSrc, '-i', songFile, '-map', '0:v:0', '-map', '1:a:0', '-t', durS);
    const copyArgs = [...base, '-c:v', 'copy', '-c:a', 'copy', ...hlsOut];
    if (this.cfg.renderMode === 'copy') {
      try { await runProcess(this.cfg.ffmpeg, copyArgs, { onSpawn }); return; }
      catch (e) {
        if (this.cancelled.has(item.id)) throw new Error('Preparación cancelada (replanificación)');
        this.log('warn', 'El modo de copia falló; se recodifica el video de la canción.', { error: e.message, detalle: String(e.stderr || '').slice(-300) }); }
    }
    const { fps, bitrateK, preset } = this.cfg.video;
    const gop = Math.round(fps * seg);
    await runProcess(this.cfg.ffmpeg, [...base, '-c:v', 'libx264', '-preset', preset, '-profile:v', 'main', '-level:v', '3.1', '-pix_fmt', 'yuv420p',
      '-b:v', `${bitrateK}k`, '-maxrate', `${Math.round(bitrateK * 1.2)}k`, '-bufsize', `${bitrateK * 2}k`,
      '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0', '-force_key_frames', `expr:gte(t,n_forced*${seg})`,
      '-c:a', 'copy', ...hlsOut], { onSpawn });
  }
}
