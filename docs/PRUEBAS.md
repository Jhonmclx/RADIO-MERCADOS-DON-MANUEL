# Pruebas automatizadas

```bash
npm test               # unitarias + integración (servidor real, FFmpeg real) — ~6 min
npm run test:unit      # solo unitarias (segundos)
npm run test:e2e       # navegador real (Chromium vía Playwright) — requiere Playwright
```
Las pruebas de integración y de navegador arrancan el servidor real como proceso aparte, con segmentos de 2 s y video de 320×180 para ir rápido. Los medios de prueba se generan con FFmpeg y tienen **firmas medibles**: los comerciales empiezan con 1 s de un color (rojo/amarillo) y siguen con otro, y llevan un tono propio (1 000 / 1 500 Hz); las canciones son tonos de 440 / 660 Hz. Así se verifica en los **segmentos publicados** qué se ve y qué suena.

## Escenarios exigidos → prueba que los cubre

| # | Escenario | Prueba | Tipo |
|---|---|---|---|
| 1 | Inicio de sesión correcto (y rechazo de clave errónea) | `broadcast` «1.» | Integración |
| 2 | Subida de comercial válido; disponible solo tras validarse | `broadcast` «2.» | Integración |
| 3 | Rechazo de archivo dañado / incompatible con motivo | `broadcast` «3.» | Integración |
| 4 | El comercial activo entra en la programación | `broadcast` «4.» | Integración |
| 5 | Dos canciones y luego el comercial | `broadcast` «5, 8 y 9», `scheduler` | Integración + unitaria |
| 6 | Video en silencio (ciclo) durante la música | `broadcast` «6.» — audio de los segmentos = tono de la canción; imagen = colores del comercial | Integración (análisis de segmentos) |
| 7 | Comercial desde el primer segundo, con su audio completo | `broadcast` «7.» — primer cuadro rojo, todos los segmentos con 1 000 Hz, duración emitida = esperada, hora oficial continua | Integración (análisis de segmentos) |
| 8 | Al terminar el comercial vuelve la música | `broadcast` «5, 8 y 9» | Integración |
| 9 | El ciclo sigue sin intervención | `broadcast` «5, 8 y 9» y toda la sesión de ~5 min | Integración |
| 10 | Desactivar un comercial mientras otro/él está al aire | `broadcast` «10 y 12» | Integración |
| 11 | Agregar comercial sin interrumpir el actual | `broadcast` «11.» | Integración |
| 12 | Se conserva el historial de desactivados | `broadcast` «10 y 12» | Integración |
| 13 | Los cambios llegan a las cinco sedes | `broadcast` «13.» (versión confirmada por 5 sedes simuladas) | Integración (sedes simuladas) |
| 14 | Una sede se desconecta y las demás siguen | `broadcast` «14 y 15», `e2e` «14 y 15 (navegador)» | Integración + navegador |
| 15 | La sede reconecta y recupera la señal central | `broadcast` «14 y 15», `e2e` «14 y 15 (navegador)» | Integración + navegador |
| 16 | Se apaga el computador del administrador y la emisión continúa | `broadcast` «16.» (cierre de sesión y 16 s sin peticiones del panel) | Integración |
| 17 | El motor se reinicia y recupera su estado | `restart` (SIGKILL a mitad de canción; caída larga) | Integración |
| 18 | Los reportes muestran solo eventos reales | `broadcast` «18.» (cruce reporte ↔ registro as-run, CSV, resumen) | Integración |
| 19 | Los enlaces públicos no dan acceso a la administración | `broadcast` «19 y 20» | Integración |
| 20 | Controles administrativos no disponibles para anónimos | `broadcast` «19 y 20» (401, CSRF 403, origen ajeno 403) | Integración |
| 21 | Se registra una reproducción interrumpida | `broadcast` «21.» | Integración |
| 22 | Reintentar el envío no duplica eventos | `broadcast` «22.» | Integración |
| — | Sincronización medida, unión tardía, autoplay bloqueado, respaldo local, pantalla de espera, diagnóstico | `e2e` | Navegador (preliminar) |

## Resultados (ejecución del 28 de octubre de 2026, entorno Linux de desarrollo)

Ver `docs/resultados/` para el detalle de la última ejecución.

* Unitarias: 20/20 correctas (suite completa `npm test`: 43/43).
* Integración `broadcast`: 21/21 correctas (≈ 5 min de emisión real).
* Integración `restart`: 2/2 correctas.
* Navegador (Chromium 153 sin interfaz, Playwright): 10/10 correctas.
  * Sincronización medida entre cinco reproductores: dispersión máxima entre 22 y 269 ms según la ejecución (5 ejecuciones); desvío respecto al objetivo ≤ ≈ 290 ms.
  * La prueba de autoplay **emula** un televisor que bloquea el sonido (Chromium sin interfaz no siempre aplica su política).

## Qué NO prueban estas pruebas
* **Televisores reales**: las pruebas de navegador son preliminares de escritorio. Falta la prueba por modelo descrita en `docs/TELEVISORES.md`.
* **Redes reales de las sedes** (latencia, pérdida de paquetes, Wi-Fi): el servidor y los navegadores corrieron en el mismo equipo.
* **Despliegue**: no se construyó la imagen Docker (el registro de imágenes no era accesible desde el entorno de desarrollo); `docker compose config` sí se validó.
* **Windows**: no se ejecutó en Windows.
* Carga prolongada (días seguidos) y archivos de comerciales reales de 5–8 minutos.

Rendimiento con archivos de tamaño real: `docs/resultados/rendimiento.md`. Capturas del panel y del reproductor: `docs/resultados/shot-*.png`.
