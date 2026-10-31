// Punto de entrada: RADIO MERCADO DON MANUEL
import { loadEnvFile, buildConfig } from './config.js';
import { createApp } from './app.js';

loadEnvFile();

// Modo "mudanza": si la radio se trasladó a otro servidor (p. ej. el PC del almacén), este servidor solo redirige
// todos los links viejos (panel y televisores) a la dirección nueva, conservando la ruta (/player/gourmet?local=1).
if (process.env.REDIRECT_TO) {
  const http = await import('node:http');
  const target = process.env.REDIRECT_TO.replace(/\/$/, '');
  const port = Number(process.env.PORT || 8080);
  http.createServer((req, res) => {
    if (req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
    res.writeHead(302, { Location: target + req.url, 'Cache-Control': 'no-store' });
    res.end();
  }).listen(port, process.env.HOST || '0.0.0.0', () => console.log(`Redirigiendo todo a ${target}`));
} else {
const cfg = buildConfig();

const app = await createApp(cfg).catch((e) => { console.error(`\n✖ No se pudo iniciar: ${e.message}\n`); process.exit(1); });
app.server.listen(cfg.port, cfg.host, () => {
  console.log(`\n  ${cfg.appName}`);
  console.log(`  Panel:        http://localhost:${cfg.port}/admin/`);
  console.log(`  Alto del Espino: http://localhost:${cfg.port}/player/alto-del-espino`);
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
}
