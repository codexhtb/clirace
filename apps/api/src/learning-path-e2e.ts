import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { loadConfig } from './config.js';
import { importLearningPaths, learningPathModuleSchema, loadAndValidateLearningPathsContent, validateLearningPathReferences, validateModuleGraph } from './learning-path-content.js';
import { calculateMastery, LearningPathError, LearningPathService, masteryPresentation } from './learning-path-service.js';
import { LearningService } from './learning-service.js';
import { runMigrations } from './migrations.js';
import { closeDependencies, connectDependencies, createDependencies } from './services.js';

const dependencies = createDependencies(loadConfig());
await connectDependencies(dependencies);
await runMigrations(dependencies.postgres);
const paths = new LearningPathService(dependencies.postgres);
const learning = new LearningService(dependencies.postgres);
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
let userId = '';
let checks = 0;
const passed: string[] = [];
const check = (condition: unknown, label: string) => { assert.ok(condition, label); checks += 1; passed.push(label); };

try {
  const loaded = await loadAndValidateLearningPathsContent();
  check(loaded.report.courses === 2 && loaded.report.modules === 27 && loaded.report.items === 237, 'content dataset report');
  const importedBefore = await importLearningPaths(dependencies.postgres);
  const countsBefore = await contentCounts();
  await importLearningPaths(dependencies.postgres);
  const countsAfter = await contentCounts();
  check(importedBefore.invalidReferences === 0 && JSON.stringify(countsBefore) === JSON.stringify(countsAfter), 'content import idempotent');

  const referenceItem = loaded.courses[0]!.modules[0]!.items.find((item) => item.type === 'practice')!;
  assert.throws(() => validateLearningPathReferences([referenceItem], new Set(), new Set()), /unknown approved challenge/);
  check(true, 'invalid challenge reference rejected');
  const circularA = learningPathModuleSchema.parse({ ...loaded.courses[0]!.modules[0], slug: 'a', order: 1, prerequisites: ['b'] });
  const circularB = learningPathModuleSchema.parse({ ...loaded.courses[0]!.modules[1], slug: 'b', order: 2, prerequisites: ['a'] });
  assert.throws(() => validateModuleGraph('fixture', [circularA, circularB]), /circular/);
  check(true, 'circular prerequisite rejected');
  check(calculateMastery({ knowledge: 80, practice: 100, lab: 100, checkpoint: 90 }) === 91, 'mastery deterministic weighted formula');
  check(masteryPresentation(91, 1).score === null && !masteryPresentation(91, 1).sufficientData, 'insufficient mastery evidence hidden');

  const user = await dependencies.postgres.query<{ id: string }>(`
    INSERT INTO users (username,username_normalized,email,email_normalized,password_hash)
    VALUES ($1,$1,$2,$2,'learning-path-e2e') RETURNING id
  `, [`path_${suffix}`, `path_${suffix}@example.test`]);
  userId = user.rows[0]!.id;

  const firstEnroll = asState(await paths.enroll(userId, 'linux-foundations'));
  check(firstEnroll.enrollment.status === 'active' && firstEnroll.enrollment.progress === 0, 'enroll course');
  const duplicateEnroll = asState(await paths.enroll(userId, 'linux-foundations'));
  const enrollmentCount = await scalar('SELECT count(*)::int AS count FROM learning_enrollments WHERE user_id=$1', [userId]);
  check(enrollmentCount === 1 && duplicateEnroll.resume?.item === 'shell-and-paths', 'duplicate enroll idempotent');
  check(firstEnroll.modules[0]?.status === 'current' && firstEnroll.modules[1]?.status === 'locked', 'module prerequisite enforced');

  await assert.rejects(() => paths.completeTheory(userId, 'linux-foundations', 'linux-foundations-filesystem-theory'), (error) => error instanceof LearningPathError && error.code === 'item_locked');
  check(true, 'locked module cannot be completed');
  await Promise.all([
    paths.completeTheory(userId, 'linux-foundations', 'linux-foundations-basics-theory'),
    paths.completeTheory(userId, 'linux-foundations', 'linux-foundations-basics-theory'),
  ]);
  check(await progressStatus('linux-foundations-basics-theory') === 'completed', 'theory completion idempotent across tabs');

  const activeA = asSession(await paths.startAssessment(userId, 'linux-foundations', 'linux-foundations-basics-knowledge'));
  const activeB = asSession(await paths.startAssessment(userId, 'linux-foundations', 'linux-foundations-basics-knowledge'));
  check(activeA.id === activeB.id, 'concurrent tabs reuse active knowledge session');
  await finishAssessment(activeA.id, false);
  let state = asState(await paths.sync(userId, 'linux-foundations'));
  check(findItem(state, 'linux-foundations-basics-knowledge').status === 'failed', 'knowledge check fail saved');
  const retry = asSession(await paths.startAssessment(userId, 'linux-foundations', 'linux-foundations-basics-knowledge'));
  check(retry.id !== activeA.id, 'failed assessment retry creates new session');
  await finishAssessment(retry.id, true);
  state = asState(await paths.sync(userId, 'linux-foundations'));
  check(findItem(state, 'linux-foundations-basics-knowledge').status === 'completed', 'knowledge check integration pass');

  await recordChallengeCompletion('shell-hello-terminal');
  state = asState(await paths.sync(userId, 'linux-foundations'));
  check(findItem(state, 'linux-foundations-basics-practice').status === 'completed', 'existing challenge completion integration');
  await recordChallengeCompletion('shell-build-castle');
  state = asState(await paths.sync(userId, 'linux-foundations'));
  check(findItem(state, 'linux-foundations-basics-lab').status === 'completed', 'shell lab completion integration');

  const failedCheckpoint = asSession(await paths.startAssessment(userId, 'linux-foundations', 'linux-foundations-basics-checkpoint'));
  await finishAssessment(failedCheckpoint.id, false);
  state = asState(await paths.sync(userId, 'linux-foundations'));
  check(findItem(state, 'linux-foundations-basics-checkpoint').status === 'failed', 'checkpoint fail');
  const checkpointRetry = asSession(await paths.startAssessment(userId, 'linux-foundations', 'linux-foundations-basics-checkpoint'));
  await finishAssessment(checkpointRetry.id, true);
  state = asState(await paths.sync(userId, 'linux-foundations'));
  check(state.modules[0]?.status === 'completed', 'checkpoint pass completes module');
  check(state.modules[1]?.status === 'current', 'next module unlocked after checkpoint');

  const refreshed = asState(await new LearningPathService(dependencies.postgres).sync(userId, 'linux-foundations'));
  check(refreshed.resume?.module === 'filesystem', 'resume after refresh');
  const progressCountBeforeImport = await scalar('SELECT count(*)::int AS count FROM learning_item_progress WHERE enrollment_id=(SELECT id FROM learning_enrollments WHERE user_id=$1)', [userId]);
  await importLearningPaths(dependencies.postgres);
  const progressCountAfterImport = await scalar('SELECT count(*)::int AS count FROM learning_item_progress WHERE enrollment_id=(SELECT id FROM learning_enrollments WHERE user_id=$1)', [userId]);
  check(progressCountBeforeImport === progressCountAfterImport, 'course version safe update preserves progress');

  state = await finishWholeCourse();
  check(state.enrollment.status === 'completed' && state.enrollment.progress === 100, 'course completion');
  check(typeof state.enrollment.finalScore === 'number' && state.enrollment.finalScore! >= 70, 'Final Assessment score');
  const courseResultCountBefore = await scalar('SELECT count(*)::int AS count FROM learning_course_results WHERE enrollment_id=(SELECT id FROM learning_enrollments WHERE user_id=$1)', [userId]);
  const completedAgain = asState(await paths.sync(userId, 'linux-foundations'));
  const courseResultCountAfter = await scalar('SELECT count(*)::int AS count FROM learning_course_results WHERE enrollment_id=(SELECT id FROM learning_enrollments WHERE user_id=$1)', [userId]);
  check(completedAgain.enrollment.status === 'completed' && courseResultCountBefore === 1 && courseResultCountAfter === 1, 'course completion idempotent');
  const moduleResultCount = await scalar('SELECT count(*)::int AS count FROM learning_module_results WHERE enrollment_id=(SELECT id FROM learning_enrollments WHERE user_id=$1)', [userId]);
  check(moduleResultCount === 10, 'all module results persisted once');
  const masteryCount = await scalar('SELECT count(*)::int AS count FROM learning_mastery WHERE user_id=$1 AND sufficient_data', [userId]);
  check(masteryCount >= 8, 'mastery persisted with sufficient evidence');
  const profile = await paths.profile(userId) as Array<{ status: string; progress: number; finalScore: number | null }>;
  check(profile[0]?.status === 'completed' && profile[0].progress === 100 && profile[0].finalScore === state.enrollment.finalScore, 'profile integration');

  const catalog = await paths.catalog(userId) as { courses: Array<{ slug: string; enrollment: unknown }> };
  check(catalog.courses[0]?.slug === 'linux-zero-to-operator', 'Zero to Operator is the primary course');
  let beginner = asState(await paths.enroll(userId, 'linux-zero-to-operator'));
  check(beginner.resume?.module === 'terminal-basics' && beginner.resume.item === 'linux-shell', 'beginner course starts at the first lesson');
  await paths.completeTheory(userId, 'linux-zero-to-operator', 'zto-terminal-basics-linux-shell-lesson');
  let beginnerQuiz = asSession(await paths.startAssessment(userId, 'linux-zero-to-operator', 'zto-terminal-basics-linux-shell-quiz'));
  await finishAssessment(beginnerQuiz.id, true);
  beginner = asState(await paths.sync(userId, 'linux-zero-to-operator'));
  check(beginner.resume?.item === 'prompt-command', 'lesson quiz advances to the next lesson');
  for (const lessonSlug of ['prompt-command', 'help-manuals', 'exit-status']) {
    await paths.completeTheory(userId, 'linux-zero-to-operator', `zto-terminal-basics-${lessonSlug}-lesson`);
    beginnerQuiz = asSession(await paths.startAssessment(userId, 'linux-zero-to-operator', `zto-terminal-basics-${lessonSlug}-quiz`));
    await finishAssessment(beginnerQuiz.id, true);
  }
  beginner = asState(await paths.sync(userId, 'linux-zero-to-operator'));
  const optional = findItem(beginner, 'zto-terminal-basics-optional-practice');
  const requiredLab = findItem(beginner, 'zto-terminal-basics-required-lab');
  check(optional.status === 'available' && optional.optional === true && requiredLab.status === 'current', 'optional practice does not block required lab');
  await recordChallengeCompletion('packages-audit-bash-runtime');
  beginner = asState(await paths.sync(userId, 'linux-zero-to-operator'));
  check(findItem(beginner, 'zto-terminal-basics-checkpoint').status === 'current', 'canonical Practice completion unlocks checkpoint');
  const beginnerCheckpoint = asSession(await paths.startAssessment(userId, 'linux-zero-to-operator', 'zto-terminal-basics-checkpoint'));
  await finishAssessment(beginnerCheckpoint.id, true);
  beginner = asState(await paths.sync(userId, 'linux-zero-to-operator'));
  check(beginner.modules[0]?.status === 'completed' && beginner.modules[1]?.status === 'current', 'beginner module completion unlocks the next module');
  check(beginner.enrollment.progress === 6, 'optional practice is excluded from required progress');
  const beginnerRestored = asState(await new LearningPathService(dependencies.postgres).sync(userId, 'linux-zero-to-operator'));
  check(beginnerRestored.resume?.module === 'filesystem-navigation', 'beginner resume persists server-side');
  check(checks >= 25, 'minimum 25 engine checks');

  console.log(JSON.stringify({ ok: true, checks, course: 'linux-foundations', modules: 10, items: 50, finalScore: state.enrollment.finalScore, passed }, null, 2));
} finally {
  if (userId) await dependencies.postgres.query('DELETE FROM users WHERE id=$1', [userId]).catch(() => undefined);
  await closeDependencies(dependencies);
}

async function finishWholeCourse(): Promise<StatePayload> {
  for (let guard = 0; guard < 100; guard += 1) {
    const state = asState(await paths.sync(userId, 'linux-foundations'));
    if (state.enrollment.status === 'completed') return state;
    const current = state.modules.flatMap((module) => module.items.map((item) => ({ module, item }))).find(({ item }) => item.status === 'current' || item.status === 'failed');
    assert(current, 'course has a current item');
    if (current.item.type === 'theory') await paths.completeTheory(userId, 'linux-foundations', current.item.stableId);
    else if (current.item.type === 'knowledge_check' || current.item.type === 'checkpoint') {
      const session = asSession(await paths.startAssessment(userId, 'linux-foundations', current.item.stableId));
      await finishAssessment(session.id, true);
    } else {
      const row = await dependencies.postgres.query<{ reference_config: { challengeSlugs: string[] } }>('SELECT reference_config FROM learning_items WHERE stable_id=$1', [current.item.stableId]);
      for (const slug of row.rows[0]!.reference_config.challengeSlugs) await recordChallengeCompletion(slug);
      await paths.sync(userId, 'linux-foundations');
    }
  }
  throw new Error('course completion guard exceeded');
}

async function finishAssessment(sessionId: string, correct: boolean): Promise<void> {
  while (true) {
    const session = asSession(await learning.getSession(userId, sessionId));
    if (session.status === 'completed') return;
    const row = await dependencies.postgres.query<{ content_snapshot: { slug: string; answers: Array<{ id: string }>; correctAnswerIds: string[] } }>(`
      SELECT content_snapshot FROM learning_session_questions WHERE session_id=$1 AND position=$2
    `, [sessionId, session.progress!.current]);
    const snapshot = row.rows[0]!.content_snapshot;
    const answers = correct ? snapshot.correctAnswerIds : [snapshot.answers.find((answer) => !snapshot.correctAnswerIds.includes(answer.id))!.id];
    await learning.submitAnswer(userId, sessionId, snapshot.slug, answers);
    await learning.next(userId, sessionId);
  }
}

async function recordChallengeCompletion(challengeSlug: string): Promise<void> {
  const existing = await dependencies.postgres.query<{ found: boolean }>(`
    SELECT EXISTS (SELECT 1 FROM results r JOIN session_tasks st ON st.id=r.session_task_id JOIN challenges c ON c.id=st.challenge_id
      WHERE r.user_id=$1 AND r.correct AND c.slug=$2) AS found
  `, [userId, challengeSlug]);
  if (existing.rows[0]?.found) return;
  const challenge = await dependencies.postgres.query<{ id: string; category_id: number; difficulty: string }>('SELECT id,category_id,difficulty FROM challenges WHERE slug=$1 AND enabled', [challengeSlug]);
  assert(challenge.rows[0], `challenge fixture ${challengeSlug}`);
  const sessionId = randomUUID();
  await dependencies.postgres.query(`INSERT INTO game_sessions (id,user_id,category_id,difficulty,mode,status,completed_at) VALUES ($1,$2,$3,$4,'real_shell','completed',now())`, [sessionId, userId, challenge.rows[0]!.category_id, challenge.rows[0]!.difficulty]);
  const task = await dependencies.postgres.query<{ id: string }>(`INSERT INTO session_tasks (game_session_id,challenge_id,position,status,presented_at,completed_at,attempt_count,score_awarded) VALUES ($1,$2,1,'correct',now(),now(),1,100) RETURNING id`, [sessionId, challenge.rows[0]!.id]);
  await dependencies.postgres.query(`INSERT INTO results (session_task_id,user_id,correct,submitted_answer,duration_ms,score_awarded) VALUES ($1,$2,true,'[learning-path-e2e]',100,100)`, [task.rows[0]!.id, userId]);
}

async function progressStatus(stableId: string): Promise<string | null> {
  const result = await dependencies.postgres.query<{ status: string }>(`
    SELECT p.status FROM learning_item_progress p JOIN learning_items i ON i.id=p.item_id
    JOIN learning_enrollments e ON e.id=p.enrollment_id WHERE e.user_id=$1 AND i.stable_id=$2
  `, [userId, stableId]);
  return result.rows[0]?.status ?? null;
}
async function contentCounts() {
  const result = await dependencies.postgres.query<{ courses: number; modules: number; items: number }>(`SELECT (SELECT count(*)::int FROM learning_courses) courses,(SELECT count(*)::int FROM learning_modules) modules,(SELECT count(*)::int FROM learning_items) items`);
  return result.rows[0]!;
}
async function scalar(query: string, values: unknown[]): Promise<number> { const result = await dependencies.postgres.query<{ count: number }>(query, values); return result.rows[0]!.count; }
function findItem(state: StatePayload, stableId: string) { const item = state.modules.flatMap((module) => module.items).find((candidate) => candidate.stableId === stableId); assert(item, stableId); return item; }
type StatePayload = { enrollment: { status: string; progress: number; finalScore: number | null }; modules: Array<{ status: string; items: Array<{ stableId: string; type: string; status: string; optional?: boolean }> }>; resume: { module: string; item: string } | null };
type SessionPayload = { id: string; status: 'active' | 'completed'; progress?: { current: number } };
function asState(value: unknown): StatePayload { return value as StatePayload; }
function asSession(value: unknown): SessionPayload { return value as SessionPayload; }
