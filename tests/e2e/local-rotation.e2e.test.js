// Modo local: durante la música el video de fondo va CAMBIANDO de comercial (antes se repetía siempre el primero).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, AdminClient, makeFixtures, waitFor, tmpDir, ROOT } from '../helpers.js';

const FIX = makeFixtures(path.join(ROOT, 'tests', 'fixtures', 'generated'));
const PW = process.env.PLAYWRIGHT_MODULE || '/opt/npm-tools/node_modules/playwright/index.mjs';
let chromium = null;
try { ({ chromium } = await import(fs.existsSync(PW) ? PW : 'playwright')); } catch { /* sin Playwright */ }

test('modo local: los comerciales de fondo rotan mientras suena la música', { skip: !chromium && 'Playwright no está disponible', timeout: 6 * 60_000 }, async () => {
  const srv = await startServer({ dataDir: tmpDir('e2e-rot') });
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const admin = new AdminClient(srv.url); await admin.login();
    await admin.put('/api/admin/schedule/hours', { hours: Array.from({ length: 7 }, (_, d) => ({ weekday: d, start: '00:00', end: '24:00' })) });
    await admin.upload('song', FIX.longSong);
    const a = await admin.upload('ad', FIX.ad1, { name: 'A', activate: '1' });
    const b = await admin.upload('ad', FIX.ad2, { name: 'B', activate: '1' });
    await waitFor(async () => {
      const ads = (await admin.get('/api/admin/ads')).data.ads;
      const songs = (await admin.get('/api/admin/music')).data.songs;
      return ads.filter((x) => x.status === 'listo').length === 2 && songs.some((s) => s.status === 'listo');
    }, { timeout: 120_000, label: 'contenido listo' });
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${srv.url}/player/gourmet?local=1`);
    await waitFor(async () => page.evaluate(() => window.RMDM.backup.active && !document.getElementById('baudio').paused && window.RMDM_loop().hasUrl),
      { timeout: 60_000, label: 'música con video de fondo' });
    const seen = new Set();
    await waitFor(async () => {
      const id = await page.evaluate(() => window.RMDM_loop().id);
      if (id != null) seen.add(id);
      return seen.size >= 2;
    }, { timeout: 40_000, interval: 500, label: 'el fondo cambia de comercial' });
    assert.ok(seen.has(a.data.id) && seen.has(b.data.id), `se vieron: ${[...seen].join(', ')}`);
  } finally { await browser.close(); await srv.stop(); }
});
