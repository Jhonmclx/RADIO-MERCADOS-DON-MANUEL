# Cómo tener la radio gratis

Hay dos caminos gratuitos con propósitos distintos:

| | **A. Prueba en el celular (Render, plan Free)** | **B. Radio real 24/7 (Oracle Cloud, Always Free)** |
|---|---|---|
| Para qué sirve | Ver y oír el sistema, probar el panel, subir un comercial corto | Dejar la radio funcionando para las 5 sedes |
| Costo | 0 | 0 dentro de los límites gratuitos |
| ¿Se duerme? | Sí: tras 15 min sin visitas se apaga y tarda ~1 min en despertar | No |
| ¿Guarda los datos? | **No**: al dormir o reiniciar se borra todo (vuelve a cargar el contenido demo) | Sí (disco de hasta 200 GB) |
| Transferencia | Limitada (no alcanza para 5 TV todo el día) | Hasta 10 TB/mes (la radio usa ~2 TB) |
| Potencia | Muy baja: procesar un comercial de 6 min puede tardar mucho | 4 núcleos ARM y 24 GB de RAM |
| Tarjeta | No | Sí, solo para verificar identidad (cargo temporal que se devuelve) |

---

## A. Demo en Render (para probar desde el celular)

La versión demo arranca sola con 2 canciones sintetizadas (sin derechos de autor de terceros) y un comercial de 20 segundos, y con horario de 24 horas.

1. El código debe estar en un repositorio de GitHub (por ejemplo `Jhonmclx/radio-mercado-don-manuel`).
2. En Render: **New → Web Service** → elegir el repositorio → **Runtime: Docker**, **Dockerfile path:** `./deploy/Dockerfile`, **Plan: Free**, región **Ohio** o **Virginia** (las más cercanas a Colombia).
3. Variables de entorno:
   ```
   DEMO_SEED=true
   ADMIN_USER=admin
   ADMIN_PASSWORD=(una clave de 10+ caracteres con letras y números)
   VIDEO_WIDTH=854
   VIDEO_HEIGHT=480
   VIDEO_BITRATE_KBPS=900
   X264_PRESET=ultrafast
   BACKUP_VIDEO_HEIGHT=240
   TRUST_PROXY=true
   COOKIE_SECURE=true
   ```
   (También se puede usar el archivo `render.yaml` de la raíz del proyecto: **New → Blueprint**.)
4. Al terminar, Render da una dirección como `https://radio-mercado-don-manuel.onrender.com`.

## Probar desde el celular

* **Reproductor (como si fuera un televisor):** abra en el celular `https://SU-DIRECCION/player/sede-1` y toque la pantalla para activar el sonido.
  * Abra `sede-2` en otro celular o en el computador y compare: deben sonar casi al mismo tiempo.
* **Panel:** `https://SU-DIRECCION/admin/` (se adapta a la pantalla del celular). Desde ahí puede ver las sedes conectadas, cambiar «canciones entre comerciales», pausar, ver reportes y subir un video corto grabado con el celular (Comerciales → Subir).
* **Diagnóstico:** `https://SU-DIRECCION/diagnostico`.
* La primera vez que abra después de un rato, puede tardar 1–3 minutos en despertar y preparar la señal.

---

## B. Radio real gratis en Oracle Cloud (Always Free)

1. Cree la cuenta en Oracle Cloud (Free Tier). Pide tarjeta para verificar identidad; los recursos «Always Free» no se cobran.
   * Recomendación: elegir como región principal una con disponibilidad (p. ej. São Paulo o Ashburn). **La región no se puede cambiar después.**
2. Cree una instancia: **Ubuntu 24.04**, forma **VM.Standard.A1.Flex** (ARM) con 2–4 OCPU y 12–24 GB de RAM, 50–100 GB de disco, IP pública.
   * Si dice «Out of capacity», intente en otro momento u otro dominio de disponibilidad (es común).
   * Si la forma ARM no está disponible, la `VM.Standard.E2.1.Micro` (1 GB) también es gratis pero queda muy justa.
3. En la **Security List / Network Security Group** de la red, abra los puertos **80 y 443** (TCP de entrada).
4. Conéctese por SSH y siga `docs/DESPLIEGUE.md` §2 (`deploy/install-ubuntu.sh su-dominio`). La imagen Docker funciona en ARM (Node.js y FFmpeg tienen versiones ARM oficiales).
   * En Ubuntu de Oracle, además del firewall de la nube, el script abre los puertos con `ufw`.
5. Dominio:
   * **Gratis:** un subdominio de DuckDNS (`radiodonmanuel.duckdns.org`) apuntando a la IP de la instancia; Caddy le pone HTTPS gratis.
   * **Propio:** un `.com` cuesta ≈ USD 10–20 al año (único costo opcional).
6. Oracle puede recuperar instancias gratuitas que considere «inactivas» (uso muy bajo durante días). La radio genera tráfico constante, pero para evitar el riesgo se puede pasar la cuenta a «Pay As You Go»: lo «Always Free» sigue sin cobrarse y solo se pagaría lo que se use por encima de los límites.

Con esto el costo mensual es **USD 0** (o solo el dominio si quiere uno propio).

### Otras opciones gratis evaluadas (no recomendadas para la radio real)
* **Netlify / Vercel / Cloudflare Pages:** solo sitios estáticos o funciones cortas; no pueden mantener la señal 24/7 ni ejecutar FFmpeg.
* **Render Free:** se duerme y borra los datos (solo para la demo).
* **Google Cloud e2-micro gratis:** solo incluye 1 GB/mes de salida a América: no alcanza para video.
* **Un computador viejo en el almacén + Cloudflare Tunnel (gratis):** funciona, pero depende de la luz e Internet del almacén; es una alternativa si no se consigue Oracle.
