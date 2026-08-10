ALTER TABLE game_sessions
  ADD COLUMN best_streak INTEGER NOT NULL DEFAULT 0 CHECK (best_streak >= 0);

ALTER TABLE session_tasks
  ADD COLUMN attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ADD COLUMN score_awarded INTEGER NOT NULL DEFAULT 0 CHECK (score_awarded >= 0),
  ADD COLUMN last_answer TEXT;

CREATE INDEX session_tasks_active_idx
  ON session_tasks (game_session_id, position)
  WHERE status = 'active';
