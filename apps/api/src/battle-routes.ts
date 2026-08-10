import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuthService, type AuthUser } from './auth-service.js';
import { BattleManager, BattleStateError } from './battle-service.js';
import type { AppConfig } from './config.js';
import { hasSameOrigin } from './http-security.js';
import type { Dependencies } from './services.js';

const roomSchema = z.object({ roomCode: z.string().trim().toUpperCase().regex(/^[A-HJ-NP-Z2-9]{5}$/) });
const createSchema = z.object({
  rounds: z.union([z.literal(3), z.literal(5), z.literal(10)]),
  category: z.string().trim().regex(/^(all|[a-z0-9-]{1,40})$/),
}).strict();
const readySchema = z.object({ ready: z.boolean() }).strict();

export async function registerBattleRoutes(
  app: FastifyInstance,
  config: AppConfig,
  dependencies: Dependencies,
  battles: BattleManager,
): Promise<void> {
  const auth = new AuthService(config, dependencies);

  app.get('/api/battles/options', async (_request, reply) => {
    return reply.header('cache-control', 'public, max-age=60').send(await battles.options());
  });

  app.post('/api/battles', {
    config: { rateLimit: { max: 8, timeWindow: '10 minutes' } },
  }, async (request, reply) => {
    if (!hasSameOrigin(request)) return forbidden(reply);
    const user = await requireUser(auth, request, reply);
    if (!user) return;
    const body = createSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, 'Выберите 3, 5 или 10 раундов и доступную категорию.');
    try {
      const battle = await battles.createBattle(user, body.data.rounds, body.data.category);
      return reply.header('cache-control', 'no-store').code(201).send({ battle });
    } catch (error) { return battleError(reply, error); }
  });

  app.get('/api/battles/:roomCode', async (request, reply) => {
    const user = await requireUser(auth, request, reply);
    if (!user) return;
    const params = roomSchema.safeParse(request.params);
    if (!params.success) return invalid(reply, 'Некорректный код комнаты.');
    try {
      const battle = await battles.loadState(params.data.roomCode, user.id);
      return reply.header('cache-control', 'no-store').send({ battle });
    } catch (error) { return battleError(reply, error); }
  });

  app.post('/api/battles/:roomCode/join', {
    config: { rateLimit: { max: 12, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    if (!hasSameOrigin(request)) return forbidden(reply);
    const user = await requireUser(auth, request, reply);
    if (!user) return;
    const params = roomSchema.safeParse(request.params);
    if (!params.success) return invalid(reply, 'Некорректный код комнаты.');
    try {
      const battle = await battles.joinBattle(params.data.roomCode, user);
      return reply.header('cache-control', 'no-store').send({ battle });
    } catch (error) { return battleError(reply, error); }
  });

  app.post('/api/battles/:roomCode/ready', async (request, reply) => {
    if (!hasSameOrigin(request)) return forbidden(reply);
    const user = await requireUser(auth, request, reply);
    if (!user) return;
    const params = roomSchema.safeParse(request.params);
    const body = readySchema.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, 'Некорректное состояние Ready.');
    try {
      await battles.setReady(params.data.roomCode, user.id, body.data.ready);
      const battle = await battles.loadState(params.data.roomCode, user.id);
      return reply.header('cache-control', 'no-store').send({ battle });
    } catch (error) { return battleError(reply, error); }
  });

  app.post('/api/battles/:roomCode/terminal', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    if (!hasSameOrigin(request)) return forbidden(reply);
    const user = await requireUser(auth, request, reply);
    if (!user) return;
    const params = roomSchema.safeParse(request.params);
    if (!params.success) return invalid(reply, 'Некорректный код комнаты.');
    try {
      const ticket = await battles.createTerminalTicket(params.data.roomCode, user.id);
      return reply.header('cache-control', 'no-store').code(201).send(ticket);
    } catch (error) { return battleError(reply, error); }
  });

  app.get('/ws/battle/:roomCode', { websocket: true }, (socket, request) => {
    if (!hasSameOrigin(request)) {
      socket.close(1008, 'forbidden_origin');
      return;
    }
    const params = roomSchema.safeParse(request.params);
    if (!params.success) {
      socket.close(1008, 'invalid_room_code');
      return;
    }
    void auth.currentUser(request).then(async (user) => {
      if (!user) {
        socket.close(1008, 'authentication_required');
        return;
      }
      try {
        await battles.connect(params.data.roomCode, user, socket);
      } catch (error) {
        socket.close(1008, error instanceof Error ? error.message.slice(0, 100) : 'battle_unavailable');
      }
    });
  });
}

async function requireUser(auth: AuthService, request: FastifyRequest, reply: FastifyReply): Promise<AuthUser | null> {
  const user = await auth.currentUser(request);
  if (!user) reply.code(401).send({ error: 'Unauthorized', message: 'Войдите в аккаунт, чтобы участвовать в Battle.' });
  return user;
}

function forbidden(reply: FastifyReply) {
  return reply.code(403).send({ error: 'Forbidden origin', message: 'Запрос отклонён системой безопасности.' });
}

function invalid(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: 'Invalid battle request', message });
}

function battleError(reply: FastifyReply, error: unknown) {
  if (error instanceof BattleStateError) {
    return reply.code(error.statusCode).send({ error: 'Battle state error', message: error.message });
  }
  throw error;
}
