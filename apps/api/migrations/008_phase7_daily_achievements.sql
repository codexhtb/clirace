ALTER TABLE game_sessions
  ADD COLUMN daily_challenge_id BIGINT REFERENCES daily_challenges(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX game_sessions_one_daily_per_user_idx
  ON game_sessions (user_id, daily_challenge_id)
  WHERE daily_challenge_id IS NOT NULL;

CREATE TABLE user_progress (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  current_daily_streak INTEGER NOT NULL DEFAULT 0 CHECK (current_daily_streak >= 0),
  best_daily_streak INTEGER NOT NULL DEFAULT 0 CHECK (best_daily_streak >= 0),
  last_daily_date DATE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO user_progress (user_id)
SELECT id FROM users
ON CONFLICT (user_id) DO NOTHING;

CREATE TABLE achievements (
  id SMALLINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug VARCHAR(60) NOT NULL UNIQUE,
  title VARCHAR(100) NOT NULL,
  description TEXT NOT NULL,
  icon VARCHAR(30) NOT NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0
);

CREATE TABLE user_achievements (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_id SMALLINT NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, achievement_id)
);

INSERT INTO achievements (slug, title, description, icon, sort_order) VALUES
  ('first-run', 'Первый забег', 'Завершить первый забег CLIRace.', 'flag', 10),
  ('perfect-five', 'Чистая пятёрка', 'Решить минимум пять заданий без единого пропуска.', 'target', 20),
  ('streak-five', 'Комбо x5', 'Собрать серию из пяти правильных ответов.', 'flame', 30),
  ('shell-rookie', 'Настоящий shell', 'Впервые решить задание в Linux-песочнице.', 'terminal', 40),
  ('daily-one', 'Сегодня в форме', 'Решить ежедневное испытание.', 'calendar', 50),
  ('daily-three', 'Три дня подряд', 'Решить ежедневное испытание три дня подряд.', 'calendar-check', 60),
  ('hundred-tasks', 'Сотня команд', 'Правильно решить 100 заданий.', 'trophy', 70)
ON CONFLICT (slug) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  icon = EXCLUDED.icon,
  sort_order = EXCLUDED.sort_order;

CREATE INDEX user_achievements_unlocked_idx
  ON user_achievements (user_id, unlocked_at DESC);
