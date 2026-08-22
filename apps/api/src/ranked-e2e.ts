import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { registerCommunityRoutes } from './community-routes.js';
import { loadConfig } from './config.js';
import { calculateRankedRating } from './ranked-config.js';
import { runMigrations } from './migrations.js';
import { RankedService } from './ranked-service.js';
import { connectDependencies, createDependencies, closeDependencies, type Dependencies } from './services.js';

let checks = 0;

async function main() {
  const dependencies = createDependencies(loadConfig());
  await connectDependencies(dependencies);
  await runMigrations(dependencies.postgres);
  const ranked = new RankedService(dependencies);
  const app = Fastify();
  await registerCommunityRoutes(app, dependencies, ranked);
  await app.ready();
  const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const userIds: string[] = [];
  let battleSequence = 0;
  const challengeIds = await dependencies.postgres.query<{ id: string }>('SELECT id FROM challenges WHERE enabled LIMIT 3')
    .then((result) => result.rows.map((row) => row.id));
  assert(challengeIds.length === 3, 'three challenges available for Battle fixtures');

  try {
    const users = await createUsers(dependencies, suffix, 15);
    userIds.push(...users.map((user) => user.id));
    const [a, b, c, d, placement, ...placementOpponents] = users;
    assert(a && b && c && d && placement && placementOpponents.length >= 5, 'Ranked fixture users created');

    const rankedBattle = await createBattle('ranked', a.id, b.id, a.id);
    const attempts = await Promise.all(Array.from({ length: 100 }, () => ranked.applyFinishedBattleById(rankedBattle)));
    equal(attempts.filter((result) => result.status === 'applied').length, 1, '100 attempts apply exactly once');
    equal(attempts.filter((result) => result.status === 'already_applied').length, 99, '99 attempts are already_applied');
    const firstStats = await loadStats([a.id, b.id]);
    equal(firstStats.get(a.id)?.mmr, 1_020, 'equal placement winner gains 20');
    equal(firstStats.get(b.id)?.mmr, 980, 'equal placement loser loses 20');
    equal(firstStats.get(a.id)?.games_played, 1, 'winner game counted once');
    equal(await resultCount(rankedBattle), 1, 'one persistent Ranked result');

    const privateBattle = await createBattle('private', a.id, b.id, a.id);
    const quickBattle = await createBattle('quick', a.id, b.id, a.id);
    equal((await ranked.applyFinishedBattleById(privateBattle)).status, 'not_ranked', 'Private Battle does not apply MMR');
    equal((await ranked.applyFinishedBattleById(quickBattle)).status, 'not_ranked', 'Quick Match does not apply MMR');
    equal((await loadStats([a.id])).get(a.id)?.mmr, 1_020, 'casual Battles leave MMR unchanged');

    const concurrentWin = await createBattle('ranked', a.id, c.id, a.id);
    const concurrentLoss = await createBattle('ranked', a.id, d.id, d.id);
    const concurrentResults = await Promise.all([
      ranked.applyFinishedBattleById(concurrentWin),
      ranked.applyFinishedBattleById(concurrentLoss),
    ]);
    equal(concurrentResults.filter((result) => result.status === 'applied').length, 2, 'two different results both apply');
    const afterConcurrent = (await loadStats([a.id])).get(a.id)!;
    equal(afterConcurrent.games_played, 3, 'simultaneous results have no lost game update');
    const winFirst = calculateRankedRating({ mmr: 1_020, gamesPlayed: 1 }, { mmr: 1_000, gamesPlayed: 0 }, 1).after;
    const winThenLoss = calculateRankedRating({ mmr: winFirst, gamesPlayed: 2 }, { mmr: 1_000, gamesPlayed: 0 }, 0).after;
    const lossFirst = calculateRankedRating({ mmr: 1_020, gamesPlayed: 1 }, { mmr: 1_000, gamesPlayed: 0 }, 0).after;
    const lossThenWin = calculateRankedRating({ mmr: lossFirst, gamesPlayed: 2 }, { mmr: 1_000, gamesPlayed: 0 }, 1).after;
    assert([winThenLoss, lossThenWin].includes(afterConcurrent.mmr), 'simultaneous MMR equals a valid serial order');

    const noContestBattle = await createBattle('ranked', c.id, d.id, null, 'cancelled');
    const beforeNoContest = await loadStats([c.id, d.id]);
    const noContest = await ranked.recordNoContest(noContestBattle, 'sandbox_start_failed');
    equal(noContest.result?.outcome, 'no_contest', 'sandbox failure records no_contest');
    const afterNoContest = await loadStats([c.id, d.id]);
    equal(afterNoContest.get(c.id)?.mmr, beforeNoContest.get(c.id)?.mmr, 'no_contest keeps first MMR');
    equal(afterNoContest.get(d.id)?.mmr, beforeNoContest.get(d.id)?.mmr, 'no_contest keeps second MMR');

    const internalFailureBattle = await createBattle('ranked', placementOpponents[5]!.id, placementOpponents[6]!.id, null, 'cancelled');
    equal((await ranked.recordNoContest(internalFailureBattle, 'internal_battle_failure')).result?.outcome, 'no_contest', 'internal failure records no_contest');
    const forfeitWinner = placementOpponents[7]!;
    const forfeitLoser = placementOpponents[8]!;
    const forfeitBattle = await createBattle('ranked', forfeitWinner.id, forfeitLoser.id, forfeitWinner.id);
    await dependencies.postgres.query("UPDATE battle_players SET result = 'dnf' WHERE battle_id = $1 AND user_id = $2", [forfeitBattle, forfeitLoser.id]);
    equal((await ranked.applyFinishedBattleById(forfeitBattle)).status, 'applied', 'server-authoritative forfeit applies as loss');
    const forfeitStats = await loadStats([forfeitWinner.id, forfeitLoser.id]);
    assert((forfeitStats.get(forfeitWinner.id)?.mmr ?? 0) > 1_000, 'forfeit winner gains MMR');
    assert((forfeitStats.get(forfeitLoser.id)?.mmr ?? 1_000) < 1_000, 'forfeit loser loses MMR');

    for (let index = 0; index < 5; index += 1) {
      const opponent = placementOpponents[index]!;
      const battleId = await createBattle('ranked', placement.id, opponent.id, placement.id);
      equal((await ranked.applyFinishedBattleById(battleId)).status, 'applied', `placement ${index + 1} applied`);
    }
    const placementStats = await ranked.stats(placement.id);
    equal(placementStats.placementGamesCompleted, 5, 'five placements completed');
    equal(placementStats.provisional, false, 'division revealed after fifth placement');
    assert(placementStats.division !== 'Unranked', 'visible placement division');

    const profile = await app.inject({ method: 'GET', url: `/api/profiles/${a.username}` }).then((response) => response.json());
    equal(profile.profile.ranked.gamesPlayed, 3, 'public profile exposes Ranked games');
    assert(profile.profile.ranked.recentMatches.length >= 3, 'public profile exposes Ranked history');
    const leaderboard = await app.inject({ method: 'GET', url: '/api/leaderboard?category=ranked&limit=5&offset=0' }).then((response) => response.json());
    assert(leaderboard.entries.length > 0, 'Ranked leaderboard has entries');
    assert(leaderboard.entries.every((entry: { division?: string; rating?: number }) => entry.division && Number.isInteger(entry.rating)), 'leaderboard computes division server-side');
    const ratings = leaderboard.entries.map((entry: { rating: number }) => entry.rating);
    assert(ratings.every((rating: number, index: number) => index === 0 || ratings[index - 1]! >= rating), 'leaderboard sorted by MMR');

    console.log(JSON.stringify({
      ok: true,
      checks,
      concurrentApply: { attempts: 100, applied: 1, alreadyApplied: 99 },
      simultaneousResults: { gamesPlayed: afterConcurrent.games_played, finalMmr: afterConcurrent.mmr, serialCandidates: [winThenLoss, lossThenWin] },
      noContest: 'zero_change',
      placements: `${placementStats.placementGamesCompleted}/5`,
      profile: true,
      leaderboard: true,
    }, null, 2));

    async function createBattle(
      mode: 'private' | 'quick' | 'ranked',
      firstId: string,
      secondId: string,
      winnerId: string | null,
      status: 'finished' | 'cancelled' = 'finished',
    ) {
      battleSequence += 1;
      const id = randomUUID();
      const roomCode = `R${battleSequence.toString(36).toUpperCase().padStart(4, '0')}`.slice(-5);
      await dependencies.postgres.query(`
        INSERT INTO battles (
          id, room_code, status, host_user_id, round_count, challenge_ids, started_at,
          finished_at, winner_user_id, expires_at, mode, matchmaking_pool
        ) VALUES ($1,$2,$3,$4,3,$5::bigint[],now(),now(),$6,now() + interval '1 hour',$7,$8)
      `, [id, roomCode, status, firstId, challengeIds, winnerId, mode, mode === 'private' ? null : mode]);
      await dependencies.postgres.query(`
        INSERT INTO battle_players (id, battle_id, user_id, result, finished_at)
        VALUES ($1,$3,$4,$6,now()), ($2,$3,$5,$7,now())
      `, [randomUUID(), randomUUID(), id, firstId, secondId, winnerId === firstId ? 'win' : winnerId ? 'loss' : null, winnerId === secondId ? 'win' : winnerId ? 'loss' : null]);
      return id;
    }

    async function loadStats(ids: string[]) {
      const rows = await dependencies.postgres.query<{ user_id: string; mmr: number; games_played: number }>(
        'SELECT user_id, mmr, games_played FROM user_ranked_stats WHERE user_id = ANY($1::bigint[])', [ids],
      );
      return new Map(rows.rows.map((row) => [row.user_id, row]));
    }
    async function resultCount(battleId: string) {
      return dependencies.postgres.query<{ count: number }>('SELECT count(*)::int AS count FROM ranked_match_results WHERE battle_id = $1', [battleId])
        .then((result) => result.rows[0]?.count ?? 0);
    }
  } finally {
    if (userIds.length) await dependencies.postgres.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [userIds]).catch(() => undefined);
    await app.close();
    await closeDependencies(dependencies);
  }
}

async function createUsers(dependencies: Dependencies, suffix: string, count: number) {
  const users: Array<{ id: string; username: string }> = [];
  for (let index = 0; index < count; index += 1) {
    const username = `rank${index}${suffix}`.slice(0, 24);
    const row = await dependencies.postgres.query<{ id: string; username: string }>(`
      INSERT INTO users (username, username_normalized, email, email_normalized, password_hash)
      VALUES ($1::varchar(24), lower($1::text), $2::varchar(254), lower($2::text), 'ranked-e2e-not-loginable') RETURNING id, username
    `, [username, `${username}@e2e.invalid`]).then((result) => result.rows[0]!);
    users.push(row);
  }
  return users;
}

function equal(actual: unknown, expected: unknown, message: string) { checks += 1; if (actual !== expected) throw new Error(`Ranked E2E failed: ${message}; expected ${String(expected)}, got ${String(actual)}`); }
function assert(value: unknown, message: string): asserts value { checks += 1; if (!value) throw new Error(`Ranked E2E failed: ${message}`); }
main().catch((error) => { console.error(error); process.exitCode = 1; });
