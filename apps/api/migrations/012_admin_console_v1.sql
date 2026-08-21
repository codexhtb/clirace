-- CLIRace Operations Console V1. Existing accounts remain active users.
ALTER TABLE users
  ADD COLUMN role VARCHAR(16) NOT NULL DEFAULT 'user'
    CHECK (role IN ('user', 'admin')),
  ADD COLUMN account_status VARCHAR(16) NOT NULL DEFAULT 'active'
    CHECK (account_status IN ('active', 'suspended')),
  ADD COLUMN suspended_at TIMESTAMPTZ,
  ADD COLUMN suspended_by BIGINT REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX users_admin_search_idx ON users (role, account_status, created_at DESC);
CREATE INDEX users_last_login_idx ON users (last_login_at DESC) WHERE last_login_at IS NOT NULL;

CREATE TABLE admin_audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(80) NOT NULL,
  target_type VARCHAR(40) NOT NULL,
  target_id VARCHAR(128),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  client_ip INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX admin_audit_log_created_idx ON admin_audit_log (created_at DESC, id DESC);
CREATE INDEX admin_audit_log_actor_idx ON admin_audit_log (actor_user_id, created_at DESC);
CREATE INDEX admin_audit_log_action_idx ON admin_audit_log (action, target_type, created_at DESC);

CREATE TABLE admin_integrity_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source VARCHAR(40) NOT NULL,
  total INTEGER NOT NULL CHECK (total >= 0),
  passed INTEGER NOT NULL CHECK (passed >= 0),
  failed INTEGER NOT NULL CHECK (failed >= 0),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  failed_challenge_ids TEXT[] NOT NULL DEFAULT '{}'::text[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (passed + failed = total)
);

CREATE INDEX admin_integrity_runs_created_idx ON admin_integrity_runs (created_at DESC, id DESC);
