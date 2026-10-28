// Contenido de demostración (solo si DEMO_SEED=true y la biblioteca está vacía).
// Música sintetizada propia (sin derechos de terceros) y un comercial de muestra, en la carpeta demo/.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function seedDemo({ cfg, db, library, log }) {
  const dir = path.join(cfg.root, 'demo');
  if (!fs.existsSync(dir)) return;
  const empty = !db.get('SELECT COUNT(*) AS n FROM songs').n && !db.get('SELECT COUNT(*) AS n FROM ads').n;
  if (!empty) return;
  const stage = (file) => {
    const ext = path.extname(file).toLowerCase();
    const tmp = path.join(cfg.tmpDir, `demo-${crypto.randomUUID()}${ext}`);
    fs.copyFileSync(path.join(dir, file), tmp);
    const buf = fs.readFileSync(tmp);
    return { tmp, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), ext };
  };
  library.createSong(stage('musica-demo-1.mp3'), { title: 'Mañana en el mercado', artist: 'Demo', originalName: 'musica-demo-1.mp3' });
  library.createSong(stage('musica-demo-2.mp3'), { title: 'Compras con calma', artist: 'Demo', originalName: 'musica-demo-2.mp3' });
  const adId = library.createAd(stage('comercial-demo.mp4'), { name: 'Frutas y verduras frescas (demo)', originalName: 'comercial-demo.mp4' });
  db.run('UPDATE ads SET activate_on_ready = 1 WHERE id = ?', adId);
  // Demostración: emisión todo el día para poder probar a cualquier hora.
  db.tx(() => {
    db.run('DELETE FROM schedule_hours');
    for (let d = 0; d < 7; d++) db.run('INSERT INTO schedule_hours (weekday, start_min, end_min) VALUES (?, 0, 1440)', d);
  });
  db.audit({ username: 'sistema' }, 'cargar_contenido_demo', 'demo', null, null);
  log('info', 'Contenido de demostración cargado (2 canciones y 1 comercial). Horario: 24 horas.');
}
