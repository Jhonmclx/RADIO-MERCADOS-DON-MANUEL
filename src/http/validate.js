// Validación de entradas del panel.
import { HttpError } from './core.js';
import { localToUtcMs } from '../lib/time.js';

export function str(v, { name, max = 200, required = false } = {}) {
  if (v === undefined || v === null || String(v).trim() === '') {
    if (required) throw new HttpError(400, `El campo "${name}" es obligatorio.`);
    return null;
  }
  const s = String(v).trim();
  if (s.length > max) throw new HttpError(400, `El campo "${name}" admite como máximo ${max} caracteres.`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(s)) throw new HttpError(400, `El campo "${name}" contiene caracteres no válidos.`);
  return s;
}

export function int(v, { name, min = -Infinity, max = Infinity, required = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, `El campo "${name}" es obligatorio.`);
    return null;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `El campo "${name}" debe ser un número entero entre ${min} y ${max}.`);
  return n;
}

export const bool = (v) => v === true || v === 1 || v === '1' || v === 'true';

export function localDateTime(v, tz, name) {
  if (v === undefined || v === null || v === '') return null;
  try { return localToUtcMs(v, tz); } catch (e) { throw new HttpError(400, `${name}: ${e.message}`); }
}

export function email(v) {
  const s = str(v, { name: 'correo', max: 160 });
  if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new HttpError(400, 'El correo electrónico no es válido.');
  return s;
}
