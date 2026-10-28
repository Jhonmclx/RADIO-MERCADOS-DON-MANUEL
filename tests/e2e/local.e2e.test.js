// Modo local (?local=1): el televisor descarga la programación y la reproduce él mismo, sin la señal en vivo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, AdminClient, makeFixtures, waitFor, sleep, tmpDir, ROOT } from '../helpers.js';

const FIX = makeFixtures(path.join(ROOT, 'tests', 'fixtures', 'generated'));
const PW = process.env.PLAYWRIGHT_MODULE || '/opt/npm-tools/node_modules/playwright/index.mjs';
let chromium = null;
try { ({ chromium } = await import(fs.existsSync(PW) ? PW : 'playwright')); } catch { /* sin Playwright */ }

test('modo local: descarga una vez, reproduce canciones y comercial con sonido, sigue sin Internet', { skip: !chromium && 'Playwright no está disponible', timeout: 10 * 60_000 }, async () => {
  const srv = await startServer({ dataDir: tmpDir('e2e-local') });
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const admin = new AdminClient(srv.url);
    await admin.login();
    await admin.put('/api/admin/schedule/hours', { hours: Array.from({ length: 7 }, (_, d) => ({ weekday: d, start: '00:00', end: '24:00' })) });
    for (const f of [FIX.song1, FIX.song2]) await admin.upload('song', f); // sin marcar "respaldo": el modo local las incluye igual
    await waitFor(async () => (await admin.get('/api/admin/music')).data.songs.filter((s) => s.status === 'listo').length === 2, { label: 'canciones' });
    const ad = await admin.upload('ad', FIX.ad1, { name: 'Comercial A', activate: '1' });
    await waitFor(async () => (await admin.get('/api/admin/ads')).data.ads.find((a) => a.id === ad.data.id)?.status === 'listo', { label: 'comercial' });

    const man = await (await fetch(`${srv.url}/api/public/sites/gourmet/backup-manifest?modo=local`)).json();
    assert.equal(man.local, true); assert.equal(man.songs.length, 2); assert.equal(man.ads.length, 1);

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const liveReqs = []; page.on('request', (r) => { if (/\/live\/|\.m3u8|\.ts(\?|$)/.test(r.url())) liveReqs.push(r.url()); });
    await page.goto(`${srv.url}/player/gourmet?local=1`);
    const st = () => page.evaluate(() => ({ state: window.RMDM.state, active: window.RMDM.backup.active, status: window.RMDM.backup.status,
      audio: !document.getElementById('baudio').paused, video: !document.getElementById('bvideo').paused, plays: window.RMDM.backupPlays.length }));
    await waitFor(async () => (await st()).active && (await st()).audio, { timeout: 60_000, label: 'modo local reproduciendo música' });
    assert.equal(liveReqs.length, 0, 'no debe pedir la señal en vivo');
    // Avanza al final de las canciones para llegar al comercial
    for (let i = 0; i < 2; i++) { await page.evaluate(() => { const a = document.getElementById('baudio'); a.currentTime = Math.max(0, a.duration - 0.3); }); await sleep(1500); }
    await waitFor(async () => page.evaluate(() => { const v = document.getElementById('bvideo'); return !v.loop && !v.muted && !v.paused; }), { timeout: 20_000, label: 'comercial con sonido' });
    // Sin Internet: sigue sonando
    await ctx.setOffline(true);
    await sleep(8000);
    const s = await st();
    assert.ok(s.active && (s.audio || s.video), 'sigue reproduciendo sin Internet');
    await ctx.setOffline(false);
  } finally { await browser.close(); await srv.stop(); }
});
