import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { AuthService, type AuthUser } from './auth-service.js';
import { BattleManager } from './battle-service.js';
import { loadConfig } from './config.js';
import { MatchmakingManager } from './matchmaking-service.js';
import { MatchmakingStore } from './matchmaking-store.js';
import { runMigrations } from './migrations.js';
import { hashPassword } from './password.js';
import { SandboxManager } from './sandbox-manager.js';
import { closeDependencies, connectDependencies, createDependencies } from './services.js';

interface InjectResult {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  json<T = unknown>(): T;
}

interface FixtureUser extends AuthUser { cookie: string }

async function main(): Promise<void> {
  const config = loadConfig();
  const dependencies = createDependencies(config);
  await connectDependencies(dependencies);
  await runMigrations(dependencies.postgres);
  const prefix = `clirace:mm:e2e:${process.pid}:${Date.now()}`;
  const lowPrefix = `${prefix}:capacity`;
  const sandboxManager = new SandboxManager(config, dependencies);
  const battleManager = new BattleManager(config, dependencies, sandboxManager);
  const matchmakingManager = new MatchmakingManager(config, dependencies, sandboxManager, battleManager, { redisPrefix: prefix });
  const app = buildApp({ config, dependencies, sandboxManager, battleManager, matchmakingManager });
  await app.ready();

  const suffix = `${Date.now()}${randomBytes(3).toString('hex')}`;
  const password = `Match-E2E-${randomBytes(12).toString('base64url')}`;
  const createdUserIds: string[] = [];
  const stores = [new MatchmakingStore(dependencies.redis, prefix), new MatchmakingStore(dependencies.redis, lowPrefix)];

  try {
    const users = await createUsers(app, dependencies, suffix, password, 8);
    createdUserIds.push(...users.map((user) => user.id));
    const [a, b, c, d, e, f, g, h] = users;
    assert(a && b && c && d && e && f && g && h, 'temporary users missing');

    equal((await inject(app, 'POST', '/api/matchmaking/queue')).statusCode, 401, 'unauthenticated enqueue');

    const firstEnqueue = await inject(app, 'POST', '/api/matchmaking/queue', a.cookie);
    const duplicateEnqueue = await inject(app, 'POST', '/api/matchmaking/queue', a.cookie);
    equal(firstEnqueue.statusCode, 200, 'first enqueue');
    equal(duplicateEnqueue.statusCode, 200, 'duplicate enqueue');
    equal(firstEnqueue.json<{ queuedAt: string }>().queuedAt, duplicateEnqueue.json<{ queuedAt: string }>().queuedAt, 'duplicate enqueue preserves entry');
    equal((await inject(app, 'GET', '/api/matchmaking/status', a.cookie)).json<{ status: string }>().status, 'searching', 'search reconnect');

    equal((await inject(app, 'POST', '/api/matchmaking/queue', b.cookie)).statusCode, 200, 'second enqueue');
    const statusA = (await inject(app, 'GET', '/api/matchmaking/status', a.cookie)).json<{ status: string; battleId: string; roomCode: string }>();
    const statusB = (await inject(app, 'GET', '/api/matchmaking/status', b.cookie)).json<{ status: string; battleId: string; roomCode: string }>();
    equal(statusA.status, 'matched', 'first user matched');
    equal(statusB.status, 'matched', 'second user matched');
    equal(statusA.battleId, statusB.battleId, 'both users share one Battle');
    equal(statusA.roomCode, statusB.roomCode, 'both users share one room');
    const pairCount = await dependencies.postgres.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM battles WHERE id = $1 AND matchmaking_pool = 'quick'
    `, [statusA.battleId]);
    equal(pairCount.rows[0]?.count, 1, 'exactly one existing Battle persisted');

    const privateBattle = await inject(app, 'POST', '/api/battles', c.cookie, { rounds: 3, category: 'all' });
    equal(privateBattle.statusCode, 201, 'private active Battle fixture');
    const activeRejected = await inject(app, 'POST', '/api/matchmaking/queue', c.cookie);
    equal(activeRejected.statusCode, 409, 'active Battle enqueue rejected');
    equal(activeRejected.json<{ code: string }>().code, 'active_battle', 'active Battle machine code');

    await dependencies.postgres.query(`UPDATE users SET account_status = 'suspended' WHERE id = $1`, [d.id]);
    const suspended = await inject(app, 'POST', '/api/matchmaking/queue', d.cookie);
    equal(suspended.statusCode, 401, 'suspended user rejected');

    const lowConfig = { ...config, SANDBOX_MAX_SESSIONS: 1 };
    const lowSandbox = new SandboxManager(lowConfig, dependencies);
    const lowMatchmaking = new MatchmakingManager(lowConfig, dependencies, lowSandbox, battleManager, { redisPrefix: lowPrefix });
    await lowMatchmaking.enqueue(e);
    const lowStatus = await lowMatchmaking.enqueue(f);
    equal(lowStatus.status, 'searching', 'capacity shortage keeps user searching');
    assert(lowStatus.status === 'searching' && lowStatus.waitingCapacity, 'capacity state is machine-readable');
    await lowMatchmaking.close();

    equal((await inject(app, 'POST', '/api/matchmaking/queue', f.cookie)).statusCode, 200, 'failure fixture queued');
    await battleManager.createBattle(f, 3, 'all');
    equal((await inject(app, 'POST', '/api/matchmaking/queue', g.cookie)).statusCode, 200, 'opponent enqueue survives creation rejection');
    const recovered = (await inject(app, 'GET', '/api/matchmaking/status', g.cookie)).json<{ status: string }>();
    equal(recovered.status, 'searching', 'Battle creation failure does not leave opponent stuck');

    equal((await inject(app, 'POST', '/api/matchmaking/queue', h.cookie)).statusCode, 200, 'suspension cleanup fixture queued');
    await matchmakingManager.removeUser(h.id, 'suspended');
    equal((await inject(app, 'GET', '/api/matchmaking/status', h.cookie)).json<{ status: string }>().status, 'idle', 'suspension removes queue entry');

    console.log(JSON.stringify({
      ok: true,
      checks: 22,
      exactlyOneBattle: statusA.battleId,
      duplicateEnqueue: 'idempotent',
      reconnect: 'restored',
      activeBattle: 'rejected',
      suspendedUser: 'rejected',
      capacity: 'waiting_capacity',
      creationFailure: 'requeued',
    }, null, 2));
  } finally {
    await Promise.allSettled(stores.map((store) => store.clearForTest()));
    const auth = new AuthService(config, dependencies);
    await Promise.allSettled(createdUserIds.map((userId) => auth.revokeAllSessions(userId)));
    if (createdUserIds.length) {
      await dependencies.postgres.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [createdUserIds]).catch(() => undefined);
    }
    await app.close();
    await closeDependencies(dependencies);
  }
}

async function createUsers(
  app: FastifyInstance,
  dependencies: ReturnType<typeof createDependencies>,
  suffix: string,
  password: string,
  count: number,
): Promise<FixtureUser[]> {
  const passwordHash = await hashPassword(password);
  const users: FixtureUser[] = [];
  for (let index = 0; index < count; index += 1) {
    const username = `mm${index}${suffix}`.slice(0, 24);
    const email = `${username}@e2e.invalid`;
    const inserted = await dependencies.postgres.query<{
      id: string; username: string; email: string; created_at: Date;
      role: 'user' | 'admin'; account_status: 'active' | 'suspended';
    }>(`
      INSERT INTO users (username, username_normalized, email, email_normalized, password_hash)
      VALUES ($1::varchar, lower($1::text), $2::varchar, lower($2::text), $3)
      RETURNING id, username, email, created_at, role, account_status
    `, [username, email, passwordHash]);
    const row = inserted.rows[0]!;
    await dependencies.postgres.query('INSERT INTO user_ratings (user_id, category_id) VALUES ($1, NULL)', [row.id]);
    await dependencies.postgres.query('INSERT INTO user_progress (user_id) VALUES ($1)', [row.id]);
    const cookie = await login(app, username, password);
    users.push({
      id: row.id, username: row.username, email: row.email, createdAt: row.created_at.toISOString(),
      role: row.role, accountStatus: row.account_status, cookie,
    });
  }
  return users;
}

async function login(app: FastifyInstance, identifier: string, password: string): Promise<string> {
  const response = await inject(app, 'POST', '/api/auth/login', undefined, { identifier, password });
  equal(response.statusCode, 200, `login ${identifier}`);
  const header = response.headers['set-cookie'];
  const cookie = (Array.isArray(header) ? header[0] : header)?.split(';')[0];
  assert(cookie, 'login did not return a session cookie');
  return cookie;
}

async function inject(
  app: FastifyInstance,
  method: 'GET' | 'POST',
  url: string,
  cookie?: string,
  payload?: unknown,
): Promise<InjectResult> {
  return await app.inject({
    method,
    url,
    headers: { host: 'localhost', origin: 'http://localhost', ...(cookie ? { cookie } : {}) },
    ...(payload ? { payload } : {}),
  }) as unknown as InjectResult;
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Matchmaking E2E failed: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(`Matchmaking E2E failed: ${message}; expected ${String(expected)}, got ${String(actual)}`);
}

if (process.argv[1]?.endsWith('matchmaking-e2e.js')) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
