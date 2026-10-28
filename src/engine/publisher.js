// Publicador de la lista HLS en vivo: UNA sola lista para todas las sedes.
// Cada segmento lleva EXT-X-PROGRAM-DATE-TIME = hora oficial (UTC) en que ese segmento sale al aire.
// Esa marca es la referencia temporal común con la que los reproductores miden y corrigen su retraso.
import fs from 'node:fs';
import path from 'node:path';

export class Publisher {
  constructor({ cfg, log }) {
    this.cfg = cfg; this.log = log;
    this.dir = cfg.liveDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.window = [];      // [{ seq, name, dur, disc, pdt, itemId }]
    this.nextSeq = 0;      // próximo número de secuencia de medios
    this.discSeq = 0;      // EXT-X-DISCONTINUITY-SEQUENCE
    this.pendingDisc = true;
    this.ended = false;
    this.lastWriteAt = 0;
  }

  restore(saved) {
    if (!saved) return;
    this.nextSeq = saved.nextSeq || 0;
    this.discSeq = saved.discSeq || 0;
    this.window = (saved.window || []).filter((e) => fs.existsSync(path.join(this.dir, e.name)));
    this.pendingDisc = true; // después de un reinicio siempre hay discontinuidad
  }

  snapshot() {
    return { nextSeq: this.nextSeq, discSeq: this.discSeq, window: this.window.slice(-this.cfg.hls.windowSegments) };
  }

  markDiscontinuity() { this.pendingDisc = true; }

  /** Publica un segmento ya renderizado. Devuelve el número de secuencia asignado. */
  publish(srcFile, dur, pdt, itemId) {
    const seq = this.nextSeq++;
    const name = `s${seq}.ts`;
    const dst = path.join(this.dir, name);
    try { fs.rmSync(dst, { force: true }); fs.linkSync(srcFile, dst); }
    catch { fs.copyFileSync(srcFile, dst); }
    this.window.push({ seq, name, dur, disc: this.pendingDisc, pdt, itemId });
    this.pendingDisc = false;
    this.ended = false;
    const max = this.cfg.hls.windowSegments;
    // Cada EXT-X-DISCONTINUITY incrementa el número de discontinuidad de los segmentos siguientes (incluido el
    // propio). Al sacar de la ventana un segmento con esa marca, se suma 1 a EXT-X-DISCONTINUITY-SEQUENCE para
    // que los segmentos que quedan conserven su número (así lo interpretan hls.js y los reproductores nativos).
    while (this.window.length > max) {
      const old = this.window.shift();
      if (old.disc) this.discSeq += 1;
    }
    this.cleanup();
    this.write();
    return seq;
  }

  /** Marca el final de la señal (al detener la emisión) para que los reproductores no esperen indefinidamente. */
  end() { this.ended = true; this.pendingDisc = true; this.write(); }

  playlistText() {
    const h = this.cfg.hls;
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${h.targetDuration}`,
      `#EXT-X-MEDIA-SEQUENCE:${this.window[0]?.seq ?? this.nextSeq}`, `#EXT-X-DISCONTINUITY-SEQUENCE:${this.discSeq}`];
    for (const e of this.window) {
      if (e.disc) lines.push('#EXT-X-DISCONTINUITY');
      lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(e.pdt).toISOString()}`);
      lines.push(`#EXTINF:${e.dur.toFixed(3)},`);
      lines.push(e.name);
    }
    if (this.ended) lines.push('#EXT-X-ENDLIST');
    return lines.join('\n') + '\n';
  }

  write() {
    const file = path.join(this.dir, 'index.m3u8');
    const tmp = file + '.tmp';
    const text = this.playlistText();
    fs.writeFileSync(tmp, text);
    try { fs.renameSync(tmp, file); }
    catch { fs.writeFileSync(file, text); fs.rmSync(tmp, { force: true }); } // Windows: el destino puede estar abierto
    this.lastWriteAt = Date.now();
  }

  /** Borra segmentos que ya salieron de la ventana (se conserva un margen para reproductores retrasados). */
  cleanup() {
    const oldestKeep = (this.window[0]?.seq ?? this.nextSeq) - this.cfg.hls.keepExtraSegments;
    if (oldestKeep <= 0) return;
    // Solo se revisa periódicamente para no listar el directorio en cada segmento.
    if (this._lastCleanup && this.nextSeq - this._lastCleanup < 5) return;
    this._lastCleanup = this.nextSeq;
    for (const f of fs.readdirSync(this.dir)) {
      const m = /^s(\d+)\.ts$/.exec(f);
      if (m && Number(m[1]) < oldestKeep) fs.rmSync(path.join(this.dir, f), { force: true });
    }
  }
}
