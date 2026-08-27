import assert from 'node:assert/strict';
import { completeShellTask, recordFailedShellCheck, ShellGameStateError } from '../apps/api/src/shell-game-service.js';
import type { Dependencies } from '../apps/api/src/services.js';

interface QueryRecord { sql: string; values?: readonly unknown[] }

function dependenciesWithTask(task: Record<string, unknown> | undefined, withPending = false) {
  const queries: QueryRecord[] = [];
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      queries.push({ sql, values });
      if (sql.includes('SELECT st.id AS task_id')) return { rows: task ? [task] : [] };
      if (sql.includes("status = 'pending'")) return { rows: withPending ? [{ id: 'task-next' }] : [] };
      return { rows: [] };
    },
    release() {},
  };
  const postgres = {
    connect: async () => client,
    async query(sql: string, values?: readonly unknown[]) {
      queries.push({ sql, values });
      return { rows: [] };
    },
  };
  return { dependencies: { postgres } as unknown as Dependencies, queries };
}

const activeTask = {
  task_id: 'task-1', session_id: 'game-1', user_id: 'user-1', challenge_id: 'challenge-db-1',
  difficulty: 'Easy', scoring_config: { base: 100, timeTargetMs: 90_000 },
  validation_config: { sandboxChallengeId: 'secure-secret' }, presented_at: new Date(), attempt_count: 0,
  task_status: 'active', session_status: 'active', score_awarded: 0,
};

{
  const { dependencies, queries } = dependenciesWithTask({ ...activeTask, task_status: 'correct', score_awarded: 137 });
  const result = await completeShellTask(dependencies, 'game-1', 'task-1', 'user-1', 'secure-secret');
  assert.deepEqual(result, { scoreAwarded: 137, gameCompleted: false, alreadyCompleted: true });
  assert.equal(queries.filter((query) => /UPDATE session_tasks|INSERT INTO results|SET score = score/.test(query.sql)).length, 0);
  assert.ok(queries.some((query) => query.sql.includes('FOR UPDATE OF gs, st')));
  console.log('ok 1 - repeated completion is idempotent and lock-protected');
}

{
  const { dependencies, queries } = dependenciesWithTask(activeTask, true);
  const result = await completeShellTask(dependencies, 'game-1', 'task-1', 'user-1', 'secure-secret');
  assert.ok(result.scoreAwarded > 0);
  assert.equal(result.gameCompleted, false);
  assert.equal(queries.filter((query) => query.sql.includes('INSERT INTO results')).length, 1);
  assert.equal(queries.filter((query) => query.sql.includes('SET score = score')).length, 1);
  assert.ok(queries.some((query) => query.sql.includes("SET status = 'active', presented_at = now()")));
  console.log('ok 2 - first completion writes once and activates the existing next task');
}

{
  const { dependencies, queries } = dependenciesWithTask(undefined);
  await assert.rejects(
    completeShellTask(dependencies, 'game-1', 'task-1', 'other-user', 'secure-secret'),
    ShellGameStateError,
  );
  assert.ok(queries.some((query) => query.sql === 'ROLLBACK'));
  console.log('ok 3 - wrong user cannot complete a task');
}

{
  const { dependencies, queries } = dependenciesWithTask(activeTask);
  await assert.rejects(
    completeShellTask(dependencies, 'game-1', 'task-1', 'user-1', 'another-challenge'),
    ShellGameStateError,
  );
  assert.equal(queries.filter((query) => query.sql.includes('INSERT INTO results')).length, 0);
  console.log('ok 4 - mismatched trusted challenge cannot complete a task');
}

{
  const { dependencies, queries } = dependenciesWithTask(undefined);
  await recordFailedShellCheck(dependencies, 'game-1', 'task-1', 'user-1');
  const update = queries[0];
  assert.deepEqual(update?.values, ['task-1', 'game-1', 'user-1']);
  assert.match(update?.sql ?? '', /gs\.status = 'active' AND st\.status = 'active'/);
  console.log('ok 5 - failed attempts are scoped to the exact active user/game/task');
}

console.log('shell-completion: 5/5 checks passed');
