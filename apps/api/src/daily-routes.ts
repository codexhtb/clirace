import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { AuthService } from './auth-service.js';
import type { AppConfig } from './config.js';
import { hasSameOrigin } from './http-security.js';
import type { Dependencies } from './services.js';

interface DailyRow {
  id: string;
  challenge_date: string;
  bonus_multiplier: string;
  challenge_id: string;
  slug: string;
  title: string;
  description: string;
  difficulty: 'Easy' | 'Medium';
  type: 'recall' | 'quick';
  category_id: number;
  category_slug: string;
  category_name: string;
  next_reset_at: Date;
}

export async function registerDailyRoutes(
  app: FastifyInstance,
  config: AppConfig,
  dependencies: Dependencies,
): Promise<void> {
  const auth = new AuthService(config, dependencies);

  app.get('/api/daily', async (request, reply) => {
    const daily = await ensureDailyChallenge(dependencies);
    if (!daily) return unavailable(reply);
    const user = await auth.currentUser(request);
    const [community, progress, streak] = await Promise.all([
      dependencies.postgres.query<{ participants: number; completions: number }>(`
        SELECT count(DISTINCT gs.user_id)::int AS participants,
               count(DISTINCT gs.user_id) FILTER (WHERE st.status = 'correct')::int AS completions
        FROM game_sessions gs
        JOIN session_tasks st ON st.game_session_id = gs.id
        WHERE gs.daily_challenge_id = $1
      `, [daily.id]),
      user ? dependencies.postgres.query<{
        id: string; status: string; score: number; rating_delta: number; started_at: Date;
      }>(`
        SELECT id, status, score, rating_delta, started_at FROM game_sessions
        WHERE user_id = $1 AND daily_challenge_id = $2
      `, [user.id, daily.id]) : Promise.resolve({ rows: [] }),
      user ? dependencies.postgres.query<{
        current_daily_streak: number; best_daily_streak: number; last_daily_date: string | null;
      }>(`
        SELECT current_daily_streak, best_daily_streak, last_daily_date
        FROM user_progress WHERE user_id = $1
      `, [user.id]) : Promise.resolve({ rows: [] }),
    ]);
    const session = progress.rows[0];
    const userStreak = streak.rows[0];
    return reply.header('cache-control', 'no-store').send({
      authenticated: Boolean(user),
      daily: publicDaily(daily),
      community: community.rows[0] ?? { participants: 0, completions: 0 },
      progress: session ? {
        gameSessionId: session.id,
        status: session.status,
        completed: session.status === 'completed',
        score: session.score,
        ratingDelta: session.rating_delta,
        practiceScoreDelta: session.rating_delta,
        startedAt: session.started_at.toISOString(),
      } : null,
      streak: {
        current: userStreak?.current_daily_streak ?? 0,
        best: userStreak?.best_daily_streak ?? 0,
        lastDate: userStreak?.last_daily_date ?? null,
      },
    });
  });

  app.post('/api/daily/start', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    if (!hasSameOrigin(request)) return forbidden(reply);
    const user = await auth.currentUser(request);
    if (!user) return reply.code(401).send({ error: 'Unauthorized', message: 'Войдите, чтобы пройти испытание дня.' });
    const daily = await ensureDailyChallenge(dependencies);
    if (!daily) return unavailable(reply);

    const existing = await findDailySession(dependencies, user.id, daily.id);
    if (existing) return reply.header('cache-control', 'no-store').send(existing);

    const client = await dependencies.postgres.connect();
    try {
      await client.query('BEGIN');
      const sessionId = randomUUID();
      await client.query(`
        INSERT INTO game_sessions (
          id, user_id, category_id, difficulty, mode, daily_challenge_id
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `, [sessionId, user.id, daily.category_id, daily.difficulty, daily.type, daily.id]);
      await client.query(`
        INSERT INTO session_tasks (game_session_id, challenge_id, position, status, presented_at)
        VALUES ($1, $2, 1, 'active', now())
      `, [sessionId, daily.challenge_id]);
      await client.query('COMMIT');
      return reply.header('cache-control', 'no-store').code(201).send({
        gameSessionId: sessionId,
        status: 'active',
      });
    } catch (error) {
      await client.query('ROLLBACK');
      if (isUniqueViolation(error)) {
        const raced = await findDailySession(dependencies, user.id, daily.id);
        if (raced) return reply.header('cache-control', 'no-store').send(raced);
      }
      throw error;
    } finally {
      client.release();
    }
  });
}

async function ensureDailyChallenge(dependencies: Dependencies): Promise<DailyRow | undefined> {
  await dependencies.postgres.query(`
    INSERT INTO daily_challenges (challenge_date, challenge_id, bonus_multiplier)
    SELECT CURRENT_DATE, c.id, 1.25
    FROM challenges c
    WHERE c.enabled AND c.type IN ('recall', 'quick') AND c.difficulty IN ('Easy', 'Medium')
    ORDER BY md5(c.id::text || CURRENT_DATE::text)
    LIMIT 1
    ON CONFLICT (challenge_date) DO NOTHING
  `);
  const result = await dependencies.postgres.query<DailyRow>(`
    SELECT dc.id, dc.challenge_date, dc.bonus_multiplier,
           (CURRENT_DATE + INTERVAL '1 day')::timestamptz AS next_reset_at,
           c.id AS challenge_id, c.slug, c.title, c.description, c.difficulty, c.type,
           categories.id AS category_id, categories.slug AS category_slug, categories.name AS category_name
    FROM daily_challenges dc
    JOIN challenges c ON c.id = dc.challenge_id AND c.enabled
    JOIN categories ON categories.id = c.category_id AND categories.enabled
    WHERE dc.challenge_date = CURRENT_DATE
  `);
  return result.rows[0];
}

async function findDailySession(dependencies: Dependencies, userId: string, dailyId: string) {
  const result = await dependencies.postgres.query<{ id: string; status: string }>(`
    SELECT id, status FROM game_sessions WHERE user_id = $1 AND daily_challenge_id = $2
  `, [userId, dailyId]);
  const session = result.rows[0];
  return session ? { gameSessionId: session.id, status: session.status } : undefined;
}

function publicDaily(daily: DailyRow) {
  return {
    date: daily.challenge_date,
    nextResetAt: daily.next_reset_at.toISOString(),
    bonusMultiplier: Number(daily.bonus_multiplier),
    challenge: {
      slug: daily.slug,
      title: daily.title,
      description: daily.description,
      difficulty: daily.difficulty,
      type: daily.type,
      category: { slug: daily.category_slug, name: daily.category_name },
    },
  };
}

function forbidden(reply: FastifyReply) {
  return reply.code(403).send({ error: 'Forbidden origin', message: 'Запрос отклонён системой безопасности.' });
}

function unavailable(reply: FastifyReply) {
  return reply.code(503).send({ error: 'Daily unavailable', message: 'Испытание дня временно недоступно.' });
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
