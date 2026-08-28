import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { AuthService, type AuthUser } from './auth-service.js';
import { validateChallengeAnswer } from './challenge-validator.js';
import type { AppConfig } from './config.js';
import { finalizeCompletedSession } from './game-progression-service.js';
import { hasSameOrigin } from './http-security.js';
import { getSandboxChallenge } from './sandbox-challenges.js';
import type { Dependencies } from './services.js';

const createSchema = z.object({
  category: z.string().trim().max(40).default('all'),
  difficulty: z.enum(['all', 'Easy', 'Medium', 'Hard', 'Expert']).default('all'),
  mode: z.enum(['recall', 'quick', 'real_shell', 'mixed']),
  taskCount: z.union([z.literal(5), z.literal(10)]).default(5),
  challengeSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100).optional(),
}).strict();

const answerSchema = z.object({ answer: z.string().trim().min(1).max(2000) }).strict();
const idSchema = z.object({ id: z.string().uuid() });

interface ChallengeRow {
  id: string;
  slug: string;
  title: string;
  description: string;
  difficulty: 'Easy' | 'Medium' | 'Hard' | 'Expert';
  type: 'recall' | 'quick' | 'real_shell';
  category_slug: string;
  category_name: string;
  scoring_config: Record<string, unknown>;
  validation_config: Record<string, unknown>;
}

interface ActiveTaskRow extends ChallengeRow {
  task_id: string;
  position: number;
  total: number;
  presented_at: Date;
  attempt_count: number;
}

interface SessionRow {
  id: string;
  status: 'active' | 'completed' | 'abandoned' | 'expired';
  score: number;
  streak: number;
  best_streak: number;
  rating_delta: number;
  bonus_multiplier?: number;
  mode: string;
  started_at: Date;
  completed_at: Date | null;
}

export async function registerGameRoutes(
  app: FastifyInstance,
  config: AppConfig,
  dependencies: Dependencies,
): Promise<void> {
  const auth = new AuthService(config, dependencies);

  app.post('/api/game/sessions', {
    config: { rateLimit: { max: 12, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    if (!hasSameOrigin(request)) return forbidden(reply);
    const user = await requireUser(auth, request, reply);
    if (!user) return;
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply, 'Проверьте режим, категорию, сложность и число заданий.');
    if (parsed.data.mode === 'real_shell' && !config.SANDBOX_ENABLED) {
      return reply.code(503).send({
        error: 'Sandbox unavailable',
        message: 'Режим Shell доступен только на сервере с rootless-песочницей.',
      });
    }

    const category = parsed.data.category === 'all'
      ? null
      : await dependencies.postgres.query<{ id: number }>(
        'SELECT id FROM categories WHERE slug = $1 AND enabled', [parsed.data.category],
      ).then((result) => result.rows[0] ?? null);
    if (parsed.data.category !== 'all' && !category) return invalidRequest(reply, 'Категория не найдена.');

    const types = parsed.data.mode === 'mixed' ? ['recall', 'quick'] : [parsed.data.mode];
    const challenges = await dependencies.postgres.query<ChallengeRow>(`
      SELECT c.id, c.slug, c.title, c.description, c.difficulty, c.type,
             c.scoring_config, c.validation_config,
             categories.slug AS category_slug, categories.name AS category_name
      FROM challenges c
      JOIN categories ON categories.id = c.category_id
      WHERE c.enabled AND categories.enabled
        AND COALESCE((c.validation_config->'availability'->>'practice')::boolean, true)
        AND c.type = ANY($1::varchar[])
        AND ($2::smallint IS NULL OR c.category_id = $2)
        AND ($3::varchar IS NULL OR c.difficulty = $3)
        AND ($4::varchar IS NULL OR c.slug = $4)
      ORDER BY random()
      LIMIT $5
    `, [types, category?.id ?? null, parsed.data.difficulty === 'all' ? null : parsed.data.difficulty,
      parsed.data.challengeSlug ?? null, parsed.data.challengeSlug ? 1 : parsed.data.taskCount]);
    if (challenges.rowCount === 0) return reply.code(422).send({
      error: 'No challenges', message: 'Для выбранных фильтров пока нет заданий.',
    });

    const client = await dependencies.postgres.connect();
    try {
      await client.query('BEGIN');
      const sessionId = randomUUID();
      await client.query(`
        INSERT INTO game_sessions (id, user_id, category_id, difficulty, mode)
        VALUES ($1, $2, $3, $4, $5)
      `, [sessionId, user.id, category?.id ?? null, parsed.data.difficulty === 'all' ? null : parsed.data.difficulty, parsed.data.mode]);
      for (const [index, challenge] of challenges.rows.entries()) {
        if (index === 0) {
          await client.query(`
            INSERT INTO session_tasks (game_session_id, challenge_id, position, status, presented_at)
            VALUES ($1, $2, $3, 'active', now())
          `, [sessionId, challenge.id, index + 1]);
        } else {
          await client.query(`
            INSERT INTO session_tasks (game_session_id, challenge_id, position, status)
            VALUES ($1, $2, $3, 'pending')
          `, [sessionId, challenge.id, index + 1]);
        }
      }
      await client.query('COMMIT');
      const state = await loadGameState(dependencies.postgres, sessionId, user.id);
      return reply.header('cache-control', 'no-store').code(201).send(state);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.get('/api/game/sessions/:id', async (request, reply) => {
    const user = await requireUser(auth, request, reply);
    if (!user) return;
    const parsed = idSchema.safeParse(request.params);
    if (!parsed.success) return invalidRequest(reply, 'Некорректный идентификатор забега.');
    const state = await loadGameState(dependencies.postgres, parsed.data.id, user.id);
    if (!state) return notFound(reply);
    return reply.header('cache-control', 'no-store').send(state);
  });

  app.post('/api/game/sessions/:id/submit', {
    config: { rateLimit: { max: 90, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    if (!hasSameOrigin(request)) return forbidden(reply);
    const user = await requireUser(auth, request, reply);
    if (!user) return;
    const id = idSchema.safeParse(request.params);
    const body = answerSchema.safeParse(request.body);
    if (!id.success || !body.success) return invalidRequest(reply, 'Введите команду длиной до 2000 символов.');

    const client = await dependencies.postgres.connect();
    try {
      await client.query('BEGIN');
      const locked = await lockActiveTask(client, id.data.id, user.id);
      if (!locked.session) {
        await client.query('ROLLBACK');
        return notFound(reply);
      }
      if (!locked.task) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'Session not active', message: 'Этот забег уже завершён.' });
      }

      const validation = validateChallengeAnswer(body.data.answer, locked.task.validation_config);
      if (!validation.correct) {
        await client.query(`
          UPDATE session_tasks SET attempt_count = attempt_count + 1, last_answer = $1 WHERE id = $2
        `, [body.data.answer, locked.task.task_id]);
        await client.query('UPDATE game_sessions SET streak = 0 WHERE id = $1', [locked.session.id]);
        await client.query('COMMIT');
        return reply.header('cache-control', 'no-store').send({
          correct: false,
          feedback: validation.feedback,
          scoreAwarded: 0,
          session: { ...publicSession(locked.session), streak: 0 },
          task: publicTask(locked.task),
        });
      }

      const durationMs = elapsedMs(locked.task.presented_at);
      const baseScore = calculateScore(locked.task.scoring_config, locked.task.difficulty, durationMs, locked.task.attempt_count);
      const scoreAwarded = Math.max(1, Math.round(baseScore * (locked.session.bonus_multiplier ?? 1)));
      await client.query(`
        UPDATE session_tasks
        SET status = 'correct', completed_at = now(), attempt_count = attempt_count + 1,
            score_awarded = $1, last_answer = $2
        WHERE id = $3
      `, [scoreAwarded, body.data.answer, locked.task.task_id]);
      await client.query(`
        INSERT INTO results (session_task_id, user_id, correct, submitted_answer, duration_ms, mistakes, score_awarded)
        VALUES ($1, $2, true, $3, $4, $5, $6)
      `, [locked.task.task_id, user.id, body.data.answer, durationMs, locked.task.attempt_count, scoreAwarded]);
      await client.query(`
        UPDATE game_sessions
        SET score = score + $1, streak = streak + 1, best_streak = GREATEST(best_streak, streak + 1)
        WHERE id = $2
      `, [scoreAwarded, locked.session.id]);
      await activateNextOrComplete(client, locked.session.id, user.id);
      await client.query('COMMIT');
      const state = await loadGameState(dependencies.postgres, locked.session.id, user.id);
      return reply.header('cache-control', 'no-store').send({
        correct: true, feedback: validation.feedback, scoreAwarded, ...state,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.post('/api/game/sessions/:id/skip', async (request, reply) => {
    if (!hasSameOrigin(request)) return forbidden(reply);
    const user = await requireUser(auth, request, reply);
    if (!user) return;
    const id = idSchema.safeParse(request.params);
    if (!id.success) return invalidRequest(reply, 'Некорректный идентификатор забега.');

    const client = await dependencies.postgres.connect();
    try {
      await client.query('BEGIN');
      const locked = await lockActiveTask(client, id.data.id, user.id);
      if (!locked.session) {
        await client.query('ROLLBACK');
        return notFound(reply);
      }
      if (!locked.task) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'Session not active', message: 'Этот забег уже завершён.' });
      }
      const durationMs = elapsedMs(locked.task.presented_at);
      await client.query(`
        UPDATE session_tasks SET status = 'skipped', completed_at = now() WHERE id = $1
      `, [locked.task.task_id]);
      await client.query(`
        INSERT INTO results (session_task_id, user_id, correct, duration_ms, mistakes, score_awarded)
        VALUES ($1, $2, false, $3, $4, 0)
      `, [locked.task.task_id, user.id, durationMs, locked.task.attempt_count]);
      await client.query('UPDATE game_sessions SET streak = 0 WHERE id = $1', [locked.session.id]);
      await activateNextOrComplete(client, locked.session.id, user.id);
      await client.query('COMMIT');
      const state = await loadGameState(dependencies.postgres, locked.session.id, user.id);
      return reply.header('cache-control', 'no-store').send({ skipped: true, feedback: 'Задание пропущено.', ...state });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
}

async function requireUser(auth: AuthService, request: FastifyRequest, reply: FastifyReply): Promise<AuthUser | null> {
  const user = await auth.currentUser(request);
  if (!user) reply.code(401).send({ error: 'Unauthorized', message: 'Войдите в аккаунт, чтобы начать забег.' });
  return user;
}

async function lockActiveTask(client: PoolClient, sessionId: string, userId: string): Promise<{
  session: SessionRow | null; task: ActiveTaskRow | null;
}> {
  const session = await client.query<SessionRow>(`
    SELECT gs.id, gs.status, gs.score, gs.streak, gs.best_streak, gs.rating_delta,
           gs.mode, gs.started_at, gs.completed_at,
           coalesce(dc.bonus_multiplier, 1)::float AS bonus_multiplier
    FROM game_sessions gs
    LEFT JOIN daily_challenges dc ON dc.id = gs.daily_challenge_id
    WHERE gs.id = $1 AND gs.user_id = $2 FOR UPDATE OF gs
  `, [sessionId, userId]);
  const row = session.rows[0] ?? null;
  if (!row || row.status !== 'active') return { session: row, task: null };
  const task = await client.query<ActiveTaskRow>(`
    SELECT st.id AS task_id, st.position, st.presented_at, st.attempt_count,
           c.id, c.slug, c.title, c.description, c.difficulty, c.type,
           c.scoring_config, c.validation_config,
           categories.slug AS category_slug, categories.name AS category_name,
           (SELECT count(*)::int FROM session_tasks total WHERE total.game_session_id = st.game_session_id) AS total
    FROM session_tasks st
    JOIN challenges c ON c.id = st.challenge_id
    JOIN categories ON categories.id = c.category_id
    WHERE st.game_session_id = $1 AND st.status = 'active'
    FOR UPDATE OF st
  `, [sessionId]);
  return { session: row, task: task.rows[0] ?? null };
}

async function activateNextOrComplete(client: PoolClient, sessionId: string, userId: string): Promise<void> {
  const next = await client.query<{ id: string }>(`
    SELECT id FROM session_tasks
    WHERE game_session_id = $1 AND status = 'pending'
    ORDER BY position LIMIT 1 FOR UPDATE
  `, [sessionId]);
  if (next.rows[0]) {
    await client.query(`UPDATE session_tasks SET status = 'active', presented_at = now() WHERE id = $1`, [next.rows[0].id]);
    return;
  }
  await client.query(`UPDATE game_sessions SET status = 'completed', completed_at = now(), streak = 0 WHERE id = $1`, [sessionId]);
  await finalizeCompletedSession(client, sessionId, userId);
}

export async function loadGameState(pool: Dependencies['postgres'], sessionId: string, userId: string): Promise<Record<string, unknown> | null> {
  const sessionResult = await pool.query<SessionRow>(`
    SELECT id, status, score, streak, best_streak, rating_delta, mode, started_at, completed_at
    FROM game_sessions WHERE id = $1 AND user_id = $2
  `, [sessionId, userId]);
  const session = sessionResult.rows[0];
  if (!session) return null;
  const taskResult = await pool.query<ActiveTaskRow>(`
    SELECT st.id AS task_id, st.position, st.presented_at, st.attempt_count,
           c.id, c.slug, c.title, c.description, c.difficulty, c.type,
           c.scoring_config, c.validation_config,
           categories.slug AS category_slug, categories.name AS category_name,
           (SELECT count(*)::int FROM session_tasks total WHERE total.game_session_id = st.game_session_id) AS total
    FROM session_tasks st
    JOIN challenges c ON c.id = st.challenge_id
    JOIN categories ON categories.id = c.category_id
    WHERE st.game_session_id = $1 AND st.status = 'active'
  `, [sessionId]);
  const summaryResult = await pool.query<{
    total: number; correct: number; skipped: number; answered: number; duration_ms: number;
  }>(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE st.status = 'correct')::int AS correct,
           count(*) FILTER (WHERE st.status = 'skipped')::int AS skipped,
           count(*) FILTER (WHERE st.status IN ('correct','skipped'))::int AS answered,
           COALESCE(sum(r.duration_ms), 0)::int AS duration_ms
    FROM session_tasks st LEFT JOIN results r ON r.session_task_id = st.id
    WHERE st.game_session_id = $1
  `, [sessionId]);
  return {
    session: publicSession(session),
    task: taskResult.rows[0] ? publicTask(taskResult.rows[0]) : null,
    summary: session.status === 'completed' ? summaryResult.rows[0] : undefined,
  };
}

function publicSession(session: SessionRow) {
  return {
    id: session.id,
    status: session.status,
    score: session.score,
    streak: session.streak,
    bestStreak: session.best_streak,
    ratingDelta: session.rating_delta,
    practiceScoreDelta: session.rating_delta,
    mode: session.mode,
    startedAt: session.started_at.toISOString(),
    completedAt: session.completed_at?.toISOString() ?? null,
  };
}

function publicTask(task: ActiveTaskRow) {
  const sandboxChallengeId = typeof task.validation_config.sandboxChallengeId === 'string'
    ? task.validation_config.sandboxChallengeId
    : undefined;
  const sandboxChallenge = task.type === 'real_shell' && sandboxChallengeId
    ? getSandboxChallenge(sandboxChallengeId)
    : undefined;
  return {
    slug: task.slug,
    title: task.title,
    description: task.description,
    difficulty: task.difficulty,
    type: task.type,
    category: { slug: task.category_slug, name: task.category_name },
    position: task.position,
    total: task.total,
    presentedAt: task.presented_at.toISOString(),
    attempts: task.attempt_count,
    ...(sandboxChallenge ? { hint: sandboxChallenge.hint } : {}),
  };
}

function calculateScore(config: Record<string, unknown>, difficulty: string, durationMs: number, mistakes: number): number {
  const base = typeof config.base === 'number' ? config.base : 100;
  const target = typeof config.timeTargetMs === 'number' ? config.timeTargetMs : 20_000;
  const multiplier = ({ Easy: 1, Medium: 1.5, Hard: 2, Expert: 3 } as Record<string, number>)[difficulty] ?? 1;
  const speedRatio = Math.max(0, Math.min(1, (target - durationMs) / target));
  const timeBonus = base * 0.5 * speedRatio;
  const attemptFactor = Math.max(0.2, 1 - mistakes * 0.15);
  return Math.max(1, Math.round((base + timeBonus) * multiplier * attemptFactor));
}

function elapsedMs(presentedAt: Date): number {
  return Math.max(0, Math.min(2_147_483_647, Date.now() - presentedAt.getTime()));
}

function forbidden(reply: FastifyReply) {
  return reply.code(403).send({ error: 'Forbidden origin', message: 'Запрос отклонён системой безопасности.' });
}

function invalidRequest(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: 'Invalid request', message });
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({ error: 'Not found', message: 'Забег не найден.' });
}
