// Guardado permanente: el servidor se reinicia SIN su disco (como Render gratis) y recupera todo desde el
// almacenamiento (aquí un servidor que imita la API de Supabase Storage).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { startServer, AdminClient, makeFixtures, waitFor, tmpDir, freePort, ROOT } from '../helpers.js';

const FIX = makeFixtures(path.join(ROOT, 'tests', 'fixtures', 'generated'));

function mockStorage(port, key) {
  const objects = new Map(); const buckets = new Set();
  const srv = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/storage/v1/bucket' && req.method === 'POST') {
      const { id } = JSON.parse(body); if (buckets.has(id)) { res.writeHead(409); res.end('{"error":"Duplicate","message":"already exists"}'); return; }
      buckets.add(id); res.writeHead(200); res.end('{}'); return;
    }
    const m = /^\/storage\/v1\/object\/([^/]+)\/(.+)$/.exec(u.pathname);
    if (m && req.method === 'POST') { objects.set(`${m[1]}/${decodeURIComponent(m[2])}`, body); res.writeHead(200); res.end('{}'); return; }
    if (m && req.method === 'GET') { const o = objects.get(`${m[1]}/${decodeURIComponent(m[2])}`); if (!o) { res.writeHead(400); res.end('{"error":"not_found"}'); return; } res.writeHead(200); res.end(o); return; }
    if (req.method === 'DELETE' && /^\/storage\/v1\/object\/([^/]+)$/.test(u.pathname)) {
      const b = u.pathname.split('/').pop(); for (const p of JSON.parse(body).prefixes || []) objects.delete(`${b}/${p}`);
      res.writeHead(200); res.end('[]'); return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r({ srv, objects, buckets })));
}

test('reinicio sin disco: música, comerciales, ajustes y contraseña se recuperan del almacenamiento permanente', { timeout: 5 * 60_000 }, async (t) => {
  const key = 'clave-secreta-de-prueba';
  const mport = await freePort();
  const mock = await mockStorage(mport, key);
  const env = { SUPABASE_URL: `http://127.0.0.1:${mport}`, SUPABASE_SERVICE_KEY: key };
  let srv = await startServer({ dataDir: tmpDir('persist-a'), env });
  t.after(async () => { await srv.stop(); mock.srv.close(); });
  let admin = new AdminClient(srv.url); await admin.login();
  assert.ok(mock.buckets.has('radio-mercado'));
  await admin.put('/api/admin/schedule/hours', { hours: Array.from({ length: 7 }, (_, d) => ({ weekday: d, start: '00:00', end: '24:00' })) });
  await admin.upload('song', FIX.song1, { title: 'Mi canción' });
  const ad = await admin.upload('ad', FIX.ad1, { name: 'Mi comercial', activate: '1' });
  await waitFor(async () => (await admin.get('/api/admin/music')).data.songs.some((s) => s.status === 'listo') && (await admin.get('/api/admin/ads')).data.ads.some((a) => a.id === ad.data.id && a.status === 'listo'), { label: 'procesados' });
  await admin.put('/api/admin/settings', { songsBetweenAds: 3, adsPerBlock: 1, musicShuffle: false });
  assert.equal((await admin.post('/api/auth/password', { current: 'ClavePrueba2026', next: 'NuevaClave2026x' })).status, 200);
  await waitFor(async () => [...mock.objects.keys()].some((k) => k.endsWith('music/1/normalized.m4a')) && [...mock.objects.keys()].some((k) => k.endsWith('ads/1/normalized.mp4')), { label: 'archivos guardados' });
  await srv.stop(); // Render envía SIGTERM antes de apagar
  assert.ok(mock.objects.has('radio-mercado/db/radio.sqlite.gz'));

  // Nuevo servidor con un disco VACÍO (como Render después de dormirse o de una actualización).
  srv = await startServer({ dataDir: tmpDir('persist-b'), env: { ...env, ADMIN_PASSWORD: 'OtraClave999x' } });
  admin = new AdminClient(srv.url);
  assert.equal((await admin.login('admin', 'NuevaClave2026x')).status, 200, 'la contraseña cambiada se conserva');
  const songs = (await admin.get('/api/admin/music')).data.songs;
  assert.deepEqual(songs.map((s) => [s.title, s.status]), [['Mi canción', 'listo']]);
  const ads = (await admin.get('/api/admin/ads')).data.ads;
  assert.equal(ads[0].name, 'Mi comercial'); assert.equal(ads[0].status, 'listo'); assert.equal(ads[0].active, true);
  assert.equal((await admin.get('/api/admin/settings')).data.songsBetweenAds, 3);
  // La radio vuelve a emitir con el contenido recuperado (los archivos pasan la verificación de integridad).
  await waitFor(async () => (await admin.get('/api/admin/logs?type=asrun')).data.items.some((i) => i.kind === 'song' && i.status === 'emitido'), { timeout: 90_000, label: 'canción emitida tras recuperar' });
  const st = (await admin.get('/api/admin/dashboard')).data.storage;
  assert.equal(st.enabled, true); assert.equal(st.restored, true);
});

test('reinicio a mitad del procesamiento: el comercial se recupera y se procesa solo', { timeout: 5 * 60_000 }, async (t) => {
  const key = 'clave-secreta-de-prueba';
  const mport = await freePort();
  const mock = await mockStorage(mport, key);
  const env = { SUPABASE_URL: `http://127.0.0.1:${mport}`, SUPABASE_SERVICE_KEY: key };
  let srv = await startServer({ dataDir: tmpDir('persist-c'), env });
  t.after(async () => { await srv.stop(); mock.srv.close(); });
  let admin = new AdminClient(srv.url); await admin.login();
  const ad = await admin.upload('ad', FIX.ad1, { name: 'Interrumpido' });
  await waitFor(async () => mock.objects.has(`radio-mercado/pending/ad/${ad.data.id}/original.bin`), { label: 'copia temporal guardada' });
  const before = (await admin.get('/api/admin/ads')).data.ads.find((a) => a.id === ad.data.id)?.status;
  console.log('# estado al reiniciar:', before);
  await srv.stop(); // reinicio antes de terminar
  srv = await startServer({ dataDir: tmpDir('persist-d'), env });
  admin = new AdminClient(srv.url); await admin.login();
  await waitFor(async () => (await admin.get('/api/admin/ads')).data.ads.find((a) => a.id === ad.data.id)?.status === 'listo', { timeout: 120_000, label: 'procesado tras el reinicio' });
  await waitFor(async () => !mock.objects.has(`radio-mercado/pending/ad/${ad.data.id}/original.bin`), { label: 'copia temporal borrada' });
});
