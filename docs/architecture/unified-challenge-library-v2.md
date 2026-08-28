# Unified Linux Challenge Library V2

## Назначение

Library V2 — единый статический каталог real-shell заданий CLIRace. Одна definition используется в Practice, Quick Match, Ranked и Private Battle. База данных хранит индекс для выборки и прогресса, но не является вторым источником checker/setup semantics.

Фактический поток:

```text
TypeScript Library V2
  ├─ startup validator → idempotent PostgreSQL index → Practice
  │                                              └→ Sandbox → Checker Framework V1
  └─ Battle Eligibility Validator → tier-aware selector
        ├─ Quick Match
        ├─ Ranked
        └─ Private Battle
              └→ immutable round pin → sandbox A / sandbox B → Checker Framework V1
```

Legacy `sandbox-challenges.ts` и Interview 100 остаются совместимыми, но не входят в новый Online pool. Новые V2 задачи нельзя создавать через legacy `setupScript` или `checkScript`.

## Canonical model

Definition содержит:

- semantic `id` и отдельную целочисленную `version` контента;
- русские `title`, `description`, безопасный `hint` и `successMessage`;
- `learningObjective`, `category`, `concepts`, `tier`, `difficulty`;
- `runtime` (Challenge Runtime Contract V1 и environment `linux-core-v1`);
- typed `setup` Declarative Setup V1;
- список state-checkers Checker Framework V1;
- bounded `estimatedDurationSeconds`;
- availability для `practice`, `quick`, `ranked`, `private`.

`challenge.version` не равна `runtime.version`. Первая меняется при изменении игрового состояния или checker semantics. Вторая версионирует протокол выполнения.

Canonical файлы находятся в `apps/api/src/challenge-library-v2/`. Пять pack-файлов содержат ровно 150 новых задач; `catalog.ts` собирает и валидирует их, а `importChallengeLibraryV2()` создаёт idempotent DB index из этого же набора.

## Категории и tiers

Категории: Filesystem, Permissions, Users & Groups, Processes, Networking, Text Processing, Shell, Packages, Troubleshooting.

Tiers дополняют существующую difficulty:

- `foundation` — один базовый concept;
- `operator` — практическое применение;
- `engineer` — несколько связанных состояний;
- `troubleshooter` — небольшой symptom-first сценарий.

Practice API отдаёт category, tier, concepts, difficulty, длительность и completed-state. `/play` предоставляет поиск и фильтры, не выводя 150 карточек одной простынёй. Online автоматически выбирает задачи и не превращается в каталог.

## Declarative Setup V1

Definition может содержать только schema-validated операции:

- filesystem: `create_directory`, `create_file`, `create_sized_file`, `remove_path`, `symlink`, `set_permissions`, `set_owner`;
- identity: `create_group`, `create_user`, `add_user_to_group`;
- process: `start_trusted_process` с server-side fixture ID;
- network: `start_trusted_listener` с server-side fixture ID, validated port и bind address.

Все filesystem paths ограничены `/workspace`, размеры и content bounded, Linux names проходят allowlist. File content кодируется base64 и не интерполируется в shell. Process/listener definitions выбирают только известный server-side argv/implementation. Ключи `setupScript`, `command`, `bash`, `eval`, `javascript`, `shell` запрещены recursive validator-ом.

Compiler генерирует bootstrap только на сервере. Operations детерминированы; user/group creation и trusted background fixtures идемпотентны. Нормальный SandboxManager запускает setup один раз, а content harness отдельно проверяет безопасный повтор.

## Checker contract

V2 использует только 13 существующих state-checkers:

`file_exists`, `file_not_exists`, `file_contains`, `permission_equals`, `owner_equals`, `symlink_points_to`, `user_exists`, `group_exists`, `user_in_group`, `process_running`, `process_not_running`, `port_listening`, `package_installed`.

Проверяется конечное состояние, а не введённая строка команды. Поэтому допустимы numeric/symbolic `chmod`, `usermod`/`gpasswd`, `awk` или pipeline и другие эквивалентные решения. Package-задачи используют только локальную dpkg database и гарантированные image packages; Internet не требуется.

## Battle eligibility

Availability — намерение автора, но не источник доверия. `evaluateBattleEligibility()` отдельно проверяет:

- real-shell Runtime Contract V1 и известный environment;
- Checker Framework вместо legacy validation;
- Declarative Setup V1;
- supported checker capabilities;
- положительную content version;
- bounded solve window;
- availability конкретного Online mode.

Validator возвращает explainable reason codes (`availability_disabled`, `unsupported_runtime`, `unsupported_environment`, `legacy_validation`, `nondeterministic_setup`, `unsupported_capability`, `unbounded_duration`, `invalid_content_version`). Невалидная availability/eligibility комбинация останавливает startup import и не может silently попасть в Ranked.

## Definition hash и version pinning

SHA-256 считается по canonical stable serialization следующих gameplay-полей:

- challenge ID и content version;
- runtime;
- declarative setup;
- checks.

Presentation-only поля не влияют на hash. При создании любого нового Battle для каждого раунда в `battle_challenge_pins` сохраняются:

- DB challenge ID;
- canonical challenge ID;
- content version;
- definition hash;
- immutable JSON snapshot, необходимый для показа, setup и checker execution.

Terminal ticket читает snapshot раунда и сверяет hash. SandboxManager запускает именно snapshot, а не mutable текущую строку каталога. Player A и B получают один pin, но отдельные containers; setup применяется независимо и создаёт эквивалентное состояние. Старые незавершённые legacy Battles имеют совместимый fallback, а все вновь создаваемые Battles обязаны иметь pins.

## Selection pools и anti-repeat

Quick, Ranked и Private вызывают один selector над `listBattleEligibleChallenges(mode)`. DB участвует только в разрешении canonical slug → numeric challenge ID.

Selector:

1. применяет mode availability и optional category;
2. исключает задачи последних bounded Battles обоих участников, если оставшегося pool достаточно;
3. не повторяет challenge внутри матча;
4. использует tier-aware round composition: Foundation/Operator в начале, Operator в середине, Operator/Engineer/Troubleshooter ближе к финалу;
5. возвращается к полному eligible pool, если anti-repeat оставил слишком мало задач.

MMR formula, количество раундов и matchmaking engine не изменены.

## Practice и Learning Paths

Startup import включает все 150 задач в таблицу `challenges` с canonical slug, version/hash/tier/concepts/availability metadata. Practice random selection учитывает `availability.practice`. Direct challenge links используют тот же slug и тот же Sandbox definition.

Linux Foundations ссылается на небольшой curated набор Foundation/Operator/Engineer задач. Остальная глубина остаётся в Practice library; курс не превращён в 150 обязательных шагов.

## Content validation и tests

`pnpm test:challenge-library-v2` проверяет:

- точное число и category distribution;
- unique IDs, titles, descriptions, objectives и checker IDs;
- content/runtime versions;
- known environment/capabilities;
- forbidden arbitrary execution fields;
- setup schema и deterministic hash;
- availability/eligibility всех modes;
- snapshot pin resolution и A/B equality;
- anti-repeat и small-pool fallback;
- отсутствие exact duplicate setup/check shapes;
- наличие trusted solution fixture для каждой задачи;
- по два alternative solution для минимум 10 задач.

Rootless content harness создаёт отдельный hardened container на каждую definition, повторно применяет setup для idempotency, подтверждает unsolved initial state, применяет trusted test-only solution, запускает Checker Framework и удаляет container. Solution fixtures не импортируются HTTP routes и не сериализуются в API.

Matchmaking E2E проверяет pin rows, одинаковые ID/version/hash у A/B, а также unified Quick, Ranked и Private pools. Полный regression gate включает Checker Framework, Sandbox Platform, Practice/PvP, Online Tab, Terminal Replay, Learning Paths, typecheck и production build.

## Security invariants

Library V2 не может задавать mounts, devices, published ports, privileged mode, capabilities или network mode. SandboxManager сохраняет rootless Docker, `NetworkMode=none`, `CapDrop=ALL`, `no-new-privileges`, private IPC, tmpfs, CPU/RAM/PID/file limits, global/per-user capacity, TTL, idle cleanup и reconciliation.

Networking challenges создают sockets только внутри отдельного sandbox namespace. Ни setup, ни checker не читают host users/files/processes/ports, Docker socket или состояние другого пользователя.

## Как добавить новую V2 задачу

1. Выберите подходящий pack в `apps/api/src/challenge-library-v2/packs/`.
2. Добавьте semantic ID, content `version`, тексты, objective, category/concepts, tier/difficulty и duration.
3. Опишите initial state только Declarative Setup V1 operations.
4. Выразите финальное состояние существующими checker types; не проверяйте точную команду.
5. Убедитесь, что initial state не solved и hint не выдаёт решение.
6. Добавьте alternative fixture, если задача должна явно принимать разные подходы.
7. Выполните:

```bash
pnpm test:challenge-library-v2
pnpm test:checker-framework
pnpm typecheck
pnpm build
```

8. Перед production deploy прогоните rootless content harness и Matchmaking E2E. При изменении setup/check semantics увеличьте `challenge.version`; не редактируйте уже pinned Battle snapshot.
