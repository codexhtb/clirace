CREATE TABLE battle_challenge_pins (
  battle_id UUID NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
  round_number SMALLINT NOT NULL CHECK (round_number > 0),
  challenge_id BIGINT NOT NULL REFERENCES challenges(id),
  canonical_challenge_id VARCHAR(100) NOT NULL,
  challenge_version INTEGER NOT NULL CHECK (challenge_version >= 1),
  definition_hash CHAR(64) NOT NULL CHECK (definition_hash ~ '^[a-f0-9]{64}$'),
  definition_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (battle_id, round_number),
  UNIQUE (battle_id, round_number, challenge_id)
);

CREATE INDEX battle_challenge_pins_challenge_idx
  ON battle_challenge_pins (canonical_challenge_id, challenge_version);
