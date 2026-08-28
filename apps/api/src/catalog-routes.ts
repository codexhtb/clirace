import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Dependencies } from './services.js';
import { AuthService } from './auth-service.js';
import type { AppConfig } from './config.js';

const querySchema = z.object({
  category: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
  difficulty: z.enum(['Easy', 'Medium', 'Hard', 'Expert']).optional(),
  type: z.enum(['typing', 'recall', 'quick', 'real_shell']).optional(),
  tier: z.enum(['foundation', 'operator', 'engineer', 'troubleshooter']).optional(),
  q: z.string().trim().min(1).max(80).optional(),
  libraryVersion: z.literal('2').optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

export async function registerCatalogRoutes(
  app: FastifyInstance,
  config: AppConfig,
  dependencies: Dependencies,
): Promise<void> {
  const auth = new AuthService(config, dependencies);
  app.get('/api/categories', async (_request, reply) => {
    const result = await dependencies.postgres.query<{
      slug: string;
      name: string;
      description: string;
      challenge_count: number;
    }>(`
      SELECT
        categories.slug,
        categories.name,
        categories.description,
        count(challenges.id)::int AS challenge_count
      FROM categories
      LEFT JOIN challenges ON challenges.category_id = categories.id AND challenges.enabled
      WHERE categories.enabled
      GROUP BY categories.id
      ORDER BY categories.sort_order, categories.id
    `);
    return reply.header('cache-control', 'public, max-age=60').send({ categories: result.rows });
  });

  app.get('/api/challenges', async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid filters', message: 'Некорректные параметры каталога.' });
    }

    const values: unknown[] = [];
    const filters = ['challenges.enabled', 'categories.enabled'];
    if (parsed.data.category) {
      values.push(parsed.data.category);
      filters.push(`categories.slug = $${values.length}`);
    }
    if (parsed.data.difficulty) {
      values.push(parsed.data.difficulty);
      filters.push(`challenges.difficulty = $${values.length}`);
    }
    if (parsed.data.type) {
      values.push(parsed.data.type);
      filters.push(`challenges.type = $${values.length}`);
    }
    if (parsed.data.tier) {
      values.push(parsed.data.tier);
      filters.push(`challenges.validation_config->>'tier' = $${values.length}`);
    }
    if (parsed.data.q) {
      values.push(`%${parsed.data.q}%`);
      filters.push(`(challenges.title ILIKE $${values.length} OR challenges.description ILIKE $${values.length})`);
    }
    if (parsed.data.libraryVersion) filters.push(`challenges.validation_config->>'libraryVersion' = '2'`);
    values.push(parsed.data.limit);

    const result = await dependencies.postgres.query<PublicChallengeRow>(`
      SELECT
        challenges.slug,
        challenges.title,
        challenges.description,
        challenges.difficulty,
        challenges.type,
        challenges.scoring_config,
        challenges.validation_config,
        categories.slug AS category_slug,
        categories.name AS category_name
      FROM challenges
      JOIN categories ON categories.id = challenges.category_id
      WHERE ${filters.join(' AND ')}
      ORDER BY categories.sort_order, challenges.id
      LIMIT $${values.length}
    `, values);

    const user = await auth.currentUser(request);
    const completed = user && result.rows.length
      ? await dependencies.postgres.query<{ slug: string }>(`
          SELECT DISTINCT c.slug
          FROM results r
          JOIN session_tasks st ON st.id=r.session_task_id
          JOIN challenges c ON c.id=st.challenge_id
          WHERE r.user_id=$1 AND r.correct AND c.slug=ANY($2::varchar[])
        `, [user.id, result.rows.map((row) => row.slug)])
      : { rows: [] as Array<{ slug: string }> };
    const completedSlugs = new Set(completed.rows.map((row) => row.slug));
    return reply.header('cache-control', user ? 'private, no-store' : 'public, max-age=30').send({
      challenges: result.rows.map((row) => publicChallenge(row, completedSlugs.has(row.slug))),
    });
  });

  app.get('/api/challenges/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    if (!/^[a-z0-9-]{1,100}$/.test(slug)) {
      return reply.code(404).send({ error: 'Not Found', message: 'Задание не найдено.' });
    }
    const result = await dependencies.postgres.query<PublicChallengeRow>(`
      SELECT
        challenges.slug,
        challenges.title,
        challenges.description,
        challenges.difficulty,
        challenges.type,
        challenges.scoring_config,
        challenges.validation_config,
        categories.slug AS category_slug,
        categories.name AS category_name
      FROM challenges
      JOIN categories ON categories.id = challenges.category_id
      WHERE challenges.slug = $1 AND challenges.enabled AND categories.enabled
    `, [slug]);
    const challenge = result.rows[0];
    if (!challenge) return reply.code(404).send({ error: 'Not Found', message: 'Задание не найдено.' });
    return reply.header('cache-control', 'public, max-age=30').send({ challenge: publicChallenge(challenge, false) });
  });
}

interface PublicChallengeRow {
  slug: string;
  title: string;
  description: string;
  difficulty: 'Easy' | 'Medium' | 'Hard' | 'Expert';
  type: 'typing' | 'recall' | 'quick' | 'real_shell';
  scoring_config: Record<string, unknown>;
  validation_config: Record<string, unknown>;
  category_slug: string;
  category_name: string;
}

function publicChallenge(row: PublicChallengeRow, completed: boolean) {
  const config = row.validation_config;
  return {
    slug: row.slug,
    title: row.title,
    description: row.description,
    difficulty: row.difficulty,
    type: row.type,
    scoring_config: row.scoring_config,
    category_slug: row.category_slug,
    category_name: row.category_name,
    completed,
    ...(config.libraryVersion === 2 ? {
      libraryVersion: 2,
      version: config.challengeVersion,
      tier: config.tier,
      concepts: config.concepts,
      estimatedDurationSeconds: config.estimatedDurationSeconds,
    } : {}),
  };
}
