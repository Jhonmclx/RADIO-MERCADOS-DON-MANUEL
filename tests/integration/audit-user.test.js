// Registro de acciones por usuario: se puede revisar lo que hizo cada persona en el panel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, AdminClient, tmpDir } from '../helpers.js';

test('acciones administrativas filtradas por usuario', { timeout: 120_000 }, async () => {
  const srv = await startServer({ dataDir: tmpDir('audit-user') });
  try {
    const admin = new AdminClient(srv.url); await admin.login();
    await admin.put('/api/admin/settings', { songsBetweenAds: 3, adsPerBlock: 1, musicShuffle: true });
    const r = await admin.get('/api/admin/logs?type=audit&user=admin');
    assert.ok(r.data.users.includes('admin'));
    assert.ok(r.data.items.length > 0 && r.data.items.every((i) => i.username === 'admin'));
    assert.ok(r.data.items.some((i) => i.action === 'login'));
    assert.equal((await admin.get('/api/admin/logs?type=audit&user=nadie')).data.items.length, 0);
  } finally { await srv.stop(); }
});
