#!/usr/bin/env sh
set -eu
output="${1:-flowmetrics-backup-$(date +%Y%m%d-%H%M%S).dump}"
docker compose exec -T postgres pg_dump -U "${POSTGRES_USER:-flowmetrics}" -d "${POSTGRES_DB:-flowmetrics}" -Fc > "$output"
printf 'Backup written to %s\n' "$output"
