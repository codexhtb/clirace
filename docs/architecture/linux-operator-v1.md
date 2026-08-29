# Linux Operator V1

Linux Operator — второй последовательный курс CLIRace после `linux-zero-to-operator`. Он использует существующие движки Learning Paths, Linux Core и Practice, поэтому у курса нет отдельного формата прогресса, quiz runtime или shell checker.

## Состав курса

| Показатель | Значение |
|---|---:|
| Модули | 14 |
| Короткие уроки | 56 |
| Вопросы | 154 |
| Новые вопросы Operator | 137 |
| Повторно используемые вопросы | 17 |
| Обязательные shell labs | 14 |
| Дополнительные Practice-задачи | 43 |
| Уникальные задачи Challenge Library V2 | 57 |
| Новые sandbox-задачи | 0 |

Каждый модуль содержит четыре пары «теория → quiz», дополнительную Practice-подборку, обязательную shell lab и checkpoint. Все обязательные шаги открываются последовательно. Дополнительная практика не влияет на процент прохождения.

| № | Модуль | Уроки | Вопросы | Обязательные | Дополнительные |
|---:|---|---:|---:|---:|---:|
| 1 | System Inspection | 4 | 11 | 1 | 3 |
| 2 | Storage и Disk Usage | 4 | 11 | 1 | 3 |
| 3 | Files, Metadata и Archives | 4 | 11 | 1 | 3 |
| 4 | Shell Control и Exit Logic | 4 | 11 | 1 | 3 |
| 5 | Job Control и Long-running Processes | 4 | 11 | 1 | 3 |
| 6 | Bash Scripting Basics | 4 | 11 | 1 | 3 |
| 7 | Permissions и Shared Access | 4 | 11 | 1 | 3 |
| 8 | Logs и Incident Investigation | 4 | 11 | 1 | 3 |
| 9 | Networking II | 4 | 11 | 1 | 3 |
| 10 | HTTP и Local Services | 4 | 11 | 1 | 3 |
| 11 | DNS и Name Resolution | 4 | 11 | 1 | 3 |
| 12 | Process, Port и Service Troubleshooting | 4 | 11 | 1 | 3 |
| 13 | System Troubleshooting | 4 | 11 | 1 | 3 |
| 14 | Operator Capstone | 4 | 11 | 1 | 4 |

## Архитектура и прогресс

- Исходники вопросов: `content/linux-core/linux-operator.json`.
- Манифест курса: `content/learning-paths/linux-operator/course.json`.
- Модули: `content/learning-paths/linux-operator/modules/*.json`.
- Генератор: `scripts/generate-linux-operator-v1-content.mjs`.
- Валидация и импорт выполняются общими `learning-content` и `learning-path-content` сервисами.
- Quiz запускается общим Linux Core engine; правильные ответы до submit остаются на сервере.
- Practice и shell lab ссылаются на стабильные slug из 150 задач Challenge Library V2. Итог принимает только authoritative checker.
- Enrollment, item progress, module result, mastery и resume хранятся на сервере отдельно для каждого `course_id`. Прогресс Zero to Operator и Linux Operator не пересекается.
- `linux-zero-to-operator` указан как рекомендуемый prerequisite. UI показывает рекомендацию, но API намеренно не создаёт hard block для опытного пользователя.

DNS рассматривается без ложной зависимости от внешней сети: теория использует `/etc/hosts`, `/etc/resolv.conf` и `getent`, а практика проверяет локальные network/tooling-состояния. Курс не требует Internet, `sudo`, systemd или ослабления sandbox.

## Авторинг и проверка

После изменения определения модулей перегенерируйте committed JSON:

```bash
pnpm operator-v1:generate
```

Проверка drift, схем, ссылок, качества вопросов и точных количеств:

```bash
pnpm operator-v1:check
pnpm test:linux-operator-v1
```

Полная интеграция Learning Paths выполняется командой `pnpm test:learning-paths`. Production E2E запускается только против HTTPS deployment:

```bash
CLIRACE_URL=https://clirace.fun pnpm test:linux-operator-v1-production
```

Production E2E создаёт временный аккаунт, начинает Operator до завершения рекомендованного курса, проходит первый модуль, решает обязательную задачу в настоящем rootless shell, проверяет resume после повторного входа и удаляет тестовый аккаунт.
