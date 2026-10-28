import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { localToUtcMs, utcToLocalString, isWithinHours, localParts } from '../../src/lib/time.js';
import { hashPassword, verifyPassword, validatePasswordStrength, csrfFor } from '../../src/http/security.js';
import { Publisher } from '../../src/engine/publisher.js';
import { siteStatusFor } from '../../src/reports/reports.js';
import { safeJoin, HttpError } from '../../src/http/core.js';

const TZ = 'America/Bogota';

test('hora local de Bogotá <-> UTC sin ambigüedad', () => {
  assert.equal(new Date(localToUtcMs('2026-10-28T07:00', TZ)).toISOString(), '2026-10-28T12:00:00.000Z');
  assert.equal(utcToLocalString(Date.parse('2026-01-01T04:30:00Z'), TZ), '2025-12-31 23:30:00');
  assert.throws(() => localToUtcMs('28/10/2026 7:00', TZ));
});

test('horario de emisión, incluyendo franjas que cruzan la medianoche', () => {
  const hours = [{ weekday: 3, start_min: 7 * 60, end_min: 21 * 60 }, { weekday: 5, start_min: 20 * 60, end_min: 2 * 60 }];
  const at = (s) => localToUtcMs(s, TZ);
  assert.equal(localParts(at('2026-10-28T08:00'), TZ).weekday, 3); // miércoles
  assert.equal(isWithinHours(at('2026-10-28T08:00'), hours, TZ), true);
  assert.equal(isWithinHours(at('2026-10-28T21:00'), hours, TZ), false);
  assert.equal(isWithinHours(at('2026-10-30T23:30'), hours, TZ), true);  // viernes noche
  assert.equal(isWithinHours(at('2026-10-31T01:59'), hours, TZ), true);  // sábado madrugada (misma franja)
  assert.equal(isWithinHours(at('2026-10-31T02:00'), hours, TZ), false);
  assert.equal(isWithinHours(at('2026-10-28T08:00'), [], TZ), false);
});

test('contraseñas con scrypt y políticas mínimas', () => {
  const h = hashPassword('MiClaveSegura99');
  assert.match(h, /^scrypt\$/);
  assert.ok(verifyPassword('MiClaveSegura99', h));
  assert.ok(!verifyPassword('otra', h));
  assert.ok(validatePasswordStrength('corta1'));
  assert.ok(validatePasswordStrength('soloLetrasLargas'));
  assert.equal(validatePasswordStrength('Letras12345'), null);
  assert.notEqual(csrfFor('a'), csrfFor('b'));
});

test('lista HLS: hora oficial por segmento, discontinuidades y ventana deslizante', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-'));
  const src = path.join(dir, 'src.ts'); fs.writeFileSync(src, 'x');
  const cfg = { liveDir: path.join(dir, 'live'), hls: { windowSegments: 3, keepExtraSegments: 2, targetDuration: 8 } };
  const p = new Publisher({ cfg });
  const t = Date.parse('2026-10-28T12:00:00Z');
  p.publish(src, 4, t, 1); p.publish(src, 4, t + 4000, 1);
  p.markDiscontinuity(); p.publish(src, 4, t + 8000, 2); p.publish(src, 4, t + 12000, 2);
  const txt = fs.readFileSync(path.join(cfg.liveDir, 'index.m3u8'), 'utf8');
  assert.match(txt, /#EXT-X-MEDIA-SEQUENCE:1\n/);
  // s0 llevaba discontinuidad (primer segmento) y salió de la ventana: la secuencia sube a 1.
  assert.match(txt, /#EXT-X-DISCONTINUITY-SEQUENCE:1\n/);
  assert.match(txt, /#EXT-X-PROGRAM-DATE-TIME:2026-10-28T12:00:04.000Z/);
  assert.equal((txt.match(/#EXT-X-DISCONTINUITY\n/g) || []).length, 1);
  p.publish(src, 4, t + 16000, 2); // sale s1 (sin discontinuidad): la secuencia no cambia
  const txt2 = fs.readFileSync(path.join(cfg.liveDir, 'index.m3u8'), 'utf8');
  assert.match(txt2, /#EXT-X-DISCONTINUITY-SEQUENCE:1\n/);
  p.publish(src, 4, t + 20000, 2); // sale s2 (con discontinuidad): sube a 2
  assert.match(fs.readFileSync(path.join(cfg.liveDir, 'index.m3u8'), 'utf8'), /#EXT-X-DISCONTINUITY-SEQUENCE:2\n/);
  p.end();
  assert.match(fs.readFileSync(path.join(cfg.liveDir, 'index.m3u8'), 'utf8'), /#EXT-X-ENDLIST/);
});

test('estado por sede en reportes: confirmada, parcial, conectada sin telemetría, sin conexión', () => {
  const play = { first_seq: 10, last_seq: 19 };
  const site = { id: 1, name: 'Sede 1' };
  assert.equal(siteStatusFor(play, site, { segments_seen: 10 }, true).status, 'confirmada');
  assert.equal(siteStatusFor(play, site, { segments_seen: 4 }, true).status, 'parcial');
  assert.equal(siteStatusFor(play, site, null, true).status, 'conectada_sin_confirmacion');
  assert.equal(siteStatusFor(play, site, null, false).status, 'sin_conexion');
});

test('rutas de archivos: no se puede salir de la carpeta pública', () => {
  const base = path.resolve('/srv/public');
  assert.equal(safeJoin(base, '/admin/app.js'), path.join(base, 'admin/app.js'));
  assert.ok(safeJoin(base, '/../../etc/passwd').startsWith(base));
  assert.equal(safeJoin(base, '..'), base);
  assert.ok(safeJoin(base, '/x/../../..//etc').startsWith(base));
  void HttpError;
});
