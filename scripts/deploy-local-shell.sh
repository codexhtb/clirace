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
    checker_contract_marker=/var/lib/clirace/checker-runtime-contract-v1-validated
    if [[ ! -f "$checker_contract_marker" ]]; then
      echo 'Running one-time Challenge Runtime Contract V1 production validation...'
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
        node apps/api/dist/sandbox-integrity.js
      install -d -m 0755 /var/lib/clirace
      touch "$checker_contract_marker"
      echo 'Challenge Runtime Contract V1 production validation passed.'
    fi

    checker_e2e_cleanup_marker=/var/lib/clirace/checker-runtime-contract-v1-e2e-cleaned
    if [[ ! -f "$checker_e2e_cleanup_marker" ]]; then
      echo 'Removing orphaned Challenge Runtime Contract V1 test accounts...'
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T postgres \
        sh -c 'psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1' <<'SQL'
DELETE FROM users
WHERE username LIKE 'chk\_%' ESCAPE '\'
  AND email LIKE '%@e2e.invalid';
SQL
      install -d -m 0755 /var/lib/clirace
      touch "$checker_e2e_cleanup_marker"
      echo 'Challenge Runtime Contract V1 test-account cleanup passed.'
    fi

    replay_validation_marker=/var/lib/clirace/terminal-replay-v1-validated
    if [[ ! -f "$replay_validation_marker" ]]; then
      echo 'Running one-time Terminal Replay V1 database validation...'
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
        node apps/api/dist/terminal-replay-e2e.js
      install -d -m 0755 /var/lib/clirace
      touch "$replay_validation_marker"
      echo 'Terminal Replay V1 database validation passed.'
    fi

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

    admin_validation_marker=/var/lib/clirace/admin-console-v1-validated
    if [[ ! -f "$admin_validation_marker" ]]; then
      echo 'Running one-time Operations Console V1 production validation...'
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
        node apps/api/dist/sandbox-integrity.js
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
        node apps/api/dist/admin-e2e.js
      install -d -m 0755 /var/lib/clirace
      touch "$admin_validation_marker"
      echo 'Operations Console V1 production validation passed.'
    fi

    matchmaking_validation_marker=/var/lib/clirace/matchmaking-v1-validated
    if [[ ! -f "$matchmaking_validation_marker" ]]; then
      echo 'Running one-time Matchmaking V1 production validation...'
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
        node apps/api/dist/matchmaking-test.js
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
        node apps/api/dist/matchmaking-e2e.js
      install -d -m 0755 /var/lib/clirace
      touch "$matchmaking_validation_marker"
      echo 'Matchmaking V1 production validation passed.'
    fi

    matchmaking_regression_marker=/var/lib/clirace/matchmaking-v1-regression-validated
    if [[ ! -f "$matchmaking_regression_marker" ]]; then
      echo 'Running one-time Matchmaking V1 regression validation...'
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
        node apps/api/dist/sandbox-integrity.js
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
        node apps/api/dist/admin-e2e.js
      install -d -m 0755 /var/lib/clirace
      touch "$matchmaking_regression_marker"
      echo 'Matchmaking V1 regression validation passed.'
    fi

    learn_validation_marker=/var/lib/clirace/learn-v1-linux-core-validated
    if [[ ! -f "$learn_validation_marker" ]]; then
      echo 'Running one-time Learn V1 / Linux Core validation...'
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
        node apps/api/dist/learning-content-cli.js validate
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
        node apps/api/dist/learning-e2e.js
      install -d -m 0755 /var/lib/clirace
      touch "$learn_validation_marker"
      echo 'Learn V1 / Linux Core validation passed.'
    fi

    learn_regression_marker=/var/lib/clirace/learn-v1-regressions-validated
    if [[ ! -f "$learn_regression_marker" ]]; then
      echo 'Running one-time Learn V1 platform regressions...'
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
        node apps/api/dist/sandbox-integrity.js
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
        node apps/api/dist/admin-e2e.js
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
        node apps/api/dist/matchmaking-test.js
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
        node apps/api/dist/matchmaking-e2e.js
      install -d -m 0755 /var/lib/clirace
      touch "$learn_regression_marker"
      echo 'Learn V1 platform regressions passed.'
    fi

    learning_paths_validation_marker=/var/lib/clirace/learning-paths-v1-validated
    if [[ ! -f "$learning_paths_validation_marker" ]]; then
      echo 'Running one-time Learning Paths V1 validation...'
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
        node apps/api/dist/learning-path-content-cli.js validate
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
        node apps/api/dist/learning-path-e2e.js
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
        node apps/api/dist/learning-e2e.js
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
        node apps/api/dist/admin-e2e.js
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
        node apps/api/dist/sandbox-integrity.js
      install -d -m 0755 /var/lib/clirace
      touch "$learning_paths_validation_marker"
      echo 'Learning Paths V1 validation passed.'
    fi

    ranked_validation_marker=/var/lib/clirace/ranked-mmr-v1-validated
    if [[ ! -f "$ranked_validation_marker" ]]; then
      echo 'Running one-time Ranked / MMR V1 validation...'
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
        node apps/api/dist/ranked-test.js
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
        node apps/api/dist/ranked-matchmaking-test.js
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
        node apps/api/dist/ranked-e2e.js
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
        node apps/api/dist/matchmaking-test.js
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
        node apps/api/dist/matchmaking-e2e.js
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
        node apps/api/dist/learning-e2e.js
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
        node apps/api/dist/admin-e2e.js
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
        node apps/api/dist/sandbox-integrity.js
      install -d -m 0755 /var/lib/clirace
      touch "$ranked_validation_marker"
      echo 'Ranked / MMR V1 validation passed.'
    fi

    challenge_library_validation_marker=/var/lib/clirace/challenge-library-v2-content-v2-validated
    if [[ ! -f "$challenge_library_validation_marker" ]]; then
      echo 'Running one-time Unified Challenge Library V2 production validation...'
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
        env SANDBOX_INTEGRITY_CONCURRENCY=4 node apps/api/dist/sandbox-integrity.js
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
        node apps/api/dist/matchmaking-e2e.js
      install -d -m 0755 /var/lib/clirace
      touch "$challenge_library_validation_marker"
      echo 'Unified Challenge Library V2 production validation passed.'
    fi

    linux_learning_v2_validation_marker=/var/lib/clirace/linux-learning-v2-zero-to-operator-validated
    if [[ ! -f "$linux_learning_v2_validation_marker" ]]; then
      echo 'Running one-time Linux Learning V2 production regressions...'
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
        env SANDBOX_INTEGRITY_CONCURRENCY=4 node apps/api/dist/sandbox-integrity.js
      docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
        node apps/api/dist/matchmaking-e2e.js
      install -d -m 0755 /var/lib/clirace
      touch "$linux_learning_v2_validation_marker"
      echo 'Linux Learning V2 production regressions passed.'
    fi

    # The legacy archive runner may have populated a real Git checkout. Verify
    # every deployed tracked file byte-for-byte before advancing HEAD/index;
    # this also handles files that are new relative to the old local index.
    if [[ -d .git ]]; then
      git -c safe.directory="$PROJECT_DIR" fetch origin main
      while IFS= read -r -d '' tracked; do
        if [[ ! -f "$tracked" ]] || ! cmp -s <(git -c safe.directory="$PROJECT_DIR" show "origin/main:$tracked") "$tracked"; then
          echo "Deployed file differs from origin/main: $tracked" >&2
          exit 1
        fi
      done < <(git -c safe.directory="$PROJECT_DIR" ls-tree -r -z --name-only origin/main)
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
