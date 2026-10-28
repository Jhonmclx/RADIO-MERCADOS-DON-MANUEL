# Despliegue — RADIO MERCADO DON MANUEL

> Estado: **no está desplegado en Internet**. Los archivos están listos; los pasos marcados con 👤 requieren una acción del administrador (contratar servidor, dominio, credenciales).

## 1. Requisitos

| Recurso | Mínimo recomendado | Motivo |
|---|---|---|
| Servidor (VPS Linux, Ubuntu 24.04) | 2 vCPU, 4 GB RAM, 40–80 GB SSD | El modo `copy` casi no usa CPU; la CPU se usa al validar/convertir comerciales subidos. |
| Transferencia mensual | ≥ 3 TB incluidos | 5 TV × ~2 Mbps; ver `docs/COSTOS.md`. |
| Dominio 👤 | p. ej. `radio.mercadosdonmanuel.com` | Necesario para HTTPS (y HTTPS es necesario para el respaldo local en los TV). |
| Correo para Let's Encrypt | opcional | Avisos de certificados. |

No se recomiendan Netlify ni servicios «serverless»: el motor necesita un proceso que corra 24/7 con FFmpeg y disco persistente. Render/Railway sirven solo con disco persistente y plan sin suspensión (más caro por transferencia).

## 2. Pasos en el servidor (Docker + HTTPS automático)

1. 👤 Contrate el VPS (Ubuntu 24.04) y anote su IP pública.
2. 👤 En el proveedor del dominio cree un registro **A**: `radio` → IP del servidor. Espere a que propague (minutos a horas).
3. Copie el proyecto al servidor (por ejemplo `git clone` de su repositorio privado, o `scp -r`) en `/opt/radio-mercado-don-manuel`.
4. Ejecute como root:
   ```bash
   cd /opt/radio-mercado-don-manuel
   bash deploy/install-ubuntu.sh radio.su-dominio.com
   ```
   El script instala Docker, abre los puertos 80/443, crea `.env` con una contraseña inicial aleatoria (la muestra en pantalla), construye la imagen, inicia la radio con Caddy (HTTPS automático) y programa la copia diaria de la base de datos.
5. Abra `https://radio.su-dominio.com/admin/`, entre con `admin` y la contraseña mostrada, y **cámbiela** en «Cuenta».
6. En el panel: Programación → ajuste el horario; Música → suba los MP3; Comerciales → suba los videos.
7. En cada televisor abra `https://radio.su-dominio.com/player/sede-N` (ver `docs/TELEVISORES.md`).

### Sin Docker (alternativa)
Instale Node.js 22+, FFmpeg y `fonts-dejavu-core`; copie el proyecto a `/opt/radio-mercado-don-manuel`, cree el usuario `radio`, configure `.env`, instale `deploy/radio.service` en systemd y ponga Caddy (o Nginx + Certbot) como proxy HTTPS hacia el puerto 8080.

## 3. Variables de entorno
Todas están documentadas en `.env.example`. Las imprescindibles en producción: `PUBLIC_BASE_URL`, `ADMIN_USER`, `ADMIN_PASSWORD` (solo para el primer arranque), `TRUST_PROXY=true`, `COOKIE_SECURE=true`.

## 4. Rutas

| Ruta | Acceso |
|---|---|
| `/admin/` | Panel privado (usuario y contraseña) |
| `/player/sede-1` … `/player/sede-5` | Públicas, solo reproducción |
| `/diagnostico` | Pública, prueba de compatibilidad del TV |
| `/live/index.m3u8` | Señal HLS común |
| `/healthz` | Estado para monitoreo (200 = la lista se actualiza; 503 = problema) |

## 5. Arranque automático, supervisión y registros
* Docker reinicia el contenedor si el proceso termina (`restart: unless-stopped`) y su `HEALTHCHECK` consulta `/healthz`.
* Registros: `cd deploy && docker compose logs -f radio`. El panel también muestra «Registros → Motor y errores».
* Monitoreo externo recomendado 👤: un servicio gratuito de «uptime» que consulte `https://SU-DOMINIO/healthz` cada minuto y avise por correo/WhatsApp.

## 6. Actualizar a una nueva versión
```bash
cd /opt/radio-mercado-don-manuel && git pull
cd deploy && docker compose up -d --build
```
El motor guarda su estado después de cada segmento: al reiniciar reanuda en el punto correspondiente (habrá unos segundos de corte en las sedes, que se reconectan solas). Hágalo fuera del horario de emisión.

## 7. Copias de seguridad y restauración
* **Base de datos**: copia diaria automática (`/data/backups/radio-AAAA-MM-DD….sqlite`, se conservan 30). Manual: `docker compose exec radio npm run backup`.
* **Todo (base + comerciales + música)** hacia otro equipo: `deploy/backup-media.sh usuario@equipo:/respaldos/radio` (semanal recomendado 👤).
* **Restaurar**:
  ```bash
  cd /opt/radio-mercado-don-manuel/deploy
  docker compose stop radio
  VOL=$(docker volume inspect -f '{{ .Mountpoint }}' deploy_radio-data)
  cp "$VOL/backups/radio-XXXX.sqlite" "$VOL/db/radio.sqlite"; rm -f "$VOL/db/radio.sqlite-wal" "$VOL/db/radio.sqlite-shm"
  docker compose start radio
  ```
  Si se perdió el disco completo: cree el servidor de nuevo (sección 2) y copie la carpeta respaldada con `rsync` al volumen antes de iniciar.

## 8. Recuperación ante errores
| Síntoma | Acción |
|---|---|
| `/healthz` responde 503 | `docker compose logs --tail 200 radio`; `docker compose restart radio`. |
| Disco lleno | Revise `docker system df`; borre comerciales rechazados desde el panel; amplíe el disco. |
| Certificado HTTPS vencido | Caddy lo renueva solo; verifique que el dominio siga apuntando a la IP y que el puerto 80 esté abierto. |
| Contraseña olvidada | `docker compose exec radio node --disable-warning=ExperimentalWarning src/cli/create-admin.js admin` |

## 9. Ejecutar en el computador Windows (pruebas locales)
Solo para probar; en producción la radio corre en el servidor.
1. Instale **Node.js 22 LTS o superior** desde nodejs.org.
2. Instale **FFmpeg**: en PowerShell `winget install Gyan.FFmpeg` (cierre y abra de nuevo la terminal).
3. Abra la carpeta del proyecto y haga doble clic en `scripts\iniciar-windows.bat` (crea `.env` la primera vez: edite `ADMIN_PASSWORD` y vuelva a ejecutarlo).
4. Panel: `http://localhost:8080/admin/` — Sede 1: `http://localhost:8080/player/sede-1`.
5. Para que un televisor de la misma red lo vea: `http://IP-DEL-PC:8080/player/sede-1` (permita Node.js en el firewall de Windows). Sin HTTPS no habrá respaldo local en el TV.

> No verificado en Windows dentro de este entorno de desarrollo (Linux). El código no usa nada específico de Linux salvo los scripts de `deploy/`.
