#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE=${CLIRACE_ENV_FILE:-$PROJECT_DIR/.env.production}
COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.sandbox.yml -f docker-compose.production.yml)

ok() { printf '[OK] %s\n' "$1"; }
die() { printf '[ERROR] %s\n' "$1" >&2; exit 1; }

if [[ ${EUID} -ne 0 ]]; then
  die 'Запустите: sudo bash scripts/deploy-production.sh'
fi

for command_name in docker curl getent id runuser stat awk grep; do
  command -v "$command_name" >/dev/null 2>&1 || die "Не найдена обязательная команда: $command_name"
done
docker compose version >/dev/null 2>&1 || die 'Docker Compose plugin недоступен.'
[[ -f "$ENV_FILE" ]] || die "Не найден $ENV_FILE. Скопируйте .env.production.example и заполните значения."

env_value() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | tr -d '\r'; }
PUBLIC_HOST=$(env_value PUBLIC_HOST)
PUBLIC_SCHEME=$(env_value PUBLIC_SCHEME)
ACME_EMAIL=$(env_value ACME_EMAIL)
PUBLIC_IP=$(env_value PUBLIC_IP)
POSTGRES_PASSWORD=$(env_value POSTGRES_PASSWORD)
REDIS_PASSWORD=$(env_value REDIS_PASSWORD)
APP_PORT=$(env_value APP_PORT)

[[ -n "$PUBLIC_HOST" ]] || die 'PUBLIC_HOST is required in .env.production.'
[[ -n "$PUBLIC_SCHEME" ]] || die 'PUBLIC_SCHEME is required in .env.production.'
[[ -n "$ACME_EMAIL" ]] || die 'ACME_EMAIL is required in .env.production.'
[[ -n "$POSTGRES_PASSWORD" ]] || die 'POSTGRES_PASSWORD is required in .env.production.'
[[ -n "$REDIS_PASSWORD" ]] || die 'REDIS_PASSWORD is required in .env.production.'

[[ "$PUBLIC_SCHEME" == https ]] || die 'PUBLIC_SCHEME должен быть https.'
[[ "$PUBLIC_HOST" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])$ ]] || die 'PUBLIC_HOST должен содержать только hostname без https:// и пути.'
[[ "$PUBLIC_HOST" == *.* ]] || die 'PUBLIC_HOST должен быть полноценным доменным именем.'
[[ "$ACME_EMAIL" == *@*.* ]] || die 'Укажите корректный ACME_EMAIL.'
if grep -Eq 'CHANGE_ME|replace-with-|change-me-before-production' "$ENV_FILE"; then
  die 'Замените все placeholder-секреты в .env.production.'
fi
if (( $(stat -c '%a' "$ENV_FILE") % 100 > 0 )); then
  printf '[WARN] Ограничьте доступ к env: chmod 600 %s\n' "$ENV_FILE" >&2
fi

id clirace-sandbox >/dev/null 2>&1 || die 'Не найден системный пользователь clirace-sandbox.'
SANDBOX_UID=$(id -u clirace-sandbox)
SANDBOX_HOME=$(getent passwd clirace-sandbox | cut -d: -f6)
configured_socket=$(env_value SANDBOX_DOCKER_SOCKET_HOST)
SANDBOX_DOCKER_SOCKET_HOST=${configured_socket:-/run/user/${SANDBOX_UID}/docker.sock}
[[ -S "$SANDBOX_DOCKER_SOCKET_HOST" ]] || die "Rootless Docker socket недоступен: $SANDBOX_DOCKER_SOCKET_HOST"
configured_image=$(env_value SANDBOX_IMAGE)
SANDBOX_SOCKET_GID=$(stat -c '%g' "$SANDBOX_DOCKER_SOCKET_HOST")
SANDBOX_IMAGE=${configured_image:-clirace-sandbox:0.2.0}
export SANDBOX_DOCKER_SOCKET_HOST SANDBOX_SOCKET_GID SANDBOX_IMAGE
curl --fail --silent --show-error --max-time 3 \
  --unix-socket "$SANDBOX_DOCKER_SOCKET_HOST" http://localhost/_ping | grep -qx 'OK' \
  || die 'Rootless Docker socket exists but /_ping failed.'
ok "Rootless sandbox available (socket gid=$SANDBOX_SOCKET_GID)"

mapfile -t dns_addresses < <(getent ahosts "$PUBLIC_HOST" 2>/dev/null | awk '{print $1}' | sort -u)
if (( ${#dns_addresses[@]} == 0 )); then
  printf 'DNS for %s does not currently resolve to this server.\n' "$PUBLIC_HOST" >&2
  printf 'Point the domain to the server and run deployment again.\n' >&2
  exit 2
fi

detected_public_ips=()
if [[ -n "$PUBLIC_IP" ]]; then
  detected_public_ips+=("$PUBLIC_IP")
else
  detected_ipv4=$(curl -4fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
  detected_ipv6=$(curl -6fsS --max-time 5 https://api64.ipify.org 2>/dev/null || true)
  [[ -n "$detected_ipv4" ]] && detected_public_ips+=("$detected_ipv4")
  [[ -n "$detected_ipv6" ]] && detected_public_ips+=("$detected_ipv6")
fi
if (( ${#detected_public_ips[@]} > 0 )); then
  dns_matches=false
  for address in "${dns_addresses[@]}"; do
    for public_address in "${detected_public_ips[@]}"; do
      [[ "$address" == "$public_address" ]] && dns_matches=true
    done
  done
  if [[ "$dns_matches" != true ]]; then
    printf 'DNS for %s resolves to: %s\n' "$PUBLIC_HOST" "${dns_addresses[*]}" >&2
    printf 'This server public addresses are: %s\n' "${detected_public_ips[*]}" >&2
    printf 'Point the domain to the server and run deployment again.\n' >&2
    exit 2
  fi
else
  printf '[WARN] Не удалось автоматически сравнить DNS с public IP; продолжаем, потому что DNS уже разрешается.\n' >&2
fi
ok "DNS resolves for $PUBLIC_HOST"

cd "$PROJECT_DIR"
compose=(docker compose --env-file "$ENV_FILE" "${COMPOSE_FILES[@]}")
"${compose[@]}" config --quiet

printf 'Building the disposable shell image with the rootless daemon...\n'
runuser -u clirace-sandbox -- env \
  HOME="$SANDBOX_HOME" \
  XDG_RUNTIME_DIR="/run/user/${SANDBOX_UID}" \
  DOCKER_HOST="unix://${SANDBOX_DOCKER_SOCKET_HOST}" \
  docker build -t "$SANDBOX_IMAGE" -f infra/sandbox/Dockerfile infra/sandbox

printf 'Building application images before container recreation...\n'
"${compose[@]}" build api web
"${compose[@]}" up -d

for attempt in $(seq 1 45); do
  if curl -fsS --max-time 5 http://127.0.0.1:${APP_PORT:-8080}/api/health >/dev/null; then
    break
  fi
  (( attempt == 45 )) && die 'Локальный gateway не прошёл health check.'
  sleep 2
done
ok 'PostgreSQL healthy'
ok 'Redis healthy'
ok 'API healthy'
ok 'Web healthy'
ok 'Gateway healthy'

local_base="http://127.0.0.1:${APP_PORT:-8080}"
curl -fsS "$local_base/healthz" >/dev/null || die 'GET /healthz завершился ошибкой.'
curl -fsS "$local_base/api/health" >/dev/null || die 'GET /api/health завершился ошибкой.'
curl -fsS "$local_base/api/sandbox/status" | grep -q '"enabled":true' || die 'Sandbox status не подтверждает enabled=true.'

https_ready=false
for attempt in $(seq 1 60); do
  if curl -fsS --max-time 8 --resolve "$PUBLIC_HOST:443:127.0.0.1" "https://$PUBLIC_HOST/healthz" >/dev/null 2>&1 \
    && curl -fsS --max-time 8 --resolve "$PUBLIC_HOST:443:127.0.0.1" "https://$PUBLIC_HOST/api/health" >/dev/null 2>&1; then
    https_ready=true
    break
  fi
  sleep 2
done

if [[ "$https_ready" != true ]]; then
  printf '[WARN] Stack работает, но ACME ещё не выдал сертификат. Проверьте DNS, ports 80/443 и logs Caddy, затем повторите deploy.\n' >&2
  "${compose[@]}" logs --tail=80 caddy >&2
  exit 3
fi

ok 'HTTPS configuration ready'
printf '\nCLIRace:\nhttps://%s\n' "$PUBLIC_HOST"
