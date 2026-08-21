import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { setAdminRole } from './admin-role-cli.js';
import { buildApp } from './app.js';
import { BattleManager } from './battle-service.js';
import { loadConfig } from './config.js';
import { hashPassword } from './password.js';
import { SandboxManager } from './sandbox-manager.js';
import { closeDependencies, connectDependencies, createDependencies } from './services.js';

interface InjectResult {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  json<T = unknown>(): T;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const dependencies = createDependencies(config);
  await connectDependencies(dependencies);
  const sandboxManager = new SandboxManager(config, dependencies);
  const battleManager = new BattleManager(config, dependencies, sandboxManager);
  const app = buildApp({ config, dependencies, sandboxManager, battleManager });
  await app.ready();

  const suffix = `${Date.now()}${randomBytes(3).toString('hex')}`;
  const password = `AdminE2E-${randomBytes(12).toString('base64url')}`;
  const adminName = `adm${suffix}`.slice(0, 24);
  const userName = `usr${suffix}`.slice(0, 24);
  const adminEmail = `${adminName}@e2e.invalid`;
  const userEmail = `${userName}@e2e.invalid`;
  const sandboxId = randomUUID();
  let adminId: string | undefined;
  let userId: string | undefined;
  let challengeId: string | undefined;
  let challengeWasEnabled = true;

  try {
    const passwordHash = await hashPassword(password);
    const inserted = await dependencies.postgres.query<{ id: string; username: string }>(`
      INSERT INTO users (username, username_normalized, email, email_normalized, password_hash)
      VALUES ($1::varchar, lower($1::text), $2::varchar, lower($2::text), $3),
             ($4::varchar, lower($4::text), $5::varchar, lower($5::text), $3)
      RETURNING id, username
    `, [adminName, adminEmail, passwordHash, userName, userEmail]);
    adminId = inserted.rows.find((row) => row.username === adminName)?.id;
    userId = inserted.rows.find((row) => row.username === userName)?.id;
    assert(adminId && userId, 'temporary users were not created');
    await dependencies.postgres.query('INSERT INTO user_ratings (user_id, category_id) VALUES ($1, NULL), ($2, NULL)', [adminId, userId]);
    await dependencies.postgres.query('INSERT INTO user_progress (user_id) VALUES ($1), ($2)', [adminId, userId]);

    equal((await inject(app, 'GET', '/api/admin/overview')).statusCode, 401, 'unauthenticated admin API');
    const userCookie = await login(app, userName, password);
    equal((await inject(app, 'GET', '/api/admin/overview', userCookie)).statusCode, 403, 'regular user admin API');

    const client = await dependencies.postgres.connect();
    try {
      await client.query('BEGIN');
      await setAdminRole(client, { id: adminId }, 'admin');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const adminCookie = await login(app, adminName, password);
    const overview = await inject(app, 'GET', '/api/admin/overview', adminCookie);
    equal(overview.statusCode, 200, 'admin overview');
    assert(!JSON.stringify(overview.json()).includes('password_hash'), 'overview exposed password hash');

    const users = await inject(app, 'GET', `/api/admin/users?search=${encodeURIComponent(userName)}&page=1&limit=1`, adminCookie);
    equal(users.statusCode, 200, 'user search and pagination');
    const userPage = users.json<{ items: Array<{ id: string }>; total: number }>();
    equal(userPage.total, 1, 'user search result count');
    equal(userPage.items[0]?.id, userId, 'user search target');
    assert(!JSON.stringify(userPage).includes('password_hash'), 'users API exposed password hash');

    await dependencies.postgres.query(`
      INSERT INTO sandbox_sessions (id, user_id, status, lifecycle_state, status_changed_at, expires_at)
      VALUES ($1, $2, 'pending', 'requested', now(), now() + interval '10 minutes')
    `, [sandboxId, userId]);
    equal((await inject(app, 'POST', `/api/admin/sandboxes/${sandboxId}/terminate`, adminCookie)).statusCode, 200, 'sandbox terminate');
    const sandboxState = await dependencies.postgres.query<{ lifecycle_state: string }>('SELECT lifecycle_state FROM sandbox_sessions WHERE id = $1', [sandboxId]);
    equal(sandboxState.rows[0]?.lifecycle_state, 'terminated', 'sandbox lifecycle after terminate');

    equal((await inject(app, 'POST', `/api/admin/users/${userId}/suspend`, adminCookie)).statusCode, 200, 'suspend user');
    equal((await inject(app, 'GET', '/api/auth/me', userCookie)).json<{ user: unknown }>().user, null, 'suspended session invalidation');
    equal((await inject(app, 'POST', `/api/admin/users/${userId}/unsuspend`, adminCookie)).statusCode, 200, 'unsuspend user');

    const challenge = await dependencies.postgres.query<{ id: string; enabled: boolean }>('SELECT id, enabled FROM challenges ORDER BY id LIMIT 1');
    challengeId = challenge.rows[0]?.id;
    challengeWasEnabled = challenge.rows[0]?.enabled ?? true;
    assert(challengeId, 'challenge fixture missing');
    const firstAction = challengeWasEnabled ? 'disable' : 'enable';
    const secondAction = challengeWasEnabled ? 'enable' : 'disable';
    equal((await inject(app, 'POST', `/api/admin/challenges/${challengeId}/${firstAction}`, adminCookie)).statusCode, 200, 'challenge toggle');
    equal((await inject(app, 'POST', `/api/admin/challenges/${challengeId}/${secondAction}`, adminCookie)).statusCode, 200, 'challenge restore');

    const audits = await dependencies.postgres.query<{ action: string }>(`
      SELECT action FROM admin_audit_log
      WHERE actor_user_id = $1 OR target_id = ANY($2::text[])
    `, [adminId, [adminId, userId, sandboxId]]);
    for (const action of ['admin.role.grant', 'admin.sandbox.terminate', 'admin.user.suspend', 'admin.user.unsuspend']) {
      assert(audits.rows.some((row) => row.action === action), `missing audit event: ${action}`);
    }

    const roleClient = await dependencies.postgres.connect();
    try {
      await roleClient.query('BEGIN');
      await setAdminRole(roleClient, { id: adminId }, 'user');
      await roleClient.query('COMMIT');
    } catch (error) {
      await roleClient.query('ROLLBACK');
      throw error;
    } finally {
      roleClient.release();
    }
    equal((await inject(app, 'GET', '/api/admin/overview', adminCookie)).statusCode, 403, 'revoked admin role');
    equal((await inject(app, 'GET', '/health/live')).statusCode, 200, 'public health remains available');
    console.log(JSON.stringify({ ok: true, checks: 18 }, null, 2));
  } finally {
    if (challengeId) await dependencies.postgres.query('UPDATE challenges SET enabled = $2 WHERE id = $1', [challengeId, challengeWasEnabled]).catch(() => undefined);
    await dependencies.postgres.query('DELETE FROM sandbox_sessions WHERE id = $1', [sandboxId]).catch(() => undefined);
    if (adminId || userId) {
      const ids = [adminId, userId].filter((id): id is string => Boolean(id));
      await dependencies.postgres.query('DELETE FROM admin_audit_log WHERE actor_user_id = ANY($1::bigint[]) OR target_id = ANY($2::text[])', [ids, [...ids, sandboxId]]).catch(() => undefined);
      await dependencies.postgres.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [ids]).catch(() => undefined);
    }
    await app.close();
    await closeDependencies(dependencies);
  }
}

async function login(app: FastifyInstance, identifier: string, password: string): Promise<string> {
  const response = await inject(app, 'POST', '/api/auth/login', undefined, { identifier, password });
  equal(response.statusCode, 200, `login ${identifier}`);
  const header = response.headers['set-cookie'];
  const cookie = (Array.isArray(header) ? header[0] : header)?.split(';')[0];
  assert(cookie, 'login did not return a session cookie');
  return cookie;
}

async function inject(app: FastifyInstance, method: 'GET' | 'POST', url: string, cookie?: string, payload?: unknown): Promise<InjectResult> {
  return await app.inject({ method, url, headers: { host: 'localhost', origin: 'http://localhost', ...(cookie ? { cookie } : {}) }, ...(payload ? { payload } : {}) }) as unknown as InjectResult;
}

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`Admin E2E failed: ${message}`); }
function equal(actual: unknown, expected: unknown, message: string): void { if (actual !== expected) throw new Error(`Admin E2E failed: ${message}; expected ${String(expected)}, got ${String(actual)}`); }

if (process.argv[1]?.endsWith('admin-e2e.js')) main().catch((error) => { console.error(error); process.exitCode = 1; });
