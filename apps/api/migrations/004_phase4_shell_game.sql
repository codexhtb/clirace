UPDATE sandbox_sessions
SET status = 'expired', destroyed_at = COALESCE(destroyed_at, now())
WHERE status IN ('pending', 'active') AND expires_at <= now();

CREATE UNIQUE INDEX sandbox_one_live_session_per_user_idx
  ON sandbox_sessions (user_id)
  WHERE user_id IS NOT NULL AND status IN ('pending', 'active');

UPDATE challenges
SET validation_config = '{"kind":"sandbox_state","sandboxChallengeId":"directory-mode"}'::jsonb,
    scoring_config = '{"base":180,"timeTargetMs":90000}'::jsonb,
    updated_at = now()
WHERE slug = 'linux-directory-mode';

WITH seed(slug, title, description, category_slug, difficulty, scoring_config, validation_config) AS (
  VALUES
    ('shell-move-largest-file', 'Найдите крупный файл', 'Найдите файл больше 5 МБ в /workspace/data и переместите его в /workspace/archive, сохранив имя.', 'linux', 'Easy',
      '{"base":180,"timeTargetMs":90000}'::jsonb, '{"kind":"sandbox_state","sandboxChallengeId":"move-largest-file"}'::jsonb),
    ('shell-secure-secret', 'Закройте доступ к секрету', 'Оставьте владельцу /workspace/secret.env права чтения и записи, а у остальных уберите все права.', 'linux', 'Easy',
      '{"base":170,"timeTargetMs":75000}'::jsonb, '{"kind":"sandbox_state","sandboxChallengeId":"secure-secret"}'::jsonb),
    ('shell-log-investigation', 'Расследуйте ошибку в логе', 'Найдите IP клиента, получившего HTTP 503 в /workspace/access.log, и запишите только его в /workspace/answer.txt.', 'linux', 'Easy',
      '{"base":190,"timeTargetMs":90000}'::jsonb, '{"kind":"sandbox_state","sandboxChallengeId":"log-investigation"}'::jsonb),
    ('shell-archive-logs', 'Упакуйте журналы', 'Создайте gzip-архив /workspace/logs.tar.gz, содержащий оба файла из /workspace/logs.', 'bash', 'Easy',
      '{"base":190,"timeTargetMs":90000}'::jsonb, '{"kind":"sandbox_state","sandboxChallengeId":"archive-logs"}'::jsonb),
    ('shell-release-symlink', 'Переключите конфигурацию', 'Создайте символическую ссылку /workspace/current.conf на /workspace/versions/app-v2.conf.', 'linux', 'Easy',
      '{"base":180,"timeTargetMs":75000}'::jsonb, '{"kind":"sandbox_state","sandboxChallengeId":"release-symlink"}'::jsonb),
    ('shell-production-config', 'Исправьте production-конфиг', 'В /workspace/app.conf замените debug=true на debug=false, сохранив остальные строки.', 'bash', 'Easy',
      '{"base":180,"timeTargetMs":90000}'::jsonb, '{"kind":"sandbox_state","sandboxChallengeId":"production-config"}'::jsonb),
    ('shell-stop-worker', 'Остановите зависший процесс', 'Остановите процесс, PID которого записан в /workspace/worker.pid. PID-файл оставьте на месте.', 'linux', 'Medium',
      '{"base":250,"timeTargetMs":120000}'::jsonb, '{"kind":"sandbox_state","sandboxChallengeId":"stop-worker"}'::jsonb),
    ('shell-restore-git-file', 'Отмените изменение в Git', 'В /workspace/repo восстановите README.md до последнего коммита, не удаляя notes.txt.', 'git', 'Medium',
      '{"base":260,"timeTargetMs":120000}'::jsonb, '{"kind":"sandbox_state","sandboxChallengeId":"restore-git-file"}'::jsonb),
    ('shell-filter-json', 'Отфильтруйте JSON', 'Из /workspace/services.json извлеките имена включённых сервисов в /workspace/enabled.txt.', 'bash', 'Medium',
      '{"base":270,"timeTargetMs":120000}'::jsonb, '{"kind":"sandbox_state","sandboxChallengeId":"filter-json"}'::jsonb),
    ('shell-local-http', 'Проверьте локальный сервис', 'Получите http://127.0.0.1:8081/status.txt и сохраните ответ в /workspace/response.txt.', 'networking', 'Medium',
      '{"base":250,"timeTargetMs":120000}'::jsonb, '{"kind":"sandbox_state","sandboxChallengeId":"local-http"}'::jsonb),
    ('shell-rename-backups', 'Верните имена резервным копиям', 'В /workspace/backups переименуйте все *.conf.bak в *.conf, убрав только суффикс .bak.', 'bash', 'Medium',
      '{"base":270,"timeTargetMs":150000}'::jsonb, '{"kind":"sandbox_state","sandboxChallengeId":"rename-backups"}'::jsonb)
)
INSERT INTO challenges (slug, title, description, category_id, difficulty, type, scoring_config, validation_config)
SELECT seed.slug, seed.title, seed.description, categories.id, seed.difficulty, 'real_shell', seed.scoring_config, seed.validation_config
FROM seed JOIN categories ON categories.slug = seed.category_slug
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
