CREATE TABLE terminal_replays (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  session_task_id BIGINT NOT NULL REFERENCES session_tasks(id) ON DELETE CASCADE,
  sandbox_session_id UUID NOT NULL REFERENCES sandbox_sessions(id) ON DELETE CASCADE,
  challenge_id BIGINT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  format_version SMALLINT NOT NULL CHECK (format_version = 1),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0 AND duration_ms <= 1800000),
  event_count INTEGER NOT NULL CHECK (event_count >= 0 AND event_count <= 4096),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 524288),
  truncated BOOLEAN NOT NULL DEFAULT false,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (session_task_id),
  UNIQUE (sandbox_session_id)
);

CREATE INDEX terminal_replays_owner_expiry_idx ON terminal_replays (user_id, expires_at DESC);
CREATE INDEX terminal_replays_expiry_idx ON terminal_replays (expires_at);
