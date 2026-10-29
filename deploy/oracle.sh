#!/usr/bin/env bash
# RADIO MERCADO DON MANUEL — instalación en un servidor Ubuntu 22.04/24.04 (Oracle Cloud, Azure for Students u otro; ARM o x86).
# Uso (desde la terminal SSH del servidor):
#   curl -fsSL https://raw.githubusercontent.com/Jhonmclx/RADIO-MERCADOS-DON-MANUEL/main/deploy/oracle.sh -o oracle.sh
#   sudo bash oracle.sh "<SUPABASE_URL>" "<SUPABASE_KEY>" "<CONTRASEÑA_ADMIN>"
# Usa el mismo almacenamiento de Supabase que la versión de prueba: la música y los comerciales ya subidos aparecen solos.
# HTTPS gratis sin comprar dominio: <ip-con-guiones>.sslip.io (Caddy obtiene el certificado automáticamente).
set -euo pipefail
SUPA_URL="${1:?Falta SUPABASE_URL}"
SUPA_KEY="${2:?Falta la clave de Supabase}"
ADMIN_PASS="${3:?Falta la contraseña del administrador (10+ caracteres, letras y números)}"
DIR=/opt/radio-mercado-don-manuel
REPO=https://github.com/Jhonmclx/RADIO-MERCADOS-DON-MANUEL.git

echo "==> Preparando el servidor…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git iptables-persistent >/dev/null || apt-get install -y ca-certificates curl git
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi

# Servidores pequeños (1 GB de RAM, p. ej. Azure B1s/B2ats): se agrega memoria de intercambio para que FFmpeg no se quede sin memoria.
if [ "$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)" -lt 3000 ] && ! swapon --show | grep -q /swapfile; then
  echo "==> Agregando 2 GB de memoria de intercambio…"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Abriendo los puertos 80 y 443 en el firewall interno de Oracle…"
for p in 80 443; do
  iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport $p -j ACCEPT
done
command -v netfilter-persistent >/dev/null && netfilter-persistent save || true

IP=$(curl -fsS https://api.ipify.org || curl -fsS https://ifconfig.me)
DOMAIN="${IP//./-}.sslip.io"
echo "==> IP pública: $IP  →  dirección: https://$DOMAIN"

if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone --depth 1 "$REPO" "$DIR"; fi
cd "$DIR"
cat > .env <<EOF
NODE_ENV=production
PORT=8080
HOST=0.0.0.0
PUBLIC_BASE_URL=https://$DOMAIN
TRUST_PROXY=true
COOKIE_SECURE=true
TIMEZONE=America/Bogota
DATA_DIR=/data
BACKUP_DIR=/data/backups
ADMIN_USER=admin
ADMIN_PASSWORD=$ADMIN_PASS
SUPABASE_URL=$SUPA_URL
SUPABASE_SERVICE_KEY=$SUPA_KEY
SUPABASE_BUCKET=radio-mercado
VIDEO_WIDTH=1280
VIDEO_HEIGHT=720
VIDEO_BITRATE_KBPS=1500
X264_PRESET=veryfast
BACKUP_VIDEO_HEIGHT=240
SYNC_TARGET_DELAY_MS=18000
EOF
chmod 600 .env
cd deploy
echo "DOMAIN=$DOMAIN" > .env
echo "==> Construyendo e iniciando la radio (la primera vez tarda unos minutos)…"
docker compose up -d --build
( crontab -l 2>/dev/null | grep -v radio-backup; echo "15 3 * * * cd $DIR/deploy && docker compose exec -T radio node --disable-warning=ExperimentalWarning src/cli/backup.js >/dev/null 2>&1 # radio-backup" ) | crontab -
echo
echo "================================================================"
echo " RADIO MERCADO DON MANUEL instalada"
echo " Panel:  https://$DOMAIN/admin/"
echo " Sedes:  https://$DOMAIN/player/alto-del-espino"
echo "         https://$DOMAIN/player/gourmet"
echo "         https://$DOMAIN/player/parque-narino"
echo "         https://$DOMAIN/player/terminal"
echo "         https://$DOMAIN/player/sachica"
echo " (El certificado HTTPS puede tardar 1–2 minutos la primera vez.)"
echo "================================================================"
