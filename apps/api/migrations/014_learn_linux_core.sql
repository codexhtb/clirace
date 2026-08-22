CREATE TABLE learning_questions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_slug VARCHAR(60) NOT NULL,
  slug VARCHAR(120) NOT NULL,
  category_slug VARCHAR(60) NOT NULL,
  concept_slug VARCHAR(80) NOT NULL,
  difficulty VARCHAR(12) NOT NULL CHECK (difficulty IN ('easy', 'medium', 'hard')),
  question_type VARCHAR(24) NOT NULL CHECK (question_type IN ('single_choice', 'multiple_choice', 'scenario', 'command_output')),
  question_text TEXT NOT NULL,
  answer_options JSONB NOT NULL,
  correct_answer_ids JSONB NOT NULL,
  explanation TEXT NOT NULL,
  answer_explanations JSONB NOT NULL DEFAULT '{}'::jsonb,
  shell_practice_challenge_slug VARCHAR(100) REFERENCES challenges(slug) ON UPDATE CASCADE ON DELETE SET NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  content_version INTEGER NOT NULL DEFAULT 1 CHECK (content_version > 0),
  source_hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (course_slug, slug),
  CHECK (jsonb_typeof(answer_options) = 'array'),
  CHECK (jsonb_array_length(answer_options) >= 2),
  CHECK (jsonb_typeof(correct_answer_ids) = 'array'),
  CHECK (jsonb_array_length(correct_answer_ids) >= 1),
  CHECK (jsonb_typeof(answer_explanations) = 'object')
);

CREATE TABLE learning_sessions (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_slug VARCHAR(60) NOT NULL,
  mode VARCHAR(16) NOT NULL CHECK (mode IN ('quick', 'standard', 'full', 'topic')),
  category_filter VARCHAR(60),
  requested_count SMALLINT NOT NULL CHECK (requested_count > 0),
  total_questions SMALLINT NOT NULL CHECK (total_questions > 0),
  current_position SMALLINT NOT NULL DEFAULT 1 CHECK (current_position > 0),
  correct_count SMALLINT NOT NULL DEFAULT 0 CHECK (correct_count >= 0),
  score_percent SMALLINT CHECK (score_percent BETWEEN 0 AND 100),
  status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'abandoned')),
  category_stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  concept_stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX learning_one_active_session_per_course_idx
  ON learning_sessions (user_id, course_slug)
  WHERE status = 'active';

CREATE INDEX learning_sessions_user_idx
  ON learning_sessions (user_id, started_at DESC);

CREATE INDEX learning_questions_catalog_idx
  ON learning_questions (course_slug, category_slug, difficulty)
  WHERE enabled;

CREATE TABLE learning_session_questions (
  session_id UUID NOT NULL REFERENCES learning_sessions(id) ON DELETE CASCADE,
  question_id BIGINT NOT NULL REFERENCES learning_questions(id),
  position SMALLINT NOT NULL CHECK (position > 0),
  option_order JSONB NOT NULL,
  content_snapshot JSONB NOT NULL,
  selected_answer_ids JSONB,
  is_correct BOOLEAN,
  answered_at TIMESTAMPTZ,
  PRIMARY KEY (session_id, position),
  UNIQUE (session_id, question_id),
  CHECK (jsonb_typeof(option_order) = 'array'),
  CHECK (jsonb_typeof(content_snapshot) = 'object'),
  CHECK (selected_answer_ids IS NULL OR jsonb_typeof(selected_answer_ids) = 'array'),
  CHECK ((answered_at IS NULL AND selected_answer_ids IS NULL AND is_correct IS NULL)
      OR (answered_at IS NOT NULL AND selected_answer_ids IS NOT NULL AND is_correct IS NOT NULL))
);

CREATE INDEX learning_session_questions_question_idx
  ON learning_session_questions (question_id);
