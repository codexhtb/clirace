ALTER TABLE game_sessions
  ADD COLUMN rating_delta INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN rating_applied BOOLEAN NOT NULL DEFAULT false;

UPDATE game_sessions
SET rating_applied = true
WHERE status = 'completed';

INSERT INTO user_ratings (user_id, category_id)
SELECT id, NULL FROM users
ON CONFLICT (user_id, category_id) DO NOTHING;

CREATE INDEX user_ratings_overall_leaderboard_idx
  ON user_ratings (rating DESC, games_played DESC, user_id)
  WHERE category_id IS NULL AND games_played > 0;

CREATE INDEX user_ratings_category_leaderboard_idx
  ON user_ratings (category_id, rating DESC, games_played DESC, user_id)
  WHERE category_id IS NOT NULL AND games_played > 0;

CREATE INDEX game_sessions_public_history_idx
  ON game_sessions (user_id, completed_at DESC)
  WHERE status = 'completed';
