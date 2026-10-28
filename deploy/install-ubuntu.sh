#!/usr/bin/env bash
# Instalación en un servidor Ubuntu 22.04/24.04 recién creado (ejecutar como root).
# Requisitos previos: el dominio ya apunta (registro A) a la IP pública del servidor.
set -euo pipefail
DOMAIN="${1:?Uso: install-ubuntu.sh radio.su-dominio.com}"
REPO_DIR="${REPO_DIR:-/opt/radio-mercado-don-manuel}"

apt-get update
apt-get install -y ca-certificates curl ufw
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi

ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable

if [ ! -f "$REPO_DIR/package.json" ]; then
  echo "Copie primero el proyecto en $REPO_DIR (git clone o scp) y vuelva a ejecutar." >&2; exit 1
fi
cd "$REPO_DIR"
if [ ! -f .env ]; then
  cp .env.example .env
  PASS="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16)7a"
  sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=${PASS}|; s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=https://${DOMAIN}|; s|^DATA_DIR=.*|DATA_DIR=/data|; s|^BACKUP_DIR=.*|BACKUP_DIR=/data/backups|" .env
  echo "Contraseña inicial del administrador: ${PASS}  (guárdela y cámbiela desde el panel)"
fi
cd deploy
DOMAIN="$DOMAIN" docker compose up -d --build
echo "DOMAIN=${DOMAIN}" > .env
# Copia de seguridad diaria de la base de datos a las 3:15 a. m.
( crontab -l 2>/dev/null | grep -v radio-backup; echo "15 3 * * * cd $REPO_DIR/deploy && docker compose exec -T radio node --disable-warning=ExperimentalWarning src/cli/backup.js >> /var/log/radio-backup.log 2>&1 # radio-backup" ) | crontab -
echo "Listo. Panel: https://${DOMAIN}/admin/   Sedes: https://${DOMAIN}/player/sede-1 ... sede-5"
