# Costos estimados y ancho de banda

> Precios **aproximados y sujetos a cambio**. No se ha contratado ningún servicio. Verifique el precio vigente antes de contratar.

## Ancho de banda de la señal

Calidad por defecto: 1280×720, 30 fps, video ≈ 1 800 kbps + audio 128 kbps + ~8 % de contenedor ≈ **2,1 Mbps por televisor** (los comerciales con mucha acción pueden subir hasta ~2,4 Mbps por momentos).

| Escenario | Horas/día | Consumo por TV y hora | Total mensual (5 TV, 30 días) |
|---|---|---|---|
| Horario por defecto (07:00–21:00) | 14 | ≈ 0,95 GB | **≈ 2,0 TB** |
| 15 horas | 15 | ≈ 0,95 GB | ≈ 2,1 TB |
| 24 horas | 24 | ≈ 0,95 GB | ≈ 3,4 TB |
| Calidad reducida (`VIDEO_BITRATE_KBPS=1200`), 15 h | 15 | ≈ 0,65 GB | ≈ 1,5 TB |

* **Subida del servidor necesaria**: 5 × 2,1 Mbps ≈ 11 Mbps continuos (trivial para un VPS).
* **Internet en cada sede**: ≈ 2,1 Mbps de bajada continuos y ≈ 14 GB/día por televisor. Confirme que el plan de Internet de cada sede no tenga límite de datos.
* Cada pantalla adicional suma ~0,4 TB/mes (15 h/día).

## Opciones de servidor (un solo servidor)

| Proveedor / plan | Recursos | Transferencia incluida | Precio aproximado | Observaciones |
|---|---|---|---|---|
| Hetzner Cloud CX23 (Alemania/Finlandia) | 2 vCPU, 4 GB, 40 GB SSD | 20 TB | ≈ 5,49 € + 0,50 € IPv4 al mes, sin IVA (según comparación de terceros, agosto de 2026) | La opción más económica. La distancia a Colombia no afecta a HLS (unos segundos de retraso común ya están previstos). |
| DigitalOcean Basic 2 vCPU / 4 GB | 2 vCPU, 4 GB, 80 GB SSD | 4 000 GiB | USD 24/mes | Centros de datos en Norteamérica (menor latencia). Exceso: USD 0,01 por GiB. |
| DigitalOcean Basic 2 vCPU / 2 GB | 2 vCPU, 2 GB, 60 GB SSD | 3 000 GiB | USD 18/mes | Suficiente si se suben pocos comerciales a la vez. |

Recomendación inicial: un VPS de **2 vCPU / 4 GB** con al menos **3 TB** incluidos.

## Otros costos

| Concepto | Costo aproximado |
|---|---|
| Dominio `.com` | ≈ USD 10–20 al año (un `.co` suele costar más; verifique con el registrador) |
| Certificado HTTPS | Gratis (Let's Encrypt vía Caddy) |
| Copias automáticas del proveedor | Opcional; normalmente un porcentaje del precio del servidor |
| Almacenamiento de medios | Incluido en el disco del VPS. Referencia: comercial de 8 min ≈ 110 MB procesado + 40 MB de respaldo + el original; 1 000 canciones ≈ 4–5 GB. Ampliable con un volumen adicional. |
| Monitoreo externo de `/healthz` | Hay planes gratuitos suficientes |
| Licencias de software | Ninguna (Node.js, FFmpeg, SQLite, Caddy y hls.js son de código abierto) |
| Derechos de difusión musical | No incluidos: consulte las obligaciones de comunicación pública de música en establecimientos comerciales en Colombia. |

## Resumen mensual aproximado (5 televisores, ~15 h/día)

| Escenario | Servidor | Dominio (prorrateado) | Total aproximado |
|---|---|---|---|
| Económico (Hetzner CX23) | ≈ 6 € | ≈ USD 1–2 | **≈ USD 8–10 / mes** |
| Norteamérica (DigitalOcean 2 vCPU / 4 GB) | USD 24 | ≈ USD 1–2 | **≈ USD 25–26 / mes** |

Fuentes consultadas: [DigitalOcean — precios de Droplets](https://www.digitalocean.com/pricing/droplets), [DigitalOcean — facturación de transferencia](https://docs.digitalocean.com/products/droplets/details/pricing/), [Comparación de precios de nube (terceros, 2026-08)](https://kimmo.suominen.com/stuff/cpc-2026-08.txt).
