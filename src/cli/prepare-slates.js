// Genera las cortinillas por adelantado (se usa al construir la imagen Docker para arrancar más rápido).
import { loadEnvFile, buildConfig } from '../config.js';
import { Renderer } from '../engine/renderer.js';
loadEnvFile();
const cfg = buildConfig();
const r = new Renderer({ cfg, library: null, log: (l, m) => console.log(l, m) });
await r.prepareSlates();
console.log(`Cortinillas listas en ${cfg.slateDir}`);
