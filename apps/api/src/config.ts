import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  HTTP_BODY_LIMIT_BYTES: z.coerce.number().int().min(16_384).max(1_048_576).default(65_536),
  DATABASE_URL: z.string().url().default('postgresql://clirace:clirace@localhost:5432/clirace'),
  REDIS_URL: z.string().url().default('redis://:clirace@localhost:6379'),
  AUTH_COOKIE_NAME: z.string().regex(/^[A-Za-z0-9_-]+$/).default('clirace_session'),
  AUTH_SESSION_TTL_SECONDS: z.coerce.number().int().min(3600).max(2_592_000).default(604_800),
  AUTH_COOKIE_SECURE: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  SANDBOX_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  SANDBOX_DOCKER_SOCKET: z.string().min(1).default('/run/clirace-sandbox/docker.sock'),
  SANDBOX_IMAGE: z.string().min(1).default('clirace-sandbox:0.2.0'),
  SANDBOX_MEMORY_MB: z.coerce.number().int().min(128).max(1024).default(256),
  SANDBOX_CPUS: z.coerce.number().min(0.1).max(1).default(0.25),
  SANDBOX_PIDS: z.coerce.number().int().min(32).max(256).default(64),
  SANDBOX_MAX_SESSIONS: z.coerce.number().int().min(1).max(128).default(25),
  SANDBOX_MAX_SESSIONS_PER_USER: z.coerce.number().int().min(1).max(8).default(1),
  SANDBOX_WARM_POOL_SIZE: z.coerce.number().int().min(0).max(16).default(0),
  SANDBOX_MAX_LIFETIME_SECONDS: z.coerce.number().int().min(60).max(1800).default(900),
  SANDBOX_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(600).default(180),
  BATTLE_COUNTDOWN_MS: z.coerce.number().int().min(1_000).max(10_000).default(3_000),
  BATTLE_RECONNECT_GRACE_SECONDS: z.coerce.number().int().min(10).max(300).default(60),
  BATTLE_WAITING_TTL_SECONDS: z.coerce.number().int().min(300).max(7_200).default(1_800),
  BATTLE_MAX_LIFETIME_SECONDS: z.coerce.number().int().min(300).max(7_200).default(1_800),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = schema.safeParse(environment);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  return result.data;
}
