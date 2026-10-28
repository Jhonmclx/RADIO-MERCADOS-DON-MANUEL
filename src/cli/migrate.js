import { loadEnvFile, buildConfig } from '../config.js';
import { Database } from '../db/index.js';
loadEnvFile();
const cfg = buildConfig();
const db = new Database(cfg.dbFile);
const applied = db.migrate();
db.seed();
console.log(applied.length ? `Migraciones aplicadas: ${applied.join(', ')}` : 'La base de datos ya está al día.');
db.close();
