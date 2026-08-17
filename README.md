# CLIRace

**CLIRace** — соревновательная платформа для практики Linux и DevOps через реальный CLI.

Вместо тестов с вариантами ответов пользователь получает задачу и настоящий изолированный Linux shell, где должен решить её командой или последовательностью команд.

Проект рассчитан как на самостоятельную практику, так и на соревнования между пользователями в реальном времени.

Текущая версия репозитория содержит полностью рабочее ядро **PHASE 8**.

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
* сохранение результатов матчей.

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
│   ├── nginx/
│   │   └── nginx.conf
│   │
│   └── sandbox/
│       └── Dockerfile
│
├── scripts/
│   └── deploy-local-shell.sh
│
├── .env.example
├── .env.server.example
├── docker-compose.yml
├── docker-compose.sandbox.yml
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

# Важно

Не изменяйте bind gateway с:

```text
127.0.0.1
```

на публичный интерфейс без проверки security model.

Несмотря на наличие authentication и sandbox isolation, публичный shell-сервис требует отдельного security review перед production deployment.

---

# Текущая стадия

```text
PHASE 8
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
