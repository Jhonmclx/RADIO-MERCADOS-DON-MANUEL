// Modo local: si el TV arrancó sin comerciales (o se cambiaron), el video de fondo aparece solo, sin recargar.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, AdminClient, makeFixtures, waitFor, tmpDir, ROOT } from '../helpers.js';

const FIX = makeFixtures(path.join(ROOT, 'tests', 'fixtures', 'generated'));
const PW = process.env.PLAYWRIGHT_MODULE || '/opt/npm-tools/node_modules/playwright/index.mjs';
let chromium = null;
try { ({ chromium } = await import(fs.existsSync(PW) ? PW : 'playwright')); } catch { /* sin Playwright */ }

test('modo local: el video de fondo aparece cuando se agrega un comercial, sin recargar', { skip: !chromium && 'Playwright no está disponible', timeout: 6 * 60_000 }, async () => {
  const srv = await startServer({ dataDir: tmpDir('e2e-loop') });
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const admin = new AdminClient(srv.url); await admin.login();
    await admin.put('/api/admin/schedule/hours', { hours: Array.from({ length: 7 }, (_, d) => ({ weekday: d, start: '00:00', end: '24:00' })) });
    await admin.upload('song', FIX.song1);
    await waitFor(async () => (await admin.get('/api/admin/music')).data.songs.some((s) => s.status === 'listo'), { label: 'canción' });
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${srv.url}/player/gourmet?local=1`);
    await waitFor(async () => page.evaluate(() => window.RMDM.backup.active && !document.getElementById('baudio').paused), { timeout: 60_000, label: 'música sonando sin comerciales' });
    assert.equal(await page.evaluate(() => !!document.getElementById('bvideo').getAttribute('src')), false);
    const ad = await admin.upload('ad', FIX.ad1, { name: 'Nuevo', activate: '1' });
    await waitFor(async () => (await admin.get('/api/admin/ads')).data.ads.find((a) => a.id === ad.data.id)?.status === 'listo', { label: 'comercial listo' });
    await waitFor(async () => page.evaluate(() => { const v = document.getElementById('bvideo'); return !!v.getAttribute('src') && !v.paused; }), { timeout: 120_000, label: 'video de fondo visible' });
  } finally { await browser.close(); await srv.stop(); }
});
