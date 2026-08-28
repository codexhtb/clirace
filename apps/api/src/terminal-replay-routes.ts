import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AuthService } from './auth-service.js';
import type { AppConfig } from './config.js';
import { hasSameOrigin } from './http-security.js';
import type { Dependencies } from './services.js';
import { InvalidReplayPayloadError, TerminalReplayService, UnsupportedReplayFormatError } from './terminal-replay-service.js';

const replayParamsSchema = z.object({ id: z.string().uuid() }).strict();

export async function registerTerminalReplayRoutes(
  app: FastifyInstance,
  config: AppConfig,
  dependencies: Dependencies,
): Promise<void> {
  const auth = new AuthService(config, dependencies);
  const replays = new TerminalReplayService(dependencies);

  app.get('/api/practice/replays/:id', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const user = await auth.currentUser(request);
    if (!user) return reply.code(401).send({ error: 'Unauthorized', message: 'Войдите, чтобы посмотреть повтор.' });
    const parsed = replayParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(404).send({ error: 'Not Found', message: 'Повтор не найден.' });
    try {
      const replay = await replays.getOwned(parsed.data.id, user.id);
      if (!replay) return reply.code(404).send({ error: 'Not Found', message: 'Повтор не найден или уже удалён.' });
      return reply.header('cache-control', 'private, no-store').send({ replay });
    } catch (error) {
      if (error instanceof UnsupportedReplayFormatError) {
        return reply.code(409).send({ error: 'Unsupported replay', message: 'Эта версия повтора пока не поддерживается.' });
      }
      if (error instanceof InvalidReplayPayloadError) {
        request.log.error({ replayId: parsed.data.id }, 'Stored terminal replay payload is invalid');
        return reply.code(422).send({ error: 'Invalid replay', message: 'Повтор повреждён и не может быть воспроизведён.' });
      }
      throw error;
    }
  });

  app.delete('/api/practice/replays/:id', {
    config: { rateLimit: { max: 12, timeWindow: '1 minute' } },
    preHandler: async (request, reply) => {
      if (!hasSameOrigin(request)) return reply.code(403).send({ error: 'Forbidden origin', message: 'Недопустимый источник запроса.' });
    },
  }, async (request, reply) => {
    const user = await auth.currentUser(request);
    if (!user) return reply.code(401).send({ error: 'Unauthorized', message: 'Войдите, чтобы удалить повтор.' });
    const parsed = replayParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(404).send({ error: 'Not Found', message: 'Повтор не найден.' });
    await replays.deleteOwned(parsed.data.id, user.id);
    return reply.code(204).send();
  });
}

