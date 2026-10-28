# RADIO MERCADO DON MANUEL

Plataforma de radio propia y publicidad audiovisual para las cinco sedes del mercado.
Un servidor en la nube genera **una sola señal en vivo** (música + video comercial en ciclo silencioso + bloques comerciales con su audio) y los televisores de las sedes la reproducen abriendo un enlace web. El administrador lo controla todo desde un panel privado en su computador con Windows; apagar ese computador no detiene la radio.

## Qué incluye

* **Motor central** en el servidor: regla «N canciones → bloque comercial» (configurable, inicia en 2), comercial desde el primer segundo con audio completo, video del comercial en ciclo y sin audio durante la música, cambios en caliente sin cortar lo que suena, horarios (America/Bogota), cambios programados, recuperación tras reinicio.
* **Señal HLS única** con hora oficial por segmento → sincronización **medida** entre sedes.
* **Panel administrativo** (español): inicio, emisión y controles, sedes, comerciales (subida validada, orden por arrastre, frecuencia, vigencia, reemplazo, historial), anunciantes, música, programación con calendario, reportes con CSV, registros y auditoría.
* **Reproductor para televisores** (`/player/sede-1` … `sede-5`): pantalla completa, reconexión automática, activación de sonido con OK, telemetría segmento a segmento, respaldo local cuando el navegador lo permite.
* **Diagnóstico de televisores** (`/diagnostico`).
* **Reportes verificables**: una fila por emisión central, confirmación por sede con telemetría real, respaldo reportado aparte, nada inventado.
* **Seguridad**: scrypt, sesiones del lado del servidor, CSRF, verificación de origen, límites de frecuencia, CSP, auditoría.
* **Pruebas automatizadas** (unitarias, integración con FFmpeg real, navegador real) y **despliegue** (Docker + Caddy con HTTPS automático, copias de seguridad).

## Inicio rápido (Linux / macOS)

Requisitos: Node.js 22.13+ y FFmpeg. No hay dependencias npm que instalar.
```bash
cp .env.example .env      # escriba ADMIN_PASSWORD; para pruebas locales: DATA_DIR=./data, TRUST_PROXY=false, COOKIE_SECURE=false
npm start
```
Windows: doble clic en `scripts\iniciar-windows.bat` (ver `docs/DESPLIEGUE.md` §9).

* Panel: http://localhost:8080/admin/
* Sedes: http://localhost:8080/player/sede-1 … sede-5
* Diagnóstico: http://localhost:8080/diagnostico

## Estructura

```
src/
  server.js, app.js, config.js     arranque, ensamblaje y configuración
  engine/                          MOTOR CENTRAL: scheduler (planificador puro), renderer (FFmpeg),
                                   publisher (lista HLS en vivo), engine (orquestación y recuperación)
  media/                           validación, normalización, huellas e integridad de archivos
  http/                            servidor HTTP, seguridad, API privada (admin-routes) y pública (public-routes)
  reports/                         reportes y exportación CSV
  db/                              SQLite + migraciones (migrations/*.sql) + datos iniciales (5 sedes)
  lib/time.js                      horas de Colombia ↔ UTC
  cli/                             crear administrador, migrar, copia de seguridad
public/
  admin/                           panel privado
  player/                          reproductor de las sedes + service worker
  diagnostico/                     prueba de compatibilidad del televisor
  vendor/hls.min.js                hls.js 1.5.20 (Apache-2.0)
tests/                             unit/, integration/, e2e/, helpers.js
deploy/                            Dockerfile, docker-compose.yml, Caddyfile, instalación Ubuntu, respaldos, systemd
docs/                              arquitectura, manual, despliegue, televisores, pruebas, costos
```

## Documentación
* [Arquitectura y decisiones técnicas](docs/ARQUITECTURA.md)
* [Manual del administrador](docs/MANUAL-ADMINISTRADOR.md)
* [Despliegue en la nube, copias y restauración](docs/DESPLIEGUE.md)
* [Televisores: instalación, diagnóstico y limitaciones](docs/TELEVISORES.md)
* [Pruebas y resultados](docs/PRUEBAS.md)
* [Costos y ancho de banda](docs/COSTOS.md)
* [Cómo tenerla gratis y probarla en el celular](docs/GRATIS.md)

## Estado

Software completo y probado en un entorno Linux de desarrollo. **No está desplegado** en Internet ni probado en los televisores de las sedes. Pasos pendientes en `docs/DESPLIEGUE.md` y `docs/TELEVISORES.md`.
