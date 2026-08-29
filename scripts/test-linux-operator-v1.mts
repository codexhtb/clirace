import assert from 'node:assert/strict';
import { listChallengeLibraryV2 } from '../apps/api/src/challenge-library-v2/catalog.js';
import { loadAndValidateLinuxCoreContent } from '../apps/api/src/learning-content.js';
import { loadAndValidateLearningPathsContent } from '../apps/api/src/learning-path-content.js';

let checks = 0;
const check = (condition: unknown, label: string) => { assert.ok(condition, label); checks += 1; };

const [core, paths] = await Promise.all([loadAndValidateLinuxCoreContent(), loadAndValidateLearningPathsContent()]);
const course = paths.courses.find((candidate) => candidate.slug === 'linux-operator');
assert(course, 'Linux Operator course missing');
const report = paths.report.linuxOperator;
assert(report, 'Linux Operator report missing');
const beginner = paths.report.zeroToOperator;
assert(beginner, 'Zero to Operator report missing');

check(paths.report.courses === 3, 'three courses coexist');
check(course.order === 1 && course.level === 'intermediate', 'Operator is the second intermediate course');
check(course.prerequisites.length === 1 && course.prerequisites[0] === 'linux-zero-to-operator', 'beginner course is a recommended prerequisite');
check(report.modules === 14 && report.lessons === 56, '14 modules and 56 lessons');
check(report.questions === 154 && report.newQuestions === 137 && report.reusedQuestions === 17, 'question inventory');
check(report.requiredPractice === 14 && report.optionalPractice === 43, 'practice inventory');
check(report.uniqueCanonicalChallenges === 57 && report.newChallenges === 0, 'only canonical V2 challenges are reused');
check(core.report.total === 324 && core.report.warnings.length === 0, 'question bank is clean');
check(paths.report.invalidReferences === 0 && paths.report.warnings.length === 0, 'all path references resolve');
check(beginner.modules === 17 && beginner.lessons === 68 && beginner.questions === 187, 'beginner content totals stay unchanged');
check(beginner.requiredPractice === 17 && beginner.optionalPractice === 34, 'beginner practice totals stay unchanged');

const catalog = new Map(listChallengeLibraryV2().map((challenge) => [challenge.id, challenge]));
check(catalog.size === 150, 'canonical challenge library remains exactly 150');
const lessonTitles = new Set<string>();
const questionRefs = new Set<string>();
const challengeRefs = new Set<string>();
let requiredLabs = 0;
let optionalChallenges = 0;
for (const [moduleIndex, module] of course.modules.entries()) {
  const theory = module.items.filter((item) => item.type === 'theory');
  const quizzes = module.items.filter((item) => item.type === 'knowledge_check');
  const required = module.items.filter((item) => (item.type === 'practice' || item.type === 'shell_lab') && item.completion.optional !== true);
  const optional = module.items.filter((item) => (item.type === 'practice' || item.type === 'shell_lab') && item.completion.optional === true);
  const checkpoints = module.items.filter((item) => item.type === 'checkpoint');
  check(theory.length === 4 && quizzes.length === 4, `${module.slug}: four focused lesson/quiz pairs`);
  check(required.length === 1 && optional.length === 1 && checkpoints.length === 1, `${module.slug}: practice and checkpoint topology`);
  check(module.estimatedMinutes >= 30 && module.estimatedMinutes <= 60, `${module.slug}: short module duration`);
  check(moduleIndex === 0 ? module.prerequisites.length === 0 : module.prerequisites[0] === course.modules[moduleIndex - 1]?.slug, `${module.slug}: linear progression`);
  requiredLabs += required.flatMap((item) => 'challengeSlugs' in item ? item.challengeSlugs : []).length;
  optionalChallenges += optional.flatMap((item) => 'challengeSlugs' in item ? item.challengeSlugs : []).length;
  for (const item of theory) {
    const codeBlocks = item.content.filter((block) => block.type === 'code');
    check(codeBlocks.length === 1, `${item.id}: one focused command example`);
    check(item.content.some((block) => block.type === 'note'), `${item.id}: explanation note`);
    check(!lessonTitles.has(item.title), `${item.id}: unique title`);
    lessonTitles.add(item.title);
    const command = codeBlocks.map((block) => block.type === 'code' ? block.code : '').join('\n');
    check(!/\b(?:sudo|systemctl|journalctl|mount|mkfs|fdisk)\b/.test(command), `${item.id}: no privileged or unavailable command`);
    check(!/https?:\/\/(?!127\.0\.0\.1|localhost)/.test(command), `${item.id}: no Internet dependency`);
  }
  for (const item of [...quizzes, ...checkpoints]) if ('questionSlugs' in item) for (const slug of item.questionSlugs) {
    check(!questionRefs.has(slug), `${slug}: unique question reference`);
    questionRefs.add(slug);
  }
  for (const item of [...required, ...optional]) if ('challengeSlugs' in item) for (const slug of item.challengeSlugs) {
    const challenge = catalog.get(slug);
    check(Boolean(challenge?.availability.practice), `${slug}: Practice-eligible V2 task`);
    check(!challengeRefs.has(slug), `${slug}: challenge is not duplicated in course`);
    challengeRefs.add(slug);
  }
}

check(lessonTitles.size === 56, 'lesson title inventory complete');
check(questionRefs.size === 154, 'question reference inventory complete');
check(challengeRefs.size === 57, 'challenge reference inventory complete');
check(requiredLabs === 14 && optionalChallenges === 43, 'required and optional challenge totals');
check([...questionRefs].every((slug) => core.questions.some((question) => question.slug === slug)), 'every question resolves');
check(core.questions.filter((question) => question.slug.startsWith('operator-')).length === 137, 'exactly 137 Operator-authored questions');
check(core.questions.filter((question) => question.slug.startsWith('operator-')).every((question) => questionRefs.has(question.slug)), 'no orphaned Operator questions');
const requiredModules = ['system-inspection', 'storage-disk-usage', 'metadata-archives', 'shell-control', 'job-control', 'bash-scripting', 'shared-access', 'logs-incidents', 'networking-ii', 'http-local-services', 'dns-resolution', 'process-port-troubleshooting', 'system-troubleshooting', 'operator-capstone'];
check(requiredModules.every((slug) => course.modules.some((module) => module.slug === slug)), 'all Operator domains are present');
const capstone = course.modules.find((module) => module.slug === 'operator-capstone')!;
check(capstone.items.filter((item) => item.type === 'practice' || item.type === 'shell_lab').flatMap((item) => 'challengeSlugs' in item ? item.challengeSlugs : []).length === 5, 'capstone contains five canonical incidents');
check(checks >= 500, 'broad Operator content integrity coverage');

console.log(JSON.stringify({ ok: true, checks, report, canonicalLibrary: catalog.size }, null, 2));
