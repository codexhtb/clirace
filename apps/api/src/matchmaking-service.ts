import { randomUUID } from 'node:crypto';
import type { AuthUser } from './auth-service.js';
import {
  BattleAdmissionError,
  type BattleManager,
  type BattleNavigation,
} from './battle-service.js';
import type { AppConfig } from './config.js';
import {
  MatchmakingStore,
  QUICK_MATCH_POOL,
  RANKED_MATCH_POOL,
  type MatchedState,
  type MatchmakingPool,
  type MatchmakingMetricsSnapshot,
  type MatchmakingRedisState,
  type PairClaim,
} from './matchmaking-store.js';
import { RankedService, type PublicRankedStats } from './ranked-service.js';
import type { SandboxManager } from './sandbox-manager.js';
import { LIVE_SANDBOX_STATES } from './sandbox-platform.js';
import type { Dependencies } from './services.js';

export type MatchmakingStatus =
  | { status: 'idle'; pool: MatchmakingPool; ranked?: PublicRankedStats }
  | {
    status: 'searching';
    pool: MatchmakingPool;
    queuedAt: string;
    leaseExpiresAt: string;
    waitingCapacity: boolean;
    phase: 'queued' | 'pairing';
    ranked?: PublicRankedStats;
  }
  | {
    status: 'matched';
    pool: MatchmakingPool;
    matchId: string | null;
    battleId: string;
    roomCode: string;
    opponent: { userId: string; username: string; ranked?: PublicRankedStats } | null;
    matchedAt: string | null;
    source: 'quick_match' | 'ranked_match' | 'active_battle';
    ranked?: PublicRankedStats;
  };

export class MatchmakingError extends Error {
  constructor(
    readonly code: 'active_battle' | 'incompatible_active_session' | 'queue_expired' | 'match_committing' | 'temporarily_unavailable',
    message: string,
    readonly statusCode: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export class MatchmakingManager {
  private readonly store: MatchmakingStore;
  private readonly ranked: RankedService;
  private maintenanceTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly dependencies: Dependencies,
    private readonly sandboxManager: SandboxManager,
    private readonly battleManager: BattleManager,
    options: { redisPrefix?: string } = {},
  ) {
    this.store = new MatchmakingStore(dependencies.redis, options.redisPrefix);
    this.ranked = new RankedService(dependencies);
  }

  async start(): Promise<void> {
    if (!this.config.MATCHMAKING_ENABLED) return;
    await this.recoverPendingPairs();
    await this.cleanupInvalidQueueEntries();
    this.maintenanceTimer = setInterval(() => {
      void this.maintenance().catch((error: unknown) => {
        console.error('Matchmaking maintenance failed', { reason: errorMessage(error) });
      });
    }, 30_000);
    this.maintenanceTimer.unref();
  }

  async close(): Promise<void> {
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = undefined;
  }

  async enqueue(user: AuthUser, pool: MatchmakingPool = QUICK_MATCH_POOL): Promise<MatchmakingStatus> {
    this.assertEnabled();
    const existingState = await this.store.getState(user.id);
    if (existingState) return this.resolveRedisState(existingState.state, existingState.ttlMs);

    const activeBattle = await this.battleManager.findActiveBattleForUser(user.id);
    if (activeBattle) throw activeBattleError(activeBattle);
    if (await this.sandboxManager.hasLiveSessionForUser(user.id)) {
      throw new MatchmakingError(
        'incompatible_active_session',
        'Сначала завершите активную Shell-сессию.',
        409,
      );
    }

    const ranked = pool === RANKED_MATCH_POOL ? await this.ranked.stats(user.id) : undefined;
    const state = await this.store.enqueue(user.id, pool, Date.now(), this.leaseMs(), ranked?.mmr);
    console.info('Matchmaking enqueue', { userId: user.id, pool, ...(ranked ? { mmr: ranked.mmr } : {}) });
    if (state.status !== 'searching') return this.resolveRedisState(state, this.leaseMs());
    await this.tryPair(pool);
    return this.status(user.id, pool);
  }

  async heartbeat(user: AuthUser): Promise<MatchmakingStatus> {
    this.assertEnabled();
    const state = await this.store.heartbeat(user.id, this.leaseMs());
    if (!state) throw new MatchmakingError('queue_expired', 'Поиск истёк. Запустите его снова.', 410);
    if (state.status === 'searching') await this.tryPair(state.pool);
    return this.status(user.id);
  }

  async cancel(userId: string): Promise<MatchmakingStatus> {
    this.assertEnabled();
    const stored = await this.store.getState(userId);
    const pool = stored?.state.pool ?? QUICK_MATCH_POOL;
    const result = await this.store.cancel(userId, pool);
    if (result.outcome === 'cancelled') {
      console.info('Matchmaking cancel', { userId, pool });
      return this.idleStatus(userId, pool);
    }
    if (result.outcome === 'match_committing') {
      throw new MatchmakingError(
        'match_committing',
        'Соперник уже найден — завершаем создание Battle.',
        409,
        { matchId: result.matchId },
      );
    }
    return this.resolveMatchedState(result.state);
  }

  async leaveQueueForManualBattle(userId: string): Promise<void> {
    if (!this.config.MATCHMAKING_ENABLED) return;
    const stored = await this.store.getState(userId);
    const result = await this.store.cancel(userId, stored?.state.pool ?? QUICK_MATCH_POOL);
    if (result.outcome === 'cancelled') return;
    if (result.outcome === 'match_committing') {
      throw new MatchmakingError(
        'match_committing',
        'Соперник уже найден — дождитесь создания Battle.',
        409,
        { matchId: result.matchId },
      );
    }
    const status = await this.resolveMatchedState(result.state);
    if (status.status === 'matched') {
      throw new MatchmakingError(
        'active_battle',
        'У вас уже есть активный Battle.',
        409,
        { battleId: status.battleId, roomCode: status.roomCode },
      );
    }
  }

  async status(userId: string, preferredPool: MatchmakingPool = QUICK_MATCH_POOL): Promise<MatchmakingStatus> {
    this.assertEnabled();
    const stored = await this.store.getState(userId);
    if (stored) return this.resolveRedisState(stored.state, stored.ttlMs);
    const activeBattle = await this.battleManager.findActiveBattleForUser(userId);
    if (!activeBattle) return this.idleStatus(userId, preferredPool);
    return this.activeBattleStatus(activeBattle, userId);
  }

  async removeUser(userId: string, reason: 'suspended' | 'session_revoked'): Promise<void> {
    const stored = await this.store.getState(userId);
    if (!stored) return;
    const state = stored.state;
    if (state.status === 'searching') {
      await this.store.cancel(userId, state.pool);
      console.info('Matchmaking user removed', { userId, reason, state: 'searching' });
      return;
    }
    if (state.status === 'pairing') {
      const claim = await this.store.getPair(state.matchId);
      if (claim) {
        const battle = await this.battleManager.findMatchmakingBattle(claim.matchId);
        if (battle && ['waiting', 'countdown', 'running'].includes(battle.status)) {
          await this.battleManager.terminateBattle(battle.id);
        }
        await this.store.rollbackPair(claim, { invalidUserId: userId, leaseMs: this.leaseMs() });
      } else {
        await this.store.clearState(userId, state.pool);
      }
      console.info('Matchmaking user removed', { userId, reason, state: 'pairing' });
      return;
    }

    const battle = await this.battleManager.findMatchmakingBattle(state.matchId);
    if (battle && ['waiting', 'countdown', 'running'].includes(battle.status)) {
      await this.battleManager.terminateBattle(battle.id);
    }
    await Promise.all([
      this.store.clearState(userId, state.pool),
      this.store.clearState(state.opponentUserId, state.pool),
    ]);
    const opponent = await this.loadActiveUsers([state.opponentUserId]).then((users) => users[0]);
    if (opponent && !await this.battleManager.findActiveBattleForUser(opponent.id)) {
      const opponentStats = state.pool === RANKED_MATCH_POOL ? await this.ranked.stats(opponent.id) : undefined;
      await this.store.enqueue(opponent.id, state.pool, Date.now(), this.leaseMs(), opponentStats?.mmr);
    }
    console.info('Matchmaking user removed', { userId, reason, state: 'matched' });
  }

  async metrics(pool: MatchmakingPool = QUICK_MATCH_POOL): Promise<MatchmakingMetricsSnapshot> {
    return this.store.metrics(pool);
  }

  async allMetrics(): Promise<Record<MatchmakingPool, MatchmakingMetricsSnapshot>> {
    const [quick, ranked] = await Promise.all([
      this.metrics(QUICK_MATCH_POOL), this.metrics(RANKED_MATCH_POOL),
    ]);
    return { quick, ranked };
  }

  async prometheusMetrics(): Promise<string> {
    const metrics = await this.metrics(QUICK_MATCH_POOL);
    const ranked = await this.metrics(RANKED_MATCH_POOL);
    return [
      '# HELP matchmaking_queue_depth Users currently waiting in Quick Match.',
      '# TYPE matchmaking_queue_depth gauge',
      `matchmaking_queue_depth ${metrics.queueDepth}`,
      '# HELP matchmaking_enqueued_total Queue entries created.',
      '# TYPE matchmaking_enqueued_total counter',
      `matchmaking_enqueued_total ${metrics.enqueuedTotal}`,
      '# HELP matchmaking_matched_total Matchmaking pairs committed.',
      '# TYPE matchmaking_matched_total counter',
      `matchmaking_matched_total ${metrics.matchedTotal}`,
      '# HELP matchmaking_cancelled_total Searches cancelled before pairing.',
      '# TYPE matchmaking_cancelled_total counter',
      `matchmaking_cancelled_total ${metrics.cancelledTotal}`,
      '# HELP matchmaking_expired_total Queue leases removed after expiry.',
      '# TYPE matchmaking_expired_total counter',
      `matchmaking_expired_total ${metrics.expiredTotal}`,
      '# HELP matchmaking_failed_total Pairings rolled back after a failed Battle creation.',
      '# TYPE matchmaking_failed_total counter',
      `matchmaking_failed_total ${metrics.failedTotal}`,
      '# HELP matchmaking_wait_seconds Recent matchmaking wait-time quantiles.',
      '# TYPE matchmaking_wait_seconds summary',
      `matchmaking_wait_seconds{quantile="0.5"} ${metrics.waitP50Seconds}`,
      `matchmaking_wait_seconds{quantile="0.95"} ${metrics.waitP95Seconds}`,
      `matchmaking_wait_seconds_sum ${metrics.waitSumSeconds}`,
      `matchmaking_wait_seconds_count ${metrics.waitCount}`,
      '# HELP matchmaking_ranked_queue_depth Users currently waiting in Ranked.',
      '# TYPE matchmaking_ranked_queue_depth gauge',
      `matchmaking_ranked_queue_depth ${ranked.queueDepth}`,
      '# HELP matchmaking_ranked_matched_total Ranked pairs committed.',
      '# TYPE matchmaking_ranked_matched_total counter',
      `matchmaking_ranked_matched_total ${ranked.matchedTotal}`,
      '',
    ].join('\n');
  }

  private async tryPair(pool: MatchmakingPool): Promise<void> {
    const lockToken = randomUUID();
    const lockTtlMs = Math.min(60_000, this.config.MATCHMAKING_PAIRING_TTL_SECONDS * 1_000);
    if (!await this.store.acquirePairingLock(lockToken, lockTtlMs)) return;
    try {
      // The lock holder drains FIFO pairs instead of creating only one match.
      // This keeps a concurrent enqueue burst from waiting for the next browser heartbeat.
      for (let paired = 0; paired < 64; paired += 1) {
        const queued = await this.store.listQueuedUserIds(pool, 256);
        if (queued.length < 2) return;
        const admission = await this.capacityAdmission();
        if (!admission.allowed) {
          await Promise.allSettled(queued.map((queuedUserId) =>
            this.store.markWaitingCapacity(queuedUserId, true, this.leaseMs()),
          ));
          return;
        }
        // Anchor pairing on the oldest waiter. Ranked then selects the closest
        // compatible opponent; Quick keeps FIFO because all casual ratings are equal.
        const currentUserId = queued[0]!;
        await this.store.markWaitingCapacity(currentUserId, false, this.leaseMs());
        const matchId = randomUUID();
        const claim = await this.store.claimOldest(
          currentUserId,
          pool,
          matchId,
          Date.now(),
          this.config.MATCHMAKING_PAIRING_TTL_SECONDS * 1_000,
        );
        if (!claim) return;
        if (!await this.createClaimedBattle(claim)) return;
      }
    } finally {
      await this.store.releasePairingLock(lockToken);
    }
  }

  private async createClaimedBattle(claim: PairClaim): Promise<boolean> {
    try {
      const users = await this.loadActiveUsers([claim.userA, claim.userB]);
      const missingUser = [claim.userA, claim.userB].find((userId) => !users.some((user) => user.id === userId));
      if (missingUser) {
        await this.store.rollbackPair(claim, { invalidUserId: missingUser, leaseMs: this.leaseMs() });
        console.warn('Matchmaking match failed', { matchId: claim.matchId, reason: 'user_unavailable', userId: missingUser });
        return true;
      }
      for (const user of users) {
        if (await this.sandboxManager.hasLiveSessionForUser(user.id)) {
          await this.store.rollbackPair(claim, { invalidUserId: user.id, leaseMs: this.leaseMs() });
          console.warn('Matchmaking match failed', { matchId: claim.matchId, reason: 'incompatible_active_session', userId: user.id });
          return true;
        }
      }
      const first = users.find((user) => user.id === claim.userA)!;
      const second = users.find((user) => user.id === claim.userB)!;
      const battle = await this.battleManager.createMatchmakingBattle(
        claim.matchId,
        claim.pool,
        first,
        second,
      );
      await this.store.commitMatch(claim, battle, Date.now(), this.config.MATCHMAKING_MATCH_TTL_SECONDS * 1_000);
      console.info('Matchmaking match created', {
        matchId: claim.matchId,
        battleId: battle.id,
        userIds: [claim.userA, claim.userB],
        waitMs: Date.now() - Math.min(claim.queuedAtA, claim.queuedAtB),
      });
      return true;
    } catch (error) {
      if (error instanceof BattleAdmissionError) {
        await this.store.rollbackPair(claim, { invalidUserId: error.userId, leaseMs: this.leaseMs() });
      } else {
        await this.store.rollbackPair(claim, { leaseMs: this.leaseMs() });
      }
      console.error('Matchmaking match failed', { matchId: claim.matchId, reason: errorMessage(error) });
      return error instanceof BattleAdmissionError;
    }
  }

  private async resolveRedisState(state: MatchmakingRedisState, ttlMs: number): Promise<MatchmakingStatus> {
    if (state.status === 'searching') {
      return {
        status: 'searching',
        pool: state.pool,
        queuedAt: new Date(state.queuedAt).toISOString(),
        leaseExpiresAt: new Date(Date.now() + ttlMs).toISOString(),
        waitingCapacity: state.waitingCapacity,
        phase: 'queued',
        ...(state.pool === RANKED_MATCH_POOL ? { ranked: await this.ranked.stats(state.userId) } : {}),
      };
    }
    if (state.status === 'pairing') {
      const battle = await this.battleManager.findMatchmakingBattle(state.matchId);
      const claim = await this.store.getPair(state.matchId);
      if (battle && claim) {
        await this.store.commitMatch(claim, battle, Date.now(), this.config.MATCHMAKING_MATCH_TTL_SECONDS * 1_000);
        const committed = await this.store.getState(state.userId);
        if (committed?.state.status === 'matched') return this.resolveMatchedState(committed.state);
      }
      if (claim && Date.now() - claim.claimedAt > 10_000) {
        await this.store.rollbackPair(claim, { leaseMs: this.leaseMs() });
        return this.status(state.userId, state.pool);
      }
      return {
        status: 'searching',
        pool: state.pool,
        queuedAt: new Date(state.queuedAt).toISOString(),
        leaseExpiresAt: new Date(Date.now() + ttlMs).toISOString(),
        waitingCapacity: false,
        phase: 'pairing',
        ...(state.pool === RANKED_MATCH_POOL ? { ranked: await this.ranked.stats(state.userId) } : {}),
      };
    }
    return this.resolveMatchedState(state);
  }

  private async resolveMatchedState(state: MatchedState): Promise<MatchmakingStatus> {
    const battle = await this.battleManager.findMatchmakingBattle(state.matchId);
    if (battle?.status === 'cancelled' || battle?.status === 'finished') {
      await this.store.clearState(state.userId, state.pool);
      return this.idleStatus(state.userId, state.pool);
    }
    const opponent = await this.opponent(
      state.battleId, state.userId, state.opponentUserId, state.pool === RANKED_MATCH_POOL,
    );
    return {
      status: 'matched',
      pool: state.pool,
      matchId: state.matchId,
      battleId: state.battleId,
      roomCode: state.roomCode,
      opponent,
      matchedAt: new Date(state.matchedAt).toISOString(),
      source: state.pool === RANKED_MATCH_POOL ? 'ranked_match' : 'quick_match',
      ...(state.pool === RANKED_MATCH_POOL ? { ranked: await this.ranked.stats(state.userId) } : {}),
    };
  }

  private async activeBattleStatus(battle: BattleNavigation, userId: string): Promise<MatchmakingStatus> {
    return {
      status: 'matched',
      pool: battle.mode === 'ranked' ? RANKED_MATCH_POOL : QUICK_MATCH_POOL,
      matchId: battle.matchmakingId,
      battleId: battle.id,
      roomCode: battle.roomCode,
      opponent: await this.opponent(battle.id, userId, undefined, battle.mode === 'ranked'),
      matchedAt: null,
      source: battle.mode === 'ranked' ? 'ranked_match' : battle.matchmakingPool ? 'quick_match' : 'active_battle',
      ...(battle.mode === 'ranked' ? { ranked: await this.ranked.stats(userId) } : {}),
    };
  }

  private async opponent(
    battleId: string,
    userId: string,
    fallbackUserId?: string,
    includeRanked = false,
  ): Promise<{ userId: string; username: string; ranked?: PublicRankedStats } | null> {
    const result = await this.dependencies.postgres.query<{ id: string; username: string }>(`
      SELECT u.id, u.username FROM battle_players bp
      JOIN users u ON u.id = bp.user_id
      WHERE bp.battle_id = $1 AND bp.user_id <> $2
      ORDER BY bp.joined_at, bp.id LIMIT 1
    `, [battleId, userId]);
    if (result.rows[0]) return this.publicOpponent(result.rows[0], includeRanked);
    if (!fallbackUserId) return null;
    const fallback = await this.dependencies.postgres.query<{ id: string; username: string }>(
      'SELECT id, username FROM users WHERE id = $1', [fallbackUserId],
    );
    return fallback.rows[0] ? this.publicOpponent(fallback.rows[0], includeRanked) : null;
  }

  private async loadActiveUsers(userIds: string[]): Promise<AuthUser[]> {
    const result = await this.dependencies.postgres.query<{
      id: string; username: string; email: string; created_at: Date;
      role: 'user' | 'admin'; account_status: 'active' | 'suspended';
    }>(`
      SELECT id, username, email, created_at, role, account_status
      FROM users WHERE id = ANY($1::bigint[]) AND account_status = 'active'
    `, [userIds]);
    return result.rows.map((row) => ({
      id: row.id,
      username: row.username,
      email: row.email,
      createdAt: row.created_at.toISOString(),
      role: row.role,
      accountStatus: row.account_status,
    }));
  }

  private async capacityAdmission(): Promise<{ allowed: boolean; available: number; pendingDemand: number }> {
    const [platform, demand] = await Promise.all([
      this.sandboxManager.getPlatformStatus(),
      this.dependencies.postgres.query<{ pending: number }>(`
        SELECT count(*)::int AS pending
        FROM battle_players bp
        JOIN battles b ON b.id = bp.battle_id
        WHERE b.matchmaking_pool IS NOT NULL
          AND b.status IN ('waiting', 'countdown', 'running')
          AND NOT EXISTS (
            SELECT 1 FROM sandbox_sessions ss
            WHERE ss.battle_player_id = bp.id
              AND ss.lifecycle_state = ANY($1::varchar[])
          )
      `, [LIVE_SANDBOX_STATES]),
    ]);
    const pendingDemand = demand.rows[0]?.pending ?? 0;
    const available = Math.max(0, platform.capacity.available - pendingDemand);
    return { allowed: platform.healthy && available >= 2, available, pendingDemand };
  }

  private async recoverPendingPairs(): Promise<void> {
    const claims = await this.store.listPairClaims();
    for (const claim of claims) {
      const battle = await this.battleManager.findMatchmakingBattle(claim.matchId);
      if (battle) {
        await this.store.commitMatch(claim, battle, Date.now(), this.config.MATCHMAKING_MATCH_TTL_SECONDS * 1_000);
        console.info('Matchmaking pair recovered', { matchId: claim.matchId, battleId: battle.id });
      } else {
        await this.store.rollbackPair(claim, { leaseMs: this.leaseMs() });
        console.warn('Matchmaking pair rolled back after restart', { matchId: claim.matchId });
      }
    }
  }

  private async cleanupInvalidQueueEntries(): Promise<void> {
    const userIds = [...new Set((await Promise.all([
      this.store.listQueuedUserIds(QUICK_MATCH_POOL),
      this.store.listQueuedUserIds(RANKED_MATCH_POOL),
    ])).flat())];
    if (!userIds.length) return;
    const valid = await this.dependencies.postgres.query<{ id: string }>(`
      SELECT u.id FROM users u
      WHERE u.id = ANY($1::bigint[]) AND u.account_status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM battle_players bp JOIN battles b ON b.id = bp.battle_id
          WHERE bp.user_id = u.id AND b.status IN ('waiting', 'countdown', 'running')
        )
    `, [userIds]);
    const validIds = new Set(valid.rows.map((row) => row.id));
    await Promise.all(userIds.filter((userId) => !validIds.has(userId)).map(async (userId) => {
      const state = await this.store.getState(userId);
      if (state) await this.store.cancel(userId, state.state.pool);
    }));
  }

  private async maintenance(): Promise<void> {
    for (const pool of [QUICK_MATCH_POOL, RANKED_MATCH_POOL] as const) {
      const expired = await this.store.sweepExpired(pool);
      if (expired) console.info('Matchmaking leases expired', { count: expired, pool });
    }
    await this.cleanupInvalidQueueEntries();
  }

  private leaseMs(): number { return this.config.MATCHMAKING_LEASE_SECONDS * 1_000; }

  private assertEnabled(): void {
    if (!this.config.MATCHMAKING_ENABLED) {
      throw new MatchmakingError('temporarily_unavailable', 'Quick Match временно недоступен.', 503);
    }
  }

  private async idleStatus(userId: string, pool: MatchmakingPool): Promise<MatchmakingStatus> {
    return {
      status: 'idle',
      pool,
      ...(pool === RANKED_MATCH_POOL ? { ranked: await this.ranked.stats(userId) } : {}),
    };
  }

  private async publicOpponent(
    opponent: { id: string; username: string },
    includeRanked: boolean,
  ): Promise<{ userId: string; username: string; ranked?: PublicRankedStats }> {
    return {
      userId: opponent.id,
      username: opponent.username,
      ...(includeRanked ? { ranked: await this.ranked.stats(opponent.id) } : {}),
    };
  }
}

function activeBattleError(battle: BattleNavigation): MatchmakingError {
  return new MatchmakingError(
    'active_battle',
    'У вас уже есть активный Battle.',
    409,
    { battleId: battle.id, roomCode: battle.roomCode },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : 'unknown';
}
