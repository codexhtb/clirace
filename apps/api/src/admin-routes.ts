import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAdminAudit } from './admin-audit.js';
import { requireAdmin } from './admin-auth.js';
import { AuthService, type AuthUser } from './auth-service.js';
import type { BattleManager } from './battle-service.js';
import type { AppConfig } from './config.js';
import { hasSameOrigin } from './http-security.js';
import { visibleDivision } from './ranked-config.js';
import type { MatchmakingManager } from './matchmaking-service.js';
import type { SandboxManager } from './sandbox-manager.js';
import { checkDependencies, type Dependencies } from './services.js';

const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
const idSchema = z.object({ id: z.string().regex(/^\d+$/) });
const uuidSchema = z.object({ id: z.string().uuid() });
const actorByRequest = new WeakMap<FastifyRequest, AuthUser>();

export async function registerAdminRoutes(
  app: FastifyInstance,
  config: AppConfig,
  dependencies: Dependencies,
  sandboxManager: SandboxManager,
  battleManager: BattleManager,
  matchmakingManager: MatchmakingManager,
): Promise<void> {
  const auth = new AuthService(config, dependencies);

  app.addHook('preHandler', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const actor = await requireAdmin(auth, request, reply);
    if (!actor) return reply;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !hasSameOrigin(request)) {
      return reply.code(403).send({
        error: 'Forbidden origin',
        code: 'invalid_origin',
        message: 'Запрос отклонён системой безопасности.',
      });
    }
    actorByRequest.set(request, actor);
  });

  app.get('/api/admin/overview', async () => {
    const [checks, sandbox, product, integrity, matchmaking] = await Promise.all([
      checkDependencies(dependencies),
      sandboxManager.getOperationsSnapshot(),
      dependencies.postgres.query<{
        users_total: number; users_24h: number; users_7d: number; users_30d: number;
        logins_24h: number; active_games: number; active_sandboxes: number;
        battles_today: number; matchmaking_today: number; challenges_today: number;
        ranked_matches_today: number; ranked_no_contest_today: number; ranked_average_mmr: number;
        learning_active: number; learning_course_starts: number; learning_course_completions: number;
        learning_average_score: number; learning_module_completion_rate: number;
      }>(`
        SELECT
          (SELECT count(*)::int FROM users) AS users_total,
          (SELECT count(*)::int FROM users WHERE created_at >= now() - interval '24 hours') AS users_24h,
          (SELECT count(*)::int FROM users WHERE created_at >= now() - interval '7 days') AS users_7d,
          (SELECT count(*)::int FROM users WHERE created_at >= now() - interval '30 days') AS users_30d,
          (SELECT count(*)::int FROM users WHERE last_login_at >= now() - interval '24 hours') AS logins_24h,
          (SELECT count(*)::int FROM game_sessions WHERE status = 'active') AS active_games,
          (SELECT count(*)::int FROM sandbox_sessions WHERE lifecycle_state IN ('requested','queued','starting','ready','attached','idle','terminating')) AS active_sandboxes,
          (SELECT count(*)::int FROM battles WHERE created_at >= date_trunc('day', now())) AS battles_today,
          (SELECT count(*)::int FROM battles WHERE matchmaking_pool IS NOT NULL AND created_at >= date_trunc('day', now())) AS matchmaking_today,
          (SELECT count(*)::int FROM ranked_match_results WHERE outcome <> 'no_contest' AND created_at >= date_trunc('day', now())) AS ranked_matches_today,
          (SELECT count(*)::int FROM ranked_match_results WHERE outcome = 'no_contest' AND created_at >= date_trunc('day', now())) AS ranked_no_contest_today,
          (SELECT coalesce(round(avg(mmr)), 1000)::int FROM user_ranked_stats WHERE games_played > 0) AS ranked_average_mmr,
          (SELECT count(*)::int FROM learning_enrollments WHERE status='active') AS learning_active,
          (SELECT count(*)::int FROM learning_enrollments) AS learning_course_starts,
          (SELECT count(*)::int FROM learning_enrollments WHERE status='completed') AS learning_course_completions,
          (SELECT coalesce(round(avg(final_score)),0)::int FROM learning_enrollments WHERE status='completed') AS learning_average_score,
          (SELECT CASE WHEN count(DISTINCT e.id)=0 THEN 0 ELSE round(
            100.0 * count(mr.module_id) / nullif(count(DISTINCT e.id) * (SELECT count(*) FROM learning_modules WHERE enabled),0)
          )::int END FROM learning_enrollments e LEFT JOIN learning_module_results mr ON mr.enrollment_id=e.id) AS learning_module_completion_rate,
          (SELECT count(*)::int FROM results WHERE correct AND created_at >= date_trunc('day', now())) AS challenges_today
      `),
      dependencies.postgres.query(`
        SELECT id, source, total, passed, failed, duration_ms, failed_challenge_ids, created_at
        FROM admin_integrity_runs ORDER BY created_at DESC, id DESC LIMIT 1
      `),
      matchmakingManager.allMetrics(),
    ]);
    return {
      dependencies: { api: 'up', ...checks },
      sandbox,
      product: product.rows[0],
      integrity: integrity.rows[0] ?? null,
      matchmaking: matchmaking.quick,
      ranked: {
        matchmaking: matchmaking.ranked,
        matchesToday: product.rows[0]?.ranked_matches_today ?? 0,
        noContestToday: product.rows[0]?.ranked_no_contest_today ?? 0,
        averageMmr: product.rows[0]?.ranked_average_mmr ?? 1000,
      },
      generatedAt: new Date().toISOString(),
    };
  });

  app.get('/api/admin/users', async (request, reply) => {
    const parsed = pageSchema.extend({
      search: z.string().trim().max(120).default(''),
      role: z.enum(['all', 'user', 'admin']).default('all'),
      status: z.enum(['all', 'active', 'suspended']).default('all'),
      recentDays: z.coerce.number().int().min(0).max(3650).default(0),
    }).safeParse(request.query);
    if (!parsed.success) return invalidQuery(reply);
    const { page, limit, search, role, status, recentDays } = parsed.data;
    const result = await dependencies.postgres.query(`
      WITH filtered AS (
        SELECT u.* FROM users u
        WHERE ($1 = '' OR u.id::text = $1 OR u.username ILIKE '%' || $1 || '%' OR u.email ILIKE '%' || $1 || '%')
          AND ($2 = 'all' OR u.role = $2)
          AND ($3 = 'all' OR u.account_status = $3)
          AND ($4::int = 0 OR u.created_at >= now() - make_interval(days => $4::int))
      ), page AS (
        SELECT * FROM filtered ORDER BY created_at DESC, id DESC LIMIT $5 OFFSET $6
      )
      SELECT p.id, p.username, p.email, p.role, p.account_status, p.created_at, p.last_login_at,
        COALESCE(r.rating, 1000)::int AS rating,
        COALESCE(rr.mmr, 1000)::int AS ranked_mmr,
        COALESCE(rr.games_played, 0)::int AS ranked_games,
        COALESCE(rr.wins, 0)::int AS ranked_wins,
        COALESCE(rr.losses, 0)::int AS ranked_losses,
        COALESCE(rr.placement_games_completed, 0)::int AS placement_games_completed,
        (SELECT count(DISTINCT st.challenge_id)::int FROM game_sessions gs
          JOIN session_tasks st ON st.game_session_id = gs.id AND st.status = 'correct'
          WHERE gs.user_id = p.id) AS completed_challenges,
        EXISTS (SELECT 1 FROM sandbox_sessions ss WHERE ss.user_id = p.id
          AND ss.lifecycle_state IN ('requested','queued','starting','ready','attached','idle','terminating')) AS active_sandbox,
        (SELECT count(*)::int FROM battle_players bp WHERE bp.user_id = p.id) AS battle_count,
        (SELECT count(*)::int FROM filtered) AS total
      FROM page p
      LEFT JOIN user_ratings r ON r.user_id = p.id AND r.category_id IS NULL
      LEFT JOIN user_ranked_stats rr ON rr.user_id = p.id
      ORDER BY p.created_at DESC, p.id DESC
    `, [search, role, status, recentDays, limit, (page - 1) * limit]);
    return paged(result.rows.map((row) => ({
      ...row,
      ranked_division: visibleDivision(Number(row.ranked_mmr), Number(row.ranked_games)),
    })), page, limit);
  });

  app.get('/api/admin/users/:id', async (request, reply) => {
    const parsed = idSchema.safeParse(request.params);
    if (!parsed.success) return invalidQuery(reply);
    const result = await dependencies.postgres.query(`
      SELECT u.id, u.username, u.email, u.role, u.account_status, u.created_at, u.updated_at,
             u.last_login_at, u.suspended_at, actor.username AS suspended_by_username,
             COALESCE(r.rating, 1000)::int AS rating,
             COALESCE(rr.mmr, 1000)::int AS ranked_mmr,
             COALESCE(rr.games_played, 0)::int AS ranked_games,
             COALESCE(rr.wins, 0)::int AS ranked_wins,
             COALESCE(rr.losses, 0)::int AS ranked_losses,
             COALESCE(rr.placement_games_completed, 0)::int AS placement_games_completed,
             (SELECT count(*)::int FROM game_sessions gs WHERE gs.user_id = u.id) AS game_count,
             (SELECT count(*)::int FROM battle_players bp WHERE bp.user_id = u.id) AS battle_count
      FROM users u
      LEFT JOIN users actor ON actor.id = u.suspended_by
      LEFT JOIN user_ratings r ON r.user_id = u.id AND r.category_id IS NULL
      LEFT JOIN user_ranked_stats rr ON rr.user_id = u.id
      WHERE u.id = $1
    `, [parsed.data.id]);
    if (!result.rows[0]) return notFound(reply, 'Пользователь не найден.');
    const user = result.rows[0] as Record<string, unknown>;
    return { user: { ...user, ranked_division: visibleDivision(Number(user.ranked_mmr), Number(user.ranked_games)) } };
  });

  app.post('/api/admin/users/:id/suspend', mutationLimit(), async (request, reply) => {
    const parsed = idSchema.safeParse(request.params);
    if (!parsed.success) return invalidQuery(reply);
    const actor = adminActor(request);
    if (actor.id === parsed.data.id) return reply.code(409).send({ error: 'Self action denied', message: 'Нельзя приостановить собственный аккаунт.' });
    const updated = await dependencies.postgres.query<{ id: string; username: string }>(`
      UPDATE users SET account_status = 'suspended', suspended_at = now(), suspended_by = $2, updated_at = now()
      WHERE id = $1 AND account_status = 'active' RETURNING id, username
    `, [parsed.data.id, actor.id]);
    if (!updated.rows[0]) return notFound(reply, 'Активный пользователь не найден.');
    const [revokedSessions, terminatedSandboxes] = await Promise.all([
      auth.revokeAllSessions(parsed.data.id),
      sandboxManager.destroyUserSessions(parsed.data.id, 'account_suspended'),
      matchmakingManager.removeUser(parsed.data.id, 'suspended'),
    ]);
    await audit(dependencies, request, 'admin.user.suspend', 'user', parsed.data.id, { revokedSessions, terminatedSandboxes });
    return { ok: true, revokedSessions, terminatedSandboxes };
  });

  app.post('/api/admin/users/:id/unsuspend', mutationLimit(), async (request, reply) => {
    const parsed = idSchema.safeParse(request.params);
    if (!parsed.success) return invalidQuery(reply);
    const updated = await dependencies.postgres.query(`
      UPDATE users SET account_status = 'active', suspended_at = NULL, suspended_by = NULL, updated_at = now()
      WHERE id = $1 AND account_status = 'suspended' RETURNING id
    `, [parsed.data.id]);
    if (!updated.rows[0]) return notFound(reply, 'Приостановленный пользователь не найден.');
    await audit(dependencies, request, 'admin.user.unsuspend', 'user', parsed.data.id);
    return { ok: true };
  });

  app.post('/api/admin/users/:id/revoke-sessions', mutationLimit(), async (request, reply) => {
    const parsed = idSchema.safeParse(request.params);
    if (!parsed.success) return invalidQuery(reply);
    const exists = await dependencies.postgres.query('SELECT id FROM users WHERE id = $1', [parsed.data.id]);
    if (!exists.rows[0]) return notFound(reply, 'Пользователь не найден.');
    const revokedSessions = await auth.revokeAllSessions(parsed.data.id);
    await audit(dependencies, request, 'admin.user.sessions.revoke', 'user', parsed.data.id, { revokedSessions });
    return { ok: true, revokedSessions };
  });

  app.get('/api/admin/sandboxes', async (request, reply) => {
    const parsed = pageSchema.extend({
      state: z.string().trim().max(24).default('all'),
      search: z.string().trim().max(120).default(''),
      live: z.enum(['all', 'true', 'false']).default('all'),
    }).safeParse(request.query);
    if (!parsed.success) return invalidQuery(reply);
    const { page, limit, state, search, live } = parsed.data;
    const result = await dependencies.postgres.query(`
      WITH filtered AS (
        SELECT ss.id, ss.lifecycle_state, ss.status, ss.created_at, ss.status_changed_at,
          ss.last_activity_at, ss.expires_at, ss.destroyed_at, ss.failure_code, ss.termination_reason,
          u.id AS user_id, u.username, c.id AS challenge_id, c.title AS challenge_title,
          b.id AS battle_id, b.room_code,
          count(*) OVER()::int AS total
        FROM sandbox_sessions ss
        LEFT JOIN users u ON u.id = ss.user_id
        LEFT JOIN challenges c ON c.id = ss.challenge_id
        LEFT JOIN battles b ON b.id = ss.battle_id
        WHERE ($1 = 'all' OR ss.lifecycle_state = $1)
          AND ($2 = '' OR u.username ILIKE '%' || $2 || '%' OR ss.id::text ILIKE '%' || $2 || '%'
            OR c.title ILIKE '%' || $2 || '%' OR b.room_code ILIKE '%' || $2 || '%')
          AND ($3 = 'all' OR ($3 = 'true') = (ss.lifecycle_state = ANY($4::varchar[])))
        ORDER BY ss.created_at DESC, ss.id DESC LIMIT $5 OFFSET $6
      ) SELECT * FROM filtered
    `, [state, search, live, ['requested','queued','starting','ready','attached','idle','terminating'], limit, (page - 1) * limit]);
    return paged(result.rows, page, limit);
  });

  app.post('/api/admin/sandboxes/:id/terminate', mutationLimit(), async (request, reply) => {
    const parsed = uuidSchema.safeParse(request.params);
    if (!parsed.success) return invalidQuery(reply);
    const terminated = await sandboxManager.terminateSession(parsed.data.id);
    if (!terminated) return notFound(reply, 'Активная sandbox-сессия не найдена.');
    await audit(dependencies, request, 'admin.sandbox.terminate', 'sandbox_session', parsed.data.id);
    return { ok: true };
  });

  app.post('/api/admin/sandboxes/reconcile', mutationLimit(2, '10 minutes'), async (request) => {
    const result = await sandboxManager.runReconciliation();
    await audit(dependencies, request, 'admin.sandbox.reconcile', 'sandbox_platform', null, { ...result });
    return { ok: true, result };
  });

  app.get('/api/admin/challenges', async (request, reply) => {
    const parsed = pageSchema.extend({
      search: z.string().trim().max(120).default(''),
      type: z.string().trim().max(24).default('all'),
      difficulty: z.string().trim().max(16).default('all'),
      category: z.string().trim().max(60).default('all'),
      enabled: z.enum(['all', 'true', 'false']).default('all'),
    }).safeParse(request.query);
    if (!parsed.success) return invalidQuery(reply);
    const { page, limit, search, type, difficulty, category, enabled } = parsed.data;
    const result = await dependencies.postgres.query(`
      SELECT c.id, c.slug, c.title, c.type, c.difficulty, c.enabled, c.updated_at,
        categories.slug AS category_slug, categories.name AS category_name,
        COALESCE(array_agg(DISTINCT cc.name) FILTER (WHERE cc.name IS NOT NULL), '{}') AS collections,
        COALESCE(string_agg(DISTINCT ch.check_type, ', '), c.validation_config->>'kind', '—') AS validation_kind,
        c.validation_config->>'sandboxChallengeId' AS sandbox_challenge_id,
        CASE WHEN c.type <> 'real_shell' THEN NULL
          WHEN integrity.id IS NULL THEN 'unknown'
          WHEN (c.validation_config->>'sandboxChallengeId') = ANY(integrity.failed_challenge_ids) THEN 'failed'
          ELSE 'passed' END AS integrity_status,
        count(*) OVER()::int AS total
      FROM challenges c
      JOIN categories ON categories.id = c.category_id
      LEFT JOIN challenge_checks ch ON ch.challenge_id = c.id
      LEFT JOIN challenge_collection_items ci ON ci.challenge_id = c.id
      LEFT JOIN challenge_collections cc ON cc.id = ci.collection_id
      LEFT JOIN LATERAL (
        SELECT id, failed_challenge_ids FROM admin_integrity_runs ORDER BY created_at DESC, id DESC LIMIT 1
      ) integrity ON true
      WHERE ($1 = '' OR c.title ILIKE '%' || $1 || '%' OR c.slug ILIKE '%' || $1 || '%')
        AND ($2 = 'all' OR c.type = $2) AND ($3 = 'all' OR c.difficulty = $3)
        AND ($4 = 'all' OR categories.slug = $4)
        AND ($5 = 'all' OR c.enabled = ($5 = 'true'))
      GROUP BY c.id, categories.id, integrity.id, integrity.failed_challenge_ids
      ORDER BY c.updated_at DESC, c.id DESC LIMIT $6 OFFSET $7
    `, [search, type, difficulty, category, enabled, limit, (page - 1) * limit]);
    return paged(result.rows, page, limit);
  });

  for (const enabled of [true, false] as const) {
    const action = enabled ? 'enable' : 'disable';
    app.post(`/api/admin/challenges/:id/${action}`, mutationLimit(), async (request, reply) => {
      const parsed = idSchema.safeParse(request.params);
      if (!parsed.success) return invalidQuery(reply);
      const updated = await dependencies.postgres.query<{ id: string; enabled: boolean }>(`
        UPDATE challenges SET enabled = $2, updated_at = now()
        WHERE id = $1 AND enabled <> $2 RETURNING id, enabled
      `, [parsed.data.id, enabled]);
      if (!updated.rows[0]) return notFound(reply, 'Задание не найдено или уже находится в этом состоянии.');
      await audit(dependencies, request, `admin.challenge.${action}`, 'challenge', parsed.data.id, { enabled });
      return { ok: true, enabled };
    });
  }

  app.get('/api/admin/battles', async (request, reply) => {
    const parsed = pageSchema.extend({
      status: z.enum(['all', 'waiting', 'countdown', 'running', 'finished', 'cancelled']).default('all'),
      search: z.string().trim().max(80).default(''),
    }).safeParse(request.query);
    if (!parsed.success) return invalidQuery(reply);
    const { page, limit, status, search } = parsed.data;
    const result = await dependencies.postgres.query(`
      SELECT b.id, b.room_code, b.status, b.mode, b.round_count, b.created_at, b.started_at, b.finished_at,
        b.expires_at, host.username AS host_username, winner.username AS winner_username,
        cat.name AS category_name,
        COALESCE(string_agg(players.username, ' vs ' ORDER BY bp.joined_at), '') AS players,
        count(*) OVER()::int AS total
      FROM battles b
      JOIN users host ON host.id = b.host_user_id
      LEFT JOIN users winner ON winner.id = b.winner_user_id
      LEFT JOIN categories cat ON cat.id = b.category_id
      LEFT JOIN battle_players bp ON bp.battle_id = b.id
      LEFT JOIN users players ON players.id = bp.user_id
      WHERE ($1 = 'all' OR b.status = $1)
        AND ($2 = '' OR b.room_code ILIKE '%' || $2 || '%' OR host.username ILIKE '%' || $2 || '%')
      GROUP BY b.id, host.id, winner.id, cat.id
      ORDER BY b.created_at DESC, b.id DESC LIMIT $3 OFFSET $4
    `, [status, search, limit, (page - 1) * limit]);
    return paged(result.rows, page, limit);
  });

  app.post('/api/admin/battles/:id/terminate', mutationLimit(), async (request, reply) => {
    const parsed = uuidSchema.safeParse(request.params);
    if (!parsed.success) return invalidQuery(reply);
    const terminated = await battleManager.terminateBattle(parsed.data.id);
    if (!terminated) return notFound(reply, 'Активный battle не найден.');
    await audit(dependencies, request, 'admin.battle.terminate', 'battle', parsed.data.id);
    return { ok: true };
  });

  app.get('/api/admin/audit', async (request, reply) => {
    const parsed = pageSchema.extend({
      actor: z.string().trim().max(80).default(''), action: z.string().trim().max(80).default(''),
      targetType: z.string().trim().max(40).default(''), days: z.coerce.number().int().min(0).max(3650).default(30),
    }).safeParse(request.query);
    if (!parsed.success) return invalidQuery(reply);
    const { page, limit, actor, action, targetType, days } = parsed.data;
    const result = await dependencies.postgres.query(`
      SELECT a.id, a.action, a.target_type, a.target_id, a.metadata, a.client_ip, a.created_at,
             u.username AS actor_username, count(*) OVER()::int AS total
      FROM admin_audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE ($1 = '' OR u.username ILIKE '%' || $1 || '%')
        AND ($2 = '' OR a.action ILIKE '%' || $2 || '%')
        AND ($3 = '' OR a.target_type = $3)
        AND ($4::int = 0 OR a.created_at >= now() - make_interval(days => $4::int))
      ORDER BY a.created_at DESC, a.id DESC LIMIT $5 OFFSET $6
    `, [actor, action, targetType, days, limit, (page - 1) * limit]);
    return paged(result.rows, page, limit);
  });
}

function mutationLimit(max = 10, timeWindow = '1 minute') {
  return { config: { rateLimit: { max, timeWindow } } };
}

function adminActor(request: FastifyRequest): AuthUser {
  const actor = actorByRequest.get(request);
  if (!actor) throw new Error('Admin pre-handler did not run.');
  return actor;
}

async function audit(
  dependencies: Dependencies,
  request: FastifyRequest,
  action: string,
  targetType: string,
  targetId: string | null,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await writeAdminAudit(dependencies, {
    actorUserId: adminActor(request).id,
    action,
    targetType,
    targetId,
    ...(metadata ? { metadata } : {}),
    clientIp: request.ip,
  });
}

function paged(rows: Array<Record<string, unknown>>, page: number, limit: number) {
  const total = Number(rows[0]?.total ?? 0);
  return { items: rows.map(({ total: _total, ...row }) => row), page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) };
}

function invalidQuery(reply: FastifyReply) {
  return reply.code(400).send({ error: 'Invalid query', message: 'Некорректные параметры запроса.' });
}

function notFound(reply: FastifyReply, message: string) {
  return reply.code(404).send({ error: 'Not found', message });
}
