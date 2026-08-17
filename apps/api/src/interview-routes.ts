import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuthService, type AuthUser } from './auth-service.js';
import type { AppConfig } from './config.js';
import { loadGameState } from './game-routes.js';
import { hasSameOrigin } from './http-security.js';
import { INTERVIEW_TOPIC_LABELS } from './interview-data.js';
import type { Dependencies } from './services.js';

const COLLECTION = 'interview-100';
const filtersSchema = z.object({
  status: z.enum(['all', 'solved', 'unsolved']).default('all'),
  difficulty: z.enum(['all', 'Easy', 'Medium', 'Hard']).default('all'),
  topic: z.union([z.literal('all'), z.string().regex(/^[a-z-]{2,40}$/)]).default('all'),
}).strict();
const runSchema = z.object({ taskCount: z.union([z.literal(10), z.literal(25), z.literal(50)]) }).strict();

interface Candidate {
  id: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  topic: string;
}

export async function registerInterviewRoutes(
  app: FastifyInstance,
  config: AppConfig,
  dependencies: Dependencies,
): Promise<void> {
  const auth = new AuthService(config, dependencies);

  app.get('/api/interview', async (request, reply) => {
    const parsed = filtersSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid filters', message: 'Некорректные фильтры.' });
    const user = await auth.currentUser(request);
    const values: unknown[] = [user?.id ?? null, COLLECTION];
    const filters = ['collections.slug = $2', 'collections.enabled', 'challenges.enabled'];
    if (parsed.data.difficulty !== 'all') {
      values.push(parsed.data.difficulty);
      filters.push(`challenges.difficulty = $${values.length}`);
    }
    if (parsed.data.topic !== 'all') {
      values.push(parsed.data.topic);
      filters.push(`items.topic = $${values.length}`);
    }
    if (parsed.data.status !== 'all') filters.push(parsed.data.status === 'solved' ? 'progress.solved' : 'NOT progress.solved');

    const tasks = await dependencies.postgres.query<{
      slug: string; title: string; description: string; difficulty: string; type: string;
      topic: string; position: number; category_slug: string; category_name: string;
      solved: boolean; solution: string | null; explanation: string | null; alternatives: string[];
    }>(`
      SELECT challenges.slug, challenges.title, challenges.description, challenges.difficulty,
             challenges.type, items.topic, items.position, categories.slug AS category_slug,
             categories.name AS category_name, progress.solved,
             CASE WHEN progress.solved THEN challenges.solution END AS solution,
             CASE WHEN progress.solved THEN challenges.explanation END AS explanation,
             CASE WHEN progress.solved THEN challenges.alternative_solutions ELSE '[]'::jsonb END AS alternatives
      FROM challenge_collection_items items
      JOIN challenge_collections collections ON collections.id = items.collection_id
      JOIN challenges ON challenges.id = items.challenge_id
      JOIN categories ON categories.id = challenges.category_id
      CROSS JOIN LATERAL (
        SELECT EXISTS (
          SELECT 1 FROM session_tasks st JOIN results r ON r.session_task_id = st.id
          WHERE st.challenge_id = challenges.id AND r.user_id = $1::bigint AND r.correct
        ) AS solved
      ) progress
      WHERE ${filters.join(' AND ')}
      ORDER BY items.position
    `, values);
    const summary = await dependencies.postgres.query<{
      total: number; solved: number; easy: number; medium: number; hard: number;
    }>(`
      SELECT count(*)::int AS total,
        count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM session_tasks st JOIN results r ON r.session_task_id = st.id
          WHERE st.challenge_id = challenges.id AND r.user_id = $1::bigint AND r.correct
        ))::int AS solved,
        count(*) FILTER (WHERE challenges.difficulty = 'Easy')::int AS easy,
        count(*) FILTER (WHERE challenges.difficulty = 'Medium')::int AS medium,
        count(*) FILTER (WHERE challenges.difficulty = 'Hard')::int AS hard
      FROM challenge_collection_items items
      JOIN challenge_collections collections ON collections.id = items.collection_id
      JOIN challenges ON challenges.id = items.challenge_id
      WHERE collections.slug = $2 AND collections.enabled AND challenges.enabled
    `, [user?.id ?? null, COLLECTION]);

    return reply.header('cache-control', 'no-store').send({
      collection: { slug: COLLECTION, name: 'Interview 100', description: 'Практическая подготовка к Linux/DevOps собеседованию.' },
      summary: summary.rows[0],
      topics: Object.entries(INTERVIEW_TOPIC_LABELS).map(([slug, name]) => ({ slug, name })),
      authenticated: Boolean(user),
      tasks: tasks.rows,
    });
  });

  app.post('/api/interview/runs', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!hasSameOrigin(request)) return reply.code(403).send({ error: 'Forbidden', message: 'Запрос отклонён.' });
    const user = await requireUser(auth, request, reply);
    if (!user) return;
    const parsed = runSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request', message: 'Выберите 10, 25 или 50 заданий.' });
    if (!config.SANDBOX_ENABLED) return reply.code(503).send({ error: 'Sandbox unavailable', message: 'Interview Run требует включённую shell-песочницу.' });

    const candidates = await dependencies.postgres.query<Candidate>(`
      SELECT challenges.id, challenges.difficulty, items.topic
      FROM challenge_collection_items items
      JOIN challenge_collections collections ON collections.id = items.collection_id
      JOIN challenges ON challenges.id = items.challenge_id
      WHERE collections.slug = $1 AND collections.enabled AND challenges.enabled
      ORDER BY random()
    `, [COLLECTION]);
    const selected = balancedSelection(candidates.rows, parsed.data.taskCount);
    if (selected.length !== parsed.data.taskCount) return reply.code(503).send({ error: 'Collection incomplete', message: 'Коллекция заданий ещё не готова.' });

    const client = await dependencies.postgres.connect();
    try {
      await client.query('BEGIN');
      const sessionId = randomUUID();
      const collection = await client.query<{ id: number }>('SELECT id FROM challenge_collections WHERE slug = $1', [COLLECTION]);
      await client.query(`
        INSERT INTO game_sessions (id, user_id, mode, collection_id) VALUES ($1, $2, 'interview', $3)
      `, [sessionId, user.id, collection.rows[0]!.id]);
      for (const [index, challenge] of selected.entries()) {
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
      return reply.code(201).header('cache-control', 'no-store').send(await loadGameState(dependencies.postgres, sessionId, user.id));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
}

function balancedSelection(candidates: Candidate[], count: 10 | 25 | 50): Candidate[] {
  const quotas = count === 10 ? { Easy: 3, Medium: 5, Hard: 2 }
    : count === 25 ? { Easy: 8, Medium: 12, Hard: 5 }
      : { Easy: 15, Medium: 25, Hard: 10 };
  const chosen: Candidate[] = [];
  const topicUse = new Map<string, number>();
  for (const difficulty of ['Easy', 'Medium', 'Hard'] as const) {
    const pool = candidates.filter((task) => task.difficulty === difficulty);
    for (let index = 0; index < quotas[difficulty]; index += 1) {
      pool.sort((a, b) => (topicUse.get(a.topic) ?? 0) - (topicUse.get(b.topic) ?? 0));
      const task = pool.shift();
      if (!task) break;
      chosen.push(task);
      topicUse.set(task.topic, (topicUse.get(task.topic) ?? 0) + 1);
    }
  }
  return chosen.sort(() => Math.random() - 0.5);
}

async function requireUser(auth: AuthService, request: FastifyRequest, reply: FastifyReply): Promise<AuthUser | null> {
  const user = await auth.currentUser(request);
  if (!user) reply.code(401).send({ error: 'Unauthorized', message: 'Войдите в аккаунт, чтобы начать Interview Run.' });
  return user;
}
