// Utilidades HTTP sin dependencias: enrutador, JSON, cookies, archivos estáticos con soporte de rangos.
import fs from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, ...handlers) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\//g, '\\/').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '\\/?$');
    this.routes.push({ method, re, keys, handlers });
  }
  get(p, ...h) { this.add('GET', p, ...h); }
  post(p, ...h) { this.add('POST', p, ...h); }
  put(p, ...h) { this.add('PUT', p, ...h); }
  delete(p, ...h) { this.add('DELETE', p, ...h); }
  match(method, pathname) {
    let methodMismatch = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) { methodMismatch = true; continue; }
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return methodMismatch ? { methodMismatch: true } : null;
  }
}

export function send(res, status, body, headers = {}) {
  if (res.headersSent) { res.end(); return; }
  const isBuf = Buffer.isBuffer(body);
  const payload = body == null ? '' : isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  const h = { ...headers };
  if (!h['Content-Type']) h['Content-Type'] = isBuf ? 'application/octet-stream' : typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8';
  h['Content-Length'] = Buffer.byteLength(payload);
  res.writeHead(status, h);
  res.end(res.req?.method === 'HEAD' ? undefined : payload);
}

export const json = (res, status, obj, headers) => send(res, status, obj, { 'Cache-Control': 'no-store', ...headers });

export async function readJson(req, limit = 1024 * 1024) {
  const ct = String(req.headers['content-type'] || '');
  if (!ct.includes('application/json')) throw new HttpError(415, 'Se esperaba contenido JSON.');
  let size = 0; const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'La solicitud es demasiado grande.');
    chunks.push(c);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'JSON inválido.'); }
}

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xf) return xf;
  }
  return req.socket?.remoteAddress || 'desconocida';
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.txt': 'text/plain; charset=utf-8',
};
export const contentType = (f) => TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream';

/** Sirve un archivo con soporte de Range (necesario para video en muchos televisores y navegadores). */
export function sendFile(req, res, file, { cacheControl = 'no-cache', headers = {} } = {}) {
  let st;
  try { st = fs.statSync(file); } catch { throw new HttpError(404, 'Archivo no encontrado.'); }
  if (!st.isFile()) throw new HttpError(404, 'Archivo no encontrado.');
  const type = contentType(file);
  const base = { 'Content-Type': type, 'Cache-Control': cacheControl, 'Accept-Ranges': 'bytes', 'Last-Modified': st.mtime.toUTCString(), ...headers };
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (range && st.size > 0) {
    let start = range[1] === '' ? Math.max(0, st.size - Number(range[2])) : Number(range[1]);
    let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : st.size - 1;
    if (range[1] === '' ) end = st.size - 1;
    if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); res.end(); return; }
    end = Math.min(end, st.size - 1);
    res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
    return;
  }
  res.writeHead(200, { ...base, 'Content-Length': st.size });
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

/** Resuelve una ruta dentro de un directorio impidiendo salir de él (path traversal). */
export function safeJoin(dir, rel) {
  const p = path.resolve(dir, '.' + path.posix.normalize('/' + String(rel || '')).replace(/^\/+/, '/'));
  if (p !== dir && !p.startsWith(dir + path.sep)) throw new HttpError(404, 'Archivo no encontrado.');
  return p;
}
