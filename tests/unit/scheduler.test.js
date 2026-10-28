import test from 'node:test';
import assert from 'node:assert/strict';
import { decideNext, initialSchedulerState, pickAd } from '../../src/engine/scheduler.js';

const songs = [{ id: 1, duration_ms: 200_000 }, { id: 2, duration_ms: 180_000 }, { id: 3, duration_ms: 240_000 }];
const adA = { id: 10, weight: 1, duration_ms: 300_000 };
const adB = { id: 11, weight: 1, duration_ms: 420_000 };
const settings = (o = {}) => ({ songs_between_ads: 2, ads_per_block: 1, music_shuffle: false, music_paused: false, ads_paused: false, ...o });

function run(n, ctx, state = initialSchedulerState()) {
  const out = [];
  for (let i = 0; i < n; i++) { const r = decideNext(state, ctx); out.push(r.item); state = r.state; }
  return { items: out, state };
}
const pattern = (items) => items.map((i) => (i.kind === 'song' ? 'C' : i.kind === 'ad' ? 'P' : `[${i.slate}]`)).join('');

test('regla inicial: dos canciones y luego el bloque comercial, en ciclo continuo', () => {
  const { items } = run(12, { settings: settings(), ads: [adA], songs, inHours: true });
  assert.equal(pattern(items), 'CCPCCPCCPCCP');
});

test('la regla es configurable (1, 3 y 4 canciones) sin tocar el código', () => {
  for (const n of [1, 3, 4]) {
    const { items } = run(2 * (n + 1), { settings: settings({ songs_between_ads: n }), ads: [adA], songs, inHours: true });
    assert.equal(pattern(items), ('C'.repeat(n) + 'P').repeat(2), `n=${n}`);
  }
});

test('cambiar la regla en caliente se aplica en la siguiente decisión, sin reiniciar el ciclo musical', () => {
  let s = initialSchedulerState();
  const ctx = { settings: settings(), ads: [adA], songs, inHours: true };
  let r = decideNext(s, ctx); s = r.state; assert.equal(r.item.kind, 'song'); // 1 canción
  ctx.settings = settings({ songs_between_ads: 1 });
  r = decideNext(s, ctx); assert.equal(r.item.kind, 'ad', 'con N=1 y una canción ya emitida, toca comercial');
});

test('las canciones siguen el orden de la lista y el ciclo continúa donde iba', () => {
  const { items } = run(9, { settings: settings({ ads_paused: true }), ads: [adA], songs, inHours: true });
  assert.deepEqual(items.map((i) => i.songId), [1, 2, 3, 1, 2, 3, 1, 2, 3]);
});

test('durante la música, el video en ciclo silencioso es el último comercial emitido y avanza su posición', () => {
  const { items } = run(6, { settings: settings(), ads: [adA, adB], songs, inHours: true });
  // C C P(A) C C P(B)
  assert.equal(items[2].adId, 10);
  assert.equal(items[3].loopAdId, 10, 'tras emitirse A, A vuelve al ciclo silencioso');
  assert.equal(items[3].loopOffsetMs, 0, 'el ciclo vuelve a empezar desde el inicio');
  assert.equal(items[4].loopOffsetMs, 240_000, 'la segunda canción continúa el ciclo donde quedó (tras la canción 3 de 240 s)');
  assert.equal(items[5].adId, 11, 'el siguiente bloque rota al comercial B');
});

test('rotación ponderada determinista: respeta la frecuencia y no monopoliza', () => {
  const ads = [{ id: 1, weight: 3 }, { id: 2, weight: 1 }];
  const s = initialSchedulerState(); const seq = [];
  for (let i = 0; i < 8; i++) seq.push(pickAd(s, ads).id);
  assert.deepEqual(seq, [1, 1, 2, 1, 1, 1, 2, 1]);
  // Nunca más de 3 seguidos del de mayor peso y el resultado es reproducible.
  const s2 = initialSchedulerState(); const seq2 = [];
  for (let i = 0; i < 8; i++) seq2.push(pickAd(s2, ads).id);
  assert.deepEqual(seq, seq2);
  const counts = seq.reduce((a, x) => ({ ...a, [x]: (a[x] || 0) + 1 }), {});
  assert.equal(counts[1], 6); assert.equal(counts[2], 2);
});

test('con pesos iguales la rotación alterna sin repetir', () => {
  const s = initialSchedulerState();
  const seq = []; for (let i = 0; i < 6; i++) seq.push(pickAd(s, [{ id: 5, weight: 1 }, { id: 6, weight: 1 }, { id: 7, weight: 1 }]).id);
  assert.deepEqual(seq, [5, 6, 7, 5, 6, 7]);
});

test('un comercial desactivado (fuera de la lista elegible) no vuelve a programarse', () => {
  let s = initialSchedulerState();
  const ctx = { settings: settings({ songs_between_ads: 1 }), ads: [adA, adB], songs, inHours: true };
  const kinds = [];
  for (let i = 0; i < 4; i++) { const r = decideNext(s, ctx); s = r.state; kinds.push(r.item); }
  ctx.ads = [adB]; // A desactivado
  for (let i = 0; i < 6; i++) { const r = decideNext(s, ctx); s = r.state; if (r.item.kind === 'ad') assert.equal(r.item.adId, 11); if (r.item.kind === 'song') assert.notEqual(r.item.loopAdId, 10); }
});

test('pausar la publicidad: solo música; pausar la música: solo comerciales; ambas: cortinilla de pausa', () => {
  assert.equal(pattern(run(5, { settings: settings({ ads_paused: true }), ads: [adA], songs, inHours: true }).items), 'CCCCC');
  assert.equal(pattern(run(3, { settings: settings({ music_paused: true }), ads: [adA], songs, inHours: true }).items), 'PPP');
  assert.equal(pattern(run(2, { settings: settings({ music_paused: true, ads_paused: true }), ads: [adA], songs, inHours: true }).items), '[pausa][pausa]');
});

test('fuera del horario: cortinilla y el estado del ciclo no cambia', () => {
  const s = initialSchedulerState(); s.songsSinceAd = 1;
  const r = decideNext(s, { settings: settings(), ads: [adA], songs, inHours: false });
  assert.equal(r.item.slate, 'fuera_horario');
  assert.equal(r.state.songsSinceAd, 1);
});

test('sin comerciales suena solo música; sin canciones ni comerciales: cortinilla sin contenido', () => {
  assert.equal(pattern(run(4, { settings: settings(), ads: [], songs, inHours: true }).items), 'CCCC');
  assert.equal(pattern(run(1, { settings: settings(), ads: [], songs: [], inHours: true }).items), '[sin_contenido]');
});

test('bloques de varios comerciales', () => {
  assert.equal(pattern(run(8, { settings: settings({ ads_per_block: 2 }), ads: [adA, adB], songs, inHours: true }).items), 'CCPPCCPP');
});

test('el planificador es puro: no modifica el estado recibido (permite re-planificar)', () => {
  const s = initialSchedulerState(); const copy = JSON.stringify(s);
  decideNext(s, { settings: settings(), ads: [adA], songs, inHours: true });
  assert.equal(JSON.stringify(s), copy);
});

test('modo aleatorio: determinista, sin repetir dentro de una ronda', () => {
  const { items } = run(6, { settings: settings({ music_shuffle: true, ads_paused: true }), ads: [], songs, inHours: true });
  const first = items.slice(0, 3).map((i) => i.songId).sort();
  assert.deepEqual(first, [1, 2, 3]);
  const again = run(6, { settings: settings({ music_shuffle: true, ads_paused: true }), ads: [], songs, inHours: true }).items.map((i) => i.songId);
  assert.deepEqual(items.map((i) => i.songId), again);
});
