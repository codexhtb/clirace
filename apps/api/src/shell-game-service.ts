import type { Dependencies } from './services.js';
import { finalizeCompletedSession } from './game-progression-service.js';

interface ShellTaskRow {
  task_id: string;
  session_id: string;
  user_id: string;
  challenge_id: string;
  difficulty: string;
  scoring_config: Record<string, unknown>;
  validation_config: Record<string, unknown>;
  presented_at: Date;
  attempt_count: number;
}

export interface ShellCompletion {
  scoreAwarded: number;
  gameCompleted: boolean;
}

export class ShellGameStateError extends Error {}

export async function recordFailedShellCheck(
  dependencies: Dependencies,
  gameSessionId: string,
  sessionTaskId: string,
  userId: string,
): Promise<void> {
  await dependencies.postgres.query(`
    UPDATE session_tasks st
    SET attempt_count = attempt_count + 1
    FROM game_sessions gs
    WHERE st.id = $1 AND st.game_session_id = $2
      AND gs.id = st.game_session_id AND gs.user_id = $3
      AND gs.status = 'active' AND st.status = 'active'
  `, [sessionTaskId, gameSessionId, userId]);
}

export async function completeShellTask(
  dependencies: Dependencies,
  gameSessionId: string,
  sessionTaskId: string,
  userId: string,
  sandboxChallengeId: string,
): Promise<ShellCompletion> {
  const client = await dependencies.postgres.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<ShellTaskRow>(`
      SELECT st.id AS task_id, gs.id AS session_id, gs.user_id, c.id AS challenge_id,
             c.difficulty, c.scoring_config, c.validation_config,
             st.presented_at, st.attempt_count
      FROM game_sessions gs
      JOIN session_tasks st ON st.game_session_id = gs.id
      JOIN challenges c ON c.id = st.challenge_id
      WHERE gs.id = $1 AND gs.user_id = $2 AND st.id = $3
        AND gs.status = 'active' AND st.status = 'active' AND c.type = 'real_shell'
      FOR UPDATE OF gs, st
    `, [gameSessionId, userId, sessionTaskId]);
    const task = result.rows[0];
    if (!task || task.validation_config.sandboxChallengeId !== sandboxChallengeId) {
      throw new ShellGameStateError('Shell task is no longer active.');
    }

    const durationMs = Math.max(0, Math.min(2_147_483_647, Date.now() - task.presented_at.getTime()));
    const scoreAwarded = calculateScore(task.scoring_config, task.difficulty, durationMs, task.attempt_count);
    await client.query(`
      UPDATE session_tasks
      SET status = 'correct', completed_at = now(), attempt_count = attempt_count + 1,
          score_awarded = $1, last_answer = '[sandbox state verified]'
      WHERE id = $2
    `, [scoreAwarded, task.task_id]);
    await client.query(`
      INSERT INTO results (session_task_id, user_id, correct, submitted_answer, duration_ms, mistakes, score_awarded)
      VALUES ($1, $2, true, '[sandbox state verified]', $3, $4, $5)
    `, [task.task_id, userId, durationMs, task.attempt_count, scoreAwarded]);
    await client.query(`
      UPDATE game_sessions
      SET score = score + $1, streak = streak + 1, best_streak = GREATEST(best_streak, streak + 1)
      WHERE id = $2
    `, [scoreAwarded, gameSessionId]);

    const next = await client.query<{ id: string }>(`
      SELECT id FROM session_tasks
      WHERE game_session_id = $1 AND status = 'pending'
      ORDER BY position LIMIT 1 FOR UPDATE
    `, [gameSessionId]);
    let gameCompleted = false;
    if (next.rows[0]) {
      await client.query(`UPDATE session_tasks SET status = 'active', presented_at = now() WHERE id = $1`, [next.rows[0].id]);
    } else {
      gameCompleted = true;
      await client.query(`UPDATE game_sessions SET status = 'completed', completed_at = now(), streak = 0 WHERE id = $1`, [gameSessionId]);
      await finalizeCompletedSession(client, gameSessionId, userId);
    }
    await client.query('COMMIT');
    return { scoreAwarded, gameCompleted };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function calculateScore(config: Record<string, unknown>, difficulty: string, durationMs: number, mistakes: number): number {
  const base = typeof config.base === 'number' ? config.base : 180;
  const target = typeof config.timeTargetMs === 'number' ? config.timeTargetMs : 90_000;
  const multiplier = ({ Easy: 1, Medium: 1.5, Hard: 2, Expert: 3 } as Record<string, number>)[difficulty] ?? 1;
  const speedRatio = Math.max(0, Math.min(1, (target - durationMs) / target));
  const attemptFactor = Math.max(0.2, 1 - mistakes * 0.15);
  return Math.max(1, Math.round((base + base * 0.5 * speedRatio) * multiplier * attemptFactor));
}
