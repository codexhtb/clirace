#!/usr/bin/env bash
set -Eeuo pipefail

ARCHIVE=/tmp/clirace-deploy.tar.gz
PROJECT_DIR=/opt/clirace
COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.sandbox.yml)

if [[ ${EUID} -ne 0 ]]; then
  echo "This deployment runner must be started through sudo." >&2
  exit 1
fi

if [[ ! -f "$ARCHIVE" ]]; then
  echo "Deployment archive is missing: $ARCHIVE" >&2
  exit 1
fi

while IFS= read -r member; do
  clean=${member#./}
  if [[ "$clean" == /* || "$clean" == ".." || "$clean" == ../* || "$clean" == */../* ]]; then
    echo "Unsafe path in deployment archive: $member" >&2
    exit 1
  fi
  if [[ "$clean" == ".env" || "$clean" == ".env.production" ]]; then
    echo "The deployment archive must not overwrite server environment files." >&2
    exit 1
  fi
done < <(tar -tzf "$ARCHIVE")

mkdir -p "$PROJECT_DIR"
tar -xzf "$ARCHIVE" --no-same-owner --no-same-permissions -C "$PROJECT_DIR"

if [[ ! -f "$PROJECT_DIR/.env" ]]; then
  echo "Server environment file is missing: $PROJECT_DIR/.env" >&2
  exit 1
fi

cd "$PROJECT_DIR"
bash scripts/deploy-local-shell.sh

for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error http://127.0.0.1:8080/api/health >/dev/null; then
    echo "CLIRace deployment completed successfully."
    docker compose "${COMPOSE_FILES[@]}" ps
    exit 0
  fi
  sleep 2
done

echo "CLIRace health check failed after deployment." >&2
docker compose "${COMPOSE_FILES[@]}" logs --tail=120 api web gateway >&2
exit 1
