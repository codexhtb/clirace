ALTER TABLE battles
  ADD COLUMN matchmaking_id UUID,
  ADD COLUMN matchmaking_pool VARCHAR(32)
    CHECK (matchmaking_pool IS NULL OR matchmaking_pool ~ '^[a-z0-9_-]{1,32}$');

CREATE UNIQUE INDEX battles_matchmaking_id_unique_idx
  ON battles (matchmaking_id)
  WHERE matchmaking_id IS NOT NULL;

CREATE INDEX battles_matchmaking_active_idx
  ON battles (matchmaking_pool, created_at DESC)
  WHERE matchmaking_pool IS NOT NULL
    AND status IN ('waiting', 'countdown', 'running');
