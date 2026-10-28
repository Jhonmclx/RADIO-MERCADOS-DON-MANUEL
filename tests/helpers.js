// Utilidades de prueba: medios sintéticos verificables, servidor real en un proceso hijo, cliente del panel.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const ADMIN = { user: 'admin', pass: 'ClavePrueba2026' };

export function tmpDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), `rmdm-${prefix}-`)); }

function ff(args) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]); }

/**
 * Medios de prueba con firmas medibles:
 *  - Comerciales: primer segundo de un color "inicial" y el resto de otro color; tono de audio propio (1000/1500 Hz).
 *  - Canciones: tonos de 440 y 660 Hz.
 * Así se puede comprobar en los segmentos publicados qué audio suena y qué video se ve.
 */
export function makeFixtures(dir, { songSeconds = 6, adSeconds = 8 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const ad = (name, c1, c2, freq) => {
    const out = path.join(dir, name);
    if (!fs.existsSync(out)) ff(['-f', 'lavfi', '-i', `color=c=${c1}:s=320x180:d=1:r=25`, '-f', 'lavfi', '-i', `color=c=${c2}:s=320x180:d=${adSeconds - 1}:r=25`,
      '-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=44100:duration=${adSeconds}`, '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
      '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]);
    return out;
  };
  const song = (name, freq, secs = songSeconds) => {
    const out = path.join(dir, name);
    if (!fs.existsSync(out)) ff(['-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=44100:duration=${secs}`, '-c:a', 'libmp3lame', '-b:a', '96k', out]);
    return out;
  };
  const corrupt = path.join(dir, 'danado.mp4');
  if (!fs.existsSync(corrupt)) { const b = Buffer.alloc(200_000); for (let i = 0; i < b.length; i++) b[i] = (i * 7919) % 251; b.write('ftypisom', 4); fs.writeFileSync(corrupt, b); }
  const text = path.join(dir, 'notas.txt');
  fs.writeFileSync(text, 'esto no es un video');
  return {
    ad1: ad('comercial-a.mp4', 'red', 'blue', 1000),
    ad2: ad('comercial-b.mp4', 'yellow', 'magenta', 1500),
    song1: song('cancion-1.mp3', 440),
    song2: song('cancion-2.mp3', 660),
    longSong: song('cancion-larga.mp3', 550, 30),
    corrupt, text,
  };
}

export async function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

/** Inicia el servidor REAL como proceso hijo (permite matarlo con SIGKILL en la prueba de reinicio). */
export async function startServer({ dataDir, port, env = {} } = {}) {
  port = port || await freePort();
  dataDir = dataDir || tmpDir('data');
  const fullEnv = {
    ...process.env, NODE_ENV: 'test', DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1',
    HLS_SEGMENT_SECONDS: '2', VIDEO_WIDTH: '320', VIDEO_HEIGHT: '180', VIDEO_FPS: '25', VIDEO_BITRATE_KBPS: '300', BACKUP_VIDEO_HEIGHT: '144',
    ADMIN_USER: ADMIN.user, ADMIN_PASSWORD: ADMIN.pass, SITE_OFFLINE_AFTER_SECONDS: '6', PLAYER_HEARTBEAT_SECONDS: '2', COOKIE_SECURE: 'false',
    PUBLIC_RATE_PER_MINUTE: '5000', ...env,
  };
  const logFile = path.join(dataDir, 'server.log');
  fs.mkdirSync(dataDir, { recursive: true });
  const out = fs.openSync(logFile, 'a');
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src', 'server.js')], { env: fullEnv, stdio: ['ignore', out, out] });
  const url = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    try { const r = await fetch(`${url}/healthz`); if (r.status === 200 || r.status === 503) break; } catch { /* aún no */ }
    if (proc.exitCode != null) throw new Error(`El servidor terminó al iniciar:\n${fs.readFileSync(logFile, 'utf8')}`);
    await sleep(200);
  }
  return {
    url, port, dataDir, proc, logFile,
    log: () => fs.readFileSync(logFile, 'utf8'),
    async stop() { if (proc.exitCode == null) { proc.kill('SIGTERM'); await new Promise((r) => proc.once('exit', r)); } },
    kill() { proc.kill('SIGKILL'); return new Promise((r) => (proc.exitCode != null ? r() : proc.once('exit', r))); },
  };
}

export class AdminClient {
  constructor(base) { this.base = base; this.cookie = ''; this.csrf = ''; }
  async login(user = ADMIN.user, pass = ADMIN.pass) {
    const r = await fetch(`${this.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: pass }) });
    const data = await r.json();
    if (r.ok) { this.cookie = r.headers.get('set-cookie').split(';')[0]; this.csrf = data.csrf; }
    return { status: r.status, data };
  }
  async req(method, p, body, { csrf = true, raw = false } = {}) {
    const headers = { Cookie: this.cookie };
    if (csrf && method !== 'GET') headers['X-CSRF-Token'] = this.csrf;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(`${this.base}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (raw) return r;
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data };
  }
  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b ?? {}); }
  put(p, b) { return this.req('PUT', p, b); }
  async upload(kind, file, params = {}) {
    const q = new URLSearchParams({ filename: path.basename(file), ...params });
    const url = kind === 'ad' ? `/api/admin/ads/upload?${q}` : `/api/admin/music/upload?${q}`;
    const r = await fetch(`${this.base}${url}`, { method: 'POST', headers: { Cookie: this.cookie, 'X-CSRF-Token': this.csrf, 'Content-Type': 'application/octet-stream' }, body: fs.readFileSync(file) });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }
}

export async function waitFor(fn, { timeout = 60_000, interval = 500, label = 'condición' } = {}) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`Tiempo agotado esperando: ${label}`);
}

/** Recolector de la señal en vivo: descarga cada segmento nuevo (como haría un televisor). */
export class LiveCollector {
  constructor(base) { this.base = base; this.segs = new Map(); this.stopFlag = false; this.playlists = []; }
  start() {
    const loop = async () => {
      while (!this.stopFlag) {
        try {
          const txt = await (await fetch(`${this.base}/live/index.m3u8`)).text();
          this.playlists.push({ at: Date.now(), txt });
          if (this.playlists.length > 50) this.playlists.shift();
          const ms = Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(txt)?.[1] ?? 0);
          let seq = ms; let pdt = null; let dur = null;
          for (const line of txt.split('\n')) {
            if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) pdt = Date.parse(line.slice(25));
            else if (line.startsWith('#EXTINF:')) dur = parseFloat(line.slice(8));
            else if (line && !line.startsWith('#')) {
              if (!this.segs.has(seq)) {
                const r = await fetch(`${this.base}/live/${line.trim()}`);
                if (r.ok) this.segs.set(seq, { seq, pdt, dur, file: line.trim(), buf: Buffer.from(await r.arrayBuffer()), fetchedAt: Date.now() });
              }
              seq++;
            }
          }
        } catch { /* servidor reiniciándose */ }
        await sleep(700);
      }
    };
    this.done = loop();
    return this;
  }
  async stop() { this.stopFlag = true; await this.done; }
}

/** Frecuencia dominante (Hz) del audio de un segmento, por cruces por cero. */
export function dominantFrequency(buf) {
  const pcm = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], { input: buf, maxBuffer: 64 * 1024 * 1024 });
  const n = Math.floor(pcm.length / 2);
  // Se descarta el primer 20 % para evitar transiciones.
  let crossings = 0; let prev = 0; let energy = 0; const start = Math.floor(n * 0.2);
  for (let i = start; i < n; i++) {
    const s = pcm.readInt16LE(i * 2);
    energy += Math.abs(s);
    if (i > start && ((prev < 0 && s >= 0) || (prev >= 0 && s < 0))) crossings++;
    prev = s;
  }
  const seconds = (n - start) / 16000;
  return { hz: seconds > 0 ? crossings / 2 / seconds : 0, avgAmplitude: n - start > 0 ? energy / (n - start) : 0 };
}

/** Color medio (RGB) del primer cuadro de un segmento. */
export function firstFrameColor(buf) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { input: buf });
  return { r: raw[0], g: raw[1], b: raw[2] };
}

export function colorName({ r, g, b }) {
  if (r > 180 && g > 180 && b < 90) return 'amarillo';
  if (r > 160 && g < 90 && b > 160) return 'magenta';
  if (r > 160 && g < 90 && b < 90) return 'rojo';
  if (b > 160 && r < 90 && g < 90) return 'azul';
  if (g > 60 && r < 60 && b < 80) return 'verde';
  return `rgb(${r},${g},${b})`;
}
