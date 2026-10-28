// Seguridad del panel: contraseñas con scrypt, sesiones en servidor, protección CSRF y límites de frecuencia.
import crypto from 'node:crypto';
import { HttpError, parseCookies } from './core.js';

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 128 * 1024 * 1024 };
export const SESSION_COOKIE = 'rmdm_sesion';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const got = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length,
    { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

export function validatePasswordStrength(pw) {
  const s = String(pw || '');
  if (s.length < 10) return 'La contraseña debe tener al menos 10 caracteres.';
  if (!/[A-Za-zÁÉÍÓÚáéíóúñÑ]/.test(s) || !/\d/.test(s)) return 'La contraseña debe combinar letras y números.';
  return null;
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const csrfFor = (token) => sha(`csrf:${token}`).slice(0, 40);

export class Sessions {
  constructor({ db, cfg }) { this.db = db; this.cfg = cfg; }

  create(user, req, ip) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.db.run('INSERT INTO sessions (id, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
      sha(token), user.id, now, now + this.cfg.admin.sessionHours * 3600_000, ip, String(req.headers['user-agent'] || '').slice(0, 300));
    this.db.run('DELETE FROM sessions WHERE expires_at < ?', now);
    return token;
  }

  cookie(token, maxAgeS) {
    const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeS}`];
    if (this.cfg.cookieSecure) parts.push('Secure');
    return parts.join('; ');
  }

  /** Devuelve { user, token } o null. */
  fromRequest(req) {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (!token || token.length > 100) return null;
    const row = this.db.get(`SELECT s.id AS sid, s.expires_at, u.id, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ?`, sha(token));
    if (!row || row.expires_at < Date.now()) return null;
    return { user: { id: row.id, username: row.username, role: row.role }, token };
  }

  destroy(token) { if (token) this.db.run('DELETE FROM sessions WHERE id = ?', sha(token)); }
  destroyAllFor(userId, exceptToken) {
    if (exceptToken) this.db.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', userId, sha(exceptToken));
    else this.db.run('DELETE FROM sessions WHERE user_id = ?', userId);
  }
}

/** Limitador de frecuencia en memoria (ventana deslizante simple por clave). */
export class RateLimiter {
  constructor({ limit, windowMs }) {
    this.limit = limit; this.windowMs = windowMs; this.hits = new Map();
    this.gc = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k);
    }, 60_000);
    this.gc.unref?.();
  }
  hit(key) {
    const now = Date.now();
    let v = this.hits.get(key);
    if (!v || v.reset < now) { v = { n: 0, reset: now + this.windowMs }; this.hits.set(key, v); }
    v.n += 1;
    return { allowed: v.n <= this.limit, retryAfterS: Math.ceil((v.reset - now) / 1000) };
  }
  reset(key) { this.hits.delete(key); }
}

/**
 * Comprueba que la petición venga del propio panel: el origen debe coincidir con el host y,
 * para cambios, la cabecera CSRF debe corresponder a la sesión.
 */
export function checkSameOrigin(req, cfg) {
  const origin = req.headers.origin;
  if (!origin) return;
  let host;
  try { host = new URL(origin).host; } catch { throw new HttpError(403, 'Origen no permitido.'); }
  const allowed = new Set([req.headers.host]);
  if (cfg.publicBaseUrl) { try { allowed.add(new URL(cfg.publicBaseUrl).host); } catch { /* ignore */ } }
  if (cfg.trustProxy && req.headers['x-forwarded-host']) allowed.add(String(req.headers['x-forwarded-host']));
  if (!allowed.has(host)) throw new HttpError(403, 'Origen no permitido.');
}

export function securityHeaders(kind) {
  const common = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
  if (kind === 'admin') {
    common['Content-Security-Policy'] = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
  } else if (kind === 'player') {
    common['Content-Security-Policy'] = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";
  }
  return common;
}
