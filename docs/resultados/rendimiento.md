# Medición de rendimiento con archivos de tamaño real

Equipo de desarrollo: Linux, 2 vCPU, FFmpeg 6.1, configuración por defecto (720p30, 1 800 kbps, segmentos de 4 s, modo `copy`).

| Operación | Tiempo medido |
|---|---|
| Validar y normalizar un comercial de 6 min (1080p → 720p) | 91,5 s |
| Generar su copia liviana de respaldo (480p) | 55,3 s |
| Normalizar una canción de 4 min | 8,7 s |
| Preparar una canción de 4 min con el video del comercial en ciclo (modo copy) | 0,4 s (61 segmentos, máx. 4,0 s) |
| Preparar un bloque comercial de 6 min | 0,6 s |
| Bitrate real del comercial normalizado | ≈ 1 940 kbps |

Conclusión: la carga de CPU durante la emisión es mínima; el trabajo pesado ocurre solo al subir comerciales
(≈ 2,5 min de CPU por cada 6 min de video), de uno en uno y sin afectar la señal.
