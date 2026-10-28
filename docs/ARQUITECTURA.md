# Arquitectura — RADIO MERCADO DON MANUEL

## 1. Vista general

```
                 ┌──────────────────────── SERVIDOR EN LA NUBE (uno solo) ────────────────────────┐
 Computador      │                                                                                 │
 Windows   ──────┼─► Panel privado (/admin)  ──►  API privada (/api/admin/*, sesión + CSRF)        │
 (navegador)     │                                     │                                           │
                 │                                     ▼                                           │
                 │   Biblioteca multimedia ◄── validación FFprobe/FFmpeg, SHA-256, normalización    │
                 │   (disco: DATA_DIR/media)           │                                           │
                 │                                     ▼                                           │
                 │   MOTOR CENTRAL ── planificador puro ──► renderizador (FFmpeg) ──► publicador   │
                 │   (estado en SQLite)                                                 │          │
                 │                                                                      ▼          │
                 │                                  UNA lista HLS en vivo: /live/index.m3u8        │
                 │                                  (segmentos .ts con hora oficial por segmento)  │
                 └───────────────────────────────────────────────┬─────────────────────────────────┘
                                                                 │ HTTPS
              ┌──────────────┬──────────────┬────────────────────┼──────────────┐
              ▼              ▼              ▼                    ▼              ▼
          TV Sede 1      TV Sede 2      TV Sede 3            TV Sede 4      TV Sede 5
       /player/sede-1  /player/sede-2  …  (reproductor web: hls.js o HLS nativo, telemetría, respaldo)
```

* El computador del administrador es **solo un cliente**. Apagarlo no afecta la emisión (prueba automatizada n.º 16).
* La señal la genera **el servidor**. Todas las sedes leen **la misma lista HLS**: no existen cinco programaciones.

## 2. Pila tecnológica y motivos

| Componente | Elección | Motivo |
|---|---|---|
| Servidor | Node.js 22 sin dependencias npm | Un solo proceso fácil de operar. Sin `npm install`: nada que se rompa por paquetes de terceros. |
| Base de datos | SQLite integrado (`node:sqlite`, modo WAL) | Un único servidor: no hace falta un servicio de base de datos aparte. Respaldo con `VACUUM INTO`. Las tablas están escritas en SQL estándar; migrar a PostgreSQL es posible si se agrega redundancia. |
| Multimedia | FFmpeg / FFprobe | Estándar de la industria para validar, normalizar y segmentar. |
| Protocolo | HLS con segmentos MPEG-TS (H.264 main + AAC 48 kHz) | Es el formato con mayor compatibilidad en navegadores de Smart TV (Tizen, webOS y Android TV lo reproducen de forma nativa o con MSE). Funciona sobre HTTPS normal, atraviesa cualquier red y se sirve con muy poca CPU. |
| Reproductor | hls.js 1.5.20 (incluido en `public/vendor`) + HLS nativo como alternativa | hls.js permite leer la hora oficial de cada segmento y medir el desfase; en TV sin MSE se usa el reproductor nativo. |
| Panel | HTML + JavaScript moderno sin compilación | Se sirve tal cual; no requiere herramientas de construcción. |
| HTTPS | Caddy (certificados automáticos de Let's Encrypt) | Configuración mínima, renovación automática. |

**¿Por qué no WebRTC?** Daría menos latencia (≈0,5 s), pero exige un servidor de medios (SFU/TURN), más CPU, más costo y su soporte en navegadores de TV es irregular. Para una radio con publicidad, unos segundos de retraso común no importan; lo que importa es que **todas las sedes tengan el mismo retraso**, y eso se resuelve con la hora oficial de HLS.

**¿Por qué no Icecast/Liquidsoap?** Resuelven el audio, pero aquí la señal es audio **y video** sincronizados, con reglas de negocio (ciclo silencioso, comercial desde el primer segundo, reportes por emisión). Un motor propio sobre FFmpeg mantiene todo en un solo lugar y medible.

## 3. Motor central

Archivos: `src/engine/scheduler.js`, `renderer.js`, `publisher.js`, `engine.js`.

1. **Planificador puro** (`decideNext`): recibe el estado (canciones desde el último comercial, rotación, último comercial emitido, posición del ciclo silencioso) y la configuración vigente; devuelve el siguiente elemento: canción, comercial o cortinilla. No tiene efectos secundarios → se prueba exhaustivamente y se puede **re-planificar** restaurando el estado anterior.
2. **Renderizador**: prepara el elemento **antes** de salir al aire como segmentos HLS de `HLS_SEGMENT_SECONDS`:
   * **Canción** = audio de la canción + video del comercial en ciclo (`-stream_loop`) **sin su pista de audio** (no se mapea). Modo `copy` (por defecto): el video ya normalizado se copia sin recodificar → consumo de CPU muy bajo. El ciclo continúa donde quedó (ajustado al fotograma clave anterior).
   * **Comercial** = el archivo normalizado completo desde el segundo 0, con su audio. Se copia sin recodificar.
   * **Cortinilla** (espera, pausa, fuera de horario, sin contenido) = imagen institucional + silencio, generada una vez.
3. **Publicador**: libera cada segmento en la lista en vivo **cuando llega su hora** según el reloj del servidor y escribe `EXT-X-PROGRAM-DATE-TIME` (hora oficial UTC de salida al aire). Entre elementos se marca `EXT-X-DISCONTINUITY`.
4. **Estado persistente**: después de cada segmento se guarda en la base de datos el número de secuencia, la ventana publicada, el estado del planificador y el progreso del elemento al aire.

### Reglas de transición segura
* El elemento **al aire nunca se corta** por un cambio de configuración (salvo «desactivar inmediatamente» o «detener la señal», que son explícitos y quedan registrados como interrupción).
* Un cambio (nuevo comercial, desactivación, regla de canciones, pausa, horario) hace que el **siguiente** elemento se vuelva a decidir si hay tiempo de prepararlo; si ya está listo y no da tiempo, se aplica en el elemento posterior. El registro del motor lo informa.
* Rotación de comerciales: algoritmo **ponderado suave** determinista (el mismo de nginx). Con pesos 3:1 produce `A A B A A A B A`: respeta la frecuencia sin que uno monopolice. La prioridad nunca salta una desactivación, una vigencia vencida, un anunciante inactivo ni una verificación de integridad fallida (SHA-256 antes de cada emisión).

### Recuperación tras reinicio (`Engine.recover`)
* Si el elemento al aire tiene sus segmentos en disco, se reanuda **en el punto que corresponde a la hora actual** (como una emisora real tras un corte). Los segmentos que no salieron durante la caída se registran: el elemento queda «interrumpido» con el motivo y la duración realmente emitida.
* La numeración de segmentos continúa (nunca vuelve a 0) y se marca discontinuidad.
* Los elementos preparados pero no emitidos se descartan y el planificador vuelve a su estado previo (no se pierden ni se duplican canciones o turnos de comercial).
* Pruebas: `tests/integration/restart.test.js` (caída abrupta con SIGKILL, corta y larga).

## 4. Sincronización entre sedes

* **Referencia común**: cada segmento lleva su hora oficial de emisión (`PROGRAM-DATE-TIME`, generada por el reloj del servidor).
* **Reloj del televisor**: el reproductor estima su diferencia con el servidor (5 muestras tipo NTP, se repite cada 10 min).
* **Retraso objetivo común** (`SYNC_TARGET_DELAY_MS`, 18 s por defecto con segmentos de 4 s): cada reproductor mide `hora_servidor − hora_oficial_del_cuadro_en_pantalla` y corrige:
  * desvío > 1 s confirmado por dos mediciones seguidas → salto directo (y en el arranque, alineación precisa);
  * desvío entre 0,1 y 1 s → ajuste de velocidad de hasta ±5 % (el navegador conserva el tono);
  * cada televisor informa su retraso y desvío al servidor cada 5 s; el panel muestra la **dispersión medida entre sedes**.
* **Precisión real medida** (pruebas preliminares en Chromium, mismo equipo, ver `docs/resultados/sincronizacion-e2e.json`): dispersión entre cinco reproductores de **≈20 a 270 ms** según la ejecución, desvío respecto al objetivo ≤ ≈290 ms. En televisores reales y redes de las sedes **no está medido**: dependerá del navegador (si permite `playbackRate`, si expone la hora del cuadro). Con HLS nativo sin `getStartDate()` el desfase **no se puede medir** y el panel lo indica como «no medido».
* No se promete sincronización perfecta: HLS es un protocolo por segmentos; el objetivo realista es que todas las sedes suenen dentro de unos cientos de milisegundos entre sí.

## 5. Reportes y prueba de emisión

* `ad_plays`: **una fila por emisión central** (no se multiplica por cinco). Estados: programado → emitiendo → completado / interrumpido; también fallido, replanificado (descartado antes de salir) e incierto.
* `site_ad_confirmations`: por cada sede, cuántos segmentos del comercial **informó haber reproducido** su televisor (telemetría de hls.js segmento a segmento). «Confirmada» = ≥ 90 % de los segmentos. Si la sede estaba conectada pero su reproductor no informa segmentos (p. ej. HLS nativo), aparece como «conectada, sin telemetría».
* `backup_ad_plays`: reproducciones hechas con el **respaldo local** sin señal central, informadas al reconectarse; se muestran aparte.
* Los eventos del televisor llevan un identificador generado en el televisor → reintentar el envío **no duplica** (prueba n.º 22).
* Ningún reporte afirma que una persona vio el anuncio.

## 6. Seguridad

* Panel y API privada: contraseñas con **scrypt**, sesiones en servidor (cookie HttpOnly, SameSite=Strict, Secure en producción), token **CSRF** para todo cambio, verificación de **origen**, bloqueo tras intentos fallidos, límite de frecuencia de inicio de sesión, registro de auditoría.
* Rutas públicas (`/player/*`, `/live/*`, `/api/public/*`, `/diagnostico`): solo lectura de la señal y envío de telemetría validada; límites por IP; no exponen anunciantes ni configuración. El respaldo solo sirve comerciales activos y canciones marcadas como «Respaldo».
* Archivos: extensión permitida + análisis con FFprobe + normalización; se guardan con nombres generados por el servidor; nunca se ejecutan. FFmpeg se invoca sin shell. Rutas protegidas contra recorrido de directorios.
* Cabeceras: CSP estricta (`script-src 'self'`), `X-Frame-Options: DENY`, `nosniff`, HSTS (en Caddy).
* Secretos solo en `.env` (no versionado).

## 7. Datos

* Instantes en **milisegundos UTC**; las horas locales (America/Bogota) se convierten en el servidor con `Intl` (`src/lib/time.js`).
* Archivos pesados en disco (`DATA_DIR/media`), nunca dentro de la base de datos.

```
DATA_DIR/
  db/radio.sqlite        base de datos (WAL)
  media/ads/<id>/        original.*, normalized.mp4, backup.mp4, thumb.jpg
  media/music/<id>/      original.*, normalized.m4a
  render/                elementos preparados (temporales)
  live/                  index.m3u8 + segmentos publicados (ventana deslizante)
  slates/                cortinillas generadas
  backups/               copias de la base de datos
```

## 8. Alta disponibilidad (no implementada en esta versión)

Hay **un solo servidor**: si se cae, se interrumpe la señal central (las sedes con respaldo local compatible siguen sonando con el respaldo). Para crecer:
1. Base de datos en PostgreSQL gestionado y medios en almacenamiento de objetos.
2. Un segundo servidor en espera que tome el control (bloqueo de líder) y publique la misma lista.
3. CDN delante de `/live/` si aumenta el número de pantallas.

El diseño modular (planificador puro, renderizador y publicador separados, estado serializable) permite estos pasos sin reescribir la lógica de programación.
