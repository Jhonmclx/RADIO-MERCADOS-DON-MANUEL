// Comerciales solo para una sede (p. ej. precios del Terminal): solo esa sede los recibe.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startServer, AdminClient, makeFixtures, waitFor, tmpDir, ROOT } from '../helpers.js';

const FIX = makeFixtures(path.join(ROOT, 'tests', 'fixtures', 'generated'));

test('comercial asignado solo al Terminal', { timeout: 5 * 60_000 }, async () => {
  const srv = await startServer({ dataDir: tmpDir('ad-sites') });
  try {
    const admin = new AdminClient(srv.url); await admin.login();
    await admin.put('/api/admin/schedule/hours', { hours: Array.from({ length: 7 }, (_, d) => ({ weekday: d, start: '00:00', end: '24:00' })) });
    const sites = (await admin.get('/api/admin/sites')).data.sites;
    const terminal = sites.find((s) => s.slug === 'terminal');
    const general = await admin.upload('ad', FIX.ad1, { name: 'Para todas', activate: '1' });
    const solo = await admin.upload('ad', FIX.ad2, { name: 'Precios Terminal', activate: '1', sites: String(terminal.id) });
    await waitFor(async () => (await admin.get('/api/admin/ads')).data.ads.filter((a) => a.status === 'listo').length === 2, { label: 'comerciales listos' });
    const ads = (await admin.get('/api/admin/ads')).data.ads;
    assert.deepEqual(ads.find((a) => a.id === solo.data.id).siteNames, ['Terminal']);
    assert.deepEqual(ads.find((a) => a.id === general.data.id).siteIds, []);

    const man = async (slug) => (await (await fetch(`${srv.url}/api/public/sites/${slug}/backup-manifest?modo=local`)).json()).ads.map((a) => a.id).sort();
    assert.deepEqual(await man('terminal'), [general.data.id, solo.data.id].sort(), 'el Terminal recibe los dos');
    assert.deepEqual(await man('gourmet'), [general.data.id], 'Gourmet no recibe el del Terminal');

    // Cambiarlo a "todas las sedes" desde Editar
    const r = await admin.put(`/api/admin/ads/${solo.data.id}`, { name: 'Precios Terminal', advertiserId: null, weight: 1, siteIds: [] });
    assert.equal(r.status, 200);
    assert.deepEqual(await man('gourmet'), [general.data.id, solo.data.id].sort());
    // Sede inexistente
    assert.equal((await admin.put(`/api/admin/ads/${solo.data.id}`, { name: 'x', weight: 1, siteIds: [999] })).status, 400);
  } finally { await srv.stop(); }
});
