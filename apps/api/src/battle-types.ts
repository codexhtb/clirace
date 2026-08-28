import type { BattleChallengeSnapshot } from './challenge-library-v2/model.js';

export interface BattleSandboxMetadata {
  battleId: string;
  battlePlayerId: string;
  roomCode: string;
  roundNumber: number;
  challengeId: string;
  sandboxChallengeId: string;
  challengeVersion?: number;
  definitionHash?: string;
  challengeSnapshot?: BattleChallengeSnapshot;
  inputLocked: boolean;
}

export interface BattleRoundCompletion {
  roundCompleted: boolean;
  battleFinished: boolean;
  currentRound: number;
  completedRounds: number;
  winnerUserId: string | null;
}

export interface BattleSandboxHooks {
  onBattleSandboxReady(metadata: BattleSandboxMetadata): Promise<void>;
  onBattleRoundCompleted(metadata: BattleSandboxMetadata, userId: string): Promise<BattleRoundCompletion>;
}
