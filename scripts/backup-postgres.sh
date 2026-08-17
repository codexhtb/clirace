#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE=${CLIRACE_ENV_FILE:-$PROJECT_DIR/.env.production}
BACKUP_DIR=${CLIRACE_BACKUP_DIR:-$PROJECT_DIR/backups}

[[ -f "$ENV_FILE" ]] || { echo "Environment file not found: $ENV_FILE" >&2; exit 1; }
env_value() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | tr -d '\r'; }
POSTGRES_DB=$(env_value POSTGRES_DB)
POSTGRES_USER=$(env_value POSTGRES_USER)
[[ -n "$POSTGRES_DB" ]] || { echo 'POSTGRES_DB is required.' >&2; exit 1; }
[[ -n "$POSTGRES_USER" ]] || { echo 'POSTGRES_USER is required.' >&2; exit 1; }

install -d -m 0700 "$BACKUP_DIR"
timestamp=$(date -u +'%Y-%m-%d_%H%M%S')
target="$BACKUP_DIR/clirace-${timestamp}.dump"
temporary="${target}.partial"
trap 'rm -f "$temporary"' EXIT

cd "$PROJECT_DIR"
docker compose --env-file "$ENV_FILE" \
  -f docker-compose.yml \
  exec -T -u postgres postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl > "$temporary"

[[ -s "$temporary" ]] || { echo 'PostgreSQL dump is empty.' >&2; exit 1; }
mv "$temporary" "$target"
chmod 0600 "$target"
trap - EXIT
echo "Backup created: $target"
echo 'Copy this dump to another host, NAS, or object storage.'
