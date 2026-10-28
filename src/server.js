// Punto de entrada: RADIO MERCADO DON MANUEL
import { loadEnvFile, buildConfig } from './config.js';
import { createApp } from './app.js';

loadEnvFile();
const cfg = buildConfig();

const app = await createApp(cfg).catch((e) => { console.error(`\n✖ No se pudo iniciar: ${e.message}\n`); process.exit(1); });
app.server.listen(cfg.port, cfg.host, () => {
  console.log(`\n  ${cfg.appName}`);
  console.log(`  Panel:        http://localhost:${cfg.port}/admin/`);
  console.log(`  Sede 1:       http://localhost:${cfg.port}/player/sede-1`);
  console.log(`  Diagnóstico:  http://localhost:${cfg.port}/diagnostico`);
  console.log(`  Datos:        ${cfg.dataDir}\n`);
  if (cfg.engineAutostart) app.start();
});

let stopping = false;
async function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  console.log(`\nRecibida señal ${sig}: guardando estado y cerrando…`);
  const t = setTimeout(() => process.exit(1), 10_000);
  try { await app.close(); } catch (e) { console.error(e); }
  clearTimeout(t);
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => { console.error('Promesa rechazada sin manejar:', e); });
