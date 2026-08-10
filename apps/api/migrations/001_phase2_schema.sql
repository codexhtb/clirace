CREATE TABLE users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username VARCHAR(24) NOT NULL,
  username_normalized VARCHAR(24) NOT NULL UNIQUE,
  email VARCHAR(254) NOT NULL,
  email_normalized VARCHAR(254) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE categories (
  id SMALLINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug VARCHAR(40) NOT NULL UNIQUE,
  name VARCHAR(80) NOT NULL,
  description TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE challenges (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug VARCHAR(100) NOT NULL UNIQUE,
  title VARCHAR(160) NOT NULL,
  description TEXT NOT NULL,
  category_id SMALLINT NOT NULL REFERENCES categories(id),
  difficulty VARCHAR(12) NOT NULL CHECK (difficulty IN ('Easy', 'Medium', 'Hard', 'Expert')),
  type VARCHAR(16) NOT NULL CHECK (type IN ('typing', 'recall', 'quick', 'real_shell')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  scoring_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  validation_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE challenge_answers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  challenge_id BIGINT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  answer TEXT NOT NULL,
  normalized_answer TEXT NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (challenge_id, normalized_answer)
);

CREATE TABLE challenge_checks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  challenge_id BIGINT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  check_type VARCHAR(40) NOT NULL,
  config JSONB NOT NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0
);

CREATE TABLE game_sessions (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id SMALLINT REFERENCES categories(id),
  difficulty VARCHAR(12) CHECK (difficulty IN ('Easy', 'Medium', 'Hard', 'Expert')),
  mode VARCHAR(16) NOT NULL CHECK (mode IN ('typing', 'recall', 'quick', 'real_shell', 'mixed')),
  status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'abandoned', 'expired')),
  score INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0),
  streak INTEGER NOT NULL DEFAULT 0 CHECK (streak >= 0),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE session_tasks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  game_session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  challenge_id BIGINT NOT NULL REFERENCES challenges(id),
  position SMALLINT NOT NULL CHECK (position > 0),
  status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'correct', 'wrong', 'skipped')),
  presented_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (game_session_id, position)
);

CREATE TABLE results (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_task_id BIGINT NOT NULL UNIQUE REFERENCES session_tasks(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  correct BOOLEAN NOT NULL,
  submitted_answer TEXT,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  mistakes SMALLINT NOT NULL DEFAULT 0 CHECK (mistakes >= 0),
  hints_used SMALLINT NOT NULL DEFAULT 0 CHECK (hints_used >= 0),
  score_awarded INTEGER NOT NULL DEFAULT 0 CHECK (score_awarded >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_ratings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id SMALLINT REFERENCES categories(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL DEFAULT 1000 CHECK (rating >= 0),
  games_played INTEGER NOT NULL DEFAULT 0 CHECK (games_played >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (user_id, category_id)
);

CREATE TABLE sandbox_sessions (
  id UUID PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  game_session_id UUID REFERENCES game_sessions(id) ON DELETE SET NULL,
  challenge_id BIGINT REFERENCES challenges(id) ON DELETE SET NULL,
  container_id VARCHAR(128),
  status VARCHAR(16) NOT NULL CHECK (status IN ('pending', 'active', 'completed', 'expired', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  destroyed_at TIMESTAMPTZ
);

CREATE TABLE daily_challenges (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  challenge_date DATE NOT NULL UNIQUE,
  challenge_id BIGINT NOT NULL REFERENCES challenges(id),
  bonus_multiplier NUMERIC(4,2) NOT NULL DEFAULT 1.00 CHECK (bonus_multiplier >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX challenges_catalog_idx ON challenges (category_id, difficulty, type) WHERE enabled;
CREATE INDEX results_user_created_idx ON results (user_id, created_at DESC);
CREATE INDEX game_sessions_user_started_idx ON game_sessions (user_id, started_at DESC);
CREATE INDEX sandbox_sessions_expires_idx ON sandbox_sessions (expires_at) WHERE status IN ('pending', 'active');
