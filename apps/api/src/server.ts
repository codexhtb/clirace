import { buildApp } from './app.js';
import { BattleManager } from './battle-service.js';
import { loadConfig } from './config.js';
import { runMigrations } from './migrations.js';
import { SandboxManager } from './sandbox-manager.js';
import { closeDependencies, connectDependencies, createDependencies } from './services.js';

const config = loadConfig();
const dependencies = createDependencies(config);
const sandboxManager = new SandboxManager(config, dependencies);
const battleManager = new BattleManager(config, dependencies, sandboxManager);
sandboxManager.setBattleHooks(battleManager);
const app = buildApp({ config, dependencies, sandboxManager, battleManager });

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'Shutting down');
  await app.close();
  await closeDependencies(dependencies);
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await connectDependencies(dependencies);
  await runMigrations(dependencies.postgres);
  await battleManager.start();
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.fatal({ error }, 'Unable to start API');
  await closeDependencies(dependencies);
  process.exit(1);
}
