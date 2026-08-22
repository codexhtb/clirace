import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuthService, type AuthUser } from './auth-service.js';
import type { AppConfig } from './config.js';
import { hasSameOrigin } from './http-security.js';
import { LINUX_CORE_CATEGORIES } from './learning-content.js';
import { LearningError, LearningService } from './learning-service.js';
import type { Dependencies } from './services.js';

const createSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.enum(['quick', 'standard', 'full']) }).strict(),
  z.object({ mode: z.literal('topic'), category: z.enum(LINUX_CORE_CATEGORIES) }).strict(),
]);
const sessionParams = z.object({ id: z.string().uuid() });
const answerSchema = z.object({
  questionSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120),
  answerIds: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/)).min(1).max(8),
}).strict();

export async function registerLearningRoutes(app: FastifyInstance, config: AppConfig, dependencies: Dependencies): Promise<void> {
  const auth = new AuthService(config, dependencies);
  const learning = new LearningService(dependencies.postgres);

  app.get('/api/learn/linux-core', async (request) => {
    const user = await auth.currentUser(request);
    return learning.catalog(user?.id);
  });

  app.get('/api/learn/sessions/current', async (request, reply) => handle(reply, async () => {
    const user = await requireUser(auth, request, reply);
    return user ? learning.current(user.id) : undefined;
  }));

  app.get('/api/learn/sessions/:id', async (request, reply) => handle(reply, async () => {
    const user = await requireUser(auth, request, reply);
    if (!user) return undefined;
    const params = sessionParams.safeParse(request.params);
    if (!params.success) throw new LearningError(400, 'invalid_session_id', 'Некорректный идентификатор сессии.');
    return learning.getSession(user.id, params.data.id);
  }));

  app.post('/api/learn/sessions', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async (request, reply) => handle(reply, async () => {
    if (!hasSameOrigin(request)) throw new LearningError(403, 'forbidden_origin', 'Запрос отклонён.');
    const user = await requireUser(auth, request, reply);
    if (!user) return undefined;
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) throw new LearningError(400, 'invalid_mode', 'Выберите доступный режим обучения.');
    const session = await learning.createSession(user.id, parsed.data.mode, 'category' in parsed.data ? parsed.data.category : undefined);
    reply.code(201);
    return session;
  }));

  app.post('/api/learn/sessions/:id/answers', { config: { rateLimit: { max: 90, timeWindow: '1 minute' } } }, async (request, reply) => handle(reply, async () => {
    if (!hasSameOrigin(request)) throw new LearningError(403, 'forbidden_origin', 'Запрос отклонён.');
    const user = await requireUser(auth, request, reply);
    if (!user) return undefined;
    const params = sessionParams.safeParse(request.params);
    const body = answerSchema.safeParse(request.body);
    if (!params.success || !body.success) throw new LearningError(400, 'invalid_answer', 'Проверьте выбранный ответ.');
    return learning.submitAnswer(user.id, params.data.id, body.data.questionSlug, body.data.answerIds);
  }));

  app.post('/api/learn/sessions/:id/next', { config: { rateLimit: { max: 90, timeWindow: '1 minute' } } }, async (request, reply) => handle(reply, async () => {
    if (!hasSameOrigin(request)) throw new LearningError(403, 'forbidden_origin', 'Запрос отклонён.');
    const user = await requireUser(auth, request, reply);
    if (!user) return undefined;
    const params = sessionParams.safeParse(request.params);
    if (!params.success) throw new LearningError(400, 'invalid_session_id', 'Некорректный идентификатор сессии.');
    return learning.next(user.id, params.data.id);
  }));
}

async function requireUser(auth: AuthService, request: FastifyRequest, reply: FastifyReply): Promise<AuthUser | null> {
  const user = await auth.currentUser(request);
  if (!user) reply.code(401).send({ error: 'Unauthorized', code: 'authentication_required', message: 'Войдите в аккаунт, чтобы начать обучение.' });
  return user;
}

async function handle(reply: FastifyReply, operation: () => Promise<unknown>): Promise<unknown> {
  try {
    const result = await operation();
    if (reply.sent) return undefined;
    return reply.header('cache-control', 'no-store').send(result);
  } catch (error) {
    if (error instanceof LearningError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    throw error;
  }
}
