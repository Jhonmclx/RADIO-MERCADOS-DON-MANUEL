// Modo local con "Orden aleatorio": las canciones salen barajadas y no se repiten hasta completar la lista.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, AdminClient, makeFixtures, waitFor, tmpDir, ROOT } from '../helpers.js';

const FIX = makeFixtures(path.join(ROOT, 'tests', 'fixtures', 'generated'));
const PW = process.env.PLAYWRIGHT_MODULE || '/opt/npm-tools/node_modules/playwright/index.mjs';
let chromium = null;
try { ({ chromium } = await import(fs.existsSync(PW) ? PW : 'playwright')); } catch { /* sin Playwright */ }

test('modo local aleatorio: baraja sin repetir', { skip: !chromium && 'Playwright no está disponible', timeout: 6 * 60_000 }, async () => {
  const srv = await startServer({ dataDir: tmpDir('e2e-shuf') });
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const admin = new AdminClient(srv.url); await admin.login();
    await admin.put('/api/admin/schedule/hours', { hours: Array.from({ length: 7 }, (_, d) => ({ weekday: d, start: '00:00', end: '24:00' })) });
    for (const f of [FIX.song1, FIX.song2, FIX.longSong]) await admin.upload('song', f);
    await waitFor(async () => (await admin.get('/api/admin/music')).data.songs.filter((s) => s.status === 'listo').length === 3, { label: 'canciones' });
    await admin.put('/api/admin/settings', { songsBetweenAds: 2, adsPerBlock: 1, musicShuffle: true });
    const man = await (await fetch(`${srv.url}/api/public/sites/gourmet/backup-manifest?modo=local`)).json();
    assert.equal(man.shuffle, true);
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${srv.url}/player/gourmet?local=1`);
    await waitFor(async () => page.evaluate(() => window.RMDM.backup.active), { timeout: 60_000, label: 'modo local' });
    // Simula muchas elecciones con la misma función del reproductor
    const res = await page.evaluate(() => {
      const list = window.RMDM.backup.manifest.songs; const n = list.length; const seq = [];
      for (let i = 0; i < n * 20; i++) seq.push(window.RMDM_pick('x', list).id);
      return { n, seq };
    });
    for (let i = 0; i < res.seq.length; i += res.n) {
      const round = res.seq.slice(i, i + res.n);
      assert.equal(new Set(round).size, res.n, 'cada vuelta tiene todas las canciones sin repetir');
    }
    for (let i = 1; i < res.seq.length; i++) assert.notEqual(res.seq[i], res.seq[i - 1], 'nunca la misma dos veces seguidas');
    const firsts = new Set(); for (let i = 0; i < res.seq.length; i += res.n) firsts.add(res.seq[i]);
    assert.ok(firsts.size > 1, 'el orden cambia entre vueltas');
  } finally { await browser.close(); await srv.stop(); }
});
