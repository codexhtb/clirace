import { randomInt } from 'node:crypto';
import type { ChallengeV2 } from './model.js';

export function selectBattleChallengeDefinitions(input: {
  available: readonly ChallengeV2[];
  rounds: number;
  recentIds: ReadonlySet<string>;
  pickIndex?: (size: number) => number;
}): ChallengeV2[] {
  if (input.available.length < input.rounds) throw new Error('Not enough battle-eligible challenges.');
  const withoutRecent = input.available.filter((challenge) => !input.recentIds.has(challenge.id));
  const pool = withoutRecent.length >= input.rounds ? withoutRecent : [...input.available];
  const selected: ChallengeV2[] = [];
  const pickIndex = input.pickIndex ?? randomInt;
  for (let round = 0; round < input.rounds; round += 1) {
    const preferredTiers = roundTierPreference(round, input.rounds);
    const unused = pool.filter((challenge) => !selected.some((entry) => entry.id === challenge.id));
    const tierCandidates = unused.filter((challenge) => preferredTiers.includes(challenge.tier));
    const candidates = tierCandidates.length ? tierCandidates : unused;
    const picked = candidates[pickIndex(candidates.length)];
    if (!picked) throw new Error('Unable to compose a balanced Battle challenge set.');
    selected.push(picked);
  }
  return selected;
}

export function roundTierPreference(roundIndex: number, roundCount: number): ChallengeV2['tier'][] {
  const position = roundCount <= 1 ? 0 : roundIndex / (roundCount - 1);
  if (position < 0.34) return ['foundation', 'operator'];
  if (position < 0.67) return ['operator'];
  return ['operator', 'engineer', 'troubleshooter'];
}
