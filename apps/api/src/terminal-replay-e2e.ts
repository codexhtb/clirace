import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { closeDependencies, connectDependencies, createDependencies } from './services.js';
import { TerminalReplayRecorder } from './terminal-replay-recorder.js';
import { TerminalReplayService } from './terminal-replay-service.js';

const dependencies = createDependencies(loadConfig());
await connectDependencies(dependencies);
const service = new TerminalReplayService(dependencies);
const suffix = randomUUID().slice(0, 8);
const usernames = [`replay_db_a_${suffix}`, `replay_db_b_${suffix}`];

try {
  const users: string[] = [];
  for (const username of usernames) {
    const result = await dependencies.postgres.query<{ id: string }>(`
      INSERT INTO users (username, username_normalized, email, email_normalized, password_hash)
      VALUES ($1,$1,$2,$2,'terminal-replay-e2e-not-a-login') RETURNING id
    `, [username, `${username}@replay-e2e.invalid`]);
    users.push(result.rows[0]!.id);
  }
  const challenge = await dependencies.postgres.query<{ id: string }>("SELECT id FROM challenges WHERE slug = 'shell-secure-secret'");
  assert.ok(challenge.rows[0]);

  async function fixture(position: number) {
    const gameSessionId = randomUUID();
    const sandboxSessionId = randomUUID();
    await dependencies.postgres.query(`
      INSERT INTO game_sessions (id,user_id,mode,status,completed_at) VALUES ($1,$2,'real_shell','completed',now())
    `, [gameSessionId, users[0]]);
    const task = await dependencies.postgres.query<{ id: string }>(`
      INSERT INTO session_tasks (game_session_id,challenge_id,position,status,presented_at,completed_at)
      VALUES ($1,$2,$3,'correct',now(),now()) RETURNING id
    `, [gameSessionId, challenge.rows[0]!.id, position]);
    await dependencies.postgres.query(`
      INSERT INTO sandbox_sessions (id,user_id,game_session_id,challenge_id,status,lifecycle_state,expires_at,destroyed_at)
      VALUES ($1,$2,$3,$4,'completed','terminated',now() + interval '1 hour',now())
    `, [sandboxSessionId, users[0], gameSessionId, challenge.rows[0]!.id]);
    const recorder = new TerminalReplayRecorder(100, 28);
    recorder.recordOutput(Buffer.from('\u001b[32mREPLAY_DB_FIXTURE\u001b[0m\r\n'));
    recorder.recordChecker({ status: 'passed', checks: [{ id: 'secret-mode', status: 'passed' }] });
    const id = await service.persistCompleted({
      recorder, userId: users[0]!, gameSessionId, sessionTaskId: task.rows[0]!.id,
      sandboxSessionId, challengeId: challenge.rows[0]!.id, scoreAwarded: 10, gameCompleted: true,
    });
    return { id, gameSessionId, taskId: task.rows[0]!.id };
  }

  const expired = await fixture(1);
  assert.ok(await service.getOwned(expired.id, users[0]!));
  assert.equal(await service.getOwned(expired.id, users[1]!), undefined);
  await dependencies.postgres.query("UPDATE terminal_replays SET expires_at = now() - interval '1 second' WHERE id = $1", [expired.id]);
  assert.equal(await service.getOwned(expired.id, users[0]!), undefined);
  assert.ok(await service.cleanupExpired() >= 1);
  assert.equal((await dependencies.postgres.query('SELECT id FROM terminal_replays WHERE id = $1', [expired.id])).rowCount, 0);

  const deletable = await fixture(1);
  await service.deleteOwned(deletable.id, users[1]!);
  assert.ok(await service.getOwned(deletable.id, users[0]!));
  await service.deleteOwned(deletable.id, users[0]!);
  assert.equal(await service.getOwned(deletable.id, users[0]!), undefined);

  console.log(JSON.stringify({ ok: true, ownerIsolation: true, expiryReadGuard: true, janitorCleanup: true, ownerDelete: true }, null, 2));
} finally {
  await dependencies.postgres.query('DELETE FROM users WHERE username = ANY($1::text[])', [usernames]).catch(() => undefined);
  await closeDependencies(dependencies);
}
