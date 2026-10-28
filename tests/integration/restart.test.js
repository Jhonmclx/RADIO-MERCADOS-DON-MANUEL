// 17. El motor central se reinicia (caída abrupta del proceso, SIGKILL) y recupera su estado de forma segura.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startServer, AdminClient, makeFixtures, waitFor, sleep, tmpDir, ROOT } from '../helpers.js';

const FIX = makeFixtures(path.join(ROOT, 'tests', 'fixtures', 'generated'));

test('17. reinicio abrupto del servidor: la emisión se reanuda en el punto correcto', { timeout: 6 * 60_000 }, async (t) => {
  const dataDir = tmpDir('restart');
  let srv = await startServer({ dataDir });
  t.after(async () => { await srv.stop(); });
  let admin = new AdminClient(srv.url);
  await admin.login();
  await admin.put('/api/admin/schedule/hours', { hours: Array.from({ length: 7 }, (_, d) => ({ weekday: d, start: '00:00', end: '24:00' })) });
  await admin.upload('song', FIX.longSong, { title: 'Canción larga' });
  await admin.upload('song', FIX.song1, { title: 'Canción corta' });
  await waitFor(async () => (await admin.get('/api/admin/music')).data.songs.filter((s) => s.status === 'listo').length === 2, { label: 'canciones' });
  const ad = await admin.upload('ad', FIX.ad1, { name: 'Comercial A', activate: '1' });
  await waitFor(async () => (await admin.get('/api/admin/ads')).data.ads.find((a) => a.id === ad.data.id)?.status === 'listo', { label: 'comercial' });

  // Espera a que la canción larga (30 s) esté a mitad de emisión.
  const mid = await waitFor(async () => {
    const e = (await admin.get('/api/admin/engine')).data;
    return e.onAir?.kind === 'song' && e.onAir.durationMs > 20_000 && Date.now() - e.onAir.startedAt > 8000 && e;
  }, { timeout: 150_000, label: 'canción larga a mitad' });
  const before = await (await fetch(`${srv.url}/live/index.m3u8`)).text();
  const lastSeqBefore = Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(before)[1]) + (before.match(/\.ts/g) || []).length - 1;
  const songsSinceAdBefore = mid.songsSinceAd;

  await srv.kill(); // caída abrupta: sin oportunidad de guardar nada al salir
  await sleep(1500);
  srv = await startServer({ dataDir, port: srv.port });
  admin = new AdminClient(srv.url);
  await admin.login();

  assert.ok(mid.next?.ready, 'antes de la caída el siguiente elemento ya estaba preparado');
  const after = await waitFor(async () => (admin.get('/api/admin/engine').then((r) => r.data.onAir && r.data.next?.ready && r.data)), { label: 'motor recuperado' });
  assert.equal(after.onAir.id, mid.onAir.id, 'continúa el MISMO elemento que estaba al aire');
  assert.equal(after.onAir.startedAt, mid.onAir.startedAt, 'conserva su hora de inicio oficial');
  assert.equal(after.songsSinceAd, songsSinceAdBefore, 'el contador de canciones desde el último comercial se conservó');
  assert.equal(after.next.kind, mid.next.kind, 'se vuelve a decidir el mismo tipo de elemento siguiente');

  // Se espera a que aparezcan segmentos nuevos; la numeración debe continuar (nunca reinicia en 0).
  const lastSeqOf = (txt) => Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(txt)[1]) + (txt.match(/\.ts/g) || []).length - 1;
  const pl = await waitFor(async () => { const txt = await (await fetch(`${srv.url}/live/index.m3u8`)).text(); return /\.ts/.test(txt) && lastSeqOf(txt) > lastSeqBefore + 1 && txt; }, { timeout: 30_000, label: 'segmentos nuevos tras el reinicio' });
  assert.match(pl, /#EXT-X-DISCONTINUITY/, 'se marca la discontinuidad del reinicio');

  // El elemento termina y el registro refleja la interrupción real si se perdieron segmentos.
  await waitFor(async () => (await admin.get('/api/admin/logs?type=asrun')).data.items.find((i) => i.id === mid.onAir.id && i.status !== 'al_aire'), { timeout: 60_000, label: 'cierre del elemento' });
  const row = (await admin.get('/api/admin/logs?type=asrun')).data.items.find((i) => i.id === mid.onAir.id);
  assert.ok(['emitido', 'interrumpido'].includes(row.status));
  const log = (await admin.get('/api/admin/logs?type=engine')).data.items.map((l) => l.message).join('\n');
  assert.match(log, /recuperado tras reinicio/);

  // La regla de dos canciones se mantiene después del reinicio: el siguiente comercial llega a tiempo.
  await waitFor(async () => (await admin.get('/api/admin/reports/plays')).data.items.some((p) => p.status === 'completado'), { timeout: 120_000, label: 'comercial tras reinicio' });
  const items = (await admin.get('/api/admin/logs?type=asrun&limit=500')).data.items.slice().reverse().filter((i) => i.kind !== 'slate');
  const firstAdIdx = items.findIndex((i) => i.kind === 'ad');
  const songsBeforeFirstAd = items.slice(0, firstAdIdx).filter((i) => i.kind === 'song').length;
  assert.ok(songsBeforeFirstAd >= 2, 'el comercial no salió antes de completarse la regla');
});

test('caída larga: los segmentos que no se emitieron se registran como interrupción (no se inventan)', { timeout: 5 * 60_000 }, async (t) => {
  const dataDir = tmpDir('restart2');
  let srv = await startServer({ dataDir });
  t.after(async () => { await srv.stop(); });
  let admin = new AdminClient(srv.url);
  await admin.login();
  await admin.put('/api/admin/schedule/hours', { hours: Array.from({ length: 7 }, (_, d) => ({ weekday: d, start: '00:00', end: '24:00' })) });
  await admin.upload('song', FIX.longSong, { title: 'Canción larga' });
  await waitFor(async () => (await admin.get('/api/admin/music')).data.songs.some((s) => s.status === 'listo'), { label: 'canción' });
  const mid = await waitFor(async () => { const e = (await admin.get('/api/admin/engine')).data; return e.onAir?.kind === 'song' && Date.now() - e.onAir.startedAt > 4000 && e; }, { timeout: 60_000, label: 'canción al aire' });
  await srv.kill();
  await sleep(9000); // más de cuatro segmentos sin servidor
  srv = await startServer({ dataDir, port: srv.port });
  admin = new AdminClient(srv.url);
  await admin.login();
  await waitFor(async () => (await admin.get('/api/admin/logs?type=asrun')).data.items.find((i) => i.id === mid.onAir.id && i.status !== 'al_aire'), { timeout: 60_000, label: 'cierre' });
  const row = (await admin.get('/api/admin/logs?type=asrun')).data.items.find((i) => i.id === mid.onAir.id);
  assert.equal(row.status, 'interrumpido');
  assert.match(row.note, /no se emitieron|Reinicio/);
  assert.ok(row.duration_ms < 30_000, 'la duración registrada es solo lo realmente emitido');
});

test('si un archivo preparado desaparece, el elemento se registra como interrumpido y la señal continúa', { timeout: 4 * 60_000 }, async (t) => {
  const fs = await import('node:fs');
  const dataDir = tmpDir('missing');
  const srv = await startServer({ dataDir });
  t.after(async () => { await srv.stop(); });
  const admin = new AdminClient(srv.url);
  await admin.login();
  await admin.put('/api/admin/schedule/hours', { hours: Array.from({ length: 7 }, (_, d) => ({ weekday: d, start: '00:00', end: '24:00' })) });
  await admin.upload('song', FIX.song1); await admin.upload('song', FIX.song2);
  await waitFor(async () => (await admin.get('/api/admin/music')).data.songs.filter((s) => s.status === 'listo').length === 2, { label: 'canciones' });
  const e = await waitFor(async () => { const r = (await admin.get('/api/admin/engine')).data; return r.onAir?.kind === 'song' && r.next?.ready && r.next.id && r; }, { timeout: 60_000, label: 'siguiente listo' });
  const victim = e.next.id;
  for (const d of fs.readdirSync(path.join(dataDir, 'render'))) if (d.startsWith(`item-${victim}-`)) fs.rmSync(path.join(dataDir, 'render', d), { recursive: true, force: true });
  await waitFor(async () => (await admin.get('/api/admin/logs?type=asrun')).data.items.find((i) => i.id === victim && i.status === 'interrumpido'), { timeout: 60_000, label: 'elemento interrumpido' });
  const seqBefore = (await admin.get('/api/admin/engine')).data.mediaSequence;
  await sleep(6000);
  const st = (await admin.get('/api/admin/engine')).data;
  assert.ok(st.mediaSequence > seqBefore, 'la señal sigue publicando segmentos');
  assert.equal((await fetch(`${srv.url}/healthz`)).status, 200);
});
