import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { MatchmakingStore, QUICK_MATCH_POOL, type PairClaim } from './matchmaking-store.js';
import { createDependencies } from './services.js';

interface SuiteResult {
  concurrency: { checks: number; cancelWon: boolean; matchWon: boolean };
  load50: LoadResult;
  load51: LoadResult;
}

interface LoadResult {
  users: number;
  pairs: number;
  searching: number;
  uniqueUsers: number;
  selfMatches: number;
  duplicateUsers: number;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const dependencies = createDependencies(config);
  await dependencies.redis.connect();
  const prefix = `clirace:mm:test:${process.pid}:${Date.now()}`;
  const store = new MatchmakingStore(dependencies.redis, prefix);
  try {
    const concurrency = await concurrencySuite(store);
    await store.clearForTest();
    const load50 = await loadSuite(store, 50);
    await store.clearForTest();
    const load51 = await loadSuite(store, 51);
    const result: SuiteResult = { concurrency, load50, load51 };
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } finally {
    await store.clearForTest().catch(() => undefined);
    await dependencies.redis.quit().catch(() => undefined);
    await dependencies.postgres.end().catch(() => undefined);
  }
}

async function concurrencySuite(store: MatchmakingStore): Promise<SuiteResult['concurrency']> {
  let checks = 0;
  const lease = 2_000;

  const first = await store.enqueue('1', QUICK_MATCH_POOL, Date.now(), lease);
  equal(first.status, 'searching', 'enqueue enters searching'); checks += 1;
  await store.enqueue('1', QUICK_MATCH_POOL, Date.now(), lease);
  equal((await store.metrics()).queueDepth, 1, 'duplicate enqueue creates one queue member'); checks += 1;
  equal((await store.metrics()).enqueuedTotal, 1, 'duplicate enqueue is idempotent'); checks += 1;

  const self = await store.claimOldest('1', QUICK_MATCH_POOL, randomUUID(), Date.now(), lease);
  equal(self, null, 'user cannot match self'); checks += 1;
  await store.enqueue('2', QUICK_MATCH_POOL, Date.now(), lease);
  const [workerOne, workerTwo] = await Promise.all([
    store.claimOldest('1', QUICK_MATCH_POOL, randomUUID(), Date.now(), lease),
    store.claimOldest('2', QUICK_MATCH_POOL, randomUUID(), Date.now(), lease),
  ]);
  const claims = [workerOne, workerTwo].filter((claim): claim is PairClaim => Boolean(claim));
  equal(claims.length, 1, 'two matcher workers commit one pair'); checks += 1;
  assert(claims[0]?.userA !== claims[0]?.userB, 'pair is not a self match'); checks += 1;
  await store.commitMatch(claims[0]!, { id: randomUUID(), roomCode: 'TST22' }, Date.now(), lease);
  equal((await store.getState('1'))?.state.status, 'matched', 'first reconnect restores match'); checks += 1;
  equal((await store.getState('2'))?.state.status, 'matched', 'second reconnect restores match'); checks += 1;

  await store.clearForTest();
  await Promise.all([
    store.enqueue('3', QUICK_MATCH_POOL, Date.now(), lease),
    store.enqueue('3', QUICK_MATCH_POOL, Date.now(), lease),
    store.enqueue('3', QUICK_MATCH_POOL, Date.now(), lease),
  ]);
  equal((await store.metrics()).queueDepth, 1, 'multiple tabs share one queue entry'); checks += 1;

  await store.enqueue('4', QUICK_MATCH_POOL, Date.now(), lease);
  const [raceClaim, raceCancel] = await Promise.all([
    store.claimOldest('4', QUICK_MATCH_POOL, randomUUID(), Date.now(), lease),
    store.cancel('3'),
  ]);
  const cancelWon = !raceClaim && raceCancel.outcome === 'cancelled';
  const matchWon = Boolean(raceClaim) && raceCancel.outcome === 'match_committing';
  assert(cancelWon !== matchWon, 'cancel-vs-match has exactly one outcome'); checks += 1;
  if (raceClaim) await store.rollbackPair(raceClaim, { leaseMs: lease });

  await store.clearForTest();
  const queuedAt = Date.now();
  await store.enqueue('5', QUICK_MATCH_POOL, queuedAt, 60);
  await wait(90);
  equal(await store.sweepExpired(), 1, 'expired lease is removed'); checks += 1;
  equal((await store.metrics()).queueDepth, 0, 'expired queue is consistent'); checks += 1;

  await store.clearForTest();
  await store.enqueue('6', QUICK_MATCH_POOL, Date.now(), lease);
  equal((await store.getState('6'))?.state.status, 'searching', 'refresh restores searching state'); checks += 1;
  await store.enqueue('7', QUICK_MATCH_POOL, Date.now(), lease);
  const failedClaim = await store.claimOldest('7', QUICK_MATCH_POOL, randomUUID(), Date.now(), lease);
  assert(failedClaim, 'failure fixture pairs users');
  await store.rollbackPair(failedClaim, { leaseMs: lease });
  equal((await store.getState('6'))?.state.status, 'searching', 'battle failure requeues first user'); checks += 1;
  equal((await store.getState('7'))?.state.status, 'searching', 'battle failure requeues second user'); checks += 1;

  return { checks, cancelWon, matchWon };
}

async function loadSuite(store: MatchmakingStore, userCount: number): Promise<LoadResult> {
  const lease = 30_000;
  const users = Array.from({ length: userCount }, (_value, index) => String(index + 1));
  await Promise.all(users.map((userId, index) => store.enqueue(userId, QUICK_MATCH_POOL, Date.now() + index, lease)));
  const attempts = await Promise.all(users.map((userId) =>
    store.claimOldest(userId, QUICK_MATCH_POOL, randomUUID(), Date.now(), lease),
  ));
  const claims = attempts.filter((claim): claim is PairClaim => Boolean(claim));
  await Promise.all(claims.map((claim, index) => store.commitMatch(
    claim,
    { id: randomUUID(), roomCode: roomCode(index) },
    Date.now(),
    lease,
  )));

  const matchedUsers = claims.flatMap((claim) => [claim.userA, claim.userB]);
  const unique = new Set(matchedUsers);
  const selfMatches = claims.filter((claim) => claim.userA === claim.userB).length;
  const duplicateUsers = matchedUsers.length - unique.size;
  const metrics = await store.metrics();
  equal(claims.length, Math.floor(userCount / 2), `${userCount} users form expected pairs`);
  equal(selfMatches, 0, `${userCount} users produce no self matches`);
  equal(duplicateUsers, 0, `${userCount} users are not reused`);
  equal(metrics.queueDepth, userCount % 2, `${userCount} users leave a consistent queue`);
  if (userCount % 2 === 1) {
    const remaining = await store.listQueuedUserIds();
    equal(remaining.length, 1, '51st user remains valid and searchable');
    equal((await store.getState(remaining[0]!))?.state.status, 'searching', '51st state remains searching');
  }
  return {
    users: userCount,
    pairs: claims.length,
    searching: metrics.queueDepth,
    uniqueUsers: unique.size,
    selfMatches,
    duplicateUsers,
  };
}

function roomCode(index: number): string {
  return `T${index.toString(32).toUpperCase().padStart(4, '2')}`.slice(0, 5);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Matchmaking test failed: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(`Matchmaking test failed: ${message}; expected ${String(expected)}, got ${String(actual)}`);
}

if (process.argv[1]?.endsWith('matchmaking-test.js')) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
