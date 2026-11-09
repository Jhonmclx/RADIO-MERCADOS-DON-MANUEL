// Si el PC del almacén se reinicia o responde con error justo cuando el TV recarga la página, el TV no debe quedar
// en «Página web no disponible»: abre la copia guardada y sigue sonando con lo descargado.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startServer, AdminClient, makeFixtures, waitFor, tmpDir, ROOT } from '../helpers.js';

const FIX = makeFixtures(path.join(ROOT, 'tests', 'fixtures', 'generated'));
const PW = process.env.PLAYWRIGHT_MODULE || '/opt/npm-tools/node_modules/playwright/index.mjs';
let chromium = null;
try { ({ chromium } = await import(fs.existsSync(PW) ? PW : 'playwright')); } catch { /* sin Playwright */ }

test('servidor caído o con error: el TV abre su copia y sigue sonando', { skip: !chromium && 'Playwright no está disponible', timeout: 6 * 60_000 }, async () => {
  const srv = await startServer({ dataDir: tmpDir('e2e-down') });
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  let fake = null;
  try {
    const admin = new AdminClient(srv.url); await admin.login();
    await admin.put('/api/admin/schedule/hours', { hours: Array.from({ length: 7 }, (_, d) => ({ weekday: d, start: '00:00', end: '24:00' })) });
    await admin.upload('song', FIX.song1);
    await admin.upload('ad', FIX.ad1, { name: 'A', activate: '1' });
    await waitFor(async () => (await admin.get('/api/admin/ads')).data.ads.some((a) => a.status === 'listo'), { label: 'listo' });
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${srv.url}/player/gourmet?local=1`);
    await waitFor(async () => page.evaluate(() => window.RMDM.backup.active), { timeout: 60_000, label: 'modo local' });
    await page.reload(); // ahora el service worker controla la página y guarda su copia
    await waitFor(async () => page.evaluate(() => window.RMDM && window.RMDM.backup.active), { timeout: 60_000, label: 'modo local 2' });
    // El servidor "se cae": en su lugar responde 502 a todo (como Tailscale cuando el programa no responde)
    await srv.stop();
    fake = http.createServer((req, res) => { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('Bad Gateway'); });
    await new Promise((r) => fake.listen(srv.port, '127.0.0.1', r));
    await page.reload();
    await waitFor(async () => page.evaluate(() => !!window.RMDM && window.RMDM.backup.active && !document.getElementById('baudio').paused), { timeout: 90_000, label: 'sigue sonando con el servidor caído' });
    assert.ok(true);
  } finally { await browser.close(); if (fake) fake.close(); await srv.stop(); }
});
