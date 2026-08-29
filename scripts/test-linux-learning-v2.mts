import assert from 'node:assert/strict';
import { listChallengeLibraryV2 } from '../apps/api/src/challenge-library-v2/catalog.js';
import { loadAndValidateLinuxCoreContent } from '../apps/api/src/learning-content.js';
import { loadAndValidateLearningPathsContent } from '../apps/api/src/learning-path-content.js';

let checks = 0;
const check = (condition: unknown, label: string) => { assert.ok(condition, label); checks += 1; };

const [core, paths] = await Promise.all([loadAndValidateLinuxCoreContent(), loadAndValidateLearningPathsContent()]);
const course = paths.courses.find((candidate) => candidate.slug === 'linux-zero-to-operator');
assert(course, 'Zero to Operator course missing');
const report = paths.report.zeroToOperator;
assert(report, 'Zero to Operator report missing');

check(paths.report.courses === 3, 'legacy, beginner, and Operator courses coexist');
check(course.order === 0 && course.level === 'beginner', 'beginner course is primary');
check(report.modules === 17, '17 focused modules');
check(report.lessons === 68, '68 short lessons');
check(report.questions === 187, '187 unique quiz questions');
check(report.newQuestions === 162 && report.reusedQuestions === 25, 'new and reused question totals');
check(report.requiredPractice === 17 && report.optionalPractice === 34, 'required and optional practice totals');
check(core.report.total === 324 && core.report.warnings.length === 0, 'expanded question bank validates without warnings');
check(paths.report.invalidReferences === 0 && paths.report.warnings.length === 0, 'path references validate without warnings');

const catalog = new Map(listChallengeLibraryV2().map((challenge) => [challenge.id, challenge]));
const lessonTitles = new Set<string>();
const questionRefs = new Set<string>();
const challengeRefs = new Set<string>();
for (const [moduleIndex, module] of course.modules.entries()) {
  const theory = module.items.filter((item) => item.type === 'theory');
  const quizzes = module.items.filter((item) => item.type === 'knowledge_check');
  const required = module.items.filter((item) => (item.type === 'practice' || item.type === 'shell_lab') && item.completion.optional !== true);
  const optional = module.items.filter((item) => (item.type === 'practice' || item.type === 'shell_lab') && item.completion.optional === true);
  const checkpoints = module.items.filter((item) => item.type === 'checkpoint');
  check(theory.length === 4 && quizzes.length === 4, `${module.slug}: four lesson/quiz pairs`);
  check(required.length === 1 && optional.length === 1 && checkpoints.length === 1, `${module.slug}: practice topology`);
  check(module.estimatedMinutes >= 20 && module.estimatedMinutes <= 60, `${module.slug}: focused duration`);
  check(moduleIndex === 0 ? module.prerequisites.length === 0 : module.prerequisites[0] === course.modules[moduleIndex - 1]?.slug, `${module.slug}: linear prerequisite`);
  for (const item of theory) {
    check(item.content.some((block) => block.type === 'code') && item.content.some((block) => block.type === 'note'), `${item.id}: example and explanation`);
    check(!lessonTitles.has(item.title), `${item.id}: unique lesson title`);
    lessonTitles.add(item.title);
  }
  for (const item of [...quizzes, ...checkpoints]) if ('questionSlugs' in item) for (const slug of item.questionSlugs) {
    check(!questionRefs.has(slug), `${slug}: unique course question reference`);
    questionRefs.add(slug);
  }
  for (const item of [...required, ...optional]) if ('challengeSlugs' in item) for (const slug of item.challengeSlugs) {
    const challenge = catalog.get(slug);
    check(Boolean(challenge?.availability.practice), `${slug}: canonical Practice-eligible V2 challenge`);
    check(!challengeRefs.has(slug), `${slug}: curated challenge is not repeated`);
    challengeRefs.add(slug);
  }
}

check(lessonTitles.size === 68, 'lesson title inventory complete');
check(questionRefs.size === 187, 'question reference inventory complete');
check(challengeRefs.size === 51, 'challenge reference inventory complete');
check([...questionRefs].every((slug) => core.questions.some((question) => question.slug === slug)), 'every question resolves');
check(core.questions.filter((question) => question.slug.startsWith('zto-')).every((question) => questionRefs.has(question.slug)), 'no orphaned V2 questions');
check(course.modules.some((module) => module.slug === 'filesystem-navigation'), 'Filesystem coverage');
check(course.modules.some((module) => module.slug === 'permissions'), 'Permissions coverage');
check(course.modules.some((module) => module.slug === 'processes'), 'Processes coverage');
check(course.modules.some((module) => module.slug === 'networking'), 'Networking coverage');
check(course.modules.some((module) => module.slug === 'troubleshooting'), 'Troubleshooting coverage');
check(checks >= 250, 'broad content integrity coverage');

console.log(JSON.stringify({ ok: true, checks, report, uniqueChallenges: challengeRefs.size }, null, 2));
