# Terminal Replay V1

Terminal Replay V1 сохраняет и воспроизводит успешно завершённые `real_shell`-сессии Practice. Replay является вторичной подсистемой: Checker Framework остаётся единственным источником истины для grading, а ошибка записи никогда не отменяет completion.

## Область действия и privacy

Recorder создаётся только для Practice session, связанной с `game_session_id` и `session_task_id`. Battle, Ranked, Private Battle, Interview и произвольный локальный shell не записываются.

Точка записи — `SandboxManager.forwardOutput()`, то есть server-side поток Docker PTY до доставки WebSocket-клиенту. Client → PTY input передаётся только в `stream.write()` и не имеет replay event. Поэтому ввод при `stty -echo`, password prompt и других no-echo режимах не появляется из отдельного recorder input path. Обычная команда остаётся видимой, если её естественно echo-ит PTY.

Terminal-visible output всё равно может содержать чувствительные данные. V1 не обещает универсальную regex-redaction. Защита строится слоями: owner-only API, opaque UUID, отсутствие sharing, лимиты, retention 7 дней, ручное удаление, отсутствие payload в логах и отсутствие сторонних сервисов.

## Replay Format V1

```json
{
  "version": 1,
  "initialCols": 100,
  "initialRows": 28,
  "events": [
    { "seq": 0, "tMs": 0, "type": "output", "data": "G1szMm0kIBtbMG0=" },
    { "seq": 1, "tMs": 810, "type": "resize", "cols": 120, "rows": 32 },
    { "seq": 2, "tMs": 12400, "type": "checker", "status": "failed", "passed": 2, "total": 3 },
    { "seq": 3, "tMs": 31800, "type": "checker", "status": "passed", "passed": 3, "total": 3 },
    { "seq": 4, "tMs": 31810, "type": "completed", "scoreAwarded": 215, "gameCompleted": false }
  ]
}
```

`output` хранит bytes в base64 и поэтому сохраняет ANSI, control bytes, Unicode и границы UTF-8 без преобразования. `resize` содержит только нормализованные `40..240 × 10..80`. `checker` содержит безопасные stable IDs/status и агрегаты без argv/stdout/stderr. `completed` добавляется только после commit существующей idempotent completion transaction.

`tMs` вычисляется через monotonic `performance.now()` относительно создания recorder. `seq` непрерывен и определяет порядок событий с одинаковым временем. Backend и frontend валидируют format/version/bounds.

## Recording и reconnect

Один `ActiveSession` владеет одним `TerminalReplayRecorder`. Authoritative PTY listener добавляется один раз при создании контейнера. При неожиданном Practice WebSocket disconnect сессия переходит в `idle` на существующий короткий reconnect grace; новый ticket привязывает новый socket к тому же `ActiveSession`, recorder и PTY listener. Доставка backlog отсутствует, поэтому recorder не получает повторно уже записанные frames. Явная кнопка «Завершить» отправляет `stop` и не удерживает capacity.

API process restart уничтожает активные sandbox через существующий reconciliation. Незавершённый in-memory replay в этом случае теряется; gameplay и уже persisted replay не повреждаются. Это намеренная V1 durability boundary.

## Лимиты и performance

- 512 KiB logical payload на session;
- 4096 events;
- небольшой резерв оставляется checker/completed markers после output truncation;
- при достижении лимита `truncated=true`, новые output/resize events отбрасываются, terminal/checker/completion продолжают работать;
- при capacity 25 верхняя граница encoded recorder payload составляет примерно 16.7 MiB плюс небольшой JS object overhead;
- output path выполняет только bounded append/base64 conversion и никогда не ждёт PostgreSQL;
- одна compact JSONB запись выполняется при успешном completion;
- abandoned/expired sessions не сохраняются.

## Persistence, authorization и retention

Additive migration `017_terminal_replay_v1.sql` создаёт одну metadata/payload row на `session_task_id` и `sandbox_session_id`. UUID является public ID. FK на пользователя использует cascade. DB constraints повторяют size/event/version bounds.

Endpoints:

- `GET /api/practice/replays/:id` — только authenticated owner и только до `expires_at`;
- `DELETE /api/practice/replays/:id` — owner-only, same-origin и idempotent.

Чужой, удалённый и истёкший replay не перечисляется и возвращается как unavailable. Janitor удаляет expired rows каждые 30 секунд; read path проверяет expiry независимо от janitor.

## Player

Route `/practice/replay/:id` загружает persisted payload без live WebSocket и создаёт read-only xterm (`disableStdin`, без blinking cursor). Output передаётся в `terminal.write(Uint8Array)`, не в HTML. Это сохраняет ANSI semantics и исключает DOM execution для строк вроде `<script>`.

Playback использует elapsed clock на `performance.now()` и скорости 1x/2x/4x. Xterm writes выполняются последовательной promise chain. Seek делает `terminal.reset()`, применяет initial dimensions и быстро воспроизводит все output/resize events от начала до target. При bounded V1 payload keyframes не нужны.

Timeline использует настоящий `range`, marker buttons и доступные labels. Space переключает play/pause, кроме focused buttons/inputs. На 390px controls переносятся, page не получает horizontal overflow; terminal сохраняет собственную внутреннюю сетку recorded dimensions.

## Failure isolation и дальнейшее развитие

Persistence/serialization errors логируются только с безопасными session/challenge identifiers и подавляются после успешного Practice completion. Replay CTA возвращается только при реально сохранённом UUID. Никакие ticket, cookie, input, raw checker output или Docker details в payload/log не входят.

Battle Replay не входит в V1. Формат описывает terminal stream и semantic events без ссылок на React-компоненты, поэтому будущая фаза сможет синхронизировать два независимых player timeline, не меняя Practice recorder.
