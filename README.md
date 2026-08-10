# CLIRace

CLIRace is a fast, competitive platform for Linux and DevOps CLI practice. The repository contains the runnable **PHASE 8 core**: infrastructure, browser authentication, 129 challenges, server-authoritative game sessions, daily challenges, private real-time battles, achievements, ratings, public profiles, leaderboards, saved history, and account-bound rootless Linux game sandboxes.

## Project structure

```text
clirace/
├── apps/
│   ├── api/                 # Fastify + TypeScript API and dependency health checks
│   │   ├── migrations/     # Ordered PostgreSQL schema and seed migrations
│   │   ├── src/
│   │   └── Dockerfile
│   └── web/                 # React + TypeScript + Vite + Tailwind frontend
│       ├── src/
│       ├── Dockerfile
│       └── nginx.conf       # Static SPA server inside the web container
├── infra/
│   └── nginx/
│       └── nginx.conf       # Public gateway: routes web, API, and future WebSockets
├── .env.example             # Complete application environment contract
├── docker-compose.yml       # Single-VM application stack
├── package.json             # npm workspace and local development commands
└── tsconfig.base.json       # Shared strict TypeScript rules
```

The `edge` network connects only Nginx, the web container, and the API. PostgreSQL and Redis are placed on the Compose-internal `data` network and publish no host ports. Database migrations run under a PostgreSQL advisory lock before the API starts accepting requests.

## Run with Docker Compose

Requirements: Docker Engine with the Compose plugin.

```bash
cp .env.example .env
# Replace both passwords in .env before exposing the service.
docker compose up --build -d
docker compose ps
curl http://localhost/healthz
curl http://localhost/api/health
```

Open <http://localhost>. Stop the stack with:

```bash
docker compose down
```

PostgreSQL data is kept in the named `postgres_data` volume. `docker compose down` preserves it; add `--volumes` only when you intentionally want a clean database.

## Local development

Requirements: Node.js 22+, pnpm 11+, local PostgreSQL, and local Redis.

```bash
pnpm install
cp .env.example .env
```

For local processes, set `DATABASE_URL` and `REDIS_URL` to reachable development services, then run:

```bash
pnpm dev
```

The web app is served at <http://localhost:5173>; Vite proxies `/api` to <http://localhost:3000>.

## Verification

```bash
pnpm typecheck
pnpm build
pnpm test:battle-e2e
docker compose config --quiet
docker compose up --build -d
docker compose ps
```

Expected HTTP checks:

- `GET /healthz` — Nginx gateway liveness.
- `GET /health/live` — API process liveness (internal API route).
- `GET /api/health` — API readiness including PostgreSQL and Redis.
- `GET /api/categories` — enabled categories with challenge counts.
- `GET /api/challenges` — public challenge catalog with filters.
- `POST /api/auth/register` — create an account and HttpOnly browser session.
- `POST /api/auth/login` — authenticate by username or email.
- `POST /api/auth/logout` — revoke the current Redis-backed session.
- `GET /api/auth/me` — return the current public account identity.
- `DELETE /api/auth/account` — delete the signed-in account after password confirmation.
- `POST /api/game/sessions` — create an authenticated Recall, Quick, or mixed run.
- `GET /api/game/sessions/:id` — resume the current user's active run.
- `POST /api/game/sessions/:id/submit` — validate a command and award server-calculated points.
- `POST /api/game/sessions/:id/skip` — skip the active task and advance the run.
- `GET /api/profiles/:username` — public profile, ratings, aggregate statistics, and recent runs.
- `GET /api/profiles/:username/history` — paginated public run history.
- `GET /api/leaderboard` — overall or category leaderboard.
- `GET /api/daily` — today’s shared challenge, community progress, and the signed-in user’s streak.
- `POST /api/daily/start` — create or resume the signed-in user’s one daily attempt.
- `GET /api/sandbox/status` — report whether the rootless Shell mode is available.
- `POST /api/sandbox/sessions` — create an authenticated one-time shell ticket for a game task.
- `GET /ws/terminal/:sessionId` — attach the browser terminal with the one-time bearer token.
- `GET /api/battles/options` — list battle categories and supported round counts.
- `POST /api/battles` — create a private room and immutable ordered challenge set.
- `POST /api/battles/:roomCode/join` — join a room idempotently as its second player.
- `POST /api/battles/:roomCode/ready` — change readiness before the match countdown.
- `POST /api/battles/:roomCode/terminal` — issue or reconnect the current round's sandbox ticket.
- `GET /ws/battle/:roomCode` — receive authoritative lobby, countdown, progress, and result events.

## Phase boundary

PHASE 8 adds two-player private Shell battles to the PHASE 7 feature set. A room uses a short invite code, 3/5/10 immutable ordered challenges, server time for the shared countdown, independent per-player round progress, backend-only winner selection, persistent results, and realtime WebSocket state. Each player receives a separate disposable rootless container; terminal bytes never pass through the opponent's battle channel. Refresh reconnects the same active session for 60 seconds instead of creating a second sandbox.

Run the production two-client regression test against the SSH tunnel with `pnpm test:battle-e2e`. It creates two temporary accounts, verifies duplicate join/ready handling, opens two battle and two terminal WebSockets, completes three rounds at different speeds, reconnects one terminal to the same session ID, validates the stored winner/results, and removes the accounts afterward.

## Rootless game shell

The game shell uses a second, rootless Docker daemon owned by `clirace-sandbox`. The application API receives only that daemon's Unix socket; it never receives the system Docker socket. User containers have no network, host mounts, published ports, devices, added capabilities, or access to another session. Tickets require an authenticated account, game shells are linked to the active game task or battle round and database result, and each user may have only one live sandbox. Sessions expire after 15 minutes and are destroyed after 3 minutes of inactivity. Per-container PID isolation is enforced with the cgroup `PidsLimit`; do not add an `nproc` ulimit in rootless mode because it counts all processes owned by the shared daemon user rather than one container.

Build the sandbox image with the rootless daemon:

```bash
SANDBOX_UID=$(id -u clirace-sandbox)
sudo -u clirace-sandbox env \
  XDG_RUNTIME_DIR="/run/user/${SANDBOX_UID}" \
  DOCKER_HOST="unix:///run/user/${SANDBOX_UID}/docker.sock" \
  docker build -t clirace-sandbox:0.2.0 -f infra/sandbox/Dockerfile infra/sandbox
```

Copy `.env.server.example` to `.env`, replace both passwords, confirm the rootless socket UID/GID with `stat -c '%u:%g' /run/user/1001/docker.sock`, then start:

```bash
docker compose -f docker-compose.yml -f docker-compose.sandbox.yml up --build -d
```

On the prepared Ubuntu server, the guarded deployment script performs the image build, socket detection, Compose startup, and readiness check:

```bash
sudo bash scripts/deploy-local-shell.sh
```

On its first run it creates a mode-`0600` `.env` and stops so the two placeholder passwords can be replaced safely.

The gateway listens only on `127.0.0.1:8080`. From an administrator workstation, use an SSH tunnel rather than publishing the unauthenticated prototype:

```bash
ssh -L 8080:127.0.0.1:8080 -p 6222 codex@SERVER_ADDRESS
```

Open <http://localhost:8080>. Do not bind this prototype to a public interface; browser authentication and per-user authorization are introduced before public terminal access.
