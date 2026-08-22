import {
  NORMAL_K_FACTOR,
  PLACEMENT_K_FACTOR,
  calculateRankedRating,
  divisionForMmr,
  rankedSearchRange,
  visibleDivision,
} from './ranked-config.js';

let checks = 0;

const equalPlacement = calculateRankedRating({ mmr: 1_000, gamesPlayed: 0 }, { mmr: 1_000, gamesPlayed: 0 }, 1);
equal(equalPlacement.after, 1_020, 'equal placement winner');
equal(equalPlacement.kFactor, PLACEMENT_K_FACTOR, 'placement K factor');

const equalNormal = calculateRankedRating({ mmr: 1_000, gamesPlayed: 5 }, { mmr: 1_000, gamesPlayed: 5 }, 1);
equal(equalNormal.after, 1_012, 'equal normal winner');
equal(equalNormal.kFactor, NORMAL_K_FACTOR, 'normal K factor');

const strongWin = calculateRankedRating({ mmr: 1_400, gamesPlayed: 5 }, { mmr: 1_000, gamesPlayed: 5 }, 1);
assert(strongWin.delta > 0 && strongWin.delta < equalNormal.delta, 'strong expected win has a small gain');
const upset = calculateRankedRating({ mmr: 1_000, gamesPlayed: 5 }, { mmr: 1_400, gamesPlayed: 5 }, 1);
assert(upset.delta > equalNormal.delta, 'weak player upset has a larger gain');
const strongLoss = calculateRankedRating({ mmr: 1_400, gamesPlayed: 5 }, { mmr: 1_000, gamesPlayed: 5 }, 0);
assert(strongLoss.delta < -equalNormal.delta, 'strong player loss has a larger penalty');
equal(calculateRankedRating({ mmr: 0, gamesPlayed: 5 }, { mmr: 2_000, gamesPlayed: 5 }, 0).after, 0, 'minimum MMR clamp');

equal(divisionForMmr(899), 'Bronze', 'Bronze boundary');
equal(divisionForMmr(900), 'Silver', 'Silver boundary');
equal(divisionForMmr(1_100), 'Gold', 'Gold boundary');
equal(divisionForMmr(1_300), 'Platinum', 'promotion boundary');
equal(divisionForMmr(1_299), 'Gold', 'demotion boundary');
equal(visibleDivision(1_700, 4), 'Unranked', 'placement hides division');
equal(visibleDivision(1_700, 5), 'Master', 'fifth game reveals division');

equal(rankedSearchRange(0), 100, 'initial matchmaking range');
equal(rankedSearchRange(15_000), 200, '15 second matchmaking range');
equal(rankedSearchRange(30_000), 350, '30 second matchmaking range');
equal(rankedSearchRange(60_000), 100_000, '60 second matchmaking range');

console.log(JSON.stringify({ ok: true, checks, roundPolicy: 'Math.round', placementK: PLACEMENT_K_FACTOR, normalK: NORMAL_K_FACTOR }, null, 2));

function equal(actual: unknown, expected: unknown, message: string) {
  checks += 1;
  if (actual !== expected) throw new Error(`Ranked unit test failed: ${message}; expected ${String(expected)}, got ${String(actual)}`);
}
function assert(value: unknown, message: string): asserts value {
  checks += 1;
  if (!value) throw new Error(`Ranked unit test failed: ${message}`);
}
