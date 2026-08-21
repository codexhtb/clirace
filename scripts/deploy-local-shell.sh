#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$PROJECT_DIR"

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this script as root: sudo bash scripts/deploy-local-shell.sh" >&2
  exit 1
fi

for command_name in docker runuser curl stat getent; do
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

# Upgrade only the known prototype value. Custom operator capacity remains
# authoritative and is never overwritten.
if grep -qx 'SANDBOX_MAX_SESSIONS=4' .env; then
  sed -i 's/^SANDBOX_MAX_SESSIONS=4$/SANDBOX_MAX_SESSIONS=25/' .env
  echo 'Upgraded legacy sandbox capacity: 4 -> 25.'
fi
grep -q '^SANDBOX_MAX_SESSIONS_PER_USER=' .env || printf '%s\n' 'SANDBOX_MAX_SESSIONS_PER_USER=1' >> .env
grep -q '^SANDBOX_WARM_POOL_SIZE=' .env || printf '%s\n' 'SANDBOX_WARM_POOL_SIZE=0' >> .env

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

if ! curl --fail --silent --show-error --max-time 3 \
  --unix-socket "$SANDBOX_SOCKET" http://localhost/_ping | grep -qx 'OK'; then
  echo "Rootless Docker socket exists but /_ping failed: $SANDBOX_SOCKET" >&2
  exit 1
fi
echo "Rootless Docker is healthy (socket gid=$SANDBOX_SOCKET_GID)."

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

# Compose does not track bind-mounted file contents. Recreate only the
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
    validation_marker=/var/lib/clirace/sandbox-platform-v2-validated
    if [[ ! -f "$validation_marker" ]]; then
      echo 'Running one-time Sandbox Platform V2 production validation...'
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
        node apps/api/dist/sandbox-integrity.js
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
        env SANDBOX_LOAD_STAGES=10,25,50 node apps/api/dist/sandbox-load-test.js
      bash scripts/test-sandbox-reconciliation.sh
      install -d -m 0755 /var/lib/clirace
      touch "$validation_marker"
      echo 'Sandbox Platform V2 production validation passed.'
    fi

    # The legacy archive runner may have populated a real Git checkout. After
    # verifying that every deployed tracked file exactly matches origin/main,
    # advance HEAD/index without discarding or overwriting any worktree data.
    if [[ -d .git ]]; then
      git -c safe.directory="$PROJECT_DIR" fetch origin main
      if ! git -c safe.directory="$PROJECT_DIR" diff --quiet origin/main -- .; then
        echo 'Deployed worktree differs from origin/main; refusing to alter Git metadata.' >&2
        git -c safe.directory="$PROJECT_DIR" status --short >&2
        exit 1
      fi
      while IFS= read -r untracked; do
        [[ -z "$untracked" ]] && continue
        git -c safe.directory="$PROJECT_DIR" cat-file -e "origin/main:$untracked" 2>/dev/null || {
          echo "Untracked production file is not present in origin/main: $untracked" >&2
          exit 1
        }
      done < <(git -c safe.directory="$PROJECT_DIR" ls-files --others --exclude-standard)
      old_head=$(git -c safe.directory="$PROJECT_DIR" rev-parse HEAD)
      new_head=$(git -c safe.directory="$PROJECT_DIR" rev-parse origin/main)
      git -c safe.directory="$PROJECT_DIR" update-ref refs/heads/main "$new_head" "$old_head"
      git -c safe.directory="$PROJECT_DIR" read-tree "$new_head"
      git -c safe.directory="$PROJECT_DIR" status --porcelain | grep -q . && {
        echo 'Production Git checkout is not clean after verified metadata sync.' >&2
        exit 1
      }
      echo "Production Git checkout synchronized at $new_head."
    fi
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
