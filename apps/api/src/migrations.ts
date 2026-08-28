import { readdir, readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { seedInterview100 } from './interview-seed.js';
import { importLinuxCoreQuestions } from './learning-content.js';
import { importLearningPaths } from './learning-path-content.js';
import { importChallengeLibraryV2 } from './challenge-library-v2/catalog.js';

const MIGRATION_LOCK_ID = 1_971_204_245;

export async function runMigrations(postgres: Pool): Promise<void> {
  const client = await postgres.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const directory = new URL('../migrations/', import.meta.url);
    const files = (await readdir(directory))
      .filter((file) => /^\d+_[a-z0-9_]+\.sql$/.test(file))
      .sort();

    const applied = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
    const appliedVersions = new Set(applied.rows.map((row) => row.version));

    for (const file of files) {
      if (appliedVersions.has(file)) continue;
      const sql = await readFile(new URL(file, directory), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    await seedInterview100(client);
    await importLinuxCoreQuestions(client);
    await importChallengeLibraryV2(client);
    await importLearningPaths(client);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}
