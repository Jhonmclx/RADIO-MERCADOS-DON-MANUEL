// Sin comerciales de fondo el TV no queda en negro: muestra el fondo de la marca con la canción que suena.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, AdminClient, makeFixtures, waitFor, tmpDir, ROOT } from '../helpers.js';

const FIX = makeFixtures(path.join(ROOT, 'tests', 'fixtures', 'generated'));
const PW = process.env.PLAYWRIGHT_MODULE || '/opt/npm-tools/node_modules/playwright/index.mjs';
let chromium = null;
try { ({ chromium } = await import(fs.existsSync(PW) ? PW : 'playwright')); } catch { /* sin Playwright */ }

test('modo local sin comerciales: pantalla "Ahora suena" en vez de negro', { skip: !chromium && 'Playwright no está disponible', timeout: 6 * 60_000 }, async () => {
  const srv = await startServer({ dataDir: tmpDir('e2e-np') });
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const admin = new AdminClient(srv.url); await admin.login();
    await admin.put('/api/admin/schedule/hours', { hours: Array.from({ length: 7 }, (_, d) => ({ weekday: d, start: '00:00', end: '24:00' })) });
    await admin.upload('song', FIX.song1, { title: 'Canción de prueba' });
    await waitFor(async () => (await admin.get('/api/admin/music')).data.songs.some((s) => s.status === 'listo'), { label: 'canción' });
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${srv.url}/player/gourmet?local=1`);
    await waitFor(async () => page.evaluate(() => !document.getElementById('nowplaying').classList.contains('hidden')), { timeout: 60_000, label: 'pantalla Ahora suena' });
    const t = await page.evaluate(() => document.getElementById('npTitle').textContent);
    assert.equal(t, 'Canción de prueba');
    // Al agregar un comercial, el video de fondo reemplaza la pantalla
    const ad = await admin.upload('ad', FIX.ad1, { name: 'Nuevo', activate: '1' });
    await waitFor(async () => (await admin.get('/api/admin/ads')).data.ads.find((a) => a.id === ad.data.id)?.status === 'listo', { label: 'comercial' });
    await waitFor(async () => page.evaluate(() => document.getElementById('nowplaying').classList.contains('hidden')), { timeout: 120_000, label: 'video de fondo visible' });
  } finally { await browser.close(); await srv.stop(); }
});
