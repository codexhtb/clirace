CREATE TABLE battles (
  id UUID PRIMARY KEY,
  room_code VARCHAR(5) NOT NULL UNIQUE,
  status VARCHAR(16) NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'countdown', 'running', 'finished', 'cancelled')),
  host_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id SMALLINT REFERENCES categories(id),
  round_count SMALLINT NOT NULL CHECK (round_count IN (3, 5, 10)),
  challenge_ids BIGINT[] NOT NULL,
  countdown_start_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  winner_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK (cardinality(challenge_ids) = round_count)
);

CREATE TABLE battle_players (
  id UUID PRIMARY KEY,
  battle_id UUID NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ready BOOLEAN NOT NULL DEFAULT false,
  connected BOOLEAN NOT NULL DEFAULT false,
  sandbox_ready BOOLEAN NOT NULL DEFAULT false,
  current_round SMALLINT NOT NULL DEFAULT 1 CHECK (current_round > 0),
  completed_rounds SMALLINT NOT NULL DEFAULT 0 CHECK (completed_rounds >= 0),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disconnected_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  result VARCHAR(8) CHECK (result IN ('win', 'loss', 'dnf')),
  UNIQUE (battle_id, user_id)
);

CREATE TABLE battle_rounds (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  battle_id UUID NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES battle_players(id) ON DELETE CASCADE,
  challenge_id BIGINT NOT NULL REFERENCES challenges(id),
  round_number SMALLINT NOT NULL CHECK (round_number > 0),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER CHECK (duration_ms >= 0),
  success BOOLEAN,
  UNIQUE (player_id, round_number)
);

ALTER TABLE sandbox_sessions
  ADD COLUMN battle_id UUID REFERENCES battles(id) ON DELETE SET NULL,
  ADD COLUMN battle_player_id UUID REFERENCES battle_players(id) ON DELETE SET NULL,
  ADD COLUMN battle_round_number SMALLINT CHECK (battle_round_number > 0);

CREATE INDEX battles_active_expiry_idx
  ON battles (expires_at)
  WHERE status IN ('waiting', 'countdown', 'running');

CREATE INDEX battle_players_battle_idx ON battle_players (battle_id, joined_at);
CREATE INDEX battle_rounds_battle_idx ON battle_rounds (battle_id, round_number, player_id);
CREATE INDEX sandbox_sessions_battle_idx
  ON sandbox_sessions (battle_id, battle_player_id, battle_round_number)
  WHERE battle_id IS NOT NULL;
