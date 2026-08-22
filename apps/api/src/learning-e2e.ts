import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { AuthService } from './auth-service.js';
import { BattleManager } from './battle-service.js';
import { loadConfig } from './config.js';
import { learningQuestionSchema, loadAndValidateLinuxCoreContent, validateLearningQuestionSet, importLinuxCoreQuestions } from './learning-content.js';
import { MatchmakingManager } from './matchmaking-service.js';
import { runMigrations } from './migrations.js';
import { hashPassword } from './password.js';
import { SandboxManager } from './sandbox-manager.js';
import { closeDependencies, connectDependencies, createDependencies } from './services.js';

interface InjectResult { statusCode: number; headers: Record<string, string | string[] | undefined>; json<T = unknown>(): T }
type ApiSession = {
  id: string; status: 'active' | 'completed';
  progress?: { current: number; total: number; answered: boolean };
  question?: { slug: string; category: string; answers: Array<{ id: string; text: string }> };
  feedback?: { isCorrect: boolean; selectedAnswerIds: string[]; correctAnswerIds: string[]; explanation: string; selectedAnswerExplanation: string | null };
  result?: { correct: number; total: number; percent: number; weakAreas: string[]; categories: Record<string, { answered: number; sufficientData: boolean }> };
};

let checks = 0;
async function main(): Promise<void> {
  const config = loadConfig();
  const dependencies = createDependencies(config);
  await connectDependencies(dependencies);
  await runMigrations(dependencies.postgres);
  const sandbox = new SandboxManager(config, dependencies);
  const battle = new BattleManager(config, dependencies, sandbox);
  const matchmaking = new MatchmakingManager(config, dependencies, sandbox, battle, { redisPrefix: `clirace:mm:learn-e2e:${process.pid}` });
  const app = buildApp({ config, dependencies, sandboxManager: sandbox, battleManager: battle, matchmakingManager: matchmaking });
  await app.ready();
  const suffix = `${Date.now()}${randomBytes(3).toString('hex')}`;
  const username = `learn${suffix}`.slice(0, 24);
  const email = `${username}@e2e.invalid`;
  const password = `Learn-E2E-${randomBytes(12).toString('base64url')}`;
  let userId: string | undefined;
  try {
    const content = await loadAndValidateLinuxCoreContent();
    assert(content.report.total >= 20 && content.report.total <= 30, 'fixture bank size is 20-30');
    equal(content.report.warnings.length, 0, 'fixture quality warnings');
    const malformed = learningQuestionSchema.safeParse({});
    assert(!malformed.success, 'structural validator rejects malformed question');
    expectThrow(() => validateLearningQuestionSet([content.questions[0]!, content.questions[0]!]), 'duplicate validator');
    const beforeImport = await countQuestions(dependencies);
    await importLinuxCoreQuestions(dependencies.postgres);
    equal(await countQuestions(dependencies), beforeImport, 'import is idempotent');

    const inserted = await dependencies.postgres.query<{ id: string }>(`
      INSERT INTO users (username, username_normalized, email, email_normalized, password_hash)
      VALUES ($1::varchar, lower($1::text), $2::varchar, lower($2::text), $3) RETURNING id
    `, [username, email, await hashPassword(password)]);
    userId = inserted.rows[0]!.id;
    const cookie = await login(app, username, password);

    const catalog = await inject(app, 'GET', '/api/learn/linux-core');
    equal(catalog.statusCode, 200, 'public catalog');
    assert(catalog.json<{ totalQuestions: number }>().totalQuestions >= 20, 'catalog content count');
    equal((await inject(app, 'POST', '/api/learn/sessions', undefined, { mode: 'quick' })).statusCode, 401, 'authentication required');
    equal((await inject(app, 'POST', '/api/learn/sessions', cookie, { mode: 'quick' }, 'http://evil.invalid')).statusCode, 403, 'same-origin mutation protection');

    const created = await inject(app, 'POST', '/api/learn/sessions', cookie, { mode: 'quick' });
    equal(created.statusCode, 201, 'quick session creation');
    const first = created.json<ApiSession>();
    equal(first.progress?.total, 10, 'quick has ten questions');
    assert(first.question, 'first question exists');
    assertNoLeak(first);
    const selectedRows = await dependencies.postgres.query<{ count: number; unique_count: number; categories: number }>(`
      SELECT count(*)::int AS count, count(DISTINCT question_id)::int AS unique_count,
             count(DISTINCT content_snapshot->>'category')::int AS categories
      FROM learning_session_questions WHERE session_id = $1
    `, [first.id]);
    equal(selectedRows.rows[0]?.count, 10, 'ten persisted session questions');
    equal(selectedRows.rows[0]?.unique_count, 10, 'no duplicate questions');
    assert((selectedRows.rows[0]?.categories ?? 0) >= 8, 'balanced category selection');
    const disabled = await dependencies.postgres.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM learning_session_questions sq
      JOIN learning_questions q ON q.id = sq.question_id WHERE sq.session_id = $1 AND NOT q.enabled
    `, [first.id]);
    equal(disabled.rows[0]?.count, 0, 'disabled questions excluded');

    const refreshed = await inject(app, 'GET', `/api/learn/sessions/${first.id}`, cookie);
    equal(refreshed.statusCode, 200, 'session refresh');
    equal(JSON.stringify(refreshed.json<ApiSession>().question?.answers), JSON.stringify(first.question!.answers), 'option order survives refresh');
    const shuffled = await dependencies.postgres.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM learning_session_questions
      WHERE session_id = $1 AND option_order <> (
        SELECT jsonb_agg(value->>'id') FROM jsonb_array_elements(content_snapshot->'answers') AS value
      )
    `, [first.id]);
    assert((shuffled.rows[0]?.count ?? 0) > 0, 'server-side option shuffle');
    equal((await inject(app, 'POST', `/api/learn/sessions/${first.id}/answers`, cookie, { questionSlug: first.question!.slug, answerIds: ['unknown'] })).statusCode, 400, 'unknown answer rejected');

    const correctIds = await correctFor(dependencies, first.id, 1);
    const wrongId = first.question!.answers.find((answer) => !correctIds.includes(answer.id))!.id;
    const wrong = await inject(app, 'POST', `/api/learn/sessions/${first.id}/answers`, cookie, { questionSlug: first.question!.slug, answerIds: [wrongId] });
    equal(wrong.statusCode, 200, 'answer accepted');
    const wrongPayload = wrong.json<ApiSession>();
    equal(wrongPayload.feedback?.isCorrect, false, 'wrong answer evaluated server-side');
    assert(Boolean(wrongPayload.feedback?.explanation), 'main explanation returned after answer');
    assert(Boolean(wrongPayload.feedback?.selectedAnswerExplanation), 'selected wrong explanation returned');
    const repeated = await inject(app, 'POST', `/api/learn/sessions/${first.id}/answers`, cookie, { questionSlug: first.question!.slug, answerIds: correctIds });
    equal(repeated.json<ApiSession>().feedback?.isCorrect, false, 'repeat submit is idempotent');
    equal(repeated.json<ApiSession>().feedback?.selectedAnswerIds[0], wrongId, 'one attempt remains fixed');
    const resumed = await inject(app, 'GET', '/api/learn/sessions/current', cookie);
    equal(resumed.json<ApiSession>().question?.slug, first.question!.slug, 'active session resume');

    let state = (await inject(app, 'POST', `/api/learn/sessions/${first.id}/next`, cookie)).json<ApiSession>();
    while (state.status === 'active') {
      const ids = await correctFor(dependencies, state.id, state.progress!.current);
      const answered = await inject(app, 'POST', `/api/learn/sessions/${state.id}/answers`, cookie, { questionSlug: state.question!.slug, answerIds: ids });
      equal(answered.statusCode, 200, `answer position ${state.progress!.current}`);
      state = (await inject(app, 'POST', `/api/learn/sessions/${state.id}/next`, cookie)).json<ApiSession>();
    }
    equal(state.result?.correct, 9, 'score counted once per question');
    equal(state.result?.percent, 90, 'score percentage');
    assert(Object.values(state.result!.categories).every((stat) => stat.answered > 0), 'category analytics persisted');
    assert(Object.values(state.result!.categories).some((stat) => !stat.sufficientData), 'small samples marked insufficient');

    const topicCreated = (await inject(app, 'POST', '/api/learn/sessions', cookie, { mode: 'topic', category: 'filesystem' })).json<ApiSession>();
    while (topicCreated.status === 'active') {
      const ids = await correctFor(dependencies, topicCreated.id, topicCreated.progress!.current);
      const wrongChoice = topicCreated.question!.answers.find((answer) => !ids.includes(answer.id))!.id;
      await inject(app, 'POST', `/api/learn/sessions/${topicCreated.id}/answers`, cookie, { questionSlug: topicCreated.question!.slug, answerIds: [wrongChoice] });
      const next = (await inject(app, 'POST', `/api/learn/sessions/${topicCreated.id}/next`, cookie)).json<ApiSession>();
      Object.assign(topicCreated, next);
    }
    assert(topicCreated.result?.weakAreas.includes('filesystem'), 'weak area requires sufficient sample and low accuracy');
    equal((await inject(app, 'GET', '/api/learn/sessions/current', cookie)).json(), null, 'no active session after completion');

    console.log(JSON.stringify({ ok: true, checks, fixtureQuestions: content.report.total, qualityWarnings: content.report.warnings.length }, null, 2));
  } finally {
    if (userId) {
      await new AuthService(config, dependencies).revokeAllSessions(userId).catch(() => undefined);
      await dependencies.postgres.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => undefined);
    }
    await app.close();
    await closeDependencies(dependencies);
  }
}

async function countQuestions(dependencies: ReturnType<typeof createDependencies>): Promise<number> {
  return dependencies.postgres.query<{ count: number }>("SELECT count(*)::int AS count FROM learning_questions WHERE course_slug = 'linux-core'").then((result) => result.rows[0]!.count);
}
async function correctFor(dependencies: ReturnType<typeof createDependencies>, sessionId: string, position: number): Promise<string[]> {
  return dependencies.postgres.query<{ ids: string[] }>("SELECT content_snapshot->'correctAnswerIds' AS ids FROM learning_session_questions WHERE session_id = $1 AND position = $2", [sessionId, position]).then((result) => result.rows[0]!.ids);
}
function assertNoLeak(session: ApiSession): void {
  const serialized = JSON.stringify(session);
  assert(!('feedback' in session), 'pre-answer response has no feedback');
  assert(!serialized.includes('correctAnswerIds'), 'pre-answer response hides correct answer IDs');
  assert(!serialized.includes('answerExplanations'), 'pre-answer response hides explanations');
}
async function login(app: FastifyInstance, identifier: string, password: string): Promise<string> {
  const response = await inject(app, 'POST', '/api/auth/login', undefined, { identifier, password });
  equal(response.statusCode, 200, 'fixture login');
  const raw = response.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(';')[0];
  assert(cookie, 'auth cookie returned');
  return cookie;
}
async function inject(app: FastifyInstance, method: 'GET' | 'POST', url: string, cookie?: string, payload?: unknown, origin = 'http://localhost'): Promise<InjectResult> {
  return await app.inject({ method, url, headers: { host: 'localhost', origin, ...(cookie ? { cookie } : {}) }, ...(payload ? { payload } : {}) }) as unknown as InjectResult;
}
function assert(value: unknown, message: string): asserts value { checks += 1; if (!value) throw new Error(`Learn E2E failed: ${message}`); }
function equal(actual: unknown, expected: unknown, message: string): void { checks += 1; if (actual !== expected) throw new Error(`Learn E2E failed: ${message}; expected ${String(expected)}, got ${String(actual)}`); }
function expectThrow(action: () => unknown, message: string): void { checks += 1; try { action(); } catch { return; } throw new Error(`Learn E2E failed: ${message}`); }

if (process.argv[1]?.endsWith('learning-e2e.js')) main().catch((error) => { console.error(error); process.exitCode = 1; });
