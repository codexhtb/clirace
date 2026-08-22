export const INITIAL_RANKED_MMR = 1_000;
export const PLACEMENT_MATCHES = 5;
export const PLACEMENT_K_FACTOR = 40;
export const NORMAL_K_FACTOR = 24;
export const MINIMUM_RANKED_MMR = 0;

export const RANKED_DIVISIONS = [
  { name: 'Bronze', minimum: 0 },
  { name: 'Silver', minimum: 900 },
  { name: 'Gold', minimum: 1_100 },
  { name: 'Platinum', minimum: 1_300 },
  { name: 'Diamond', minimum: 1_500 },
  { name: 'Master', minimum: 1_700 },
] as const;

export type RankedDivision = 'Unranked' | typeof RANKED_DIVISIONS[number]['name'];

export interface RankedRatingInput {
  mmr: number;
  gamesPlayed: number;
}

export interface RankedRatingChange {
  before: number;
  after: number;
  delta: number;
  expectedScore: number;
  kFactor: number;
}

export function visibleDivision(mmr: number, gamesPlayed: number): RankedDivision {
  if (gamesPlayed < PLACEMENT_MATCHES) return 'Unranked';
  return divisionForMmr(mmr);
}

export function divisionForMmr(mmr: number): Exclude<RankedDivision, 'Unranked'> {
  let result: Exclude<RankedDivision, 'Unranked'> = 'Bronze';
  for (const division of RANKED_DIVISIONS) {
    if (mmr >= division.minimum) result = division.name;
  }
  return result;
}

export function calculateRankedRating(
  player: RankedRatingInput,
  opponent: RankedRatingInput,
  score: 0 | 1,
): RankedRatingChange {
  const expectedScore = 1 / (1 + 10 ** ((opponent.mmr - player.mmr) / 400));
  const kFactor = player.gamesPlayed < PLACEMENT_MATCHES ? PLACEMENT_K_FACTOR : NORMAL_K_FACTOR;
  const after = Math.max(MINIMUM_RANKED_MMR, Math.round(player.mmr + kFactor * (score - expectedScore)));
  return { before: player.mmr, after, delta: after - player.mmr, expectedScore, kFactor };
}

export function rankedSearchRange(waitMs: number): number {
  if (waitMs < 15_000) return 100;
  if (waitMs < 30_000) return 200;
  if (waitMs < 60_000) return 350;
  return 100_000;
}
