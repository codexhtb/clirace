#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$PROJECT_DIR"

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this script as root: sudo bash scripts/deploy-local-shell.sh" >&2
  exit 1
fi

for command_name in docker runuser curl stat; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command is missing: $command_name" >&2
    exit 1
  fi
done

if ! id clirace-sandbox >/dev/null 2>&1; then
  echo "The clirace-sandbox user does not exist." >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  cp .env.server.example .env
  chmod 0600 .env
  echo "Created $PROJECT_DIR/.env"
  echo "Replace both placeholder passwords, then run this script again." >&2
  exit 2
fi

if grep -q 'replace-with-' .env; then
  echo "Refusing to deploy with placeholder passwords in .env." >&2
  exit 1
fi

SANDBOX_UID=$(id -u clirace-sandbox)
SANDBOX_HOME=$(getent passwd clirace-sandbox | cut -d: -f6)
SANDBOX_SOCKET="/run/user/${SANDBOX_UID}/docker.sock"
SANDBOX_IMAGE_NAME=$(sed -n 's/^SANDBOX_IMAGE=//p' .env | tail -n 1)
SANDBOX_IMAGE_NAME=${SANDBOX_IMAGE_NAME:-clirace-sandbox:0.2.0}

if [[ ! -S "$SANDBOX_SOCKET" ]]; then
  echo "Rootless Docker socket is unavailable: $SANDBOX_SOCKET" >&2
  exit 1
fi

export SANDBOX_DOCKER_SOCKET_HOST="$SANDBOX_SOCKET"
export SANDBOX_SOCKET_GID
SANDBOX_SOCKET_GID=$(stat -c '%g' "$SANDBOX_SOCKET")

echo "Building the disposable shell image with the rootless daemon..."
runuser -u clirace-sandbox -- env \
  HOME="$SANDBOX_HOME" \
  XDG_RUNTIME_DIR="/run/user/${SANDBOX_UID}" \
  DOCKER_HOST="unix://${SANDBOX_SOCKET}" \
  docker build \
    -t "$SANDBOX_IMAGE_NAME" \
    -f infra/sandbox/Dockerfile \
    infra/sandbox

echo "Starting CLIRace on 127.0.0.1:8080..."
docker compose \
  -f docker-compose.yml \
  -f docker-compose.sandbox.yml \
  up --build -d

# Compose does not track the contents of bind-mounted files. Recreate only the
# lightweight edge container so every deployment reloads the current nginx config.
docker compose \
  -f docker-compose.yml \
  -f docker-compose.sandbox.yml \
  up -d --force-recreate --no-deps gateway

for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error http://127.0.0.1:8080/api/health >/dev/null; then
    echo "CLIRace is ready."
    docker compose \
      -f docker-compose.yml \
      -f docker-compose.sandbox.yml \
      ps
    exit 0
  fi
  sleep 2
done

echo "CLIRace did not become ready in time. Recent logs:" >&2
docker compose \
  -f docker-compose.yml \
  -f docker-compose.sandbox.yml \
  logs --tail=100 >&2
exit 1
