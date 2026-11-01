// Los TV con control sencillo no tienen F5: al publicar una versión nueva del reproductor, se recargan solos.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, AdminClient, makeFixtures, waitFor, tmpDir, ROOT } from '../helpers.js';

const FIX = makeFixtures(path.join(ROOT, 'tests', 'fixtures', 'generated'));
const PW = process.env.PLAYWRIGHT_MODULE || '/opt/npm-tools/node_modules/playwright/index.mjs';
let chromium = null;
try { ({ chromium } = await import(fs.existsSync(PW) ? PW : 'playwright')); } catch { /* sin Playwright */ }

test('modo local: el TV se recarga solo cuando cambia la versión del reproductor', { skip: !chromium && 'Playwright no está disponible', timeout: 6 * 60_000 }, async () => {
  const srv = await startServer({ dataDir: tmpDir('e2e-upd') });
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const admin = new AdminClient(srv.url); await admin.login();
    await admin.put('/api/admin/schedule/hours', { hours: Array.from({ length: 7 }, (_, d) => ({ weekday: d, start: '00:00', end: '24:00' })) });
    await admin.upload('song', FIX.song1);
    await waitFor(async () => (await admin.get('/api/admin/music')).data.songs.some((s) => s.status === 'listo'), { label: 'canción' });
    const page = await (await browser.newContext()).newPage();
    let loads = 0; page.on('load', () => { loads++; });
    await page.goto(`${srv.url}/player/gourmet?local=1`);
    await waitFor(async () => page.evaluate(() => window.RMDM.backup.active), { timeout: 60_000, label: 'modo local' });
    const before = loads;
    // Simula que el servidor ya tiene otra versión del reproductor
    await page.evaluate(() => { window.RMDM.playerVersion = 'version-vieja'; });
    // Termina la canción para llegar a un momento tranquilo
    await page.waitForTimeout(1500);
    await page.evaluate(() => { const a = document.getElementById('baudio'); a.currentTime = Math.max(0, a.duration - 0.2); });
    await waitFor(async () => loads > before, { timeout: 90_000, label: 'se recargó sola' });
    await waitFor(async () => page.evaluate(() => window.RMDM && window.RMDM.backup.active), { timeout: 60_000, label: 'vuelve a sonar tras actualizarse' });
    assert.ok(loads > before);
  } finally { await browser.close(); await srv.stop(); }
});
