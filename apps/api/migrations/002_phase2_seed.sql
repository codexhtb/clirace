INSERT INTO categories (slug, name, description, sort_order) VALUES
  ('linux', 'Linux', 'Файлы, права, процессы и базовые инструменты системы.', 10),
  ('networking', 'Networking', 'Сокеты, маршруты, DNS и диагностика сети.', 20),
  ('bash', 'Bash', 'Конвейеры, обработка текста и безопасные shell-скрипты.', 30),
  ('systemd', 'systemd', 'Управление сервисами и чтение системных журналов.', 40),
  ('docker', 'Docker', 'Контейнеры, образы, журналы и использование ресурсов.', 50),
  ('git', 'Git', 'История, ветки и безопасное управление изменениями.', 60)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  enabled = true;

WITH seed(slug, title, description, category_slug, difficulty, type, scoring_config, validation_config) AS (
  VALUES
    ('linux-listening-sockets', 'Слушающие TCP-сокеты', 'Покажите слушающие TCP-сокеты и связанные процессы.', 'linux', 'Easy', 'recall',
      '{"base":100,"timeTargetMs":15000}'::jsonb, '{"kind":"command_semantics","accepted":["ss -lntp","ss -ntlp","ss -ptnl"]}'::jsonb),
    ('linux-find-large-files', 'Крупные файлы в /var', 'Найдите обычные файлы больше 500 МБ внутри /var.', 'linux', 'Medium', 'quick',
      '{"base":160,"timeTargetMs":30000}'::jsonb, '{"kind":"command_semantics","program":"find","requires":["/var","-type f","-size +500M"]}'::jsonb),
    ('linux-directory-mode', 'Права каталога', 'Создайте /opt/app и установите права 750.', 'linux', 'Easy', 'real_shell',
      '{"base":140,"timeTargetMs":30000}'::jsonb, '{"kind":"final_state","checks":[{"path":"/opt/app","type":"directory","mode":"0750"}]}'::jsonb),
    ('network-route-get', 'Маршрут ядра', 'Покажите маршрут, который ядро использует для адреса 8.8.8.8.', 'networking', 'Easy', 'recall',
      '{"base":100,"timeTargetMs":15000}'::jsonb, '{"kind":"command_semantics","accepted":["ip route get 8.8.8.8"]}'::jsonb),
    ('network-dns-query', 'DNS-запрос', 'Получите A-запись домена example.com через dig.', 'networking', 'Easy', 'quick',
      '{"base":110,"timeTargetMs":20000}'::jsonb, '{"kind":"command_semantics","program":"dig","requires":["example.com","A"]}'::jsonb),
    ('network-port-owner', 'Процесс на порту 8080', 'Найдите процесс, слушающий TCP-порт 8080.', 'networking', 'Medium', 'quick',
      '{"base":160,"timeTargetMs":30000}'::jsonb, '{"kind":"command_semantics","programs":["ss","lsof"],"targetPort":8080}'::jsonb),
    ('bash-error-lines', 'Ошибки в журнале', 'Выведите строки с ERROR из app.log вместе с номерами строк.', 'bash', 'Easy', 'quick',
      '{"base":100,"timeTargetMs":20000}'::jsonb, '{"kind":"command_semantics","program":"grep","requires":["-n","ERROR","app.log"]}'::jsonb),
    ('bash-unique-ips', 'Уникальные IP', 'Посчитайте количество уникальных IP-адресов в первом столбце access.log.', 'bash', 'Medium', 'quick',
      '{"base":170,"timeTargetMs":35000}'::jsonb, '{"kind":"pipeline_semantics","stages":["extract_column_1","unique","count"]}'::jsonb),
    ('bash-strict-mode', 'Строгий режим Bash', 'Включите завершение при ошибке, неопределённых переменных и ошибках конвейера.', 'bash', 'Medium', 'typing',
      '{"base":130,"timeTargetMs":15000}'::jsonb, '{"kind":"exact_normalized","answer":"set -Eeuo pipefail"}'::jsonb),
    ('systemd-nginx-logs', 'Журнал nginx', 'Покажите журнал сервиса nginx за последние 10 минут.', 'systemd', 'Easy', 'recall',
      '{"base":110,"timeTargetMs":20000}'::jsonb, '{"kind":"command_semantics","program":"journalctl","unit":"nginx","since":"10 minutes ago"}'::jsonb),
    ('systemd-failed-units', 'Сбойные сервисы', 'Покажите все systemd-юниты в состоянии failed.', 'systemd', 'Easy', 'recall',
      '{"base":100,"timeTargetMs":15000}'::jsonb, '{"kind":"command_semantics","accepted":["systemctl --failed","systemctl list-units --failed"]}'::jsonb),
    ('systemd-restart-service', 'Перезапуск сервиса', 'Перезапустите сервис api.service.', 'systemd', 'Easy', 'quick',
      '{"base":100,"timeTargetMs":15000}'::jsonb, '{"kind":"command_semantics","program":"systemctl","action":"restart","unit":"api.service"}'::jsonb),
    ('docker-running-containers', 'Запущенные контейнеры', 'Покажите только запущенные Docker-контейнеры.', 'docker', 'Easy', 'recall',
      '{"base":90,"timeTargetMs":10000}'::jsonb, '{"kind":"command_semantics","accepted":["docker ps","docker container ls"]}'::jsonb),
    ('docker-follow-logs', 'Журнал контейнера', 'Следите в реальном времени за журналом контейнера api.', 'docker', 'Easy', 'quick',
      '{"base":110,"timeTargetMs":15000}'::jsonb, '{"kind":"command_semantics","program":"docker","subcommand":"logs","requires":["--follow","api"]}'::jsonb),
    ('docker-disk-usage', 'Использование диска', 'Покажите использование диска объектами Docker.', 'docker', 'Easy', 'recall',
      '{"base":100,"timeTargetMs":15000}'::jsonb, '{"kind":"command_semantics","accepted":["docker system df"]}'::jsonb),
    ('git-current-branch', 'Текущая ветка', 'Выведите только имя текущей Git-ветки.', 'git', 'Easy', 'recall',
      '{"base":100,"timeTargetMs":15000}'::jsonb, '{"kind":"command_semantics","accepted":["git branch --show-current","git rev-parse --abbrev-ref HEAD"]}'::jsonb),
    ('git-restore-file', 'Отмена локальных изменений', 'Отмените незакоммиченные изменения файла README.md.', 'git', 'Easy', 'quick',
      '{"base":110,"timeTargetMs":20000}'::jsonb, '{"kind":"command_semantics","accepted":["git restore README.md","git checkout -- README.md"]}'::jsonb),
    ('git-compact-log', 'Краткая история', 'Покажите последние пять коммитов по одному в строке.', 'git', 'Medium', 'quick',
      '{"base":150,"timeTargetMs":25000}'::jsonb, '{"kind":"command_semantics","program":"git","subcommand":"log","limit":5,"oneLine":true}'::jsonb)
)
INSERT INTO challenges (slug, title, description, category_id, difficulty, type, scoring_config, validation_config)
SELECT seed.slug, seed.title, seed.description, categories.id, seed.difficulty, seed.type, seed.scoring_config, seed.validation_config
FROM seed
JOIN categories ON categories.slug = seed.category_slug
ON CONFLICT (slug) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  category_id = EXCLUDED.category_id,
  difficulty = EXCLUDED.difficulty,
  type = EXCLUDED.type,
  scoring_config = EXCLUDED.scoring_config,
  validation_config = EXCLUDED.validation_config,
  enabled = true,
  updated_at = now();

WITH answers(challenge_slug, answer, normalized_answer, is_primary) AS (
  VALUES
    ('linux-listening-sockets', 'ss -lntp', 'ss -lntp', true),
    ('linux-listening-sockets', 'ss -ntlp', 'ss -ntlp', false),
    ('network-route-get', 'ip route get 8.8.8.8', 'ip route get 8.8.8.8', true),
    ('bash-strict-mode', 'set -Eeuo pipefail', 'set -eeuo pipefail', true),
    ('systemd-nginx-logs', 'journalctl -u nginx --since "10 minutes ago"', 'journalctl -u nginx --since 10 minutes ago', true),
    ('systemd-failed-units', 'systemctl --failed', 'systemctl --failed', true),
    ('docker-running-containers', 'docker ps', 'docker ps', true),
    ('docker-running-containers', 'docker container ls', 'docker container ls', false),
    ('docker-disk-usage', 'docker system df', 'docker system df', true),
    ('git-current-branch', 'git branch --show-current', 'git branch --show-current', true),
    ('git-current-branch', 'git rev-parse --abbrev-ref HEAD', 'git rev-parse --abbrev-ref head', false)
)
INSERT INTO challenge_answers (challenge_id, answer, normalized_answer, is_primary)
SELECT challenges.id, answers.answer, answers.normalized_answer, answers.is_primary
FROM answers
JOIN challenges ON challenges.slug = answers.challenge_slug
ON CONFLICT (challenge_id, normalized_answer) DO UPDATE SET
  answer = EXCLUDED.answer,
  is_primary = EXCLUDED.is_primary;
