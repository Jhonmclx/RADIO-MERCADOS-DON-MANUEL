import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startServer, AdminClient, makeFixtures, waitFor, tmpDir, ROOT } from '../helpers.js';

const FIX = makeFixtures(path.join(ROOT, 'tests', 'fixtures', 'generated'));

test('eliminar un comercial que ya se emitió: desaparece del panel y se conservan sus reportes', { timeout: 5 * 60_000 }, async () => {
  const srv = await startServer({ dataDir: tmpDir('del-ad') });
  try {
    const admin = new AdminClient(srv.url);
    await admin.login();
    await admin.put('/api/admin/schedule/hours', { hours: Array.from({ length: 7 }, (_, d) => ({ weekday: d, start: '00:00', end: '24:00' })) });
    await admin.upload('song', FIX.song1);
    const ad = await admin.upload('ad', FIX.ad1, { name: 'Viejo', activate: '1' });
    const id = ad.data.id;
    await waitFor(async () => (await admin.get('/api/admin/ads')).data.ads.find((a) => a.id === id)?.plays > 0, { timeout: 180_000, label: 'comercial emitido' });
    const active = await admin.req('DELETE', `/api/admin/ads/${id}`);
    assert.equal(active.status, 409, 'activo: pide desactivar primero');
    await admin.post(`/api/admin/ads/${id}/deactivate`, { mode: 'inmediato' });
    await waitFor(async () => (await admin.req('DELETE', `/api/admin/ads/${id}`)).status === 200, { timeout: 120_000, label: 'eliminado' });
    assert.ok(!(await admin.get('/api/admin/ads')).data.ads.some((a) => a.id === id), 'ya no aparece en la lista');
  } finally { await srv.stop(); }
});
