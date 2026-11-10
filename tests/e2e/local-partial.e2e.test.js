// Modo local: si una parte de la descarga falla (p. ej. el TV se queda sin espacio para todas las canciones),
// el TV debe seguir mostrando los comerciales. Antes borraba los comerciales viejos, la descarga fallaba completa
// y quedaba solo el logo mientras sonaba la música.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, AdminClient, makeFixtures, waitFor, tmpDir, ROOT } from '../helpers.js';

const FIX = makeFixtures(path.join(ROOT, 'tests', 'fixtures', 'generated'));
const PW = process.env.PLAYWRIGHT_MODULE || '/opt/npm-tools/node_modules/playwright/index.mjs';
let chromium = null;
try { ({ chromium } = await import(fs.existsSync(PW) ? PW : 'playwright')); } catch { /* sin Playwright */ }

test('modo local: con descarga incompleta el TV sigue mostrando los comerciales nuevos', { skip: !chromium && 'Playwright no está disponible', timeout: 6 * 60_000 }, async () => {
  const srv = await startServer({ dataDir: tmpDir('e2e-partial') });
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const admin = new AdminClient(srv.url); await admin.login();
    await admin.put('/api/admin/schedule/hours', { hours: Array.from({ length: 7 }, (_, d) => ({ weekday: d, start: '00:00', end: '24:00' })) });
    await admin.upload('song', FIX.longSong);
    const a = await admin.upload('ad', FIX.ad1, { name: 'A', activate: '1' });
    const ready = async (id) => (await admin.get('/api/admin/ads')).data.ads.find((x) => x.id === id)?.status === 'listo';
    await waitFor(async () => (await ready(a.data.id)) && (await admin.get('/api/admin/music')).data.songs.some((s) => s.status === 'listo'), { timeout: 120_000, label: 'contenido inicial' });

    // Sin service worker para poder simular que una descarga falla.
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(`${srv.url}/player/gourmet?local=1`);
    await waitFor(async () => page.evaluate((id) => window.RMDM.backup.active && window.RMDM_loop().id === id, a.data.id), { timeout: 60_000, label: 'fondo con comercial A' });

    // Las canciones nuevas no se pueden descargar (como un TV sin espacio).
    await page.route('**/media/local/song/**', (r) => r.abort());
    const b = await admin.upload('ad', FIX.ad2, { name: 'B', activate: '1' });
    await admin.upload('song', FIX.song2);
    await waitFor(() => ready(b.data.id), { timeout: 120_000, label: 'comercial B listo' });
    await admin.post(`/api/admin/ads/${a.data.id}/deactivate`, {});

    await waitFor(async () => page.evaluate((id) => window.RMDM_loop().id === id && window.RMDM_loop().hasUrl, b.data.id),
      { timeout: 120_000, label: 'el fondo pasa al comercial B' });
    const st = await page.evaluate(() => window.RMDM.backup.status);
    assert.match(st, /parcial/, st);
    assert.equal(await page.evaluate(() => document.getElementById('nowplaying').classList.contains('hidden')), true, 'no queda solo el logo');
  } finally { await browser.close(); await srv.stop(); }
});
