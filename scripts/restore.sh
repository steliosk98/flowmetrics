#!/usr/bin/env sh
set -eu
if [ "$#" -ne 1 ]; then echo "Usage: scripts/restore.sh BACKUP.dump" >&2; exit 2; fi
if [ "${FLOWMETRICS_CONFIRM_RESTORE:-}" != "YES_REPLACE_DATABASE" ]; then echo "Restore replaces FlowMetrics data. Set FLOWMETRICS_CONFIRM_RESTORE=YES_REPLACE_DATABASE to continue." >&2; exit 3; fi
docker compose stop flowmetrics
docker compose exec -T postgres pg_restore -U "${POSTGRES_USER:-flowmetrics}" -d "${POSTGRES_DB:-flowmetrics}" --clean --if-exists < "$1"
docker compose start flowmetrics
