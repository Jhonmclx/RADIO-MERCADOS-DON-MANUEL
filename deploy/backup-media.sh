#!/usr/bin/env bash
# Copia de seguridad COMPLETA (base de datos + comerciales + música) hacia otro equipo o disco.
# Ejemplo: ./backup-media.sh usuario@equipo-respaldo:/respaldos/radio
set -euo pipefail
DEST="${1:?Indique el destino de rsync, p. ej. usuario@host:/respaldos/radio}"
cd "$(dirname "$0")"
docker compose exec -T radio node --disable-warning=ExperimentalWarning src/cli/backup.js
VOL=$(docker volume inspect -f '{{ .Mountpoint }}' deploy_radio-data)
rsync -a --delete --exclude live/ --exclude render/ --exclude tmp/ "$VOL/" "$DEST/"
echo "Respaldo copiado a $DEST"
