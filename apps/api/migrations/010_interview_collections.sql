ALTER TABLE challenges
  ADD COLUMN solution TEXT,
  ADD COLUMN explanation TEXT,
  ADD COLUMN tags TEXT[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN alternative_solutions JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE challenge_collections (
  id SMALLINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug VARCHAR(60) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  description TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE challenge_collection_items (
  collection_id SMALLINT NOT NULL REFERENCES challenge_collections(id) ON DELETE CASCADE,
  challenge_id BIGINT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  position SMALLINT NOT NULL CHECK (position > 0),
  topic VARCHAR(40) NOT NULL,
  PRIMARY KEY (collection_id, challenge_id),
  UNIQUE (collection_id, position)
);

ALTER TABLE game_sessions
  ADD COLUMN collection_id SMALLINT REFERENCES challenge_collections(id);

ALTER TABLE game_sessions DROP CONSTRAINT game_sessions_mode_check;
ALTER TABLE game_sessions ADD CONSTRAINT game_sessions_mode_check
  CHECK (mode IN ('typing', 'recall', 'quick', 'real_shell', 'mixed', 'interview'));

CREATE INDEX challenge_collection_items_topic_idx
  ON challenge_collection_items (collection_id, topic, position);

CREATE INDEX game_sessions_collection_idx
  ON game_sessions (collection_id, started_at DESC)
  WHERE collection_id IS NOT NULL;
