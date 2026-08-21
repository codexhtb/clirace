import { createHash, randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { loadConfig } from './config.js';
import { closeDependencies, connectDependencies, createDependencies, type Dependencies } from './services.js';

interface LoadFixture { userId: string; token: string; cookie: string; }
interface AttemptResult { outcome: 'success' | 'capacity_full' | 'failed'; startupMs?: number; commandExecuted?: boolean; error?: string; }

export async function runSandboxLoadTest(stages = [10, 25, 50]): Promise<unknown> {
  const config = loadConfig();
  const dependencies = createDependencies(config);
  await connectDependencies(dependencies);
  const runId = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`.slice(-8);
  const fixtures = await createFixtures(dependencies, config.AUTH_COOKIE_NAME, Math.max(...stages), runId);
  const reports: unknown[] = [];
  try {
    for (const stage of stages) {
      const before = await timedHealth();
      const results = await Promise.all(fixtures.slice(0, stage).map((fixture, index) => runAttempt(fixture, index)));
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const after = await timedHealth();
      const latencies = results.flatMap((result) => result.startupMs === undefined ? [] : [result.startupMs]).sort((a, b) => a - b);
      reports.push({
        concurrency: stage,
        success: results.filter((result) => result.outcome === 'success').length,
        capacityFull: results.filter((result) => result.outcome === 'capacity_full').length,
        failed: results.filter((result) => result.outcome === 'failed').length,
        commandExecutionSuccess: results.filter((result) => result.commandExecuted).length,
        startupLatencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
        apiHealthLatencyMs: { before, after },
        errors: results.flatMap((result) => result.error ? [result.error] : []).slice(0, 5),
      });
    }
    const status = await fetch('http://127.0.0.1:3000/api/sandbox/status').then((response) => response.json());
    return { ok: true, runId, stages: reports, finalStatus: status };
  } finally {
    await cleanupFixtures(dependencies, fixtures, runId);
    await closeDependencies(dependencies);
  }
}

async function createFixtures(
  dependencies: Dependencies,
  cookieName: string,
  count: number,
  runId: string,
): Promise<LoadFixture[]> {
  const fixtures: LoadFixture[] = [];
  for (let index = 0; index < count; index += 1) {
    const username = `load_${runId}_${index}`;
    const result = await dependencies.postgres.query<{ id: string }>(`
      INSERT INTO users (username, username_normalized, email, email_normalized, password_hash)
      VALUES ($1, $1, $2, $2, 'load-test-account-not-for-login') RETURNING id
    `, [username, `${username}@load.invalid`]);
    const userId = result.rows[0]!.id;
    const token = randomBytes(32).toString('base64url');
    await dependencies.redis.set(`clirace:auth:session:${createHash('sha256').update(token).digest('hex')}`, userId, { EX: 3_600 });
    fixtures.push({ userId, token, cookie: `${cookieName}=${token}` });
  }
  return fixtures;
}

async function cleanupFixtures(dependencies: Dependencies, fixtures: LoadFixture[], runId: string): Promise<void> {
  await Promise.allSettled(fixtures.map((fixture) => dependencies.redis.del(
    `clirace:auth:session:${createHash('sha256').update(fixture.token).digest('hex')}`,
  )));
  await dependencies.postgres.query('DELETE FROM users WHERE username_normalized LIKE $1', [`load_${runId}_%`]);
}

async function runAttempt(fixture: LoadFixture, index: number): Promise<AttemptResult> {
  const startedAt = performance.now();
  const forwarded = `198.18.${Math.floor(index / 250)}.${(index % 250) + 1}`;
  try {
    const response = await fetch('http://127.0.0.1:3000/api/sandbox/sessions', {
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1:3000',
        cookie: fixture.cookie,
        'content-type': 'application/json',
        'x-forwarded-for': forwarded,
      },
      body: '{}',
    });
    const payload = await response.json() as { token?: string; websocketPath?: string; code?: string; error?: string; message?: string };
    if (response.status === 429 && payload.code === 'capacity_full') return { outcome: 'capacity_full' };
    if (response.status !== 201 || !payload.token || !payload.websocketPath) {
      return { outcome: 'failed', error: `${response.status}:${payload.code ?? payload.error ?? payload.message ?? 'unknown'}` };
    }
    const startupMs = await attachAndExecute(payload.websocketPath, payload.token, fixture.cookie, forwarded, index);
    return { outcome: 'success', startupMs, commandExecuted: true };
  } catch (error) {
    return { outcome: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}

function attachAndExecute(path: string, token: string, cookie: string, forwarded: string, index: number): Promise<number> {
  const marker = `LOAD_V2_${index}`;
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:3000${path}`, {
      headers: { origin: 'http://127.0.0.1:3000', cookie, 'x-forwarded-for': forwarded },
    });
    let readyAt = 0;
    let output = '';
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('websocket_timeout'));
    }, 30_000);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'auth', token, cols: 80, rows: 24 })));
    socket.on('message', (data, binary) => {
      if (binary) {
        output += data.toString();
        if (output.includes(marker)) {
          clearTimeout(timer);
          socket.close(1000, 'load_test_complete');
          resolve(readyAt || Math.round(performance.now() - startedAt));
        }
        return;
      }
      const message = JSON.parse(data.toString()) as { type: string };
      if (message.type === 'ready') {
        readyAt = Math.round(performance.now() - startedAt);
        socket.send(JSON.stringify({ type: 'input', data: `printf '${marker}\\n'\r` }));
      }
    });
    socket.once('error', reject);
    socket.once('close', (code, reason) => {
      if (!output.includes(marker)) reject(new Error(`websocket_closed:${code}:${reason.toString()}`));
    });
  });
}

async function timedHealth(): Promise<number> {
  const startedAt = performance.now();
  const response = await fetch('http://127.0.0.1:3000/api/health');
  if (!response.ok) throw new Error(`API health failed: ${response.status}`);
  return Math.round(performance.now() - startedAt);
}

function percentile(values: readonly number[], ratio: number): number | null {
  if (values.length === 0) return null;
  return values[Math.min(values.length - 1, Math.floor((values.length - 1) * ratio))] ?? null;
}

if (process.argv[1]?.endsWith('sandbox-load-test.js')) {
  const stages = (process.env.SANDBOX_LOAD_STAGES ?? '10,25,50').split(',').map(Number).filter((value) => Number.isInteger(value) && value > 0);
  runSandboxLoadTest(stages).then((report) => console.log(JSON.stringify(report, null, 2))).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
