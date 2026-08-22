import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AuthService } from './auth-service.js';
import type { AppConfig } from './config.js';
import { hasSameOrigin } from './http-security.js';
import { hashPassword, verifyPassword } from './password.js';
import type { Dependencies } from './services.js';

const registerSchema = z.object({
  username: z.string().trim().min(3).max(24).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  email: z.string().trim().email().max(254),
  password: z.string().min(10).max(128),
}).strict();

const loginSchema = z.object({
  identifier: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(128),
}).strict();

const deleteAccountSchema = z.object({
  password: z.string().min(1).max(128),
}).strict();

export async function registerAuthRoutes(
  app: FastifyInstance,
  config: AppConfig,
  dependencies: Dependencies,
): Promise<void> {
  const auth = new AuthService(config, dependencies);

  app.post('/api/auth/register', {
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
  }, async (request, reply) => {
    if (!hasSameOrigin(request)) return forbidden(reply);
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid registration data',
        message: 'Проверьте имя, email и пароль. Пароль должен содержать не меньше 10 символов.',
      });
    }

    const usernameNormalized = parsed.data.username.toLowerCase();
    const emailNormalized = parsed.data.email.toLowerCase();
    const passwordHash = await hashPassword(parsed.data.password);
    try {
      const result = await dependencies.postgres.query<{
        id: string;
        username: string;
        email: string;
        created_at: Date;
        role: 'user';
        account_status: 'active';
      }>(`
        INSERT INTO users (username, username_normalized, email, email_normalized, password_hash)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, username, email, created_at, role, account_status
      `, [parsed.data.username, usernameNormalized, parsed.data.email, emailNormalized, passwordHash]);
      const user = result.rows[0]!;
      await dependencies.postgres.query(
        'INSERT INTO user_ratings (user_id, category_id) VALUES ($1, NULL)',
        [user.id],
      );
      await dependencies.postgres.query(
        'INSERT INTO user_progress (user_id) VALUES ($1)',
        [user.id],
      );
      await auth.startSession(user.id, request, reply);
      return reply.header('cache-control', 'no-store').code(201).send({
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          createdAt: user.created_at.toISOString(),
          role: user.role,
          accountStatus: user.account_status,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({
          error: 'Account already exists',
          message: 'Пользователь с таким именем или email уже существует.',
        });
      }
      throw error;
    }
  });

  app.post('/api/auth/login', {
    config: { rateLimit: { max: 8, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    if (!hasSameOrigin(request)) return forbidden(reply);
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return invalidCredentials(reply);

    const identifier = parsed.data.identifier.toLowerCase();
    const result = await dependencies.postgres.query<{
      id: string;
      username: string;
      email: string;
      password_hash: string;
      created_at: Date;
      account_status: 'active' | 'suspended';
      role: 'user' | 'admin';
    }>(`
      SELECT id, username, email, password_hash, created_at, account_status, role
      FROM users
      WHERE username_normalized = $1 OR email_normalized = $1
      LIMIT 1
    `, [identifier]);
    const user = result.rows[0];
    const passwordValid = user
      ? await verifyPassword(parsed.data.password, user.password_hash)
      : await hashPassword(parsed.data.password).then(() => false);
    if (!user || !passwordValid) return invalidCredentials(reply);
    if (user.account_status !== 'active') {
      await auth.revokeAllSessions(user.id);
      return reply.code(403).send({
        error: 'Account suspended',
        code: 'account_suspended',
        message: 'Аккаунт приостановлен. Обратитесь к администратору CLIRace.',
      });
    }

    await dependencies.postgres.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    await auth.startSession(user.id, request, reply);
    return reply.header('cache-control', 'no-store').send({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        createdAt: user.created_at.toISOString(),
        role: user.role,
        accountStatus: user.account_status,
      },
    });
  });

  app.post('/api/auth/logout', async (request, reply) => {
    if (!hasSameOrigin(request)) return forbidden(reply);
    await auth.endSession(request, reply);
    return reply.header('cache-control', 'no-store').code(204).send();
  });

  app.get('/api/auth/me', async (request, reply) => {
    const user = await auth.currentUser(request);
    return reply.header('cache-control', 'no-store').send({ user });
  });

  app.delete('/api/auth/account', {
    config: { rateLimit: {
      max: 5,
      timeWindow: '1 hour',
      keyGenerator: (request) => {
        const token = request.cookies[config.AUTH_COOKIE_NAME];
        return token ? createHash('sha256').update(token).digest('hex') : request.ip;
      },
    } },
  }, async (request, reply) => {
    if (!hasSameOrigin(request)) return forbidden(reply);
    const user = await auth.currentUser(request);
    if (!user) return reply.code(401).send({ error: 'Unauthorized', message: 'Сначала войдите в аккаунт.' });
    const parsed = deleteAccountSchema.safeParse(request.body);
    if (!parsed.success) return invalidCredentials(reply);
    const account = await dependencies.postgres.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1', [user.id],
    );
    const passwordValid = account.rows[0]
      ? await verifyPassword(parsed.data.password, account.rows[0].password_hash)
      : false;
    if (!passwordValid) return invalidCredentials(reply);
    await auth.endSession(request, reply);
    await dependencies.postgres.query('DELETE FROM users WHERE id = $1', [user.id]);
    return reply.header('cache-control', 'no-store').code(204).send();
  });
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

function forbidden(reply: { code: (status: number) => { send: (body: unknown) => unknown } }): unknown {
  return reply.code(403).send({ error: 'Forbidden origin', message: 'Запрос отклонён системой безопасности.' });
}

function invalidCredentials(reply: { code: (status: number) => { send: (body: unknown) => unknown } }): unknown {
  return reply.code(401).send({ error: 'Invalid credentials', message: 'Неверное имя пользователя, email или пароль.' });
}
