// Pruebas con un navegador real (Chromium sin interfaz, vía Playwright) y el reproductor real de las sedes.
// IMPORTANTE: son pruebas PRELIMINARES de escritorio. No reemplazan la prueba en los televisores físicos.
// Requiere Playwright instalado (PLAYWRIGHT_MODULE apunta al módulo si no está en node_modules).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, AdminClient, makeFixtures, waitFor, sleep, tmpDir, ROOT } from '../helpers.js';

const FIX = makeFixtures(path.join(ROOT, 'tests', 'fixtures', 'generated'));
const PW = process.env.PLAYWRIGHT_MODULE || '/opt/npm-tools/node_modules/playwright/index.mjs';
let chromium = null;
try { ({ chromium } = await import(fs.existsSync(PW) ? PW : 'playwright')); } catch { /* sin Playwright */ }

test('reproductores en navegador real: cinco sedes, sincronización medida, reconexión, autoplay y respaldo', { skip: !chromium && 'Playwright no está disponible', timeout: 15 * 60_000 }, async (t) => {
  const srv = await startServer({ dataDir: tmpDir('e2e'), env: { PLAYER_BACKUP_DOWNLOAD_DELAY_SECONDS: '3', PLAYER_BACKUP_AFTER_SECONDS: '6', SYNC_TARGET_DELAY_MS: '10000' } });
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  t.after(async () => { await browser.close(); await srv.stop(); });
  const admin = new AdminClient(srv.url);
  await admin.login();
  await admin.put('/api/admin/schedule/hours', { hours: Array.from({ length: 7 }, (_, d) => ({ weekday: d, start: '00:00', end: '24:00' })) });
  for (const f of [FIX.song1, FIX.song2]) await admin.upload('song', f);
  await waitFor(async () => (await admin.get('/api/admin/music')).data.songs.filter((s) => s.status === 'listo').length === 2, { label: 'canciones' });
  for (const s of (await admin.get('/api/admin/music')).data.songs) await admin.put(`/api/admin/music/${s.id}`, { title: s.title, enabled: true, backup: true });
  const ad = await admin.upload('ad', FIX.ad1, { name: 'Comercial A', activate: '1' });
  await waitFor(async () => (await admin.get('/api/admin/ads')).data.ads.find((a) => a.id === ad.data.id)?.status === 'listo', { label: 'comercial' });

  const pages = {}; const contexts = {};
  const state = (slug) => pages[slug].evaluate(() => window.RMDM && { state: window.RMDM.state, delay: window.RMDM.delay, err: window.RMDM.syncErr, mode: window.RMDM.mode, backup: window.RMDM.backup.status, muted: document.getElementById('live').muted });

  await t.test('las cinco páginas de sede reproducen la señal central con sonido', async () => {
    for (let i = 1; i <= 5; i++) {
      const slug = `sede-${i}`;
      contexts[slug] = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      pages[slug] = await contexts[slug].newPage();
      await pages[slug].goto(`${srv.url}/player/${slug}`);
    }
    for (const slug of Object.keys(pages)) {
      await waitFor(async () => (await state(slug))?.state === 'reproduciendo', { timeout: 60_000, label: `${slug} reproduciendo` });
      const s = await state(slug);
      assert.match(s.mode, /hls\.js/);
      assert.equal(s.muted, false);
    }
    await waitFor(async () => (await admin.get('/api/admin/sites')).data.sites.every((s) => s.connection === 'conectada' && s.playerState === 'reproduciendo'), { label: 'panel ve 5 sedes reproduciendo' });
  });

  const measurements = [];
  await t.test('sincronización: se MIDE el retraso de cada sede respecto a la hora oficial y la dispersión entre sedes', async () => {
    await sleep(25_000); // tiempo para que el control de sincronización converja
    for (let k = 0; k < 10; k++) {
      // Lectura casi simultánea de la posición (hora oficial del cuadro en pantalla) en las cinco páginas.
      const vals = await Promise.all(Object.keys(pages).map((slug) => pages[slug].evaluate(() => {
        const P = window.RMDM; const pd = P.hls && P.hls.playingDate ? P.hls.playingDate.getTime() : null;
        return pd == null ? null : (Date.now() + P.clockOffset) - pd;
      })));
      measurements.push(vals);
      await sleep(1000);
    }
    const spreads = measurements.filter((v) => v.every((x) => x != null)).map((v) => Math.max(...v) - Math.min(...v));
    const target = 10_000;
    const errors = measurements.flat().filter((x) => x != null).map((x) => x - target);
    const result = {
      fecha: new Date().toISOString(), entorno: 'Chromium sin interfaz en el mismo equipo del servidor (red local)',
      dispersionEntreSedesMs: { max: Math.max(...spreads), promedio: Math.round(spreads.reduce((a, b) => a + b, 0) / spreads.length) },
      desvioRespectoAlObjetivoMs: { maxAbs: Math.max(...errors.map(Math.abs)), promedio: Math.round(errors.reduce((a, b) => a + b, 0) / errors.length) },
      muestras: measurements.length,
    };
    fs.mkdirSync(path.join(ROOT, 'docs', 'resultados'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'docs', 'resultados', 'sincronizacion-e2e.json'), JSON.stringify(result, null, 2));
    t.diagnostic(`Sincronización medida: ${JSON.stringify(result)}`);
    assert.ok(result.dispersionEntreSedesMs.max < 1000, `dispersión entre sedes ${result.dispersionEntreSedesMs.max} ms`);
  });

  await t.test('confirmación por sede con telemetría real del reproductor (segmentos de hls.js)', async () => {
    const play = await waitFor(async () => (await admin.get('/api/admin/reports/plays')).data.items.find((p) => p.status === 'completado' && p.sites.filter((s) => s.status === 'confirmada').length === 5), { timeout: 120_000, label: 'comercial confirmado en 5 sedes' });
    assert.equal(play.sites.length, 5);
  });

  await t.test('un televisor que entra tarde se une al punto actual (no empieza desde el principio)', async () => {
    const ctx = await browser.newContext(); const late = await ctx.newPage();
    await late.goto(`${srv.url}/player/sede-1`);
    await waitFor(async () => (await late.evaluate(() => window.RMDM && window.RMDM.state)) === 'reproduciendo', { timeout: 60_000, label: 'tardío reproduciendo' });
    await sleep(8000);
    const [a, b] = await Promise.all([late, pages['sede-2']].map((p) => p.evaluate(() => window.RMDM.hls.playingDate.getTime())));
    assert.ok(Math.abs(a - b) < 1500, `el tardío está a ${Math.abs(a - b)} ms de las demás sedes`);
    await ctx.close();
  });

  await t.test('14 y 15 (navegador). una sede pierde Internet, las demás siguen; al volver recupera la señal central', async () => {
    await contexts['sede-2'].setOffline(true);
    await waitFor(async () => ['reconectando', 'sin_senal', 'respaldo'].includes((await state('sede-2')).state), { timeout: 60_000, label: 'sede 2 detecta la pérdida' });
    for (const slug of ['sede-1', 'sede-3', 'sede-4', 'sede-5']) assert.equal((await state(slug)).state, 'reproduciendo', slug);
    await sleep(4000);
    await contexts['sede-2'].setOffline(false);
    await waitFor(async () => (await state('sede-2')).state === 'reproduciendo', { timeout: 120_000, label: 'sede 2 recupera la señal' });
    const ev = await waitFor(async () => { const s = (await admin.get('/api/admin/sites')).data.sites.find((x) => x.slug === 'sede-2'); return s.recentEvents.some((e) => e.type === 'reconexion') && s; }, { timeout: 30_000, label: 'evento de reconexión' });
    assert.ok(ev.recentEvents.some((e) => e.type === 'desconexion'));
  });

  await t.test('respaldo local: descarga autorizada, reproducción sin Internet marcada como respaldo y regreso controlado', async () => {
    const st = await waitFor(async () => { const s = await state('sede-4'); return /^listo/.test(s.backup) && s; }, { timeout: 90_000, label: 'respaldo descargado' });
    t.diagnostic(`Estado del respaldo en sede-4: ${st.backup}`);
    await contexts['sede-4'].setOffline(true);
    await waitFor(async () => (await state('sede-4')).state === 'respaldo', { timeout: 60_000, label: 'sede 4 en respaldo local' });
    const playing = await pages['sede-4'].evaluate(() => { const a = document.getElementById('baudio'); return !a.paused && a.currentTime > 0 && a.src.startsWith('blob:'); });
    await sleep(3000);
    const playing2 = await pages['sede-4'].evaluate(() => { const a = document.getElementById('baudio'); const v = document.getElementById('bvideo'); return { a: !a.paused && a.src.startsWith('blob:'), v: !v.paused }; });
    assert.ok(playing || playing2.a || playing2.v, 'el respaldo reproduce contenido descargado');
    await contexts['sede-4'].setOffline(false);
    await waitFor(async () => (await state('sede-4')).state === 'reproduciendo', { timeout: 120_000, label: 'regreso a la señal central' });
    const s4 = await waitFor(async () => { const s = (await admin.get('/api/admin/sites')).data.sites.find((x) => x.slug === 'sede-4'); return s.recentEvents.some((e) => e.type === 'respaldo_fin') && s; }, { timeout: 30_000, label: 'eventos de respaldo' });
    assert.ok(s4.recentEvents.some((e) => e.type === 'respaldo_inicio'));
  });

  await t.test('señal detenida: las sedes muestran la pantalla de espera y vuelven solas al reiniciar', async () => {
    await admin.post('/api/admin/engine/action', { action: 'detener', confirm: true });
    await waitFor(async () => (await state('sede-5')).state === 'en_espera', { timeout: 60_000, label: 'pantalla de espera' });
    assert.ok(await pages['sede-5'].evaluate(() => !document.getElementById('wait').classList.contains('hidden')));
    await admin.post('/api/admin/engine/action', { action: 'iniciar' });
    await waitFor(async () => (await state('sede-5')).state === 'reproduciendo', { timeout: 90_000, label: 'vuelve a reproducir' });
  });

  await t.test('autoplay bloqueado: se muestra la pantalla de activación y basta con pulsar OK', async () => {
    const b2 = await chromium.launch({ args: ['--autoplay-policy=user-gesture-required'] }); // política que exige un gesto, como muchos TV
    try {
      const p = await (await b2.newContext()).newPage();
      // Emulación determinista de un televisor que bloquea el audio automático hasta que alguien pulse una tecla
      // (Chromium sin interfaz no siempre aplica su política de autoplay).
      await p.addInitScript(() => {
        let gesture = false;
        addEventListener('keydown', () => { gesture = true; }, true);
        addEventListener('click', () => { gesture = true; }, true);
        const orig = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () {
          if (!this.muted && !gesture) return Promise.reject(new DOMException('Autoplay bloqueado', 'NotAllowedError'));
          return orig.call(this);
        };
      });
      await p.goto(`${srv.url}/player/sede-3`);
      let last = null;
      try {
        await waitFor(async () => { last = await p.evaluate(() => window.RMDM && { s: window.RMDM.state, m: document.getElementById('live').muted, e: window.RMDM.lastError }); return last && last.s === 'bloqueado_autoplay'; }, { timeout: 60_000, label: 'autoplay bloqueado' });
      } catch (e) { throw new Error(`${e.message}; último estado: ${JSON.stringify(last)}`); }
      assert.ok(await p.evaluate(() => !document.getElementById('unmute').classList.contains('hidden')));
      await p.keyboard.press('Enter');
      await waitFor(async () => (await p.evaluate(() => ({ s: window.RMDM.state, m: document.getElementById('live').muted }))).m === false, { timeout: 20_000, label: 'sonido activado' });
      assert.equal(await p.evaluate(() => window.RMDM.state), 'reproduciendo');
    } finally { await b2.close(); }
  });

  await t.test('página de diagnóstico del televisor', async () => {
    const p = await (await browser.newContext()).newPage();
    await p.goto(`${srv.url}/diagnostico?sede=sede-1`);
    await p.click('#run');
    await waitFor(async () => !(await p.$eval('#send', (b) => b.disabled)), { timeout: 60_000, label: 'diagnóstico completo' });
    const summary = await p.$eval('#summary', (e) => e.textContent);
    assert.match(summary, /Señal en vivo: COMPATIBLE/);
    p.on('dialog', (d) => d.accept().catch(() => {}));
    await p.click('#send');
    await waitFor(async () => (await admin.get('/api/admin/logs?type=diagnostics')).data.items.length > 0, { label: 'diagnóstico recibido' });
  });
});
