import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuthService, type AuthUser } from './auth-service.js';
import type { AppConfig } from './config.js';
import { hasSameOrigin } from './http-security.js';
import { LearningPathError, LearningPathService } from './learning-path-service.js';
import type { Dependencies } from './services.js';

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120);
const courseParams = z.object({ course: slug });
const itemParams = z.object({ course: slug, module: slug, item: slug });
const actionParams = z.object({ course: slug, itemId: slug });

export async function registerLearningPathRoutes(app: FastifyInstance, config: AppConfig, dependencies: Dependencies): Promise<void> {
  const auth = new AuthService(config, dependencies);
  const paths = new LearningPathService(dependencies.postgres);

  app.get('/api/learn/paths', async (request, reply) => handle(reply, async () => {
    const user = await auth.currentUser(request);
    return paths.catalog(user?.id);
  }));

  app.get('/api/learn/paths/:course', async (request, reply) => handle(reply, async () => {
    const params = courseParams.safeParse(request.params);
    if (!params.success) throw new LearningPathError(400, 'invalid_course', 'Некорректный идентификатор курса.');
    const user = await auth.currentUser(request);
    return paths.course(params.data.course, user?.id);
  }));

  app.post('/api/learn/paths/:course/enroll', mutationLimit(6), async (request, reply) => handle(reply, async () => {
    ensureOrigin(request);
    const user = await requireUser(auth, request, reply);
    if (!user) return undefined;
    const params = courseParams.safeParse(request.params);
    if (!params.success) throw new LearningPathError(400, 'invalid_course', 'Некорректный идентификатор курса.');
    reply.code(201);
    return paths.enroll(user.id, params.data.course);
  }));

  app.get('/api/learn/paths/:course/modules/:module/items/:item', async (request, reply) => handle(reply, async () => {
    const user = await requireUser(auth, request, reply);
    if (!user) return undefined;
    const params = itemParams.safeParse(request.params);
    if (!params.success) throw new LearningPathError(400, 'invalid_item', 'Некорректный учебный шаг.');
    return paths.item(user.id, params.data.course, params.data.module, params.data.item);
  }));

  app.post('/api/learn/paths/:course/items/:itemId/complete-theory', mutationLimit(30), async (request, reply) => handle(reply, async () => {
    ensureOrigin(request);
    const user = await requireUser(auth, request, reply);
    if (!user) return undefined;
    const params = actionParams.safeParse(request.params);
    if (!params.success) throw new LearningPathError(400, 'invalid_item', 'Некорректный учебный шаг.');
    return paths.completeTheory(user.id, params.data.course, params.data.itemId);
  }));

  app.post('/api/learn/paths/:course/items/:itemId/start-assessment', mutationLimit(12), async (request, reply) => handle(reply, async () => {
    ensureOrigin(request);
    const user = await requireUser(auth, request, reply);
    if (!user) return undefined;
    const params = actionParams.safeParse(request.params);
    if (!params.success) throw new LearningPathError(400, 'invalid_item', 'Некорректный учебный шаг.');
    reply.code(201);
    return paths.startAssessment(user.id, params.data.course, params.data.itemId);
  }));

  app.post('/api/learn/paths/:course/sync', mutationLimit(60), async (request, reply) => handle(reply, async () => {
    ensureOrigin(request);
    const user = await requireUser(auth, request, reply);
    if (!user) return undefined;
    const params = courseParams.safeParse(request.params);
    if (!params.success) throw new LearningPathError(400, 'invalid_course', 'Некорректный идентификатор курса.');
    return paths.sync(user.id, params.data.course);
  }));
}

function mutationLimit(max: number) { return { config: { rateLimit: { max, timeWindow: '1 minute' } } }; }
function ensureOrigin(request: FastifyRequest): void {
  if (!hasSameOrigin(request)) throw new LearningPathError(403, 'forbidden_origin', 'Запрос отклонён системой безопасности.');
}
async function requireUser(auth: AuthService, request: FastifyRequest, reply: FastifyReply): Promise<AuthUser | null> {
  const user = await auth.currentUser(request);
  if (!user) reply.code(401).send({ error: 'Unauthorized', code: 'authentication_required', message: 'Войдите, чтобы сохранять прогресс курса.' });
  return user;
}
async function handle(reply: FastifyReply, operation: () => Promise<unknown>): Promise<unknown> {
  try {
    const result = await operation();
    if (reply.sent) return undefined;
    return reply.header('cache-control', 'no-store').send(result);
  } catch (error) {
    if (error instanceof LearningPathError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    throw error;
  }
}
