# CLIRace

**CLIRace** — соревновательная платформа для практики Linux и DevOps через реальный CLI.

Вместо тестов с вариантами ответов пользователь получает задачу и настоящий изолированный Linux shell, где должен решить её командой или последовательностью команд.

Проект рассчитан как на самостоятельную практику, так и на соревнования между пользователями в реальном времени.

Текущая версия репозитория содержит production-платформу и обучающий режим **CLIRace Learn V1**.

---

## Что уже реализовано

На текущем этапе CLIRace включает:

* регистрацию и авторизацию пользователей;
* HttpOnly browser sessions;
* **229 CLI-заданий**, включая отдельную коллекцию Interview 100;
* категории и фильтрацию заданий;
* режимы одиночной игры;
* Daily Challenge;
* streak-систему;
* достижения;
* рейтинги;
* глобальный leaderboard;
* рейтинги по категориям;
* публичные профили;
* историю прохождений;
* серверный расчёт результатов;
* реальные Linux sandbox-сессии;
* rootless Docker isolation;
* browser terminal через WebSocket;
* приватные PvP-битвы;
* realtime lobby и countdown;
* матчи на 3 / 5 / 10 раундов;
* восстановление активной сессии после refresh;
* серверное определение победителя;
* сохранение результатов матчей;
* автоматический поиск соперника Quick Match;
* Redis-очередь с heartbeat, TTL и восстановлением после обновления страницы;
* защищённое от гонок создание ровно одного существующего Battle на пару.
* Linux Core с объяснением каждого ответа, восстановлением сессии и аналитикой по темам.

## CLIRace Learn / Linux Core

На `/learn/linux-core` доступны Quick Check на 10 вопросов, Standard на 25 вопросов и практика по выбранной теме. Full Assessment автоматически появится, когда в банке будет не меньше 50 уникальных активных вопросов.

Вопросы хранятся в `content/linux-core/*.json`. Клиент до ответа получает только текст и перемешанные варианты: правильные ID и объяснения остаются на сервере. После ответа попытка фиксируется один раз, а сервер возвращает результат и разбор ошибки. Незавершённая сессия продолжается после обновления страницы.

Проверить локальный банк без базы данных:

```bash
pnpm build
pnpm linux-core:validate
```

Импортировать банк в PostgreSQL (команда безопасно повторяется и обновляет вопросы по стабильному slug):

```bash
pnpm linux-core:import
```

Запустить интеграционные проверки Learn:

```bash
pnpm test:learning
```

## Operations Console

Закрытая операционная консоль доступна по адресу `/admin`. Она показывает состояние PostgreSQL, Redis и rootless sandbox runtime, продуктовые метрики, пользователей, sandbox-сессии, задания, Battles и журнал административных действий.

Администратор не создаётся автоматически: в проекте нет стандартного логина или пароля. Сначала зарегистрируйте обычный аккаунт через сайт, затем на production-сервере явно выдайте ему роль по email:

```bash
cd /opt/clirace
sudo docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
  node apps/api/dist/admin-role-cli.js grant --email owner@example.com
```

Отозвать роль можно без изменения пароля и пользовательских сессий:

```bash
cd /opt/clirace
sudo docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec -T api \
  node apps/api/dist/admin-role-cli.js revoke --email owner@example.com
```

Обе операции выводят выбранного пользователя и сохраняют audit event. Веб-консоль намеренно не умеет менять роли, выполнять произвольные SQL-запросы, Docker-команды или shell-команды.

## Interview 100

Страница `/interview` содержит отдельную коллекцию из ровно 100 практических задач для подготовки к Linux/DevOps-собеседованию. Старые задания остаются в общем каталоге и не изменяются.

Коллекция охватывает основы Linux, файлы и обработку текста, процессы, сети, права, systemd, диски, Bash, Git и контейнеры. Распределение сложности: **30 Easy / 50 Medium / 20 Hard**.

Пользователь может:

* фильтровать задачи по теме, сложности и статусу;
* видеть личный прогресс от 0 до 100;
* запускать сбалансированный Interview Run на 10, 25 или 50 задач;
* решать команды тем же игровым движком и в той же rootless shell-песочнице;
* после успешного решения открыть основную команду, объяснение и допустимые альтернативы.

Проверка целостности коллекции:

```bash
pnpm test:interview-100
```

Для проверки уже развёрнутого API:

```bash
CLIRACE_BASE_URL=http://127.0.0.1:8080 pnpm test:interview-100
```

---

# Архитектура

CLIRace состоит из нескольких изолированных компонентов:

```text
Browser
   │
   ▼
Nginx Gateway
   │
   ├── Web frontend
   │
   ├── REST API
   │
   ├── Battle WebSocket
   │
   └── Terminal WebSocket
           │
           ▼
      Fastify API
       │        │
       │        ├── Redis
       │        │
       │        └── PostgreSQL
       │
       ▼
Rootless Docker daemon
       │
       ▼
Disposable Linux sandboxes
```

Frontend построен на:

* React;
* TypeScript;
* Vite;
* Tailwind CSS.

Backend:

* Fastify;
* TypeScript;
* PostgreSQL;
* Redis;
* WebSocket.

Sandbox infrastructure:

* rootless Docker;
* отдельный daemon;
* disposable containers;
* network isolation;
* cgroup PID limits.

---

# Структура проекта

```text
clirace/
├── content/
│   └── linux-core/        # версионируемый банк учебных вопросов
│
├── apps/
│   ├── api/
│   │   ├── migrations/
│   │   ├── src/
│   │   └── Dockerfile
│   │
│   └── web/
│       ├── src/
│       ├── Dockerfile
│       └── nginx.conf
│
├── infra/
│   ├── caddy/
│   │   └── Caddyfile
│   │
│   ├── nginx/
│   │   └── nginx.conf
│   │
│   └── sandbox/
│       └── Dockerfile
│
├── scripts/
│   ├── deploy-local-shell.sh
│   ├── deploy-production.sh
│   ├── backup-postgres.sh
│   └── test-production-smoke.mjs
│
├── .env.example
├── .env.server.example
├── .env.production.example
├── docker-compose.yml
├── docker-compose.sandbox.yml
├── docker-compose.production.yml
├── package.json
└── tsconfig.base.json
```

---

# Docker networking

Основной application stack использует две Docker-сети.

### `edge`

Доступна только для компонентов, которым необходимо взаимодействовать с gateway:

```text
Nginx
Web
API
```

### `data`

Внутренняя сеть для:

```text
API
PostgreSQL
Redis
```

PostgreSQL и Redis **не публикуют host ports**.

Таким образом база данных и Redis недоступны напрямую извне Docker Compose stack.

---

# Быстрый запуск

## Требования

Необходимо установить:

* Docker Engine;
* Docker Compose plugin.

Создайте конфигурацию окружения:

```bash
cp .env.example .env
```

Перед использованием приложения обязательно замените пароли в `.env`.

Запуск:

```bash
docker compose up --build -d
```

Проверить состояние контейнеров:

```bash
docker compose ps
```

Проверить gateway:

```bash
curl http://localhost/healthz
```

Проверить API:

```bash
curl http://localhost/api/health
```

После запуска интерфейс доступен по адресу:

```text
http://localhost
```

---

# Остановка

```bash
docker compose down
```

PostgreSQL использует named volume:

```text
postgres_data
```

Поэтому обычный:

```bash
docker compose down
```

не удаляет данные.

Для полного сброса окружения:

```bash
docker compose down --volumes
```

Используйте эту команду только если действительно хотите удалить данные PostgreSQL.

---

# Локальная разработка

## Требования

* Node.js 22+
* pnpm 11+
* PostgreSQL
* Redis

Установка зависимостей:

```bash
pnpm install
```

Создание environment-файла:

```bash
cp .env.example .env
```

Укажите локальные:

```text
DATABASE_URL
REDIS_URL
```

После этого:

```bash
pnpm dev
```

Frontend:

```text
http://localhost:5173
```

Backend:

```text
http://localhost:3000
```

Vite автоматически проксирует:

```text
/api
```

на API-сервер.

---

# Проверка проекта

Основной набор проверок:

```bash
pnpm typecheck
pnpm build
pnpm test:battle-e2e
docker compose config --quiet
docker compose up --build -d
docker compose ps
```

---

# Health checks

### Nginx

```http
GET /healthz
```

Проверяет доступность публичного gateway.

---

### API process

```http
GET /health/live
```

Проверяет, что API-процесс работает.

---

### API readiness

```http
GET /api/health
```

Проверяет:

* API;
* PostgreSQL;
* Redis.

---

# Authentication API

### Registration

```http
POST /api/auth/register
```

Создаёт пользователя и browser session.

---

### Login

```http
POST /api/auth/login
```

Поддерживает вход через:

* username;
* email.

---

### Logout

```http
POST /api/auth/logout
```

Текущая Redis-backed session отзывается.

---

### Current user

```http
GET /api/auth/me
```

Возвращает публичную информацию об авторизованном пользователе.

---

### Delete account

```http
DELETE /api/auth/account
```

Удаляет аккаунт после подтверждения пароля.

---

# Challenges

Получить категории:

```http
GET /api/categories
```

Получить каталог заданий:

```http
GET /api/challenges
```

Каталог поддерживает фильтрацию.

Всего в текущем seed-наборе:

```text
129 challenges
```

---

# Game sessions

Создание игровой сессии:

```http
POST /api/game/sessions
```

Поддерживаемые режимы:

* Recall;
* Quick;
* Mixed.

Получить активную сессию:

```http
GET /api/game/sessions/:id
```

Отправить решение:

```http
POST /api/game/sessions/:id/submit
```

Пропустить задачу:

```http
POST /api/game/sessions/:id/skip
```

Проверка команд и начисление очков выполняются **на backend**.

Frontend не является источником истины для игровых результатов.

---

# Daily Challenge

Текущее ежедневное задание:

```http
GET /api/daily
```

Endpoint возвращает:

* сегодняшнее общее задание;
* community progress;
* streak текущего пользователя.

Начать Daily Challenge:

```http
POST /api/daily/start
```

Один пользователь может иметь только одну daily attempt на текущий день.

---

# Profiles

Публичный профиль:

```http
GET /api/profiles/:username
```

Содержит:

* рейтинг;
* статистику;
* достижения;
* результаты;
* последние игровые сессии.

Полная история:

```http
GET /api/profiles/:username/history
```

Поддерживается pagination.

---

# Leaderboard

```http
GET /api/leaderboard
```

Можно получать:

* общий leaderboard;
* leaderboard по категории.

---

# Linux Sandbox

Главная особенность CLIRace — задачи можно выполнять внутри настоящего Linux shell.

Каждая sandbox-сессия запускается внутри отдельного disposable container.

Проверить доступность Shell Mode:

```http
GET /api/sandbox/status
```

Создать sandbox session:

```http
POST /api/sandbox/sessions
```

API выдаёт одноразовый ticket для подключения терминала.

Подключение браузера:

```http
GET /ws/terminal/:sessionId
```

Для подключения используется одноразовый bearer token.

---

# Sandbox security model

CLIRace **не передаёт API системный `/var/run/docker.sock`**.

Для игровых контейнеров запускается отдельный:

```text
rootless Docker daemon
```

под пользователем:

```text
clirace-sandbox
```

API получает доступ исключительно к Unix socket этого daemon.

---

Каждый игровой контейнер создаётся без:

* network access;
* host mounts;
* published ports;
* devices;
* added Linux capabilities;
* доступа к другим sandbox-сессиям.

Sandbox также связан с:

* авторизованным аккаунтом;
* активной игровой сессией;
* конкретным заданием;
* battle round;
* сохранённым результатом.

---

# Sandbox limits

Одновременно пользователь может иметь только:

```text
1 live sandbox
```

Максимальная продолжительность сессии:

```text
15 минут
```

Timeout при отсутствии активности:

```text
3 минуты
```

После timeout контейнер уничтожается.

Количество процессов ограничивается через:

```text
cgroup PidsLimit
```

В rootless-режиме не используется:

```text
nproc
```

поскольку такой лимит учитывал бы процессы всего пользователя rootless Docker daemon, а не конкретного контейнера.

---

# Сборка sandbox image

Получить UID пользователя:

```bash
SANDBOX_UID=$(id -u clirace-sandbox)
```

Собрать image через rootless daemon:

```bash
sudo -u clirace-sandbox env \
  XDG_RUNTIME_DIR="/run/user/${SANDBOX_UID}" \
  DOCKER_HOST="unix:///run/user/${SANDBOX_UID}/docker.sock" \
  docker build \
  -t clirace-sandbox:0.2.0 \
  -f infra/sandbox/Dockerfile \
  infra/sandbox
```

---

# Проверка rootless Docker socket

Например:

```bash
stat -c '%u:%g' /run/user/1001/docker.sock
```

UID/GID socket должны соответствовать конфигурации сервера.

---

# Запуск с Sandbox Mode

Создайте `.env`:

```bash
cp .env.server.example .env
```

Измените placeholder-пароли.

После этого:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.sandbox.yml \
  up --build -d
```

---

# Deployment script

На подготовленном Ubuntu-сервере можно использовать:

```bash
sudo bash scripts/deploy-local-shell.sh
```

Скрипт выполняет:

1. проверку окружения;
2. создание `.env`;
3. настройку permissions;
4. определение rootless Docker socket;
5. сборку sandbox image;
6. запуск Compose stack;
7. readiness check.

При первом запуске создаётся:

```text
.env
```

с permissions:

```text
0600
```

После этого deployment намеренно останавливается, чтобы administrator заменил placeholder-пароли.

---

# Private Battles

PHASE 8 добавляет полноценные приватные PvP Shell-битвы.

## Quick Match

На странице `/play` доступен автоматический поиск соперника. Это небольшой orchestration-слой над уже существующими Battle Engine и Sandbox Platform: после сведения двух игроков создаётся обычная запись в `battles`, а Ready, countdown, WebSocket, реальные терминалы, проверка заданий, победитель и результаты продолжают обслуживаться существующим движком.

В V1 используется один публичный FIFO-pool `quick`. Очередь и краткоживущие состояния хранятся только в Redis с namespace `clirace:mm:*`; PostgreSQL остаётся источником истины для созданных Battles. Повторный вход в очередь идемпотентен, самоподбор запрещён, а Lua-операции атомарно выполняют claim, commit, rollback и cancel. Глобальная Redis-блокировка координирует будущие параллельные API workers.

Перед созданием пары сервер проверяет активный Battle, несовместимую Shell-сессию, статус аккаунта и реальную доступность двух мест в Sandbox Platform. При нехватке ёмкости пользователь остаётся в состоянии `waitingCapacity`; отдельный счётчик ресурсов не создаётся.

Поиск имеет lease 90 секунд. Браузер продлевает его heartbeat-запросом, а при F5 восстанавливает server-authoritative состояние через status API. Если пользователь пропустил событие о создании матча, status возвращает `battleId` и `roomCode`, после чего UI открывает обычную страницу Battle.

API:

```http
POST   /api/matchmaking/queue
GET    /api/matchmaking/status
POST   /api/matchmaking/heartbeat
DELETE /api/matchmaking/queue
GET    /api/matchmaking/metrics   # только admin
```

Основные параметры:

```env
MATCHMAKING_ENABLED=true
MATCHMAKING_LEASE_SECONDS=90
MATCHMAKING_PAIRING_TTL_SECONDS=120
MATCHMAKING_MATCH_TTL_SECONDS=3600
MATCHMAKING_BATTLE_WAITING_TTL_SECONDS=120
```

Проверки Redis-очереди, конкурентных гонок и нагрузки 50/51 пользователей:

```bash
pnpm test:matchmaking
```

Интеграционная проверка API, PostgreSQL, Redis и BattleService:

```bash
pnpm --filter @clirace/api test:matchmaking-e2e
```

Полный внешний сценарий с двумя временными production-аккаунтами, двумя реальными sandbox, тремя раундами и server-authoritative результатом:

```bash
CLIRACE_URL=https://clirace.fun pnpm test:matchmaking-e2e
```

Получить настройки battle:

```http
GET /api/battles/options
```

Создать комнату:

```http
POST /api/battles
```

Backend создаёт:

* короткий room code;
* фиксированный challenge set;
* порядок заданий;
* количество раундов.

Поддерживаются:

```text
3 rounds
5 rounds
10 rounds
```

---

# Join

Второй игрок подключается через:

```http
POST /api/battles/:roomCode/join
```

Операция идемпотентная.

Повторный запрос не создаёт второго игрока и не ломает состояние комнаты.

---

# Ready state

```http
POST /api/battles/:roomCode/ready
```

Игрок может менять ready state до начала матча.

После готовности обоих игроков backend запускает общий countdown.

---

# Battle WebSocket

Realtime-состояние комнаты передаётся через:

```http
GET /ws/battle/:roomCode
```

Battle WebSocket используется для:

* lobby state;
* ready state;
* countdown;
* текущего раунда;
* прогресса игроков;
* завершения раунда;
* завершения матча;
* результатов.

---

# Battle Terminal

Для каждого раунда игрок получает отдельную sandbox session.

Ticket:

```http
POST /api/battles/:roomCode/terminal
```

Терминал подключается отдельно через Terminal WebSocket.

Важно:

```text
Terminal traffic Player A
```

никогда не проходит через:

```text
Battle channel Player B
```

Игроки имеют независимые терминальные соединения и отдельные контейнеры.

---

# Server-authoritative battles

CLIRace использует server-authoritative модель.

Backend определяет:

* текущее время;
* начало countdown;
* challenge order;
* состояние раундов;
* успешность решения;
* время прохождения;
* score;
* winner.

Клиент не может самостоятельно объявить победу.

---

# Reconnect

При обновлении страницы пользователь не получает новую sandbox-сессию автоматически.

В течение:

```text
60 секунд
```

можно подключиться к той же активной session.

Это предотвращает появление нескольких контейнеров для одного battle round.

---

# Battle E2E test

Полный production regression test:

```bash
pnpm test:battle-e2e
```

Тест эмулирует двух игроков.

Во время теста:

1. создаются два временных аккаунта;
2. создаётся battle room;
3. второй пользователь входит в комнату;
4. проверяются duplicate `join`;
5. проверяются duplicate `ready`;
6. открываются два Battle WebSocket;
7. открываются два Terminal WebSocket;
8. пользователи проходят три раунда;
9. игроки проходят задания с разной скоростью;
10. один terminal reconnect выполняется к тому же session ID;
11. backend определяет победителя;
12. проверяются сохранённые результаты;
13. временные аккаунты удаляются.

---

# Database migrations

Миграции выполняются перед началом обработки API requests.

Для защиты от одновременного запуска нескольких экземпляров используется:

```text
PostgreSQL advisory lock
```

Это позволяет избежать параллельного выполнения одной migration несколькими API instances.

---

# Безопасный доступ к текущему prototype

Gateway на подготовленном сервере слушает только:

```text
127.0.0.1:8080
```

То есть приложение намеренно не публикуется напрямую в Интернет.

Для доступа с administrator workstation используется SSH port forwarding:

```bash
ssh \
  -L 8080:127.0.0.1:8080 \
  -p 6222 \
  codex@SERVER_ADDRESS
```

После подключения:

```text
http://localhost:8080
```

будет проксироваться на CLIRace server.

---

# Публикация CLIRace в Интернет

PHASE 9 добавляет воспроизводимый production deployment на одном Ubuntu-сервере. До появления домена локальный gateway продолжает работать на `127.0.0.1:8080` и не публикуется наружу.

Production traffic проходит так:

```text
Internet
   │
   ├── HTTP :80 ── redirect to HTTPS
   │
   ▼
Caddy :443 · automatic ACME TLS
   │
   ▼
Nginx gateway :80 · internal Docker network
   ├── React frontend
   ├── /api/*       → Fastify API
   ├── /ws/terminal → Terminal WebSocket
   └── /ws/battle   → Battle WebSocket
                         │
                         ▼
                 rootless Docker socket
```

Caddy автоматически выпускает и обновляет TLS-сертификат. Certificate data хранится в Docker volume `caddy_data`, не попадает в Git и переживает recreation контейнера. Nginx сохраняет существующую маршрутизацию, CSP и WebSocket Upgrade. Frontend строит API и `wss://` адреса от `window.location.host`, поэтому домен, localhost и IP не зашиты в React-код.

## Первый production deployment

1. Купите домен.
2. Создайте DNS A record:

```text
clirace.example -> SERVER_PUBLIC_IP
```

При использовании IPv6 также можно создать AAAA record.

3. Скопируйте production template:

```bash
cd /opt/clirace
cp .env.production.example .env.production
chmod 600 .env.production
nano .env.production
```

Укажите как минимум:

```env
PUBLIC_HOST=clirace.example
PUBLIC_SCHEME=https
ACME_EMAIL=admin@clirace.example
POSTGRES_PASSWORD=длинный_существующий_пароль
REDIS_PASSWORD=другой_длинный_существующий_пароль
```

При обновлении существующего сервера перенесите реальные пароли из `/opt/clirace/.env`: смена только переменной окружения не меняет пароль уже созданной PostgreSQL role.

4. Запустите одну команду:

```bash
sudo bash scripts/deploy-production.sh
```

Скрипт проверяет env, DNS, rootless daemon и Compose, собирает sandbox и application images до recreation, запускает миграции через API startup, ждёт health checks и проверяет HTTPS с настоящим сертификатом.

Если DNS ещё не указывает на сервер, скрипт завершится до изменения работающего stack и напечатает:

```text
Point the domain to the server and run deployment again.
```

После исправления DNS просто повторите ту же deployment-команду.

## Public ports и firewall

Публично нужны только:

```text
80/tcp   HTTP redirect и ACME challenge
443/tcp  HTTPS и WSS
6222/tcp административный SSH на текущем сервере
```

Не открывайте наружу:

```text
3000  Fastify API
5432  PostgreSQL
6379  Redis
8080  локальный gateway
Docker API/socket
/run/user/<UID>/docker.sock
sandbox container ports
```

Deployment намеренно не меняет firewall и не рискует закрыть SSH. Если используется UFW, сначала подтвердите фактический SSH port, затем настройте правила вручную, например:

```bash
sudo ufw allow 6222/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw status verbose
```

Не выполняйте `ufw enable`, пока не проверен доступ по SSH во второй сессии.

## Проверка production

Основные endpoints:

```bash
curl -fsS https://clirace.example/healthz
curl -fsS https://clirace.example/api/health
curl -fsS https://clirace.example/api/sandbox/status
```

Проверить certificate и дату окончания:

```bash
openssl s_client -connect clirace.example:443 -servername clirace.example </dev/null 2>/dev/null \
  | openssl x509 -noout -issuer -subject -dates
```

Полный smoke test создаёт временный аккаунт, проверяет register/logout/login, Secure cookie, authenticated session, `wss://` Terminal, выполнение shell-команды и cleanup:

```bash
CLIRACE_URL=https://clirace.example pnpm test:production-smoke
```

Private Battle проверяется существующим regression test:

```bash
CLIRACE_URL=https://clirace.example pnpm test:battle-e2e
```

Оба теста удаляют временные аккаунты после завершения.

## Logs и диагностика

```bash
docker compose --env-file .env.production \
  -f docker-compose.yml \
  -f docker-compose.sandbox.yml \
  -f docker-compose.production.yml \
  ps

docker compose --env-file .env.production \
  -f docker-compose.yml \
  -f docker-compose.sandbox.yml \
  -f docker-compose.production.yml \
  logs --tail=200 api gateway caddy
```

Rootless socket проверяется отдельно:

```bash
SANDBOX_UID=$(id -u clirace-sandbox)
sudo -u clirace-sandbox env \
  XDG_RUNTIME_DIR="/run/user/${SANDBOX_UID}" \
  DOCKER_HOST="unix:///run/user/${SANDBOX_UID}/docker.sock" \
  docker info
```

## Безопасное обновление

Загрузите новую версию repository и повторите:

```bash
sudo bash scripts/deploy-production.sh
```

Скрипт сначала собирает новые images. PostgreSQL volume, аккаунты, результаты, Caddy certificates и idempotent migrations сохраняются. `.env.production` не перезаписывается.

## PostgreSQL backup

Создать consistent custom-format dump:

```bash
sudo bash scripts/backup-postgres.sh
```

Результат:

```text
backups/clirace-2026-08-18_030000.dump
```

Проверка архива:

```bash
pg_restore --list backups/clirace-2026-08-18_030000.dump | head
```

Backup на той же VM не является disaster recovery. Регулярно копируйте `.dump` на другой host, NAS или object storage и периодически проверяйте восстановление на отдельной PostgreSQL instance.

---

# Production security

Не изменяйте локальный bind gateway с:

```text
127.0.0.1
```

на публичный интерфейс: внешний доступ должен идти только через Caddy на 80/443.

Production cookies имеют `HttpOnly`, `Secure`, `SameSite=Lax` и `Path=/`. Fastify ограничивает HTTP body до 64 KiB, WebSocket payload до 16 KiB, а чувствительные auth/game/sandbox/battle endpoints защищены отдельными rate limits. Sandbox capacity резервируется атомарно в PostgreSQL; глобальный и пользовательский лимиты задаются независимо.

## Sandbox Platform V2

Authoritative lifecycle: `requested → starting → ready → attached`, с отдельными состояниями `queued`, `idle`, `terminating`, `terminated` и `failed`. Старое поле `status` сохранено для совместимости отчётов, а актуальное состояние хранится в `lifecycle_state`.

Основные параметры:

```text
SANDBOX_MAX_SESSIONS=25
SANDBOX_MAX_SESSIONS_PER_USER=1
SANDBOX_WARM_POOL_SIZE=0
```

На production-хосте с 8 CPU и 10 GiB RAM первая проверяемая граница — 25 одновременных сессий. `SANDBOX_WARM_POOL_SIZE` зарезервирован для следующей ступени и остаётся `0`, пока concurrency/load tests не подтвердят запас ресурсов.

Deployment всегда получает supplemental GID из фактического socket:

```bash
SANDBOX_SOCKET_GID=$(stat -c '%g' /run/user/1001/docker.sock)
curl --unix-socket /run/user/1001/docker.sock http://localhost/_ping
```

Не храните числовой GID в `.env`: subordinate ID rootless Docker может измениться. Запускайте Compose через deployment script, который экспортирует вычисленное значение.

Диагностика и Prometheus-метрики:

```bash
curl -fsS https://clirace.fun/api/sandbox/status
curl -fsS https://clirace.fun/api/sandbox/metrics
```

Reconciliation при старте API удаляет контейнеры namespace `com.clirace.sandbox=true`, которые остались после аварийного завершения, очищает одноразовые Redis tickets и завершает соответствующие DB sessions. Security invariants остаются обязательными: rootless daemon, `network=none`, без host mounts, ports, devices и capabilities, с memory/CPU/PID/TTL/idle limits.

Проверки V2:

```bash
pnpm test:sandbox-platform
# Выполняются внутри API container, где доступен rootless socket:
docker compose exec -T api node apps/api/dist/sandbox-load-test.js
docker compose exec -T api node apps/api/dist/sandbox-integrity.js
```

Reference host-level Caddy configuration находится в `infra/caddy/Caddyfile.host.example`. Файл `/etc/caddy/Caddyfile` не перезаписывается deployment автоматически.

---

# Текущая стадия

```text
PHASE 9
```

Основное ядро платформы уже работает:

```text
Authentication
      ↓
Challenges
      ↓
Game Sessions
      ↓
Real Linux Sandbox
      ↓
Profiles / Ratings
      ↓
Daily Challenges
      ↓
Private Realtime Battles
```

Следующие этапы могут развивать CLIRace в сторону полноценной multiplayer-платформы для Linux / DevOps практики.

---

## CLIRace

**Learn the command line by competing in it.**
