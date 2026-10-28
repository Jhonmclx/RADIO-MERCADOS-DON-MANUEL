// Prueba de integración de extremo a extremo contra el servidor REAL (FFmpeg real, HLS real, base de datos real).
// Los "televisores" de esta prueba son clientes HTTP simulados que leen la lista en vivo y envían telemetría:
// validan el protocolo y la lógica del servidor, NO la compatibilidad de un televisor físico.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startServer, AdminClient, makeFixtures, waitFor, sleep, LiveCollector, dominantFrequency, firstFrameColor, colorName, tmpDir, ROOT } from '../helpers.js';

const FIX = makeFixtures(path.join(ROOT, 'tests', 'fixtures', 'generated'));

test('RADIO MERCADO DON MANUEL — emisión central completa', { timeout: 15 * 60_000 }, async (t) => {
  const srv = await startServer({ dataDir: tmpDir('broadcast') });
  const admin = new AdminClient(srv.url);
  const live = new LiveCollector(srv.url).start();
  const sims = [];
  t.after(async () => { for (const s of sims) s.stop = true; await live.stop(); await srv.stop(); });

  const asrun = async () => (await admin.get('/api/admin/logs?type=asrun&limit=1000')).data.items.slice().reverse();
  const plays = async (q = '') => (await admin.get(`/api/admin/reports/plays?limit=1000${q}`)).data.items;
  const engine = async () => (await admin.get('/api/admin/engine')).data;
  const content = (items) => items.filter((i) => i.kind !== 'slate' && ['emitido', 'interrumpido', 'al_aire'].includes(i.status));
  const pattern = (items) => items.map((i) => (i.kind === 'song' ? 'C' : 'P')).join('');
  const adsDone = async (adId) => (await plays()).filter((p) => p.adId === adId && ['completado', 'interrumpido'].includes(p.status));

  await t.test('1. el administrador inicia sesión (y se rechaza una contraseña incorrecta)', async () => {
    assert.equal((await new AdminClient(srv.url).login('admin', 'incorrecta123')).status, 401);
    const r = await admin.login();
    assert.equal(r.status, 200);
    assert.ok(r.data.csrf);
    const me = await admin.get('/api/auth/me');
    assert.equal(me.data.user.username, 'admin');
    // Horario de prueba: todo el día, todos los días.
    const hours = Array.from({ length: 7 }, (_, d) => ({ weekday: d, start: '00:00', end: '24:00' }));
    assert.equal((await admin.put('/api/admin/schedule/hours', { hours })).status, 200);
  });

  await t.test('canciones MP3 cargadas y procesadas', async () => {
    for (const f of [FIX.song1, FIX.song2]) assert.equal((await admin.upload('song', f)).status, 202);
    await waitFor(async () => (await admin.get('/api/admin/music')).data.songs.filter((s) => s.status === 'listo').length === 2, { label: 'canciones listas' });
  });

  let ad1;
  await t.test('2. se sube un video comercial válido y queda disponible solo tras validarse', async () => {
    const r = await admin.upload('ad', FIX.ad1, { name: 'Comercial A', activate: '1' });
    assert.equal(r.status, 202);
    ad1 = r.data.id;
    const first = (await admin.get('/api/admin/ads')).data.ads.find((a) => a.id === ad1);
    assert.ok(['procesando', 'listo'].includes(first.status));
    const a = await waitFor(async () => (await admin.get('/api/admin/ads')).data.ads.find((x) => x.id === ad1 && x.status === 'listo'), { label: 'comercial listo' });
    assert.ok(Math.abs(a.durationMs - 8000) < 600, `duración ${a.durationMs}`);
    assert.match(a.sha256, /^[0-9a-f]{64}$/);
    assert.ok(a.thumbUrl);
  });

  await t.test('3. se rechaza un archivo dañado o incompatible (y se informa el motivo)', async () => {
    const bad = await admin.upload('ad', FIX.corrupt, { name: 'Dañado', activate: '1' });
    assert.equal(bad.status, 202);
    const a = await waitFor(async () => (await admin.get('/api/admin/ads')).data.ads.find((x) => x.id === bad.data.id && x.status !== 'procesando'), { label: 'validación del dañado' });
    assert.equal(a.status, 'rechazado');
    assert.equal(a.active, false);
    assert.match(a.error, /dañado|reconocible|procesar/i);
    const txt = await admin.upload('ad', FIX.text, { name: 'Texto' });
    assert.equal(txt.status, 415);
  });

  await t.test('4. el comercial activo aparece en la programación', async () => {
    const a = (await admin.get('/api/admin/ads')).data.ads.find((x) => x.id === ad1);
    assert.ok(['en_rotacion', 'al_aire'].includes(a.state), a.state);
    assert.equal((await admin.get('/api/admin/dashboard')).data.counts.adsInRotation, 1);
    await waitFor(async () => (await adsDone(ad1)).length >= 1, { timeout: 90_000, label: 'primera emisión del comercial' });
  });

  await t.test('5, 8 y 9. dos canciones y el comercial; al terminar vuelve la música; el ciclo sigue solo', async () => {
    await waitFor(async () => (await adsDone(ad1)).length >= 3, { timeout: 120_000, label: 'tres bloques comerciales' });
    const items = content(await asrun());
    const firstAd = items.findIndex((i) => i.kind === 'ad');
    assert.equal(pattern(items.slice(firstAd, firstAd + 7)), 'PCCPCCP');
  });

  await t.test('6. durante la música el video comercial va en ciclo y SIN su audio', async () => {
    const items = content(await asrun());
    const firstAd = items.findIndex((i) => i.kind === 'ad');
    const song = items.slice(firstAd).find((i) => i.kind === 'song' && i.status === 'emitido');
    let checked = 0;
    for (let seq = song.first_seq; seq <= song.last_seq; seq++) {
      const seg = live.segs.get(seq);
      if (!seg || seg.dur < 1.5) continue;
      const { hz } = dominantFrequency(seg.buf);
      assert.ok(Math.abs(hz - 440) < 40 || Math.abs(hz - 660) < 40, `segmento ${seq}: se esperaba la canción (440/660 Hz) y sonó ${hz.toFixed(0)} Hz`);
      const c = colorName(firstFrameColor(seg.buf));
      assert.ok(['rojo', 'azul'].includes(c), `segmento ${seq}: se esperaba el video del comercial y se vio ${c}`);
      checked++;
    }
    assert.ok(checked >= 2, `segmentos verificados: ${checked}`);
  });

  await t.test('7. el bloque comercial arranca desde el primer segundo y suena su audio completo', async () => {
    const items = content(await asrun());
    const adItem = items.find((i) => i.kind === 'ad' && i.status === 'emitido' && live.segs.has(i.first_seq) && live.segs.has(i.last_seq));
    assert.ok(adItem, 'emisión de comercial capturada completa');
    const first = live.segs.get(adItem.first_seq);
    assert.equal(colorName(firstFrameColor(first.buf)), 'rojo', 'el primer cuadro debe ser el primer segundo del comercial');
    for (let seq = adItem.first_seq; seq <= adItem.last_seq; seq++) {
      const seg = live.segs.get(seq);
      if (seg.dur < 1.5) continue;
      const { hz } = dominantFrequency(seg.buf);
      assert.ok(Math.abs(hz - 1000) < 50, `segmento ${seq}: se esperaba el audio del comercial (1000 Hz), sonó ${hz.toFixed(0)} Hz`);
    }
    const p = (await plays()).find((x) => x.firstSeq === adItem.first_seq);
    assert.equal(p.status, 'completado');
    assert.ok(Math.abs(p.observedMs - p.expectedMs) < 700, `emitido ${p.observedMs} vs esperado ${p.expectedMs}`);
    // Continuidad temporal: la hora oficial de cada segmento sigue exactamente a la anterior.
    for (let seq = adItem.first_seq + 1; seq <= adItem.last_seq; seq++) {
      const a = live.segs.get(seq - 1); const b = live.segs.get(seq);
      assert.ok(Math.abs(b.pdt - (a.pdt + a.dur * 1000)) < 5, 'hora oficial continua');
    }
  });

  // Televisores simulados (clientes HTTP): leen la lista y confirman los segmentos que "reproducen".
  const startSim = (slug) => {
    const sim = { slug, stop: false, paused: false, configVersion: null };
    (async () => {
      const st = await (await fetch(`${srv.url}/api/public/sites/${slug}/state`)).json();
      sim.configVersion = st.configVersion;
      while (!sim.stop) {
        if (!sim.paused) {
          try {
            const txt = await (await fetch(`${srv.url}/live/index.m3u8`)).text();
            const ms = Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(txt)[1]);
            const n = (txt.match(/\.ts/g) || []).length;
            const seqs = Array.from({ length: n }, (_, i) => ms + i);
            const r = await (await fetch(`${srv.url}/api/public/sites/${slug}/heartbeat`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId: `sim-${slug}`, state: 'reproduciendo', mode: 'simulado', seqs, seq: seqs.at(-1), delayMs: 10_000, syncErrorMs: 0, configVersion: sim.configVersion }) })).json();
            sim.configVersion = r.configVersion; // el reproductor adopta la versión que le confirma el servidor
          } catch { /* ignore */ }
        }
        await sleep(1000);
      }
    })();
    sims.push(sim);
    return sim;
  };

  await t.test('13. los cambios llegan a las cinco sedes conectadas (confirmación de versión por sede)', async () => {
    for (const s of ['alto-del-espino', 'gourmet', 'parque-narino', 'terminal', 'sachica']) startSim(s);
    await waitFor(async () => (await admin.get('/api/admin/sites')).data.sites.every((s) => s.connection === 'conectada'), { label: 'cinco sedes conectadas' });
    const before = (await admin.get('/api/admin/settings')).data.configVersion;
    assert.equal((await admin.put('/api/admin/settings', { songsBetweenAds: 2, adsPerBlock: 1, musicShuffle: false })).status, 200);
    const after = (await admin.get('/api/admin/settings')).data.configVersion;
    assert.ok(after > before);
    await waitFor(async () => (await admin.get('/api/admin/sites')).data.sites.every((s) => s.lastConfigVersion === after && s.configUpToDate), { label: 'versión confirmada por las 5 sedes' });
  });

  let ad2;
  await t.test('11. se agrega un comercial nuevo sin interrumpir el que está al aire', async () => {
    await waitFor(async () => { const e = await engine(); return e.onAir?.kind === 'ad' && e.onAir.mediaId === ad1; }, { timeout: 90_000, label: 'comercial A al aire' });
    const airing = (await plays()).find((p) => p.status === 'emitiendo');
    const r = await admin.upload('ad', FIX.ad2, { name: 'Comercial B', activate: '1' });
    ad2 = r.data.id;
    await waitFor(async () => { const p = (await plays()).find((x) => x.id === airing.id); return p.status !== 'emitiendo' && p; }, { label: 'fin del comercial A' });
    const p = (await plays()).find((x) => x.id === airing.id);
    assert.equal(p.status, 'completado', 'el comercial al aire no se cortó');
    await waitFor(async () => (await adsDone(ad2)).length >= 1, { timeout: 120_000, label: 'primera emisión del comercial B' });
    // La emisión central se registra UNA vez y se relaciona con las sedes (no se multiplica por cinco).
    const pb = (await adsDone(ad2))[0];
    assert.equal(pb.sites.length, 5);
    assert.equal((await plays()).filter((x) => x.firstSeq === pb.firstSeq).length, 1);
    assert.ok(pb.sites.filter((s) => s.status === 'confirmada').length >= 4, JSON.stringify(pb.sites.map((s) => s.status)));
  });

  await t.test('10 y 12. se desactiva un comercial mientras está al aire: termina completo, sale de la rotación y conserva su historial', async () => {
    await waitFor(async () => { const e = await engine(); return e.onAir?.kind === 'ad' && e.onAir.mediaId === ad1; }, { timeout: 120_000, label: 'comercial A al aire de nuevo' });
    const airing = (await plays()).find((p) => p.status === 'emitiendo' && p.adId === ad1);
    const r = await admin.post(`/api/admin/ads/${ad1}/deactivate`, { mode: 'al_terminar' });
    assert.equal(r.status, 200); assert.equal(r.data.cut, false);
    await waitFor(async () => (await plays()).find((x) => x.id === airing.id).status !== 'emitiendo', { label: 'fin del comercial A' });
    assert.equal((await plays()).find((x) => x.id === airing.id).status, 'completado');
    const countA = (await adsDone(ad1)).length;
    await waitFor(async () => (await adsDone(ad2)).length >= 3, { timeout: 150_000, label: 'más bloques con B' });
    assert.equal((await adsDone(ad1)).length, countA, 'A no volvió a programarse');
    const hist = await admin.get(`/api/admin/ads/${ad1}/history`);
    assert.ok(hist.data.items.filter((p) => p.status === 'completado').length >= 3, 'el historial de A se conserva');
    // Durante la música el ciclo silencioso ya no usa A.
    const items = content(await asrun());
    const lastSongs = items.filter((i) => i.kind === 'song').slice(-2);
    assert.ok(lastSongs.length === 2);
  });

  await t.test('21. una reproducción interrumpida se registra como tal (retiro inmediato)', async () => {
    await waitFor(async () => { const e = await engine(); return e.onAir?.kind === 'ad' && e.onAir.mediaId === ad2; }, { timeout: 90_000, label: 'B al aire' });
    await sleep(2500);
    const r = await admin.post(`/api/admin/ads/${ad2}/deactivate`, { mode: 'inmediato' });
    assert.equal(r.data.cut, true);
    const p = (await plays()).filter((x) => x.adId === ad2).sort((a, b) => b.startedAt - a.startedAt)[0];
    assert.equal(p.status, 'interrumpido');
    assert.match(p.interruptionReason, /inmediato|Retirado/i);
    assert.ok(p.observedMs < p.expectedMs);
    // La emisión sigue (música) y B se reactiva para las siguientes pruebas.
    await waitFor(async () => (await engine()).onAir?.kind === 'song', { label: 'la música continúa' });
    assert.equal((await admin.post(`/api/admin/ads/${ad2}/activate`)).status, 200);
  });

  await t.test('14 y 15. una sede pierde conexión, las demás siguen; al volver se registra la reconexión', async () => {
    const sim3 = sims.find((s) => s.slug === 'parque-narino');
    sim3.paused = true;
    await waitFor(async () => (await admin.get('/api/admin/sites')).data.sites.find((s) => s.slug === 'parque-narino').connection === 'desconectada', { label: 'sede 3 desconectada' });
    const sites = (await admin.get('/api/admin/sites')).data.sites;
    assert.ok(sites.filter((s) => s.slug !== 'parque-narino').every((s) => s.connection === 'conectada'));
    const segsBefore = live.segs.size; await sleep(5000);
    assert.ok(live.segs.size > segsBefore, 'la señal sigue publicándose para las demás sedes');
    sim3.paused = false;
    const s3 = await waitFor(async () => { const s = (await admin.get('/api/admin/sites')).data.sites.find((x) => x.slug === 'parque-narino'); return s.connection === 'conectada' && s.lastReconnectAt && s; }, { label: 'sede 3 reconectada' });
    assert.ok(s3.lastDisconnectMs >= 6000);
    assert.ok(s3.recentEvents.some((e) => e.type === 'reconexion'));
  });

  await t.test('16. el administrador se desconecta y la emisión continúa en el servidor', async () => {
    await admin.post('/api/auth/logout');
    assert.equal((await admin.get('/api/admin/engine')).status, 401);
    const segs = live.segs.size;
    await sleep(16_000);
    assert.ok(live.segs.size - segs >= 6, `segmentos nuevos sin administrador: ${live.segs.size - segs}`);
    assert.equal((await fetch(`${srv.url}/healthz`)).status, 200);
    await admin.login();
  });

  await t.test('regla configurable: con 1 canción entre comerciales el patrón cambia a C P C P', async () => {
    const r = await admin.put('/api/admin/settings', { songsBetweenAds: 1, adsPerBlock: 1, musicShuffle: false });
    assert.equal(r.status, 200);
    const startCount = content(await asrun()).length;
    await waitFor(async () => content(await asrun()).length >= startCount + 7, { timeout: 150_000, label: 'siete elementos más' });
    const items = content(await asrun()).slice(startCount + 2).filter((i) => i.status !== 'al_aire');
    const p = pattern(items);
    assert.ok(/^(PC|CP)(PC)*P?C?$/.test(p) || /CPCP/.test(p), `patrón tras el cambio: ${p}`);
    assert.ok(!/CC/.test(p), `no debe haber dos canciones seguidas: ${p}`);
    await admin.put('/api/admin/settings', { songsBetweenAds: 2, adsPerBlock: 1, musicShuffle: false });
  });

  await t.test('controles: pausar publicidad, pausar programación y detener/iniciar la señal (con confirmación)', async () => {
    assert.equal((await admin.post('/api/admin/engine/action', { action: 'pausar_publicidad' })).status, 200);
    const startCount = content(await asrun()).length;
    await waitFor(async () => content(await asrun()).length >= startCount + 5, { timeout: 120_000, label: 'cinco elementos más' });
    assert.match(pattern(content(await asrun()).slice(startCount + 1)), /^C{3,}/, 'con la publicidad en pausa solo suena música');
    await admin.post('/api/admin/engine/action', { action: 'reanudar_publicidad' });

    const noConfirm = await admin.post('/api/admin/engine/action', { action: 'detener' });
    assert.equal(noConfirm.status, 409);
    assert.equal(noConfirm.data.requiresConfirm, true);
    assert.equal((await admin.post('/api/admin/engine/action', { action: 'detener', confirm: true })).status, 200);
    const pl = await (await fetch(`${srv.url}/live/index.m3u8`)).text();
    assert.match(pl, /#EXT-X-ENDLIST/);
    assert.equal((await engine()).mode, 'stopped');
    assert.equal((await (await fetch(`${srv.url}/api/public/sites/alto-del-espino/state`)).json()).engine.mode, 'stopped');
    assert.equal((await admin.post('/api/admin/engine/action', { action: 'iniciar' })).status, 200);
    await waitFor(async () => !(await (await fetch(`${srv.url}/live/index.m3u8`)).text()).includes('ENDLIST'), { label: 'señal reanudada' });
  });

  await t.test('18. los reportes muestran exactamente los eventos reales registrados', async () => {
    const items = (await asrun()).filter((i) => i.kind === 'ad' && ['emitido', 'interrumpido'].includes(i.status));
    const all = await plays();
    const closed = all.filter((p) => ['completado', 'interrumpido'].includes(p.status));
    assert.equal(closed.length, items.length, 'una fila de reporte por cada emisión central de comercial');
    for (const it of items) {
      const p = closed.find((x) => x.firstSeq === it.first_seq);
      assert.ok(p, `emisión ${it.id} presente en el reporte`);
      assert.equal(p.status, it.status === 'emitido' ? 'completado' : 'interrumpido');
    }
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
    const csv = await admin.req('GET', `/api/admin/reports/plays.csv?from=${today}&to=${today}`, undefined, { raw: true });
    assert.equal(csv.status, 200);
    const text = await csv.text();
    assert.match(text, /id_evento;inicio_local;fin_local;comercial/);
    assert.ok(text.trim().split('\r\n').length >= closed.length + 1);
    const sum = await admin.get(`/api/admin/reports/summary?date=${today}`);
    assert.ok(sum.data.ads.length >= 1);
  });

  await t.test('19 y 20. los enlaces públicos no dan acceso a la administración', async () => {
    const anon = new AdminClient(srv.url);
    for (const p of ['/api/admin/dashboard', '/api/admin/ads', '/api/admin/reports/plays', '/api/admin/logs', '/api/admin/settings']) {
      assert.equal((await anon.get(p)).status, 401, p);
    }
    for (const [m, p] of [['POST', '/api/admin/engine/action'], ['PUT', '/api/admin/settings'], ['POST', `/api/admin/ads/${ad2}/deactivate`], ['POST', '/api/admin/ads/upload?name=x&filename=x.mp4']]) {
      assert.equal((await anon.req(m, p, { action: 'detener', confirm: true, songsBetweenAds: 9 })).status, 401, `${m} ${p}`);
    }
    // Con sesión pero sin token CSRF tampoco se permiten cambios.
    assert.equal((await admin.req('PUT', '/api/admin/settings', { songsBetweenAds: 9 }, { csrf: false })).status, 403);
    // Origen ajeno: rechazado.
    const evil = await fetch(`${srv.url}/api/admin/settings`, { method: 'PUT', headers: { Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf, 'Content-Type': 'application/json', Origin: 'https://atacante.example' }, body: '{"songsBetweenAds":9}' });
    assert.equal(evil.status, 403);
    const html = await (await fetch(`${srv.url}/player/alto-del-espino`)).text();
    assert.ok(!/\/api\/admin|\/admin\//.test(html), 'la página pública no enlaza al panel');
    const js = await (await fetch(`${srv.url}/static/player/player.js`)).text();
    assert.ok(!/\/api\/admin/.test(js));
    // La telemetría pública no puede cambiar ajustes, aunque lo intente.
    await fetch(`${srv.url}/api/public/sites/alto-del-espino/heartbeat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'reproduciendo', songs_between_ads: 9, engine_mode: 'stopped' }) });
    const s = (await admin.get('/api/admin/settings')).data;
    assert.equal(s.songsBetweenAds, 2); assert.equal(s.engineMode, 'running');
    // El estado público no expone datos del anunciante.
    const st = await (await fetch(`${srv.url}/api/public/sites/alto-del-espino/state`)).text();
    assert.ok(!/advertiser|anunciante|Comercial A|Comercial B/.test(st));
    // Rutas inexistentes / recorridos de directorio.
    assert.equal((await fetch(`${srv.url}/static/../src/config.js`)).status, 404);
    assert.equal((await fetch(`${srv.url}/static/%2e%2e/src/config.js`)).status, 404);
    assert.equal((await fetch(`${srv.url}/live/..%2fdb%2fradio.sqlite`)).status, 404);
    assert.equal((await fetch(`${srv.url}/player/no-existe`)).status, 404);
    // Sin sesión no se puede descargar el video original de un comercial.
    assert.equal((await fetch(`${srv.url}/api/admin/ads/${ad2}/video`)).status, 401);
  });

  await t.test('22. reintentar el envío de un evento no lo duplica en el historial', async () => {
    const ev = { id: 'evento-prueba-0001', type: 'desconexion', at: Date.now() - 5000, detail: { motivo: 'prueba' } };
    const bp = { id: 'respaldo-prueba-0001', adId: ad2, startedAt: Date.now() - 60_000, endedAt: Date.now() - 52_000, completed: true };
    const send = () => fetch(`${srv.url}/api/public/sites/gourmet/heartbeat`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'reproduciendo', events: [ev], backupPlays: [bp] }) }).then((r) => r.json());
    const r1 = await send(); const r2 = await send(); await send();
    assert.equal(r1.accepted, 1); assert.equal(r2.accepted, 0);
    const evs = (await admin.get('/api/admin/logs?type=sites&limit=1000')).data.items.filter((e) => e.id === ev.id);
    assert.equal(evs.length, 1);
    const back = (await admin.get('/api/admin/reports/backup')).data.items.filter((b) => b.id === bp.id);
    assert.equal(back.length, 1);
  });

  await t.test('registro de auditoría de acciones administrativas', async () => {
    const audit = (await admin.get('/api/admin/logs?type=audit&limit=500')).data.items.map((a) => a.action);
    for (const a of ['login', 'subir_comercial', 'desactivar_comercial', 'desactivar_comercial_inmediato', 'cambiar_reglas', 'motor_detener', 'motor_iniciar']) assert.ok(audit.includes(a), a);
  });
});
