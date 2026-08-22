import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { MatchmakingStore, QUICK_MATCH_POOL, RANKED_MATCH_POOL, type PairClaim } from './matchmaking-store.js';
import { createDependencies } from './services.js';

let checks = 0;

async function main() {
  const dependencies = createDependencies(loadConfig());
  await dependencies.redis.connect();
  const store = new MatchmakingStore(dependencies.redis, `clirace:mm:ranked-test:${process.pid}:${Date.now()}`);
  try {
    await store.enqueue('1', QUICK_MATCH_POOL, Date.now(), 30_000, 1_000);
    await store.enqueue('2', RANKED_MATCH_POOL, Date.now(), 30_000, 1_000);
    equal(await store.claimOldest('2', RANKED_MATCH_POOL, randomUUID(), Date.now(), 30_000), null, 'Quick and Ranked queues isolated');
    await store.enqueue('3', RANKED_MATCH_POOL, Date.now(), 30_000, 1_020);
    const equalClaim = await store.claimOldest('3', RANKED_MATCH_POOL, randomUUID(), Date.now(), 30_000);
    assert(equalClaim && Math.abs(equalClaim.ratingA - equalClaim.ratingB) === 20, 'nearby MMR users pair');

    await store.clearForTest();
    await store.enqueue('10', RANKED_MATCH_POOL, Date.now(), 30_000, 1_000);
    await store.enqueue('11', RANKED_MATCH_POOL, Date.now(), 30_000, 1_400);
    equal(await store.claimOldest('11', RANKED_MATCH_POOL, randomUUID(), Date.now(), 30_000), null, 'large initial MMR gap does not pair');

    await store.clearForTest();
    const old = Date.now() - 61_000;
    await store.enqueue('12', RANKED_MATCH_POOL, old, 90_000, 1_000);
    await store.enqueue('13', RANKED_MATCH_POOL, old + 1, 90_000, 1_700);
    assert(await store.claimOldest('13', RANKED_MATCH_POOL, randomUUID(), Date.now(), 30_000), 'wait window expands without starvation');

    await store.clearForTest();
    await Promise.all(Array.from({ length: 3 }, () => store.enqueue('20', RANKED_MATCH_POOL, Date.now(), 30_000, 1_000)));
    equal((await store.metrics(RANKED_MATCH_POOL)).queueDepth, 1, 'duplicate Ranked enqueue idempotent');
    await store.enqueue('21', RANKED_MATCH_POOL, Date.now(), 30_000, 1_000);
    const [claim, cancel] = await Promise.all([
      store.claimOldest('21', RANKED_MATCH_POOL, randomUUID(), Date.now(), 30_000),
      store.cancel('20', RANKED_MATCH_POOL),
    ]);
    assert((Boolean(claim) && cancel.outcome === 'match_committing') || (!claim && cancel.outcome === 'cancelled'), 'Ranked cancel-vs-match race safe');

    await store.clearForTest();
    const users = Array.from({ length: 50 }, (_, index) => ({ id: String(100 + index), mmr: 800 + Math.floor(index / 2) * 20 }));
    await Promise.all(users.map((user, index) => store.enqueue(user.id, RANKED_MATCH_POOL, Date.now() + index, 30_000, user.mmr)));
    const attempts = await Promise.all(users.map((user) => store.claimOldest(user.id, RANKED_MATCH_POOL, randomUUID(), Date.now(), 30_000)));
    const claims = attempts.filter((value): value is PairClaim => Boolean(value));
    const matched = claims.flatMap((value) => [value.userA, value.userB]);
    equal(claims.length, 25, '50 Ranked users form 25 pairs');
    equal(new Set(matched).size, 50, 'Ranked load has no duplicate players');
    equal(claims.filter((value) => value.userA === value.userB).length, 0, 'Ranked load has no self-match');
    assert(claims.every((value) => Math.abs(value.ratingA - value.ratingB) <= 100), 'Ranked load respects initial MMR range');
    console.log(JSON.stringify({ ok: true, checks, users: 50, pairs: claims.length, uniqueUsers: new Set(matched).size, maxDistance: Math.max(...claims.map((value) => Math.abs(value.ratingA - value.ratingB))) }, null, 2));
  } finally {
    await store.clearForTest().catch(() => undefined);
    await dependencies.redis.quit().catch(() => undefined);
    await dependencies.postgres.end().catch(() => undefined);
  }
}

function equal(actual: unknown, expected: unknown, message: string) { checks += 1; if (actual !== expected) throw new Error(`Ranked matchmaking test failed: ${message}; expected ${String(expected)}, got ${String(actual)}`); }
function assert(value: unknown, message: string): asserts value { checks += 1; if (!value) throw new Error(`Ranked matchmaking test failed: ${message}`); }
main().catch((error) => { console.error(error); process.exitCode = 1; });
