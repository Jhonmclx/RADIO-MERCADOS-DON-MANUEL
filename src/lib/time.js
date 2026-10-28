// Conversión de horas locales (America/Bogota por defecto) <-> instantes UTC.
// Se usa Intl para no depender de que la zona no tenga horario de verano.

const fmtCache = new Map();
function fmt(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Partes de la fecha local en la zona indicada para un instante UTC (ms). */
export function localParts(ms, tz) {
  const p = {};
  for (const { type, value } of fmt(tz).formatToParts(new Date(ms))) p[type] = value;
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second),
    weekday: WD[p.weekday],
  };
}

/** Desfase (ms) de la zona respecto a UTC en un instante dado. */
export function tzOffsetMs(ms, tz) {
  const p = localParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Convierte "AAAA-MM-DDTHH:MM" (hora local de la zona) a ms UTC. */
export function localToUtcMs(localStr, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(localStr || '').trim());
  if (!m) throw new Error('Fecha y hora inválidas. Use el formato AAAA-MM-DD HH:MM.');
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  let ms = guess - tzOffsetMs(guess, tz);
  ms = guess - tzOffsetMs(ms, tz); // segunda pasada por si cruza un cambio de horario
  return ms;
}

export function utcToLocalString(ms, tz) {
  if (ms == null) return '';
  const p = localParts(ms, tz);
  const z = (n) => String(n).padStart(2, '0');
  return `${p.year}-${z(p.month)}-${z(p.day)} ${z(p.hour)}:${z(p.minute)}:${z(p.second)}`;
}

/** Inicio (ms UTC) del día local que contiene `ms`. */
export function localDayStart(ms, tz) {
  const p = localParts(ms, tz);
  const z = (n) => String(n).padStart(2, '0');
  return localToUtcMs(`${p.year}-${z(p.month)}-${z(p.day)}T00:00`, tz);
}

export function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) throw new Error(`Hora inválida: "${s}". Use HH:MM.`);
  const v = Number(m[1]) * 60 + Number(m[2]);
  if (v < 0 || v > 1440 || Number(m[2]) > 59) throw new Error(`Hora fuera de rango: "${s}".`);
  return v;
}

export function minToHHMM(v) {
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
}

/**
 * ¿Está dentro del horario de emisión? `hours` = [{weekday, start_min, end_min}] en hora local.
 * Una franja con end_min <= start_min cruza la medianoche.
 */
export function isWithinHours(ms, hours, tz) {
  if (!hours || hours.length === 0) return false;
  const p = localParts(ms, tz);
  const minute = p.hour * 60 + p.minute;
  for (const h of hours) {
    if (h.start_min === h.end_min) continue;
    if (h.end_min > h.start_min) {
      if (h.weekday === p.weekday && minute >= h.start_min && minute < h.end_min) return true;
    } else {
      if (h.weekday === p.weekday && minute >= h.start_min) return true;
      if ((h.weekday + 1) % 7 === p.weekday && minute < h.end_min) return true;
    }
  }
  return false;
}
