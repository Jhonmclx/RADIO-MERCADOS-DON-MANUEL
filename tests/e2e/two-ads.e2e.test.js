// Con DOS comerciales activos, la música debe seguir sonando entre comerciales (modo local).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, AdminClient, makeFixtures, waitFor, tmpDir, ROOT } from '../helpers.js';

const FIX = makeFixtures(path.join(ROOT, 'tests', 'fixtures', 'generated'));
const PW = process.env.PLAYWRIGHT_MODULE || '/opt/npm-tools/node_modules/playwright/index.mjs';
let chromium = null;
try { ({ chromium } = await import(fs.existsSync(PW) ? PW : 'playwright')); } catch { /* sin Playwright */ }

test('dos comerciales: música y comerciales se alternan', { skip: !chromium && 'Playwright no está disponible', timeout: 8 * 60_000 }, async () => {
  const srv = await startServer({ dataDir: tmpDir('e2e-2ads') });
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const admin = new AdminClient(srv.url); await admin.login();
    await admin.put('/api/admin/schedule/hours', { hours: Array.from({ length: 7 }, (_, d) => ({ weekday: d, start: '00:00', end: '24:00' })) });
    for (const f of [FIX.song1, FIX.song2]) await admin.upload('song', f);
    await admin.upload('ad', FIX.ad1, { name: 'A', activate: '1' });
    await admin.upload('ad', FIX.ad2, { name: 'B', activate: '1' });
    await waitFor(async () => (await admin.get('/api/admin/ads')).data.ads.filter((a) => a.status === 'listo').length === 2 && (await admin.get('/api/admin/music')).data.songs.filter((s) => s.status === 'listo').length === 2, { label: 'contenido listo' });
    await admin.put('/api/admin/settings', { songsBetweenAds: 1, adsPerBlock: 1, musicShuffle: false });
    const page = await (await browser.newContext()).newPage();
    page.on('console', (m) => { if (/error/i.test(m.type())) console.log('console', m.text()); });
    await page.goto(`${srv.url}/player/gourmet?local=1`);
    await waitFor(async () => page.evaluate(() => window.RMDM.backup.active && window.RMDM.backup.manifest.ads.length === 2), { timeout: 60_000, label: 'modo local con 2 comerciales' });
    const st = () => page.evaluate(() => { const a = document.getElementById('baudio'); const v = document.getElementById('bvideo'); const B = window.RMDM_video.B;
      return { song: !a.paused, ad: !!B.current, vmuted: v.muted, vloop: v.loop, vpaused: v.paused, src: v.currentSrc.slice(-12) }; });
    const log = [];
    for (let i = 0; i < 8; i++) {
      // Esperar a que suene algo (canción o comercial) y adelantarlo hasta el final
      await waitFor(async () => { const s = await st(); return s.song || s.ad; }, { timeout: 30_000, label: `ronda ${i}: suena algo` });
      const s = await st(); log.push(s.ad ? 'C' : 'M');
      await page.evaluate(() => {
        const B = window.RMDM_video.B;
        const el = B.current ? document.getElementById('bvideo') : document.getElementById('baudio');
        el.currentTime = Math.max(0, el.duration - 0.2);
      });
      await page.waitForTimeout(1500);
    }
    console.log('secuencia', log.join(' '));
    assert.ok(log.filter((x) => x === 'M').length >= 3, `la música debe sonar entre comerciales: ${log.join(' ')}`);

    // TV que pausa la música cuando arranca otro video (algunos navegadores de televisor lo hacen):
    const page2 = await (await browser.newContext()).newPage();
    await page2.addInitScript(() => {
      const orig = HTMLVideoElement.prototype.play;
      HTMLVideoElement.prototype.play = function () { document.querySelectorAll('audio').forEach((a) => a.pause()); return orig.apply(this, arguments); };
    });
    await page2.goto(`${srv.url}/player/sachica?local=1`);
    await waitFor(async () => page2.evaluate(() => window.RMDM.backup.active && !document.getElementById('baudio').paused && !window.RMDM_video.B.current), { timeout: 60_000, label: 'canción sonando (TV que pausa)' });
    // El fondo termina y pasa al otro comercial mientras suena la canción
    await page2.evaluate(() => { const v = document.getElementById('bvideo'); v.currentTime = Math.max(0, v.duration - 0.2); });
    await page2.waitForTimeout(4000);
    assert.equal(await page2.evaluate(() => !document.getElementById('baudio').paused), true, 'la música sigue sonando después del cambio de fondo');
  } finally { await browser.close(); await srv.stop(); }
});
