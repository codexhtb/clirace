import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AuthService } from './auth-service.js';
import type { AppConfig } from './config.js';
import { hasSameOrigin } from './http-security.js';
import type { SandboxManager } from './sandbox-manager.js';
import { SandboxCapacityError, SandboxUnavailableError, SandboxUserSessionError } from './sandbox-manager.js';
import type { Dependencies } from './services.js';

const ticketSchema = z.object({
  excludeChallengeId: z.string().regex(/^[a-z0-9-]{1,64}$/).optional(),
  gameSessionId: z.string().uuid().optional(),
}).strict();

export async function registerSandboxRoutes(
  app: FastifyInstance,
  sandboxManager: SandboxManager,
  config: AppConfig,
  dependencies: Dependencies,
): Promise<void> {
  const auth = new AuthService(config, dependencies);

  app.get('/api/sandbox/status', { config: { rateLimit: false } }, async (_request, reply) => {
    const status = await sandboxManager.getPlatformStatus();
    return reply.header('cache-control', 'no-store').send({
      ...status,
      authenticatedGameSessions: true,
    });
  });

  app.get('/api/sandbox/metrics', { config: { rateLimit: false } }, async (_request, reply) => {
    const metrics = await sandboxManager.prometheusMetrics();
    return reply.header('cache-control', 'no-store').type('text/plain; version=0.0.4; charset=utf-8').send(metrics);
  });

  app.post('/api/sandbox/sessions', {
    config: {
      rateLimit: { max: 8, timeWindow: '1 minute' },
    },
    preHandler: async (request, reply) => {
      if (!hasSameOrigin(request)) {
        return reply.code(403).send({
          error: 'Forbidden origin',
          message: 'Запуск shell разрешён только со страницы CLIRace.',
        });
      }
    },
  }, async (request, reply) => {
    const user = await auth.currentUser(request);
    if (!user) return reply.code(401).send({
      error: 'Unauthorized',
      message: 'Войдите в аккаунт, чтобы запустить настоящий shell.',
    });
    const parsed = ticketSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({
      error: 'Invalid request', message: 'Некорректные параметры shell-сессии.',
    });

    try {
      let game: {
        gameSessionId: string;
        sessionTaskId: string;
        challengeId: string;
        sandboxChallengeId: string;
      } | undefined;
      if (parsed.data.gameSessionId) {
        const task = await dependencies.postgres.query<{
          session_task_id: string;
          challenge_id: string;
          validation_config: Record<string, unknown>;
        }>(`
          SELECT st.id AS session_task_id, c.id AS challenge_id, c.validation_config
          FROM game_sessions gs
          JOIN session_tasks st ON st.game_session_id = gs.id
          JOIN challenges c ON c.id = st.challenge_id
          WHERE gs.id = $1 AND gs.user_id = $2 AND gs.status = 'active'
            AND st.status = 'active' AND c.type = 'real_shell'
        `, [parsed.data.gameSessionId, user.id]);
        const activeTask = task.rows[0];
        const sandboxChallengeId = activeTask?.validation_config.sandboxChallengeId;
        if (!activeTask || typeof sandboxChallengeId !== 'string') {
          return reply.code(409).send({
            error: 'No active shell task',
            message: 'В этом забеге сейчас нет активного Shell-задания.',
          });
        }
        game = {
          gameSessionId: parsed.data.gameSessionId,
          sessionTaskId: activeTask.session_task_id,
          challengeId: activeTask.challenge_id,
          sandboxChallengeId,
        };
      }
      const ticket = await sandboxManager.createTicket({
        userId: user.id,
        ...(parsed.data.excludeChallengeId ? { excludeChallengeId: parsed.data.excludeChallengeId } : {}),
        ...(game ? { game } : {}),
      });
      return reply.header('cache-control', 'no-store').code(201).send(ticket);
    } catch (error) {
      if (error instanceof SandboxCapacityError) {
        return reply.header('retry-after', '15').code(429).send({
          error: 'capacity_full',
          code: error.code,
          queued: error.queued,
          retryAfterSeconds: 15,
          message: 'Все терминалы заняты. Подождите несколько секунд и попробуйте снова.',
        });
      }
      if (error instanceof SandboxUnavailableError) {
        app.log.warn({ error }, 'Sandbox is unavailable');
        return reply.code(503).send({
          error: error.code,
          code: error.code,
          message: sandboxUnavailableMessage(error.code),
        });
      }
      if (error instanceof SandboxUserSessionError) {
        return reply.code(409).send({
          error: 'user_capacity_full',
          code: 'user_capacity_full',
          message: 'Достигнут лимит shell-сессий для аккаунта. Завершите текущую сессию.',
        });
      }
      throw error;
    }
  });

  app.get('/ws/terminal/:sessionId', { websocket: true }, (socket, request) => {
    if (!hasSameOrigin(request)) {
      socket.close(1008, 'Forbidden origin');
      return;
    }
    const { sessionId } = request.params as { sessionId: string };
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
      socket.close(1008, 'Invalid session id');
      return;
    }
    sandboxManager.bindSocket(sessionId, socket);
  });
}

function sandboxUnavailableMessage(code: string): string {
  if (code === 'feature_disabled') return 'Shell отключён на этом сервере.';
  if (code === 'socket_unavailable') return 'Сервис запуска терминалов временно не отвечает.';
  if (code === 'permission_denied') return 'Сервис запуска терминалов восстанавливает доступ к окружению.';
  if (code === 'image_missing') return 'Окружение терминала обновляется. Попробуйте немного позже.';
  if (code === 'daemon_not_rootless') return 'Безопасный режим терминала недоступен.';
  return 'Локальный shell временно недоступен.';
}
