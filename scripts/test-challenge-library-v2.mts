import assert from 'node:assert/strict';
import {
  challengeLibraryV2Report,
  getChallengeV2,
  listBattleEligibleChallenges,
  listChallengeLibraryV2,
  validateChallengeLibraryV2,
} from '../apps/api/src/challenge-library-v2/catalog.js';
import {
  challengeDefinitionHash,
  createBattleChallengeSnapshot,
  defineChallengeV2,
  evaluateBattleEligibility,
  parseBattleChallengeSnapshot,
} from '../apps/api/src/challenge-library-v2/model.js';
import { selectBattleChallengeDefinitions } from '../apps/api/src/challenge-library-v2/selection.js';
import { compileDeclarativeSetup } from '../apps/api/src/challenge-library-v2/setup.js';
import { alternativeSolutionFixtures, trustedSolutionForChallenge } from '../apps/api/src/challenge-library-v2/test-solutions.js';
import { listSandboxChallenges, sandboxChallengeFromBattleSnapshot } from '../apps/api/src/sandbox-challenges.js';

let checks = 0;
const check = (condition: unknown, message: string) => { checks += 1; assert.ok(condition, message); };
const library = listChallengeLibraryV2();
const report = challengeLibraryV2Report();

check(library.length === 150 && report.total === 150, 'canonical Library V2 contains exactly 150 new challenges');
check(Object.values(report.categories).reduce((sum, count) => sum + count, 0) === 150, 'category distribution accounts for every challenge');
check(report.availability.practice === 150 && report.onlineEligible.quick === 150 && report.onlineEligible.ranked === 150 && report.onlineEligible.private === 150, 'all V2 challenges are Practice and Battle eligible');
check(new Set(library.map((challenge) => challenge.id)).size === 150, 'challenge IDs are unique');
check(new Set(library.map((challenge) => challenge.title)).size === 150, 'challenge titles are unique');
check(new Set(library.map((challenge) => challenge.learningObjective)).size === 150, 'learning objectives are unique');
check(library.every((challenge) => challenge.version >= 1 && challenge.runtime.version === 1), 'content and runtime versions are independent and valid');
check(library.every((challenge) => challenge.checks.length > 0 && !('checkScript' in challenge)), 'every V2 task is checker-first with no legacy checkScript');
check(library.every((challenge) => challenge.setup.kind === 'declarative' && !('setupScript' in challenge)), 'every V2 task uses declarative setup with no setupScript');
check(library.every((challenge) => evaluateBattleEligibility(challenge, 'ranked').eligible), 'ranked eligibility validator accepts the full V2 pool');
check(listBattleEligibleChallenges('quick').length === 150, 'Quick Match resolves the canonical eligible pool');
check(listBattleEligibleChallenges('ranked').length === 150, 'Ranked resolves the canonical eligible pool');
check(listBattleEligibleChallenges('private').length === 150, 'Private Battle resolves the canonical eligible pool');
check(validateChallengeLibraryV2(library).warnings.length === 0, 'quality audit finds no exact duplicate gameplay shapes');

const sample = getChallengeV2('filesystem-switch-current-release')!;
const firstHash = challengeDefinitionHash(sample);
const secondHash = challengeDefinitionHash(structuredClone(sample));
check(firstHash === secondHash && /^[a-f0-9]{64}$/.test(firstHash), 'definition hash is deterministic');
const snapshot = createBattleChallengeSnapshot(sample);
check(parseBattleChallengeSnapshot(snapshot).definitionHash === firstHash, 'pinned Battle snapshot validates against its hash');
const sandboxA = sandboxChallengeFromBattleSnapshot(snapshot);
const sandboxB = sandboxChallengeFromBattleSnapshot(structuredClone(snapshot));
check(sandboxA.definitionHash === sandboxB.definitionHash && sandboxA.challengeVersion === sandboxB.challengeVersion, 'A/B resolve the same pinned definition and version');
const changed = structuredClone(sample);
changed.checks[0] = { ...changed.checks[0]!, target: '/workspace/releases/v1' } as typeof changed.checks[number];
check(challengeDefinitionHash(changed) !== snapshot.definitionHash, 'catalog gameplay mutation produces a different hash without altering the existing snapshot');
check(parseBattleChallengeSnapshot(snapshot).definitionHash === snapshot.definitionHash, 'existing Battle snapshot remains resolvable after a catalog mutation');

const malicious = defineChallengeV2({
  id: 'security-escaped-content-probe', title: 'Проверка безопасного содержимого',
  description: 'Тестовая definition проверяет безопасное кодирование содержимого setup.',
  learningObjective: 'Проверять отсутствие shell injection в declarative setup compiler.',
  category: 'filesystem', concepts: ['security'], tier: 'foundation', difficulty: 'Easy',
  setup: { version: 1, kind: 'declarative', operations: [{ type: 'create_file', path: '/workspace/probe', content: "$(touch /workspace/PWNED);'\n" }] },
  checks: [{ id: 'probe', type: 'file_exists', path: '/workspace/probe', kind: 'file' }],
  hint: 'Тестовая подсказка не используется пользователем.', successMessage: 'Безопасность подтверждена.', estimatedDurationSeconds: 30,
});
const compiled = compileDeclarativeSetup(malicious.setup);
check(!compiled.includes('$(touch') && compiled.includes('base64 -d'), 'file content is encoded rather than interpolated as shell');
assert.throws(() => defineChallengeV2({ ...malicious, setupScript: 'id' } as never)); checks += 1;
assert.throws(() => defineChallengeV2({ ...malicious, setup: { version: 1, kind: 'declarative', operations: [{ type: 'command', value: 'id' }] } } as never)); checks += 1;

const recentIds = new Set(library.slice(0, 147).map((challenge) => challenge.id));
const noRepeat = selectBattleChallengeDefinitions({ available: library, rounds: 3, recentIds, pickIndex: () => 0 });
check(noRepeat.every((challenge) => !recentIds.has(challenge.id)), 'selection avoids recent challenges when the remaining pool is sufficient');
const fallback = selectBattleChallengeDefinitions({ available: library.slice(0, 3), rounds: 3, recentIds: new Set(library.slice(0, 3).map((challenge) => challenge.id)), pickIndex: () => 0 });
check(new Set(fallback.map((challenge) => challenge.id)).size === 3, 'selection safely falls back when the eligible pool is small');
check(new Set(selectBattleChallengeDefinitions({ available: library, rounds: 3, recentIds: new Set(), pickIndex: () => 0 }).map((challenge) => challenge.id)).size === 3, 'one Battle never repeats a challenge across rounds');

const sandboxV2 = listSandboxChallenges().filter((challenge) => challenge.source === 'library-v2');
check(sandboxV2.length === 150, 'Practice/Sandbox adapter exposes every canonical V2 challenge once');
check(sandboxV2.every((challenge) => challenge.runtime && challenge.checks && challenge.definitionHash), 'Sandbox adapter preserves checker contract and definition hash');
check(library.every((challenge) => trustedSolutionForChallenge(challenge).length > 0), 'every challenge has a trusted test solution fixture');
check(Object.keys(alternativeSolutionFixtures).length >= 10 && Object.values(alternativeSolutionFixtures).every((solutions) => solutions.length === 2), 'at least ten challenges have two alternative solution fixtures');

console.log(JSON.stringify({ ok: true, checks, report, alternativeChallenges: Object.keys(alternativeSolutionFixtures).length }, null, 2));
