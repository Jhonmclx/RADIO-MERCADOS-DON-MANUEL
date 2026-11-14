// "Quitar toda la música": exige escribir BORRAR, quita todas las canciones y los TV dejan de recibirlas.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startServer, AdminClient, makeFixtures, waitFor, tmpDir, ROOT } from '../helpers.js';

const FIX = makeFixtures(path.join(ROOT, 'tests', 'fixtures', 'generated'));

test('quitar toda la música', { timeout: 3 * 60_000 }, async () => {
  const srv = await startServer({ dataDir: tmpDir('music-all') });
  try {
    const admin = new AdminClient(srv.url); await admin.login();
    for (const f of [FIX.song1, FIX.song2]) await admin.upload('song', f);
    await waitFor(async () => (await admin.get('/api/admin/music')).data.songs.filter((s) => s.status === 'listo').length === 2, { label: 'canciones' });
    assert.equal((await admin.post('/api/admin/music/archive-all', {})).status, 400, 'sin la palabra BORRAR no hace nada');
    assert.equal((await admin.get('/api/admin/music')).data.songs.length, 2);
    const r = await admin.post('/api/admin/music/archive-all', { confirm: 'BORRAR' });
    assert.equal(r.status, 200); assert.equal(r.data.removed, 2);
    assert.equal((await admin.get('/api/admin/music')).data.songs.length, 0);
    const man = await (await fetch(`${srv.url}/api/public/sites/gourmet/backup-manifest?modo=local`)).json();
    assert.equal(man.songs.length, 0, 'los TV ya no reciben canciones');
  } finally { await srv.stop(); }
});
