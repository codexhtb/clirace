-- Sandbox Platform V2 lifecycle metadata. Existing status is retained for
-- backwards-compatible reporting; lifecycle_state is the authoritative state.
ALTER TABLE sandbox_sessions
  ADD COLUMN lifecycle_state VARCHAR(16) NOT NULL DEFAULT 'terminated'
    CHECK (lifecycle_state IN ('requested', 'queued', 'starting', 'ready', 'attached', 'idle', 'terminating', 'terminated', 'failed')),
  ADD COLUMN status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN last_activity_at TIMESTAMPTZ,
  ADD COLUMN failure_code VARCHAR(64),
  ADD COLUMN termination_reason VARCHAR(64);

UPDATE sandbox_sessions
SET lifecycle_state = CASE
  WHEN status = 'pending' AND expires_at > now() THEN 'requested'
  WHEN status = 'active' AND expires_at > now() THEN 'attached'
  WHEN status = 'failed' THEN 'failed'
  ELSE 'terminated'
END,
status_changed_at = now();

DROP INDEX IF EXISTS sandbox_one_live_session_per_user_idx;

DROP INDEX IF EXISTS sandbox_sessions_expires_idx;
CREATE INDEX sandbox_sessions_live_expiry_idx
  ON sandbox_sessions (expires_at)
  WHERE lifecycle_state IN ('requested', 'queued', 'starting', 'ready', 'attached', 'idle', 'terminating');

CREATE INDEX sandbox_sessions_user_live_idx
  ON sandbox_sessions (user_id, lifecycle_state)
  WHERE user_id IS NOT NULL
    AND lifecycle_state IN ('requested', 'queued', 'starting', 'ready', 'attached', 'idle', 'terminating');

-- Correct a production mismatch: the checker has always required /workspace/app.
UPDATE challenges
SET description = 'Создайте /workspace/app и установите права 750.',
    updated_at = now()
WHERE slug = 'linux-directory-mode'
  AND validation_config->>'sandboxChallengeId' = 'directory-mode';
