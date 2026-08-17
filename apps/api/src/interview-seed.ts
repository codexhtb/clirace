import type { PoolClient } from 'pg';
import { assertInterviewData, INTERVIEW_100 } from './interview-data.js';

const COLLECTION_SLUG = 'interview-100';

export async function seedInterview100(client: PoolClient): Promise<void> {
  assertInterviewData();
  await client.query('BEGIN');
  try {
    const collection = await client.query<{ id: number }>(`
      INSERT INTO challenge_collections (slug, name, description)
      VALUES ($1, 'Interview 100', 'Сто практических задач для подготовки к Linux/DevOps собеседованию.')
      ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
        enabled = true, updated_at = now()
      RETURNING id
    `, [COLLECTION_SLUG]);
    const collectionId = collection.rows[0]!.id;

    for (const [index, task] of INTERVIEW_100.entries()) {
      const validation = task.type === 'real_shell'
        ? { kind: 'sandbox_state', sandboxChallengeId: task.slug }
        : { kind: 'command_semantics', accepted: [task.solution, ...task.alternatives], successFeedback: task.explanation };
      const base = task.difficulty === 'Easy' ? 100 : task.difficulty === 'Medium' ? 150 : 220;
      const challenge = await client.query<{ id: string }>(`
        INSERT INTO challenges (
          slug, title, description, category_id, difficulty, type, scoring_config, validation_config,
          solution, explanation, tags, alternative_solutions, enabled
        )
        SELECT $1, $2, $3, categories.id, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11::text[], $12::jsonb, true
        FROM categories WHERE slug = $4
        ON CONFLICT (slug) DO UPDATE SET
          title = EXCLUDED.title, description = EXCLUDED.description, category_id = EXCLUDED.category_id,
          difficulty = EXCLUDED.difficulty, type = EXCLUDED.type, scoring_config = EXCLUDED.scoring_config,
          validation_config = EXCLUDED.validation_config, solution = EXCLUDED.solution,
          explanation = EXCLUDED.explanation, tags = EXCLUDED.tags,
          alternative_solutions = EXCLUDED.alternative_solutions, enabled = true, updated_at = now()
        RETURNING id
      `, [
        task.slug, task.title, task.description, task.category, task.difficulty, task.type,
        JSON.stringify({ base, timeTargetMs: task.difficulty === 'Easy' ? 20_000 : task.difficulty === 'Medium' ? 35_000 : 55_000 }),
        JSON.stringify(validation), task.solution, task.explanation, [...task.tags], JSON.stringify(task.alternatives),
      ]);
      if (!challenge.rows[0]) throw new Error(`Category ${task.category} is missing for ${task.slug}`);
      await client.query(`
        INSERT INTO challenge_collection_items (collection_id, challenge_id, position, topic)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (collection_id, challenge_id) DO UPDATE SET position = EXCLUDED.position, topic = EXCLUDED.topic
      `, [collectionId, challenge.rows[0].id, index + 1, task.topic]);
    }

    const slugs = INTERVIEW_100.map((task) => task.slug);
    await client.query(`
      DELETE FROM challenge_collection_items items USING challenges
      WHERE items.collection_id = $1 AND items.challenge_id = challenges.id
        AND NOT (challenges.slug = ANY($2::varchar[]))
    `, [collectionId, slugs]);
    const count = await client.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM challenge_collection_items WHERE collection_id = $1', [collectionId],
    );
    if (count.rows[0]?.count !== 100) throw new Error(`Seeded Interview collection has ${count.rows[0]?.count} items`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
