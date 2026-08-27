# Challenge Runtime Contract V1

## Назначение

Runtime Contract V1 отделяет условие real-shell задания от способа решения. Пользователь может применить любую корректную Linux-команду или последовательность команд. После нажатия «Проверить» сервер наблюдает только итоговое состояние уже существующей песочницы.

Контракт хранится в доверенном серверном каталоге `apps/api/src/sandbox-challenges.ts`. Браузер не передаёт идентификатор контейнера, определения проверок или команды для выполнения.

## Граница доверия

Поток проверки:

1. API создаёт ticket для аутентифицированного пользователя и конкретной активной `game_session`/`session_task`.
2. `SandboxManager` остаётся единственным владельцем Docker container handle.
3. WebSocket принимает только сообщение `{ "type": "check" }`.
4. Менеджер берёт runtime и checks из доверенного каталога, а не из запроса.
5. `CheckerService` преобразует каждый типизированный checker в фиксированный argv и запускает его в том же контейнере без shell.
6. Только успешное выполнение всех checks вызывает существующий транзакционный `completeShellTask`.

Checker service не создаёт новую песочницу, не подключается к Docker самостоятельно и не выполняет авторские shell-строки.

## Runtime и capabilities

Текущая среда — `linux-core-v1`, contract version `1`, type `real_shell`. Её статический capability registry разрешает:

- `filesystem`;
- `identity`;
- `processes`;
- `network`;
- `packages` с `dpkg`.

Неизвестная среда, несовместимый checker, неизвестное поле, повторяющийся checker ID или больше 24 checks отклоняются Zod-валидатором. `service_active` в V1 отсутствует: sandbox image не запускает настоящий systemd. Такой checker отложен до V1.1 и может появиться только вместе с отдельной одобренной runtime-средой.

## Разрешённые checkers

V1 поддерживает `file_exists`, `file_not_exists`, `file_contains`, `permission_equals`, `owner_equals`, `symlink_points_to`, `user_exists`, `group_exists`, `user_in_group`, `process_running`, `process_not_running`, `port_listening` и `package_installed`.

У каждого checker есть стабильный уникальный `id`, строгие параметры и необязательный безопасный `failureHint`. Все checks обязательны; boolean expression engine в V1 отсутствует.

## Полный пример

```ts
checkerContract(linuxCoreRuntime, [
  {
    id: 'deploy-user',
    type: 'user_exists',
    user: 'deploy',
    failureHint: 'Создайте пользователя deploy.',
  },
  {
    id: 'deploy-group',
    type: 'group_exists',
    group: 'release',
    failureHint: 'Создайте группу release.',
  },
  {
    id: 'deploy-membership',
    type: 'user_in_group',
    user: 'deploy',
    group: 'release',
    failureHint: 'Добавьте deploy в группу release.',
  },
  {
    id: 'config-mode',
    type: 'permission_equals',
    path: '/workspace/app.conf',
    mode: '0640',
    failureHint: 'Установите для app.conf режим 640.',
  },
]);
```

В определении намеренно нет `command`, `script`, `eval`, JavaScript callback или ожидаемого пользовательского ввода.

## Безопасность и лимиты

- команды — фиксированные массивы argv (`test`, `stat`, `head`, `readlink`, `getent`, `id`, `ps`, `ss`, `dpkg-query`);
- `shell=false` по конструкции Docker Exec: `/bin/sh` и `/bin/bash` не участвуют в V1 checker execution;
- абсолютные пути ограничены 512 символами и не допускают управляющие символы;
- имена пользователей, групп, процессов, пакетов, адреса и порты проходят allowlist-валидацию;
- чтение файла ограничено 64 KiB;
- вывод одной команды ограничен 16 KiB и продолжает дренироваться без накопления в памяти;
- одна команда получает не больше 1,5 секунды, полный набор — не больше 8 секунд;
- timeout, переполнение, повреждённый вывод и ошибка инспекции являются system error, а не неправильным ответом;
- в браузер уходят только ID, статус и заранее заданный `failureHint`; фактическое содержимое файлов и stderr не раскрываются.

Контейнер по-прежнему запускается rootless Docker с `NetworkMode=none`, без host mounts/devices, без published ports, с `CapDrop=ALL`, `no-new-privileges`, memory/CPU/PID/tmpfs/ulimit ограничениями.

## Completion и идемпотентность

`completeShellTask` блокирует точные строки game/task через `FOR UPDATE`, повторно сверяет пользователя, тип задачи и `validation_config.sandboxChallengeId`. Первое успешное завершение записывает результат и начисляет очки. Повторная или параллельная успешная проверка возвращает сохранённый результат без второго начисления. Уникальность `results.session_task_id` остаётся дополнительной защитой БД.

Проваленная проверка увеличивает попытки только у точной активной задачи. System error попыткой пользователя не считается. Существующий переход Continue к следующей real-shell задаче и автоматический старт её shell не меняются.

## Совместимость и миграция

Первая партия переводит 14 подходящих существующих задач на V1. Остальные определения сохраняют доверенный серверный `checkScript` как временный legacy fallback. Новые авторские определения должны использовать только Runtime Contract V1; raw shell checker не является частью публичной схемы.

`setupScript` пока остаётся доверенным bootstrap-кодом каталога и никогда не приходит от клиента. Его будущая декларативная замена — отдельная задача, не часть V1 checker contract.

## Граница будущего replay

V1 проверяет текущее состояние одной живой sandbox-сессии. Replay, снапшоты, восстановление среды, перенос проверки в другую машину и сериализация истории команд не входят в контракт. Будущий replay должен сохранять семантику environment ID и capability registry, но не имеет права превращать checker definition в исполняемый код.

## Проверка изменений

- `npm run test:checker-framework` — 47 schema/checker/security/limit проверок;
- `npm run test:real-shell-integrity` — реальные rootless контейнеры: начальный fail, reference solution, V1 pass, legacy parity, альтернативное решение и identity/package runtime probe;
- `npm run typecheck` и `npm run build` — API и web;
- production shell smoke — ticket, WebSocket, fail → solve → pass и повторная идемпотентная проверка;
- production smoke после деплоя и удаление временных пользователей.
