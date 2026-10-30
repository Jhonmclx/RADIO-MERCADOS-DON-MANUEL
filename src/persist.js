// Guardado permanente en Supabase Storage (opcional).
// Sirve para servidores sin disco permanente (por ejemplo Render gratis): al arrancar se recupera la base de datos
// y los archivos procesados; mientras funciona se van guardando copias.
// Se activa con SUPABASE_URL y SUPABASE_SERVICE_KEY (clave secreta: solo en variables de entorno del servidor).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

const MIME = { '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.jpg': 'image/jpeg', '.sqlite': 'application/octet-stream' };

export class Persist {
  constructor({ cfg, env = process.env, log = () => {} }) {
    this.cfg = cfg; this.log = log;
    this.url = String(env.SUPABASE_URL || '').replace(/\/$/, '');
    this.key = env.SUPABASE_SERVICE_KEY || '';
    this.bucket = env.SUPABASE_BUCKET || 'radio-mercado';
    this.enabled = !!(this.url && this.key);
    this.maxBytes = Number(env.SUPABASE_MAX_FILE_MB || 50) * 1024 * 1024;
    this.lastDbHash = null;
    this.status = { enabled: this.enabled, lastSnapshotAt: null, lastError: null, restored: null, uploads: 0 };
  }

  headers(extra = {}) { return { Authorization: `Bearer ${this.key}`, apikey: this.key, ...extra }; }
  objUrl(p) { return `${this.url}/storage/v1/object/${this.bucket}/${p.split('/').map(encodeURIComponent).join('/')}`; }

  async ensureBucket() {
    const r = await fetch(`${this.url}/storage/v1/bucket`, { method: 'POST', headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ id: this.bucket, name: this.bucket, public: false }) });
    if (r.ok) { this.log('info', `Almacenamiento permanente: carpeta "${this.bucket}" creada en Supabase.`); return; }
    const t = await r.text();
    if (r.status === 409 || /already exists|Duplicate/i.test(t)) return;
    // Con una clave sin permiso para crear carpetas (clave pública + reglas de acceso), la carpeta ya debe existir.
    if (r.status === 401 || r.status === 403 || /row-level security|Unauthorized/i.test(t)) return;
    throw new Error(`No se pudo preparar el almacenamiento (${r.status}): ${t.slice(0, 200)}`);
  }

  async download(remote, local) {
    const r = await fetch(this.objUrl(remote), { headers: this.headers() });
    if (r.status === 404 || r.status === 400) return false; // no existe
    if (!r.ok) throw new Error(`Error ${r.status} al descargar ${remote}`);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    const tmp = `${local}.dl-${crypto.randomBytes(3).toString('hex')}`;
    const { pipeline } = await import('node:stream/promises');
    await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(tmp));
    fs.renameSync(tmp, local);
    return true;
  }

  async upload(local, remote) {
    const st = fs.statSync(local);
    if (st.size > this.maxBytes) throw new Error(`${path.basename(local)} pesa ${Math.round(st.size / 1048576)} MB y supera el límite de ${Math.round(this.maxBytes / 1048576)} MB por archivo de Supabase gratis.`);
    // Se envía en flujo (sin cargar el archivo completo en memoria) y de a un archivo a la vez:
    // el servidor gratis tiene 512 MB y varios comerciales de 40 MB en memoria lo hacían reiniciarse.
    const prev = this.uploadChain || Promise.resolve();
    let release; this.uploadChain = new Promise((r) => { release = r; });
    await prev;
    let r;
    try {
      r = await fetch(this.objUrl(remote), { method: 'POST', duplex: 'half',
        headers: this.headers({ 'Content-Type': MIME[path.extname(local)] || 'application/octet-stream', 'Content-Length': String(st.size), 'x-upsert': 'true', 'cache-control': '3600' }),
        body: Readable.toWeb(fs.createReadStream(local)) });
    } finally { release(); }
    if (!r.ok) throw new Error(`Error ${r.status} al guardar ${remote}: ${(await r.text()).slice(0, 200)}`);
    this.status.uploads += 1;
  }

  async remove(prefixes) {
    await fetch(`${this.url}/storage/v1/object/${this.bucket}`, { method: 'DELETE', headers: this.headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ prefixes }) }).catch(() => {});
  }

  /** Antes de abrir la base de datos: trae la última copia guardada. */
  async restoreDatabase() {
    if (!this.enabled) return false;
    await this.ensureBucket();
    // La copia se guarda comprimida (gasta ~4 veces menos datos); se acepta también la copia antigua sin comprimir.
    let ok = await this.download('db/radio.sqlite.gz', this.cfg.dbFile + '.gz');
    if (ok) {
      fs.writeFileSync(this.cfg.dbFile, zlib.gunzipSync(fs.readFileSync(this.cfg.dbFile + '.gz')));
      fs.rmSync(this.cfg.dbFile + '.gz', { force: true });
    } else {
      ok = await this.download('db/radio.sqlite', this.cfg.dbFile);
    }
    if (ok) {
      for (const s of ['-wal', '-shm']) fs.rmSync(this.cfg.dbFile + s, { force: true });
      this.log('info', 'Base de datos recuperada del almacenamiento permanente.');
    }
    this.status.restored = ok;
    return ok;
  }

  mediaFiles(kind, id) {
    const base = kind === 'ad' ? path.join(this.cfg.mediaDir, 'ads', String(id)) : path.join(this.cfg.mediaDir, 'music', String(id));
    const rel = kind === 'ad' ? `media/ads/${id}` : `media/music/${id}`;
    const names = kind === 'ad' ? ['normalized.mp4', 'thumb.jpg', 'backup.mp4'] : ['normalized.m4a'];
    return names.map((n) => ({ local: path.join(base, n), remote: `${rel}/${n}`, required: n.startsWith('normalized') }));
  }

  /** Después de abrir la base: descarga los archivos de canciones y comerciales que falten en disco. */
  async restoreMedia(db) {
    if (!this.enabled) return;
    const items = [
      ...db.all("SELECT id FROM ads WHERE status = 'listo' AND archived = 0").map((r) => ['ad', r.id]),
      ...db.all("SELECT id FROM songs WHERE status = 'listo' AND archived = 0").map((r) => ['song', r.id]),
    ];
    let n = 0; let missing = 0;
    for (const [kind, id] of items) {
      for (const f of this.mediaFiles(kind, id)) {
        if (fs.existsSync(f.local)) continue;
        try {
          if (await this.download(f.remote, f.local)) n++;
          else if (f.required) missing++;
        } catch (e) { this.log('warn', `No se pudo recuperar ${f.remote}`, { error: e.message }); }
      }
    }
    if (n || missing) this.log(missing ? 'warn' : 'info', `Archivos recuperados del almacenamiento permanente: ${n}.${missing ? ` Faltan ${missing} (se marcarán como no disponibles).` : ''}`);
  }

  async saveMedia(kind, id, db) {
    if (!this.enabled) return;
    for (const f of this.mediaFiles(kind, id)) {
      if (!fs.existsSync(f.local)) continue;
      try { await this.upload(f.local, f.remote); }
      catch (e) {
        this.status.lastError = e.message;
        this.log('warn', `No se pudo guardar en el almacenamiento permanente: ${e.message}`);
        if (f.required && kind === 'ad' && db) {
          const prev = db.get('SELECT warnings FROM ads WHERE id = ?', id)?.warnings;
          db.run('UPDATE ads SET warnings = ? WHERE id = ?', [prev, `No quedó guardado de forma permanente: ${e.message}`].filter(Boolean).join(' '), id);
        }
      }
    }
  }

  /** Copia consistente de la base de datos; solo se sube si cambió. */
  async snapshot(db, { force = false } = {}) {
    if (!this.enabled || this.saving) return;
    this.saving = true;
    const tmp = path.join(this.cfg.tmpDir, `snap-${Date.now()}.sqlite`);
    try {
      db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      const hash = crypto.createHash('sha256').update(fs.readFileSync(tmp)).digest('hex');
      if (force || hash !== this.lastDbHash) {
        fs.writeFileSync(tmp + '.gz', zlib.gzipSync(fs.readFileSync(tmp), { level: 9 }));
        try { await this.upload(tmp + '.gz', 'db/radio.sqlite.gz'); } finally { fs.rmSync(tmp + '.gz', { force: true }); }
        this.lastDbHash = hash;
        this.status.lastSnapshotAt = Date.now();
      }
      this.status.lastError = null;
    } catch (e) {
      this.status.lastError = e.message;
      this.log('warn', 'No se pudo guardar la copia de la base de datos', { error: e.message });
    } finally {
      fs.rmSync(tmp, { force: true });
      this.saving = false;
    }
  }
}
