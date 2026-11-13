// Los televisores tienen pocos decodificadores de video (a veces uno solo). Si la página del TV tiene videos
// decorativos reproduciéndose (fondos animados), el comercial se queda sin decodificador: error 3 y solo el logo.
// Por eso la página del TV solo puede tener la señal en vivo y el video de comerciales.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'player', 'player.html'), 'utf8');

test('la página del TV no tiene videos decorativos que ocupen el decodificador', () => {
  const ids = [...html.matchAll(/<video\b[^>]*>/g)].map((m) => (m[0].match(/id="([^"]+)"/) || [])[1] || '(sin id)');
  assert.deepEqual(ids.sort(), ['bvideo', 'live']);
  assert.doesNotMatch(html, /fondo\.mp4/);
});
