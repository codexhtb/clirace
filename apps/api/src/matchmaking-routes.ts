import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthService, type AuthUser } from './auth-service.js';
import type { AppConfig } from './config.js';
import { hasSameOrigin } from './http-security.js';
import { MatchmakingError, type MatchmakingManager } from './matchmaking-service.js';
import type { Dependencies } from './services.js';

export async function registerMatchmakingRoutes(
  app: FastifyInstance,
  config: AppConfig,
  dependencies: Dependencies,
  matchmaking: MatchmakingManager,
): Promise<void> {
  const auth = new AuthService(config, dependencies);

  app.post('/api/matchmaking/queue', {
    config: { rateLimit: { max: 8, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    if (!hasSameOrigin(request)) return forbiddenOrigin(reply);
    const user = await requireUser(auth, request, reply);
    if (!user) return;
    return sendResult(reply, () => matchmaking.enqueue(user));
  });

  app.get('/api/matchmaking/status', {
    // Polling runs every 1.5 seconds and several authenticated users may share
    // one NAT address. Keep this read-only limit comfortably above that load.
    config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const user = await requireUser(auth, request, reply);
    if (!user) return;
    return sendResult(reply, () => matchmaking.status(user.id));
  });

  app.post('/api/matchmaking/heartbeat', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    if (!hasSameOrigin(request)) return forbiddenOrigin(reply);
    const user = await requireUser(auth, request, reply);
    if (!user) return;
    return sendResult(reply, () => matchmaking.heartbeat(user));
  });

  app.delete('/api/matchmaking/queue', {
    config: { rateLimit: { max: 12, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    if (!hasSameOrigin(request)) return forbiddenOrigin(reply);
    const user = await requireUser(auth, request, reply);
    if (!user) return;
    return sendResult(reply, () => matchmaking.cancel(user.id));
  });

  app.get('/api/matchmaking/metrics', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const user = await requireUser(auth, request, reply);
    if (!user) return;
    if (user.role !== 'admin') {
      return reply.code(403).send({
        error: 'Forbidden', code: 'admin_required', message: 'Метрики доступны только администратору.',
      });
    }
    return reply
      .header('cache-control', 'no-store')
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(await matchmaking.prometheusMetrics());
  });
}

async function requireUser(
  auth: AuthService,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthUser | null> {
  const user = await auth.currentUser(request);
  if (!user) {
    reply.code(401).send({
      error: 'Unauthorized', code: 'authentication_required',
      message: 'Войдите в аккаунт, чтобы искать соперника.',
    });
  }
  return user;
}

async function sendResult(reply: FastifyReply, operation: () => Promise<unknown>) {
  try {
    return reply.header('cache-control', 'no-store').send(await operation());
  } catch (error) {
    if (error instanceof MatchmakingError) {
      return reply.code(error.statusCode).send({
        error: 'Matchmaking state error',
        code: error.code,
        message: error.message,
        ...(error.details ?? {}),
      });
    }
    reply.request.log.error({ error }, 'Matchmaking request failed');
    return reply.code(503).send({
      error: 'Matchmaking unavailable',
      code: 'temporarily_unavailable',
      message: 'Поиск соперника временно недоступен. Попробуйте ещё раз.',
    });
  }
}

function forbiddenOrigin(reply: FastifyReply) {
  return reply.code(403).send({
    error: 'Forbidden origin', code: 'invalid_origin',
    message: 'Запрос отклонён системой безопасности.',
  });
}
