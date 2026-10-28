# RADIO MERCADO DON MANUEL — imagen de producción
# Node.js 22 + FFmpeg + fuentes para las cortinillas. Sin dependencias npm: no hay "npm install".
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production TZ=America/Bogota DATA_DIR=/data PORT=8080 HOST=0.0.0.0
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY demo ./demo
# Parámetros de video: si el proveedor los entrega como argumentos de construcción (Render lo hace con las
# variables de entorno), las cortinillas se generan con la misma resolución que usará el servidor.
ARG VIDEO_WIDTH=1280
ARG VIDEO_HEIGHT=720
ARG VIDEO_FPS=30
ARG VIDEO_BITRATE_KBPS=1800
ARG AUDIO_BITRATE_KBPS=128
ARG HLS_SEGMENT_SECONDS=4
ENV VIDEO_WIDTH=$VIDEO_WIDTH VIDEO_HEIGHT=$VIDEO_HEIGHT VIDEO_FPS=$VIDEO_FPS VIDEO_BITRATE_KBPS=$VIDEO_BITRATE_KBPS \
    AUDIO_BITRATE_KBPS=$AUDIO_BITRATE_KBPS HLS_SEGMENT_SECONDS=$HLS_SEGMENT_SECONDS SLATE_DIR=/app/slates
RUN node --disable-warning=ExperimentalWarning src/cli/prepare-slates.js && mkdir -p /data && chown -R node:node /data /app/slates
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
