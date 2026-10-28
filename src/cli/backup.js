// Copia de seguridad consistente de la base de datos (VACUUM INTO) + configuración.
// Los archivos multimedia se respaldan aparte (ver docs/DESPLIEGUE.md): son grandes y no cambian.
import fs from 'node:fs';
import path from 'node:path';
import { loadEnvFile, buildConfig } from '../config.js';
import { Database } from '../db/index.js';

loadEnvFile();
const cfg = buildConfig();
fs.mkdirSync(cfg.backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = path.join(cfg.backupDir, `radio-${stamp}.sqlite`);
const db = new Database(cfg.dbFile);
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
db.close();
const keep = Number(process.env.BACKUP_KEEP || 30);
const files = fs.readdirSync(cfg.backupDir).filter((f) => /^radio-.*\.sqlite$/.test(f)).sort();
for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(cfg.backupDir, f));
console.log(`Copia creada: ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB). Se conservan las últimas ${keep}.`);
