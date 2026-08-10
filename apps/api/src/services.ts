import { Pool } from 'pg';
import { createClient } from 'redis';
import type { AppConfig } from './config.js';

export type ServiceStatus = 'up' | 'down';

export interface Dependencies {
  postgres: Pool;
  redis: ReturnType<typeof createClient>;
}

export function createDependencies(config: AppConfig): Dependencies {
  const postgres = new Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
    application_name: 'clirace-api',
  });

  const redis = createClient({ url: config.REDIS_URL });

  return { postgres, redis };
}

export async function connectDependencies(dependencies: Dependencies): Promise<void> {
  await dependencies.postgres.query('SELECT 1');
  await dependencies.redis.connect();
  await dependencies.redis.ping();
}

export async function checkDependencies(dependencies: Dependencies): Promise<{
  postgres: ServiceStatus;
  redis: ServiceStatus;
}> {
  const [postgres, redis] = await Promise.allSettled([
    dependencies.postgres.query('SELECT 1'),
    dependencies.redis.ping(),
  ]);

  return {
    postgres: postgres.status === 'fulfilled' ? 'up' : 'down',
    redis: redis.status === 'fulfilled' ? 'up' : 'down',
  };
}

export async function closeDependencies(dependencies: Dependencies): Promise<void> {
  const closeRedis = dependencies.redis.isOpen
    ? dependencies.redis.quit()
    : Promise.resolve();
  await Promise.allSettled([dependencies.postgres.end(), closeRedis]);
}
