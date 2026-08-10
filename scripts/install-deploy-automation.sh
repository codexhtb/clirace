#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR=/opt/clirace
DEPLOY_USER=codex
RUNNER=/usr/local/sbin/clirace-deploy
SUDOERS_FILE=/etc/sudoers.d/clirace-deploy

if [[ ${EUID} -ne 0 ]]; then
  echo "Run once as root: sudo bash scripts/install-deploy-automation.sh" >&2
  exit 1
fi

if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  echo "Deployment user does not exist: $DEPLOY_USER" >&2
  exit 1
fi

install -o root -g root -m 0755 \
  "$PROJECT_DIR/scripts/clirace-deploy-runner.sh" \
  "$RUNNER"

printf '%s ALL=(root) NOPASSWD: %s\n' "$DEPLOY_USER" "$RUNNER" > "$SUDOERS_FILE"
chmod 0440 "$SUDOERS_FILE"

if ! visudo -cf "$SUDOERS_FILE"; then
  rm -f "$SUDOERS_FILE"
  echo "Invalid sudoers configuration; installation was rolled back." >&2
  exit 1
fi

echo "Automatic CLIRace deployment is installed."
echo "Allowed command: sudo -n $RUNNER"
