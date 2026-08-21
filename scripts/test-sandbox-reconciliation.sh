#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$PROJECT_DIR"
[[ ${EUID} -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }

SANDBOX_UID=$(id -u clirace-sandbox)
SANDBOX_HOME=$(getent passwd clirace-sandbox | cut -d: -f6)
SOCKET="/run/user/${SANDBOX_UID}/docker.sock"
IMAGE=$(sed -n 's/^SANDBOX_IMAGE=//p' .env | tail -n 1)
IMAGE=${IMAGE:-clirace-sandbox:0.2.0}
NAME="clirace-v2-orphan-test-$$"
compose=(docker compose -f docker-compose.yml -f docker-compose.sandbox.yml)

cleanup() {
  runuser -u clirace-sandbox -- env HOME="$SANDBOX_HOME" XDG_RUNTIME_DIR="/run/user/${SANDBOX_UID}" \
    DOCKER_HOST="unix://${SOCKET}" docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

runuser -u clirace-sandbox -- env HOME="$SANDBOX_HOME" XDG_RUNTIME_DIR="/run/user/${SANDBOX_UID}" \
  DOCKER_HOST="unix://${SOCKET}" docker run -d --name "$NAME" \
  --label com.clirace.sandbox=true --label com.clirace.namespace=sandbox-v2 \
  --network none --memory 128m --cpus 0.1 --pids-limit 32 --cap-drop ALL \
  --security-opt no-new-privileges:true "$IMAGE" sleep 120 >/dev/null

"${compose[@]}" restart api >/dev/null
for attempt in $(seq 1 45); do
  curl -fsS http://127.0.0.1:8080/api/health >/dev/null 2>&1 && break
  (( attempt == 45 )) && { echo 'API did not recover after reconciliation restart.' >&2; exit 1; }
  sleep 1
done

if runuser -u clirace-sandbox -- env HOME="$SANDBOX_HOME" XDG_RUNTIME_DIR="/run/user/${SANDBOX_UID}" \
  DOCKER_HOST="unix://${SOCKET}" docker inspect "$NAME" >/dev/null 2>&1; then
  echo 'Orphan sandbox container survived API reconciliation.' >&2
  exit 1
fi

trap - EXIT
echo '{"ok":true,"orphanRemoved":true,"apiRecovered":true}'
