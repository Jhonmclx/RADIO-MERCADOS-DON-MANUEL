// Crea o restablece un usuario administrador:  npm run create-admin -- usuario
import readline from 'node:readline';
import { loadEnvFile, buildConfig } from '../config.js';
import { openDatabase } from '../db/index.js';
import { hashPassword, validatePasswordStrength } from '../http/security.js';

loadEnvFile();
const cfg = buildConfig();
const db = openDatabase(cfg.dbFile);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

const username = process.argv[2] || (await ask('Usuario administrador: ')).trim();
if (!/^[A-Za-z0-9._-]{3,60}$/.test(username)) { console.error('Usuario inválido (3 a 60 letras, números, punto, guion).'); process.exit(1); }
const password = process.env.NEW_ADMIN_PASSWORD || (await ask('Contraseña (mínimo 10 caracteres, letras y números): ')).trim();
rl.close();
const err = validatePasswordStrength(password);
if (err) { console.error(err); process.exit(1); }
const exists = db.get('SELECT id FROM users WHERE username = ?', username);
if (exists) {
  db.run('UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?', hashPassword(password), exists.id);
  db.run('DELETE FROM sessions WHERE user_id = ?', exists.id);
  db.audit({ username: 'consola' }, 'restablecer_contrasena', 'user', exists.id);
  console.log(`Contraseña de "${username}" actualizada.`);
} else {
  db.run('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)', username, hashPassword(password), 'admin', Date.now());
  db.audit({ username: 'consola' }, 'crear_administrador', 'user', username);
  console.log(`Administrador "${username}" creado.`);
}
db.close();
