import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAdminRoutes } from './admin-routes.js';
import { registerBattleRoutes } from './battle-routes.js';
import type { BattleManager } from './battle-service.js';
import { registerAuthRoutes } from './auth-routes.js';
import { registerCatalogRoutes } from './catalog-routes.js';
import { registerCommunityRoutes } from './community-routes.js';
import type { AppConfig } from './config.js';
import { registerDailyRoutes } from './daily-routes.js';
import { registerGameRoutes } from './game-routes.js';
import { registerInterviewRoutes } from './interview-routes.js';
import { registerLearningRoutes } from './learning-routes.js';
import { registerMatchmakingRoutes } from './matchmaking-routes.js';
import type { MatchmakingManager } from './matchmaking-service.js';
import type { SandboxManager } from './sandbox-manager.js';
import { registerSandboxRoutes } from './sandbox-routes.js';
import { checkDependencies, type Dependencies } from './services.js';

interface BuildAppOptions {
  config: AppConfig;
  dependencies: Dependencies;
  sandboxManager: SandboxManager;
  battleManager: BattleManager;
  matchmakingManager: MatchmakingManager;
}

export function buildApp({ config, dependencies, sandboxManager, battleManager, matchmakingManager }: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    // Caddy is the only public proxy in front of the Docker nginx gateway.
    // Trust exactly one proxy hop so rate limiting uses nginx's verified client IP.
    trustProxy: 1,
    bodyLimit: config.HTTP_BODY_LIMIT_BYTES,
    requestTimeout: 10_000,
  });

  void app.register(helmet, {
    contentSecurityPolicy: false,
  });

  void app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
  });

  void app.register(websocket, {
    options: {
      maxPayload: 16 * 1024,
      perMessageDeflate: false,
    },
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.addHook('onResponse', async (request, reply) => {
    if (reply.elapsedTime >= 1_000) {
      request.log.warn({ elapsedMs: Math.round(reply.elapsedTime), statusCode: reply.statusCode }, 'Slow request');
    }
  });

  app.get('/health/live', { config: { rateLimit: false } }, async () => ({
    status: 'ok',
    service: 'clirace-api',
    uptimeSeconds: Math.floor(process.uptime()),
  }));

  const readinessHandler = async (_request: unknown, reply: { code: (status: number) => unknown }) => {
    const checks = await checkDependencies(dependencies);
    const ready = Object.values(checks).every((status) => status === 'up');
    if (!ready) reply.code(503);

    return {
      status: ready ? 'ready' : 'not_ready',
      service: 'clirace-api',
      version: '0.1.0',
      checks,
      timestamp: new Date().toISOString(),
    };
  };

  app.get('/health/ready', { config: { rateLimit: false } }, readinessHandler);
  app.get('/api/health', { config: { rateLimit: false } }, readinessHandler);

  void app.register(async (sandboxApp) => {
    await registerSandboxRoutes(sandboxApp, sandboxManager, config, dependencies);
  });

  void app.register(async (authApp) => {
    await registerAuthRoutes(authApp, config, dependencies);
  });

  void app.register(async (catalogApp) => {
    await registerCatalogRoutes(catalogApp, dependencies);
  });

  void app.register(async (communityApp) => {
    await registerCommunityRoutes(communityApp, dependencies);
  });

  void app.register(async (dailyApp) => {
    await registerDailyRoutes(dailyApp, config, dependencies);
  });

  void app.register(async (battleApp) => {
    await registerBattleRoutes(battleApp, config, dependencies, battleManager, matchmakingManager);
  });

  void app.register(async (matchmakingApp) => {
    await registerMatchmakingRoutes(matchmakingApp, config, dependencies, matchmakingManager);
  });

  void app.register(async (gameApp) => {
    await registerGameRoutes(gameApp, config, dependencies);
  });

  void app.register(async (interviewApp) => {
    await registerInterviewRoutes(interviewApp, config, dependencies);
  });

  void app.register(async (learningApp) => {
    await registerLearningRoutes(learningApp, config, dependencies);
  });

  void app.register(async (adminApp) => {
    await registerAdminRoutes(adminApp, config, dependencies, sandboxManager, battleManager, matchmakingManager);
  });

  app.addHook('onClose', async () => {
    await battleManager.close();
    await matchmakingManager.close();
    await sandboxManager.close();
  });

  app.setNotFoundHandler(async (_request, reply) => {
    return reply.code(404).send({
      error: 'Not Found',
      message: 'The requested API endpoint does not exist.',
    });
  });

  return app;
}
