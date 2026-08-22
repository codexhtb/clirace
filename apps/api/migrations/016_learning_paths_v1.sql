CREATE TABLE learning_courses (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug VARCHAR(80) NOT NULL UNIQUE,
  title VARCHAR(160) NOT NULL,
  description TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  enabled BOOLEAN NOT NULL DEFAULT true,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  estimated_minutes INTEGER NOT NULL CHECK (estimated_minutes > 0),
  level VARCHAR(24) NOT NULL,
  prerequisites JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(prerequisites) = 'array')
);

CREATE TABLE learning_modules (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_id BIGINT NOT NULL REFERENCES learning_courses(id) ON DELETE CASCADE,
  slug VARCHAR(80) NOT NULL,
  title VARCHAR(160) NOT NULL,
  description TEXT NOT NULL,
  sort_order SMALLINT NOT NULL CHECK (sort_order > 0),
  prerequisite_slugs JSONB NOT NULL DEFAULT '[]'::jsonb,
  estimated_minutes INTEGER NOT NULL CHECK (estimated_minutes > 0),
  completion_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL CHECK (version > 0),
  enabled BOOLEAN NOT NULL DEFAULT true,
  source_hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (course_id, slug),
  UNIQUE (course_id, sort_order),
  CHECK (jsonb_typeof(prerequisite_slugs) = 'array'),
  CHECK (jsonb_typeof(completion_config) = 'object')
);

CREATE TABLE learning_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  module_id BIGINT NOT NULL REFERENCES learning_modules(id) ON DELETE CASCADE,
  stable_id VARCHAR(120) NOT NULL UNIQUE,
  slug VARCHAR(80) NOT NULL,
  title VARCHAR(160) NOT NULL,
  item_type VARCHAR(24) NOT NULL CHECK (item_type IN ('theory','knowledge_check','practice','shell_lab','checkpoint')),
  sort_order SMALLINT NOT NULL CHECK (sort_order > 0),
  category_slug VARCHAR(60),
  concept_slug VARCHAR(80),
  reference_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  theory_content JSONB,
  completion_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL CHECK (version > 0),
  enabled BOOLEAN NOT NULL DEFAULT true,
  source_hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (module_id, slug),
  UNIQUE (module_id, sort_order),
  CHECK (jsonb_typeof(reference_config) = 'object'),
  CHECK (theory_content IS NULL OR jsonb_typeof(theory_content) = 'array'),
  CHECK (jsonb_typeof(completion_config) = 'object')
);

CREATE TABLE learning_enrollments (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id BIGINT NOT NULL REFERENCES learning_courses(id),
  course_version_started INTEGER NOT NULL CHECK (course_version_started > 0),
  status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed')),
  current_module_id BIGINT REFERENCES learning_modules(id),
  current_item_id BIGINT REFERENCES learning_items(id),
  progress_percent SMALLINT NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  final_score SMALLINT CHECK (final_score BETWEEN 0 AND 100),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, course_id)
);

CREATE TABLE learning_item_progress (
  enrollment_id UUID NOT NULL REFERENCES learning_enrollments(id) ON DELETE CASCADE,
  item_id BIGINT NOT NULL REFERENCES learning_items(id),
  status VARCHAR(16) NOT NULL CHECK (status IN ('started','failed','completed')),
  score_percent SMALLINT CHECK (score_percent BETWEEN 0 AND 100),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (enrollment_id, item_id),
  CHECK (jsonb_typeof(evidence) = 'object')
);

CREATE TABLE learning_module_results (
  enrollment_id UUID NOT NULL REFERENCES learning_enrollments(id) ON DELETE CASCADE,
  module_id BIGINT NOT NULL REFERENCES learning_modules(id),
  knowledge_score SMALLINT CHECK (knowledge_score BETWEEN 0 AND 100),
  practice_score SMALLINT CHECK (practice_score BETWEEN 0 AND 100),
  lab_score SMALLINT CHECK (lab_score BETWEEN 0 AND 100),
  checkpoint_score SMALLINT CHECK (checkpoint_score BETWEEN 0 AND 100),
  mastery_score SMALLINT CHECK (mastery_score BETWEEN 0 AND 100),
  recommendations JSONB NOT NULL DEFAULT '[]'::jsonb,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (enrollment_id, module_id),
  CHECK (jsonb_typeof(recommendations) = 'array')
);

CREATE TABLE learning_course_results (
  enrollment_id UUID PRIMARY KEY REFERENCES learning_enrollments(id) ON DELETE CASCADE,
  knowledge_score SMALLINT NOT NULL CHECK (knowledge_score BETWEEN 0 AND 100),
  practice_score SMALLINT NOT NULL CHECK (practice_score BETWEEN 0 AND 100),
  lab_score SMALLINT NOT NULL CHECK (lab_score BETWEEN 0 AND 100),
  checkpoint_score SMALLINT NOT NULL CHECK (checkpoint_score BETWEEN 0 AND 100),
  overall_score SMALLINT NOT NULL CHECK (overall_score BETWEEN 0 AND 100),
  strong_areas JSONB NOT NULL DEFAULT '[]'::jsonb,
  weak_areas JSONB NOT NULL DEFAULT '[]'::jsonb,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(strong_areas) = 'array'),
  CHECK (jsonb_typeof(weak_areas) = 'array')
);

CREATE TABLE learning_mastery (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_slug VARCHAR(60) NOT NULL,
  concept_slug VARCHAR(80) NOT NULL DEFAULT '',
  evidence_count INTEGER NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
  score SMALLINT CHECK (score BETWEEN 0 AND 100),
  sufficient_data BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category_slug, concept_slug)
);

ALTER TABLE learning_sessions
  ADD COLUMN learning_path_item_id BIGINT REFERENCES learning_items(id) ON DELETE SET NULL,
  ADD COLUMN learning_enrollment_id UUID REFERENCES learning_enrollments(id) ON DELETE SET NULL;

CREATE INDEX learning_modules_course_idx ON learning_modules (course_id, sort_order) WHERE enabled;
CREATE INDEX learning_items_module_idx ON learning_items (module_id, sort_order) WHERE enabled;
CREATE INDEX learning_enrollments_user_idx ON learning_enrollments (user_id, last_activity_at DESC);
CREATE INDEX learning_item_progress_item_idx ON learning_item_progress (item_id, status);
CREATE INDEX learning_sessions_path_item_idx ON learning_sessions (learning_path_item_id, user_id, started_at DESC)
  WHERE learning_path_item_id IS NOT NULL;
