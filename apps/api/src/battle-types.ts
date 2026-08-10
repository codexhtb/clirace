export interface BattleSandboxMetadata {
  battleId: string;
  battlePlayerId: string;
  roomCode: string;
  roundNumber: number;
  challengeId: string;
  sandboxChallengeId: string;
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
