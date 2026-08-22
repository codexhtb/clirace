ALTER TABLE battles
  ADD COLUMN mode VARCHAR(16) NOT NULL DEFAULT 'private'
    CHECK (mode IN ('private', 'quick', 'ranked'));

UPDATE battles
SET mode = CASE
  WHEN matchmaking_pool = 'ranked' THEN 'ranked'
  WHEN matchmaking_pool IS NOT NULL THEN 'quick'
  ELSE 'private'
END;

CREATE TABLE user_ranked_stats (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mmr INTEGER NOT NULL DEFAULT 1000 CHECK (mmr >= 0),
  games_played INTEGER NOT NULL DEFAULT 0 CHECK (games_played >= 0),
  wins INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
  losses INTEGER NOT NULL DEFAULT 0 CHECK (losses >= 0),
  placement_games_completed SMALLINT NOT NULL DEFAULT 0
    CHECK (placement_games_completed BETWEEN 0 AND 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (games_played = wins + losses),
  CHECK (placement_games_completed = LEAST(games_played, 5))
);

CREATE TABLE ranked_match_results (
  id UUID PRIMARY KEY,
  battle_id UUID NOT NULL UNIQUE REFERENCES battles(id) ON DELETE CASCADE,
  player_a_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  player_b_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  winner_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  outcome VARCHAR(24) NOT NULL
    CHECK (outcome IN ('player_a_win', 'player_b_win', 'no_contest')),
  no_contest_reason VARCHAR(64),
  player_a_mmr_before INTEGER NOT NULL CHECK (player_a_mmr_before >= 0),
  player_a_mmr_after INTEGER NOT NULL CHECK (player_a_mmr_after >= 0),
  player_b_mmr_before INTEGER NOT NULL CHECK (player_b_mmr_before >= 0),
  player_b_mmr_after INTEGER NOT NULL CHECK (player_b_mmr_after >= 0),
  player_a_division_before VARCHAR(16) NOT NULL,
  player_a_division_after VARCHAR(16) NOT NULL,
  player_b_division_before VARCHAR(16) NOT NULL,
  player_b_division_after VARCHAR(16) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (player_a_id <> player_b_id),
  CHECK (
    (outcome = 'no_contest' AND winner_id IS NULL AND no_contest_reason IS NOT NULL
      AND player_a_mmr_before = player_a_mmr_after
      AND player_b_mmr_before = player_b_mmr_after)
    OR
    (outcome <> 'no_contest' AND winner_id IS NOT NULL AND no_contest_reason IS NULL)
  )
);

CREATE INDEX user_ranked_stats_leaderboard_idx
  ON user_ranked_stats (mmr DESC, wins DESC, games_played ASC, user_id)
  WHERE games_played > 0;

CREATE INDEX ranked_match_results_player_a_history_idx
  ON ranked_match_results (player_a_id, created_at DESC);

CREATE INDEX ranked_match_results_player_b_history_idx
  ON ranked_match_results (player_b_id, created_at DESC);

CREATE INDEX ranked_match_results_created_idx
  ON ranked_match_results (created_at DESC);

CREATE INDEX battles_ranked_recovery_idx
  ON battles (finished_at, id)
  WHERE mode = 'ranked' AND status IN ('finished', 'cancelled');
