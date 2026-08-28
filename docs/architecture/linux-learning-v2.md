# Linux Learning V2 — Zero to Operator

## Назначение

`linux-zero-to-operator` — основной beginner-курс CLIRace. Он проводит пользователя по циклу:

1. короткая структурированная теория;
2. статический пример команды;
3. проверка из двух вопросов;
4. необязательная дополнительная Practice-практика;
5. обязательная real-shell лабораторная;
6. checkpoint из трёх вопросов;
7. следующий модуль.

Старый `linux-foundations` оставлен отдельным включённым курсом. Его stable IDs, enrollment, item progress, mastery и результаты не мигрируют и не удаляются, поэтому существующие пользователи продолжают его с прежнего места.

## Источники истины

- Авторский источник: `scripts/generate-linux-learning-v2-content.mjs`.
- Сгенерированный банк вопросов: `content/linux-core/zero-to-operator.json`.
- Сгенерированный курс: `content/learning-paths/linux-zero-to-operator/`.
- Канонические shell-задачи: Challenge Library V2 в `apps/api/src/challenge-library-v2/`.
- Server-side progress: существующие таблицы `learning_enrollments`, `learning_item_progress`, `learning_module_results`, `learning_course_results` и `learning_mastery`.
- Quiz runtime: существующий Linux Core engine и его immutable question snapshots.
- Shell runtime/checker: существующие Practice, SandboxManager и Checker Framework.

Новый sandbox, отдельный checker или копии challenge definitions не создаются. Ссылки курса разрешаются по стабильным V2 challenge IDs и допускаются только при `availability.practice=true`.

## Контентная модель

Курс содержит 17 линейно связанных модулей. В каждом модуле ровно четыре `theory`-урока и четыре следующих за ними `knowledge_check`, один необязательный `practice`, один обязательный `shell_lab` и один итоговый `checkpoint`.

Необязательная практика отмечена `completion.optional=true`. Она доступна из модуля, но:

- не становится resume-point;
- не блокирует обязательную лабораторную;
- не входит в процент прохождения;
- не входит в mastery score;
- сохраняет обычное Practice completion, если пользователь её решил.

Все остальные шаги обязательны и открываются последовательно. Явное завершение теории и результаты quiz/checkpoint сохраняются на сервере. Завершение лабораторной определяется по обычному корректному Practice result.

## Состав курса

| Модуль | Уроки | Quiz-вопросы | Обязательная Practice | Необязательная Practice |
|---|---:|---:|---:|---:|
| Linux и терминал | 4 | 11 | 1 | 2 |
| Навигация по файловой системе | 4 | 11 | 1 | 2 |
| Файлы и каталоги | 4 | 11 | 1 | 2 |
| Просмотр содержимого файлов | 4 | 11 | 1 | 2 |
| Поиск файлов и текста | 4 | 11 | 1 | 2 |
| Права доступа | 4 | 11 | 1 | 2 |
| Пользователи и группы | 4 | 11 | 1 | 2 |
| Процессы и сигналы | 4 | 11 | 1 | 2 |
| stdin, stdout и stderr | 4 | 11 | 1 | 2 |
| Pipelines и перенаправления | 4 | 11 | 1 | 2 |
| Обработка текста | 4 | 11 | 1 | 2 |
| Основы shell | 4 | 11 | 1 | 2 |
| Окружение и PATH | 4 | 11 | 1 | 2 |
| Жёсткие и символические ссылки | 4 | 11 | 1 | 2 |
| Основы сети | 4 | 11 | 1 | 2 |
| Пакеты и инструменты | 4 | 11 | 1 | 2 |
| Системная диагностика | 4 | 11 | 1 | 2 |
| **Итого** | **68** | **187** | **17** | **34** |

В 187 уникальных ссылок входят 162 новых вопроса с префиксом `zto-` и 25 существующих Linux Core questions. Курс использует 51 уникальную Practice-eligible V2-задачу; оставшиеся 99 Library V2 challenges остаются доступными в обычной Practice.

## Валидация и authoring workflow

После изменения авторского источника выполните:

```bash
pnpm learning-v2:generate
pnpm learning-v2:check
pnpm test:linux-learning-v2
```

`learning-v2:check` проверяет drift сгенерированных файлов, схемы вопросов и path-content. Path validator дополнительно проверяет:

- уникальность course/module/item/question IDs и порядков;
- линейную и ациклическую цепочку prerequisites;
- 68 уникальных lesson titles и обязательные example/note blocks;
- ровно 187 уникальных question references без `zto-` orphans;
- ровно 17 обязательных и 34 необязательных уникальных V2 challenge references;
- существование каждого вопроса и challenge;
- `availability.practice=true` для каждой shell-задачи;
- отсутствие raw HTML в уроках, вопросах, ответах и объяснениях;
- отсутствие запрещённых giveaway-ответов и подозрительной длины вариантов.

`test:linux-learning-v2` выполняет более 500 структурных проверок, включая все 17 модулей и каждую ссылку. DB E2E дополнительно проверяет сохранение server-side progress, переход lesson → quiz → next lesson, пропуск optional practice, completion канонической shell-задачи и resume в следующем модуле.

## UX и ограничения среды

Теория рендерится только доверенными структурными блоками React; произвольный HTML и CMS отсутствуют. Кодовые блоки горизонтально прокручиваются. Интерактивный терминал появляется только через существующий `/play?mode=real_shell&challenge=...`; примеры внутри уроков статические.

Лаборатории не требуют внешнего Интернета. Темы `systemd` и package installation объясняют поведение production Linux, но обязательные labs используют гарантированные возможности rootless sandbox. SandboxManager, rootless profile, network isolation, memory/CPU/PID/time limits и Checker Framework этой фазой не изменяются.
