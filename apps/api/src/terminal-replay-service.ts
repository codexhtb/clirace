import { randomUUID } from 'node:crypto';
import type { Dependencies } from './services.js';
import { REPLAY_FORMAT_VERSION, REPLAY_RETENTION_DAYS, terminalReplayV1Schema, type TerminalReplayV1 } from './terminal-replay-format.js';
import type { TerminalReplayRecorder } from './terminal-replay-recorder.js';

interface PersistReplayInput {
  recorder: TerminalReplayRecorder;
  userId: string;
  gameSessionId: string;
  sessionTaskId: string;
  sandboxSessionId: string;
  challengeId: string;
  scoreAwarded: number;
  gameCompleted: boolean;
}

export interface PublicTerminalReplay {
  id: string;
  challenge: { slug: string; title: string };
  durationMs: number;
  eventCount: number;
  sizeBytes: number;
  truncated: boolean;
  createdAt: string;
  completedAt: string;
  expiresAt: string;
  payload: TerminalReplayV1;
}

export class TerminalReplayService {
  constructor(private readonly dependencies: Dependencies) {}

  async persistCompleted(input: PersistReplayInput): Promise<string> {
    const finalized = input.recorder.finalize(input.scoreAwarded, input.gameCompleted);
    const id = randomUUID();
    const result = await this.dependencies.postgres.query<{ id: string }>(`
      INSERT INTO terminal_replays (
        id, user_id, game_session_id, session_task_id, sandbox_session_id, challenge_id,
        format_version, duration_ms, event_count, size_bytes, truncated, payload,
        completed_at, expires_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),now() + ($13 * interval '1 day'))
      ON CONFLICT (session_task_id) DO NOTHING
      RETURNING id
    `, [
      id, input.userId, input.gameSessionId, input.sessionTaskId, input.sandboxSessionId, input.challengeId,
      REPLAY_FORMAT_VERSION, finalized.durationMs, finalized.eventCount, finalized.sizeBytes,
      finalized.truncated, JSON.stringify(finalized.payload), REPLAY_RETENTION_DAYS,
    ]);
    if (result.rows[0]) return result.rows[0].id;
    const existing = await this.dependencies.postgres.query<{ id: string }>(`
      SELECT id FROM terminal_replays WHERE session_task_id = $1 AND user_id = $2
    `, [input.sessionTaskId, input.userId]);
    if (!existing.rows[0]) throw new Error('Replay idempotency lookup failed.');
    return existing.rows[0].id;
  }

  async getOwned(replayId: string, userId: string): Promise<PublicTerminalReplay | undefined> {
    const result = await this.dependencies.postgres.query<{
      id: string; slug: string; title: string; format_version: number; duration_ms: number;
      event_count: number; size_bytes: number; truncated: boolean; payload: unknown;
      created_at: Date; completed_at: Date; expires_at: Date;
    }>(`
      SELECT tr.id, c.slug, c.title, tr.format_version, tr.duration_ms, tr.event_count,
             tr.size_bytes, tr.truncated, tr.payload, tr.created_at, tr.completed_at, tr.expires_at
      FROM terminal_replays tr
      JOIN challenges c ON c.id = tr.challenge_id
      WHERE tr.id = $1 AND tr.user_id = $2 AND tr.expires_at > now()
    `, [replayId, userId]);
    const row = result.rows[0];
    if (!row) return undefined;
    if (row.format_version !== REPLAY_FORMAT_VERSION) throw new UnsupportedReplayFormatError();
    const payload = terminalReplayV1Schema.safeParse(row.payload);
    if (!payload.success) throw new InvalidReplayPayloadError();
    return {
      id: row.id,
      challenge: { slug: row.slug, title: row.title },
      durationMs: row.duration_ms,
      eventCount: row.event_count,
      sizeBytes: row.size_bytes,
      truncated: row.truncated,
      createdAt: row.created_at.toISOString(),
      completedAt: row.completed_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      payload: payload.data,
    };
  }

  async deleteOwned(replayId: string, userId: string): Promise<void> {
    await this.dependencies.postgres.query('DELETE FROM terminal_replays WHERE id = $1 AND user_id = $2', [replayId, userId]);
  }

  async cleanupExpired(): Promise<number> {
    const result = await this.dependencies.postgres.query('DELETE FROM terminal_replays WHERE expires_at <= now()');
    return result.rowCount ?? 0;
  }
}

export class UnsupportedReplayFormatError extends Error {}
export class InvalidReplayPayloadError extends Error {}

