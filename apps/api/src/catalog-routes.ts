import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Dependencies } from './services.js';

const querySchema = z.object({
  category: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
  difficulty: z.enum(['Easy', 'Medium', 'Hard', 'Expert']).optional(),
  type: z.enum(['typing', 'recall', 'quick', 'real_shell']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export async function registerCatalogRoutes(
  app: FastifyInstance,
  dependencies: Dependencies,
): Promise<void> {
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
    values.push(parsed.data.limit);

    const result = await dependencies.postgres.query<PublicChallengeRow>(`
      SELECT
        challenges.slug,
        challenges.title,
        challenges.description,
        challenges.difficulty,
        challenges.type,
        challenges.scoring_config,
        categories.slug AS category_slug,
        categories.name AS category_name
      FROM challenges
      JOIN categories ON categories.id = challenges.category_id
      WHERE ${filters.join(' AND ')}
      ORDER BY categories.sort_order, challenges.id
      LIMIT $${values.length}
    `, values);

    return reply.header('cache-control', 'public, max-age=30').send({ challenges: result.rows });
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
        categories.slug AS category_slug,
        categories.name AS category_name
      FROM challenges
      JOIN categories ON categories.id = challenges.category_id
      WHERE challenges.slug = $1 AND challenges.enabled AND categories.enabled
    `, [slug]);
    const challenge = result.rows[0];
    if (!challenge) return reply.code(404).send({ error: 'Not Found', message: 'Задание не найдено.' });
    return reply.header('cache-control', 'public, max-age=30').send({ challenge });
  });
}

interface PublicChallengeRow {
  slug: string;
  title: string;
  description: string;
  difficulty: 'Easy' | 'Medium' | 'Hard' | 'Expert';
  type: 'typing' | 'recall' | 'quick' | 'real_shell';
  scoring_config: Record<string, unknown>;
  category_slug: string;
  category_name: string;
}
