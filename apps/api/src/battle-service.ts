import { randomInt, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { RawData, WebSocket } from 'ws';
import type { AuthUser } from './auth-service.js';
import type { BattleRoundCompletion, BattleSandboxHooks, BattleSandboxMetadata } from './battle-types.js';
import type { AppConfig } from './config.js';
import { RankedService, type PublicRankedStats, type RankedApplication, type RankedBattleResult } from './ranked-service.js';
import type { SandboxManager, SessionTicket } from './sandbox-manager.js';
import type { Dependencies } from './services.js';
import { listBattleEligibleChallenges } from './challenge-library-v2/catalog.js';
import {
  createBattleChallengeSnapshot,
  parseBattleChallengeSnapshot,
  type BattleChallengeSnapshot,
  type ChallengeV2,
} from './challenge-library-v2/model.js';
import { selectBattleChallengeDefinitions } from './challenge-library-v2/selection.js';

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

interface BattleRow {
  id: string;
  room_code: string;
  status: 'waiting' | 'countdown' | 'running' | 'finished' | 'cancelled';
  host_user_id: string;
  category_id: number | null;
  category_slug: string | null;
  category_name: string | null;
  round_count: number;
  challenge_ids: string[];
  countdown_start_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  winner_user_id: string | null;
  matchmaking_id: string | null;
  matchmaking_pool: string | null;
  mode: 'private' | 'quick' | 'ranked';
  created_at: Date;
  expires_at: Date;
}

interface PlayerRow {
  id: string;
  battle_id: string;
  user_id: string;
  username: string;
  ready: boolean;
  connected: boolean;
  sandbox_ready: boolean;
  current_round: number;
  completed_rounds: number;
  joined_at: Date;
  disconnected_at: Date | null;
  finished_at: Date | null;
  result: 'win' | 'loss' | 'dnf' | null;
}

interface CurrentChallengeRow {
  id: string;
  slug: string;
  title: string;
  description: string;
  difficulty: string;
  category_slug: string;
  category_name: string;
  validation_config: Record<string, unknown>;
  challenge_version?: number;
  definition_hash?: string;
  tier?: string;
  concepts?: string[];
}

interface SelectedBattleChallenge {
  databaseId: string;
  definition: ChallengeV2;
  snapshot: BattleChallengeSnapshot;
}

export class BattleStateError extends Error {
  constructor(message: string, readonly statusCode = 409) {
    super(message);
  }
}

export interface BattleNavigation {
  id: string;
  roomCode: string;
  status: BattleRow['status'];
  matchmakingId: string | null;
  matchmakingPool: string | null;
  mode: BattleRow['mode'];
}

export class BattleAdmissionError extends BattleStateError {
  constructor(
    readonly code: 'active_battle' | 'user_unavailable',
    readonly userId: string,
    message: string,
    readonly battle: BattleNavigation | null = null,
  ) {
    super(message, 409);
  }
}

export class BattleManager implements BattleSandboxHooks {
  private readonly sockets = new Map<string, Map<string, Set<WebSocket>>>();
  private readonly countdownTimers = new Map<string, NodeJS.Timeout>();
  private readonly disconnectTimers = new Map<string, NodeJS.Timeout>();
  private cleanupTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly dependencies: Dependencies,
    private readonly sandboxManager: SandboxManager,
    private readonly rankedService = new RankedService(dependencies),
  ) {}

  async start(): Promise<void> {
    await this.dependencies.postgres.query('UPDATE battle_players SET connected = false, disconnected_at = now() WHERE connected');
    const countdowns = await this.dependencies.postgres.query<{ id: string; countdown_start_at: Date }>(`
      SELECT id, countdown_start_at FROM battles
      WHERE status = 'countdown' AND countdown_start_at IS NOT NULL
    `);
    for (const battle of countdowns.rows) this.scheduleCountdown(battle.id, battle.countdown_start_at);
    const disconnected = await this.dependencies.postgres.query<{ battle_id: string; user_id: string; disconnected_at: Date }>(`
      SELECT bp.battle_id, bp.user_id, bp.disconnected_at
      FROM battle_players bp JOIN battles b ON b.id = bp.battle_id
      WHERE b.status = 'running' AND NOT bp.connected AND bp.disconnected_at IS NOT NULL
    `);
    for (const player of disconnected.rows) {
      this.scheduleDisconnectResolution(player.battle_id, player.user_id, player.disconnected_at);
    }
    const recovered = await this.rankedService.recover();
    if (recovered.applied || recovered.noContest) {
      console.info('Ranked result recovery completed', recovered);
    }
    this.cleanupTimer = setInterval(() => void this.cleanupExpiredBattles(), 60_000);
    this.cleanupTimer.unref();
  }

  async close(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    for (const timer of this.countdownTimers.values()) clearTimeout(timer);
    for (const timer of this.disconnectTimers.values()) clearTimeout(timer);
    this.countdownTimers.clear();
    this.disconnectTimers.clear();
    for (const battleSockets of this.sockets.values()) {
      for (const userSockets of battleSockets.values()) {
        for (const socket of userSockets) socket.close(1001, 'server_shutdown');
      }
    }
    this.sockets.clear();
  }

  async terminateBattle(battleId: string): Promise<boolean> {
    const result = await this.dependencies.postgres.query<{ id: string }>(`
      UPDATE battles
      SET status = 'cancelled', finished_at = now(), updated_at = now()
      WHERE id = $1 AND status IN ('waiting', 'countdown', 'running')
      RETURNING id
    `, [battleId]);
    if (!result.rows[0]) return false;
    const timer = this.countdownTimers.get(battleId);
    if (timer) clearTimeout(timer);
    this.countdownTimers.delete(battleId);
    await this.broadcast(battleId, 'match:finished', { cancelled: true, reason: 'admin_terminated' });
    const ranked = await this.rankedService.recordNoContest(battleId, 'admin_terminated');
    this.logRankedApplication(ranked);
    await this.sandboxManager.destroyBattleSessions(battleId, 'battle_admin_terminated');
    return true;
  }

  async options(): Promise<{ categories: Array<{ slug: string; name: string; challengeCount: number }> }> {
    const result = await this.dependencies.postgres.query<{ slug: string; name: string; challenge_count: number }>(`
      SELECT categories.slug, categories.name, count(challenges.id)::int AS challenge_count
      FROM categories
      JOIN challenges ON challenges.category_id = categories.id
        AND challenges.enabled AND challenges.type = 'real_shell'
        AND challenges.validation_config->>'libraryVersion' = '2'
        AND COALESCE((challenges.validation_config->'battleEligible'->>'private')::boolean, false)
      WHERE categories.enabled
      GROUP BY categories.id
      HAVING count(challenges.id) >= 3
      ORDER BY categories.sort_order, categories.name
    `);
    return {
      categories: result.rows.map((row) => ({
        slug: row.slug,
        name: row.name,
        challengeCount: row.challenge_count,
      })),
    };
  }

  async findActiveBattleForUser(userId: string): Promise<BattleNavigation | null> {
    const result = await this.dependencies.postgres.query<BattleRow>(`
      SELECT b.* FROM battles b
      JOIN battle_players bp ON bp.battle_id = b.id
      WHERE bp.user_id = $1 AND b.status IN ('waiting', 'countdown', 'running')
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT 1
    `, [userId]);
    return result.rows[0] ? toBattleNavigation(result.rows[0]) : null;
  }

  async findMatchmakingBattle(matchmakingId: string): Promise<BattleNavigation | null> {
    const result = await this.dependencies.postgres.query<BattleRow>(`
      SELECT * FROM battles WHERE matchmaking_id = $1 LIMIT 1
    `, [matchmakingId]);
    return result.rows[0] ? toBattleNavigation(result.rows[0]) : null;
  }

  async createBattle(user: AuthUser, rounds: 3 | 5 | 10, categorySlug: string): Promise<unknown> {
    const client = await this.dependencies.postgres.connect();
    try {
      await client.query('BEGIN');
      await this.lockBattleUsers(client, [user.id]);
      await this.assertUsersActive(client, [user.id]);
      await this.assertNoActiveBattle(client, user.id);
      const selection = await this.selectBattleChallenges(client, rounds, categorySlug, 'private', [user.id]);
      const expiresAt = new Date(Date.now() + this.config.BATTLE_WAITING_TTL_SECONDS * 1_000);
      const battle = await this.insertBattle(client, {
        hostUserId: user.id,
        rounds,
        categoryId: selection.categoryId,
        challenges: selection.challenges,
        expiresAt,
        mode: 'private',
      });
      await client.query(`
        INSERT INTO battle_players (id, battle_id, user_id)
        VALUES ($1, $2, $3)
      `, [randomUUID(), battle.id, user.id]);
      await client.query('COMMIT');
      return this.loadState(battle.roomCode, user.id);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async createMatchmakingBattle(
    matchmakingId: string,
    pool: string,
    first: AuthUser,
    second: AuthUser,
  ): Promise<BattleNavigation> {
    if (first.id === second.id) throw new BattleStateError('Нельзя создать Battle с самим собой.', 409);
    const client = await this.dependencies.postgres.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('clirace:match:' || $1::text, 0))", [matchmakingId]);
      const existing = await client.query<BattleRow>('SELECT * FROM battles WHERE matchmaking_id = $1', [matchmakingId]);
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return toBattleNavigation(existing.rows[0]);
      }

      const users = [first.id, second.id].sort((left, right) => BigInt(left) < BigInt(right) ? -1 : 1);
      await this.lockBattleUsers(client, users);
      await this.assertUsersActive(client, users);
      await this.assertNoActiveBattle(client, first.id);
      await this.assertNoActiveBattle(client, second.id);
      const battleMode = pool === 'ranked' ? 'ranked' : 'quick';
      const selection = await this.selectBattleChallenges(client, 3, 'all', battleMode, [first.id, second.id]);
      const battle = await this.insertBattle(client, {
        hostUserId: first.id,
        rounds: 3,
        categoryId: selection.categoryId,
        challenges: selection.challenges,
        expiresAt: new Date(Date.now() + this.config.MATCHMAKING_BATTLE_WAITING_TTL_SECONDS * 1_000),
        matchmakingId,
        matchmakingPool: pool,
        mode: battleMode,
      });
      await client.query(`
        INSERT INTO battle_players (id, battle_id, user_id)
        VALUES ($1, $3, $4), ($2, $3, $5)
      `, [randomUUID(), randomUUID(), battle.id, first.id, second.id]);
      await client.query('COMMIT');
      return {
        id: battle.id,
        roomCode: battle.roomCode,
        status: 'waiting',
        matchmakingId,
        matchmakingPool: pool,
        mode: pool === 'ranked' ? 'ranked' : 'quick',
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async joinBattle(roomCode: string, user: AuthUser): Promise<unknown> {
    const client = await this.dependencies.postgres.connect();
    let battleId: string | undefined;
    let joined = false;
    try {
      await client.query('BEGIN');
      const battle = await this.lockBattleByCode(client, roomCode);
      if (!battle) throw new BattleStateError('Комната не найдена.', 404);
      battleId = battle.id;
      const existing = await client.query('SELECT id FROM battle_players WHERE battle_id = $1 AND user_id = $2', [battle.id, user.id]);
      if (existing.rowCount === 0) {
        await this.lockBattleUsers(client, [user.id]);
        await this.assertUsersActive(client, [user.id]);
        await this.assertNoActiveBattle(client, user.id, battle.id);
        if (battle.status !== 'waiting') throw new BattleStateError('Матч уже начался.', 409);
        const count = await client.query<{ count: number }>('SELECT count(*)::int AS count FROM battle_players WHERE battle_id = $1', [battle.id]);
        if ((count.rows[0]?.count ?? 0) >= 2) throw new BattleStateError('Комната уже заполнена.', 409);
        await client.query('INSERT INTO battle_players (id, battle_id, user_id) VALUES ($1, $2, $3)', [randomUUID(), battle.id, user.id]);
        joined = true;
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    if (joined && battleId) await this.broadcast(battleId, 'player:joined', { userId: user.id, username: user.username });
    return this.loadState(roomCode, user.id);
  }

  async loadState(roomCode: string, viewerUserId: string): Promise<unknown> {
    const battle = await this.findBattle(roomCode);
    if (!battle) throw new BattleStateError('Комната не найдена.', 404);
    const players = await this.loadPlayers(battle.id);
    const viewer = players.find((player) => player.user_id === viewerUserId);
    const challenge = viewer && battle.status !== 'finished' && battle.status !== 'cancelled'
      ? await this.loadChallenge(battle.id, viewer.current_round, battle.challenge_ids[viewer.current_round - 1])
      : undefined;
    const results = battle.status === 'finished' ? await this.loadResults(battle.id, players) : undefined;
    const rankedResult = battle.mode === 'ranked' && ['finished', 'cancelled'].includes(battle.status)
      ? await this.rankedService.getBattleResult(battle.id)
      : null;
    const rankedStats = battle.mode === 'ranked' && viewer
      ? await this.rankedService.stats(viewer.user_id)
      : null;
    return publicBattleState(battle, players, viewer, challenge, results, rankedResult, rankedStats);
  }

  async setReady(roomCode: string, userId: string, ready: boolean): Promise<void> {
    const client = await this.dependencies.postgres.connect();
    let battleId: string | undefined;
    try {
      await client.query('BEGIN');
      const battle = await this.lockBattleByCode(client, roomCode);
      if (!battle) throw new BattleStateError('Комната не найдена.', 404);
      if (battle.status !== 'waiting') throw new BattleStateError('Готовность уже зафиксирована: матч запускается.', 409);
      battleId = battle.id;
      const updated = await client.query(`
        UPDATE battle_players SET ready = $1, sandbox_ready = CASE WHEN $1 THEN sandbox_ready ELSE false END
        WHERE battle_id = $2 AND user_id = $3 RETURNING id
      `, [ready, battle.id, userId]);
      if (updated.rowCount === 0) throw new BattleStateError('Вы не участвуете в этой комнате.', 403);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    if (battleId) await this.broadcast(battleId, 'player:ready', { userId, ready });
  }

  async createTerminalTicket(roomCode: string, userId: string): Promise<SessionTicket> {
    const result = await this.dependencies.postgres.query<{
      battle_id: string; status: BattleRow['status']; round_count: number;
      player_id: string; current_round: number; completed_rounds: number; ready: boolean;
      challenge_id: string; validation_config: Record<string, unknown>;
      canonical_challenge_id: string | null; challenge_version: number | null;
      definition_hash: string | null; definition_snapshot: unknown | null;
    }>(`
      SELECT b.id AS battle_id, b.status, b.round_count,
             bp.id AS player_id, bp.current_round, bp.completed_rounds, bp.ready,
             c.id AS challenge_id, c.validation_config,
             bcp.canonical_challenge_id, bcp.challenge_version,
             bcp.definition_hash, bcp.definition_snapshot
      FROM battles b
      JOIN battle_players bp ON bp.battle_id = b.id AND bp.user_id = $2
      JOIN challenges c ON c.id = b.challenge_ids[bp.current_round]
      LEFT JOIN battle_challenge_pins bcp
        ON bcp.battle_id=b.id AND bcp.round_number=bp.current_round AND bcp.challenge_id=c.id
      WHERE b.room_code = $1
    `, [roomCode, userId]);
    const row = result.rows[0];
    if (!row) throw new BattleStateError('Активный раунд не найден.', 404);
    if (!['waiting', 'countdown', 'running'].includes(row.status) || row.completed_rounds >= row.round_count) {
      throw new BattleStateError('Battle уже завершён.', 409);
    }
    if (!row.ready) throw new BattleStateError('Сначала нажмите Ready.', 409);
    if (row.status === 'waiting') {
      const readiness = await this.dependencies.postgres.query<{ ready: number }>(`
        SELECT count(*) FILTER (WHERE ready AND connected)::int AS ready
        FROM battle_players WHERE battle_id = $1
      `, [row.battle_id]);
      if ((readiness.rows[0]?.ready ?? 0) !== 2) throw new BattleStateError('Ждём Ready второго игрока.', 409);
    }
    const pinned = row.definition_snapshot ? parseBattleChallengeSnapshot(row.definition_snapshot) : undefined;
    const sandboxChallengeId = pinned?.id ?? row.validation_config.sandboxChallengeId;
    if (typeof sandboxChallengeId !== 'string') throw new BattleStateError('Для задания не настроен sandbox.', 500);
    return this.sandboxManager.createTicket({
      userId,
      battle: {
        battleId: row.battle_id,
        battlePlayerId: row.player_id,
        roomCode,
        roundNumber: row.current_round,
        challengeId: row.challenge_id,
        sandboxChallengeId,
        ...(pinned ? {
          challengeVersion: pinned.version,
          definitionHash: pinned.definitionHash,
          challengeSnapshot: pinned,
        } : {}),
        inputLocked: row.status !== 'running',
      },
    });
  }

  async connect(roomCode: string, user: AuthUser, socket: WebSocket): Promise<void> {
    const battle = await this.findBattle(roomCode);
    if (!battle) throw new BattleStateError('Комната не найдена.', 404);
    const player = await this.dependencies.postgres.query<{ id: string }>(
      'SELECT id FROM battle_players WHERE battle_id = $1 AND user_id = $2', [battle.id, user.id],
    );
    if (!player.rows[0]) throw new BattleStateError('Сначала войдите в комнату.', 403);

    const battleSockets = this.sockets.get(battle.id) ?? new Map<string, Set<WebSocket>>();
    const userSockets = battleSockets.get(user.id) ?? new Set<WebSocket>();
    userSockets.add(socket);
    battleSockets.set(user.id, userSockets);
    this.sockets.set(battle.id, battleSockets);
    const disconnectKey = `${battle.id}:${user.id}`;
    const disconnectTimer = this.disconnectTimers.get(disconnectKey);
    if (disconnectTimer) clearTimeout(disconnectTimer);
    this.disconnectTimers.delete(disconnectKey);
    await this.dependencies.postgres.query(`
      UPDATE battle_players SET connected = true, disconnected_at = NULL
      WHERE battle_id = $1 AND user_id = $2
    `, [battle.id, user.id]);

    socket.on('message', (raw) => void this.handleSocketMessage(roomCode, user, socket, raw));
    socket.once('close', () => void this.disconnectSocket(battle.id, user.id, socket));
    socket.once('error', () => void this.disconnectSocket(battle.id, user.id, socket));
    await this.broadcast(battle.id, 'player:reconnected', { userId: user.id });
  }

  async onBattleSandboxReady(metadata: BattleSandboxMetadata): Promise<void> {
    const client = await this.dependencies.postgres.connect();
    let countdownAt: Date | undefined;
    let runningRound = false;
    try {
      await client.query('BEGIN');
      const battleResult = await client.query<BattleRow>('SELECT * FROM battles WHERE id = $1 FOR UPDATE', [metadata.battleId]);
      const battle = battleResult.rows[0];
      if (!battle || !['waiting', 'countdown', 'running'].includes(battle.status)) {
        throw new BattleStateError('Battle больше не активен.');
      }
      const player = await client.query<PlayerRow>(`
        SELECT bp.*, u.username FROM battle_players bp JOIN users u ON u.id = bp.user_id
        WHERE bp.id = $1 AND bp.battle_id = $2 FOR UPDATE OF bp
      `, [metadata.battlePlayerId, metadata.battleId]);
      const row = player.rows[0];
      if (!row || row.current_round !== metadata.roundNumber || battle.challenge_ids[row.current_round - 1] !== metadata.challengeId) {
        throw new BattleStateError('Раунд игрока уже изменился.');
      }
      await client.query('UPDATE battle_players SET sandbox_ready = true WHERE id = $1', [row.id]);

      if (battle.status === 'running') {
        runningRound = true;
        await this.ensureRound(client, battle.id, row.id, metadata.challengeId, metadata.roundNumber, new Date());
      } else if (battle.status === 'waiting') {
        const ready = await client.query<{ total: number; ready: number }>(`
          SELECT count(*)::int AS total,
                 count(*) FILTER (WHERE ready AND connected AND sandbox_ready)::int AS ready
          FROM battle_players WHERE battle_id = $1
        `, [battle.id]);
        if (ready.rows[0]?.total === 2 && ready.rows[0]?.ready === 2) {
          countdownAt = new Date(Date.now() + this.config.BATTLE_COUNTDOWN_MS);
          const expiresAt = new Date(countdownAt.getTime() + this.config.BATTLE_MAX_LIFETIME_SECONDS * 1_000);
          await client.query(`
            UPDATE battles SET status = 'countdown', countdown_start_at = $1, expires_at = $2, updated_at = now()
            WHERE id = $3 AND status = 'waiting'
          `, [countdownAt, expiresAt, battle.id]);
          const players = await client.query<{ id: string; current_round: number }>('SELECT id, current_round FROM battle_players WHERE battle_id = $1', [battle.id]);
          for (const battlePlayer of players.rows) {
            const challengeId = battle.challenge_ids[battlePlayer.current_round - 1]!;
            await this.ensureRound(client, battle.id, battlePlayer.id, challengeId, battlePlayer.current_round, countdownAt);
          }
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    if (countdownAt) {
      await this.broadcast(metadata.battleId, 'countdown:start', { startAt: countdownAt.toISOString() });
      this.scheduleCountdown(metadata.battleId, countdownAt);
    } else {
      await this.broadcast(metadata.battleId, runningRound ? 'round:start' : 'battle:state', {
        userId: undefined, round: metadata.roundNumber,
      });
    }
  }

  async onBattleRoundCompleted(metadata: BattleSandboxMetadata, userId: string): Promise<BattleRoundCompletion> {
    const client = await this.dependencies.postgres.connect();
    let completion: BattleRoundCompletion | undefined;
    let eventBattleFinished = false;
    let rankedApplication: RankedApplication | undefined;
    try {
      await client.query('BEGIN');
      const battle = await client.query<BattleRow>('SELECT * FROM battles WHERE id = $1 FOR UPDATE', [metadata.battleId]).then((result) => result.rows[0]);
      const player = await client.query<PlayerRow>(`
        SELECT bp.*, u.username FROM battle_players bp JOIN users u ON u.id = bp.user_id
        WHERE bp.id = $1 AND bp.user_id = $2 FOR UPDATE OF bp
      `, [metadata.battlePlayerId, userId]).then((result) => result.rows[0]);
      if (!battle || !player) throw new BattleStateError('Battle player не найден.', 404);
      if (metadata.roundNumber !== player.current_round || battle.challenge_ids[metadata.roundNumber - 1] !== metadata.challengeId) {
        const existing = await client.query<{ success: boolean }>('SELECT success FROM battle_rounds WHERE player_id = $1 AND round_number = $2', [player.id, metadata.roundNumber]);
        if (existing.rows[0]?.success) {
          await client.query('ROLLBACK');
          return {
            roundCompleted: false,
            battleFinished: battle.status === 'finished',
            currentRound: player.current_round,
            completedRounds: player.completed_rounds,
            winnerUserId: battle.winner_user_id,
          };
        }
        throw new BattleStateError('Раунд уже изменился.');
      }
      const round = await client.query<{ id: string; started_at: Date | null; success: boolean | null }>(`
        SELECT id, started_at, success FROM battle_rounds
        WHERE player_id = $1 AND round_number = $2 FOR UPDATE
      `, [player.id, metadata.roundNumber]).then((result) => result.rows[0]);
      if (round?.success) {
        await client.query('ROLLBACK');
        return {
          roundCompleted: false,
          battleFinished: battle.status === 'finished',
          currentRound: player.current_round,
          completedRounds: player.completed_rounds,
          winnerUserId: battle.winner_user_id,
        };
      }
      const completedAt = new Date();
      const startedAt = round?.started_at ?? completedAt;
      const durationMs = Math.max(0, Math.min(2_147_483_647, completedAt.getTime() - startedAt.getTime()));
      if (round) {
        await client.query(`UPDATE battle_rounds SET started_at = $1, completed_at = $2, duration_ms = $3, success = true WHERE id = $4`, [startedAt, completedAt, durationMs, round.id]);
      } else {
        await client.query(`
          INSERT INTO battle_rounds (battle_id, player_id, challenge_id, round_number, started_at, completed_at, duration_ms, success)
          VALUES ($1, $2, $3, $4, $5, $6, $7, true)
        `, [battle.id, player.id, metadata.challengeId, metadata.roundNumber, startedAt, completedAt, durationMs]);
      }

      const completedRounds = Math.max(player.completed_rounds, metadata.roundNumber);
      let currentRound = player.current_round;
      if (completedRounds >= battle.round_count) {
        if (battle.status === 'running') {
          eventBattleFinished = true;
          battle.status = 'finished';
          battle.winner_user_id = userId;
          await client.query(`
            UPDATE battles SET status = 'finished', winner_user_id = $1, finished_at = $2, updated_at = now()
            WHERE id = $3
          `, [userId, completedAt, battle.id]);
          rankedApplication = await this.rankedService.applyFinishedBattle(client, battle.id);
          await client.query(`
            UPDATE battle_players
            SET result = CASE WHEN user_id = $1 THEN 'win' ELSE 'loss' END,
                finished_at = COALESCE(finished_at, $2), sandbox_ready = false
            WHERE battle_id = $3
          `, [userId, completedAt, battle.id]);
        } else if (battle.status === 'finished') {
          await client.query(`
            UPDATE battle_players SET completed_rounds = $1,
              result = CASE WHEN user_id = $2 THEN 'win' ELSE 'loss' END,
              finished_at = COALESCE(finished_at, $3), sandbox_ready = false
            WHERE id = $4
          `, [completedRounds, battle.winner_user_id, completedAt, player.id]);
        }
      } else {
        currentRound = completedRounds + 1;
        await client.query(`
          UPDATE battle_players SET completed_rounds = $1, current_round = $2, sandbox_ready = false
          WHERE id = $3
        `, [completedRounds, currentRound, player.id]);
      }
      if (completedRounds >= battle.round_count) {
        await client.query('UPDATE battle_players SET completed_rounds = $1 WHERE id = $2', [completedRounds, player.id]);
      }
      await client.query('COMMIT');
      completion = {
        roundCompleted: true,
        battleFinished: battle.status === 'finished',
        currentRound,
        completedRounds,
        winnerUserId: battle.winner_user_id,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    await this.broadcast(metadata.battleId, 'round:completed', {
      userId, round: metadata.roundNumber, completedRounds: completion.completedRounds,
    });
    if (eventBattleFinished) {
      if (rankedApplication) this.logRankedApplication(rankedApplication);
      await this.broadcast(metadata.battleId, 'match:finished', { winnerUserId: completion.winnerUserId });
      setTimeout(() => void this.sandboxManager.destroyBattleSessions(metadata.battleId, 'battle_finished'), 750).unref();
    }
    return completion;
  }

  private async handleSocketMessage(roomCode: string, user: AuthUser, socket: WebSocket, raw: RawData): Promise<void> {
    if (Buffer.byteLength(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer)) > 4_096) {
      socket.close(1009, 'message_too_large');
      return;
    }
    try {
      const parsed = JSON.parse(raw.toString()) as { type?: string; ready?: boolean };
      if (parsed.type === 'player:ready' && typeof parsed.ready === 'boolean') {
        await this.setReady(roomCode, user.id, parsed.ready);
      } else if (parsed.type === 'battle:state') {
        const state = await this.loadState(roomCode, user.id);
        safeSend(socket, { type: 'battle:state', state });
      }
    } catch (error) {
      safeSend(socket, {
        type: 'battle:error',
        message: error instanceof Error ? error.message : 'Некорректное действие.',
      });
    }
  }

  private async disconnectSocket(battleId: string, userId: string, socket: WebSocket): Promise<void> {
    const battleSockets = this.sockets.get(battleId);
    const userSockets = battleSockets?.get(userId);
    if (!userSockets?.delete(socket)) return;
    if (userSockets.size > 0) return;
    battleSockets?.delete(userId);
    if (battleSockets?.size === 0) this.sockets.delete(battleId);
    await this.dependencies.postgres.query(`
      UPDATE battle_players SET connected = false, disconnected_at = now()
      WHERE battle_id = $1 AND user_id = $2
    `, [battleId, userId]);
    await this.broadcast(battleId, 'player:left', { userId });
    this.scheduleDisconnectResolution(battleId, userId, new Date());
  }

  private scheduleDisconnectResolution(battleId: string, userId: string, disconnectedAt: Date): void {
    const key = `${battleId}:${userId}`;
    const previous = this.disconnectTimers.get(key);
    if (previous) clearTimeout(previous);
    const dueAt = disconnectedAt.getTime() + this.config.BATTLE_RECONNECT_GRACE_SECONDS * 1_000;
    const timer = setTimeout(() => void this.resolveDisconnect(battleId, userId), Math.max(0, dueAt - Date.now()));
    timer.unref();
    this.disconnectTimers.set(key, timer);
  }

  private async resolveDisconnect(battleId: string, userId: string): Promise<void> {
    this.disconnectTimers.delete(`${battleId}:${userId}`);
    const client = await this.dependencies.postgres.connect();
    let outcome: 'forfeit' | 'no_contest' | null = null;
    let winnerUserId: string | null = null;
    let rankedApplication: RankedApplication | undefined;
    try {
      await client.query('BEGIN');
      const battle = await client.query<BattleRow>('SELECT * FROM battles WHERE id = $1 FOR UPDATE', [battleId])
        .then((result) => result.rows[0]);
      if (!battle || battle.status !== 'running') {
        await client.query('ROLLBACK');
        return;
      }
      const players = await client.query<PlayerRow>(`
        SELECT bp.*, u.username FROM battle_players bp JOIN users u ON u.id = bp.user_id
        WHERE bp.battle_id = $1 ORDER BY bp.user_id FOR UPDATE OF bp
      `, [battleId]);
      const disconnected = players.rows.find((player) => player.user_id === userId);
      if (!disconnected || disconnected.connected || !disconnected.disconnected_at
        || Date.now() - disconnected.disconnected_at.getTime() < this.config.BATTLE_RECONNECT_GRACE_SECONDS * 1_000) {
        await client.query('ROLLBACK');
        return;
      }
      const opponent = players.rows.find((player) => player.user_id !== userId);
      if (!opponent?.connected) {
        outcome = 'no_contest';
        await client.query(`
          UPDATE battles SET status = 'cancelled', finished_at = now(), updated_at = now()
          WHERE id = $1
        `, [battleId]);
      } else {
        outcome = 'forfeit';
        winnerUserId = opponent.user_id;
        await client.query(`
          UPDATE battles SET status = 'finished', winner_user_id = $2, finished_at = now(), updated_at = now()
          WHERE id = $1
        `, [battleId, winnerUserId]);
        await client.query(`
          UPDATE battle_players
          SET result = CASE WHEN user_id = $2 THEN 'win' ELSE 'dnf' END,
              finished_at = COALESCE(finished_at, now()), sandbox_ready = false
          WHERE battle_id = $1
        `, [battleId, winnerUserId]);
        rankedApplication = await this.rankedService.applyFinishedBattle(client, battleId);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      console.error('Battle disconnect resolution failed', { battleId, userId, reason: errorMessage(error) });
      return;
    } finally {
      client.release();
    }
    if (outcome === 'no_contest') {
      rankedApplication = await this.rankedService.recordNoContest(battleId, 'both_players_disconnected');
    }
    if (rankedApplication) this.logRankedApplication(rankedApplication);
    await this.broadcast(battleId, 'match:finished', {
      ...(winnerUserId ? { winnerUserId, reason: 'forfeit' } : { cancelled: true, reason: 'no_contest' }),
    });
    await this.sandboxManager.destroyBattleSessions(battleId, outcome === 'forfeit' ? 'battle_forfeit' : 'battle_no_contest');
  }

  private async broadcast(battleId: string, type: string, data?: Record<string, unknown>): Promise<void> {
    const battleSockets = this.sockets.get(battleId);
    if (!battleSockets?.size) return;
    const room = await this.dependencies.postgres.query<{ room_code: string }>('SELECT room_code FROM battles WHERE id = $1', [battleId]);
    const roomCode = room.rows[0]?.room_code;
    if (!roomCode) return;
    for (const [userId, sockets] of battleSockets.entries()) {
      let state: unknown;
      try { state = await this.loadState(roomCode, userId); } catch { continue; }
      for (const socket of sockets) {
        if (type !== 'battle:state') safeSend(socket, { type, ...(data ?? {}) });
        safeSend(socket, { type: 'battle:state', state });
      }
    }
  }

  private scheduleCountdown(battleId: string, startsAt: Date): void {
    const previous = this.countdownTimers.get(battleId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => void this.startMatch(battleId), Math.max(0, startsAt.getTime() - Date.now()));
    timer.unref();
    this.countdownTimers.set(battleId, timer);
  }

  private async startMatch(battleId: string): Promise<void> {
    this.countdownTimers.delete(battleId);
    const result = await this.dependencies.postgres.query<{ started_at: Date }>(`
      UPDATE battles
      SET status = 'running', started_at = countdown_start_at, updated_at = now()
      WHERE id = $1 AND status = 'countdown' AND countdown_start_at <= now()
      RETURNING started_at
    `, [battleId]);
    if (!result.rows[0]) return;
    await this.dependencies.postgres.query(`
      UPDATE battle_rounds SET started_at = COALESCE(started_at, $2)
      WHERE battle_id = $1 AND round_number = 1
    `, [battleId, result.rows[0].started_at]);
    this.sandboxManager.unlockBattle(battleId);
    await this.broadcast(battleId, 'match:start', { startedAt: result.rows[0].started_at.toISOString() });
  }

  private async cleanupExpiredBattles(): Promise<void> {
    const expired = await this.dependencies.postgres.query<{ id: string }>(`
      UPDATE battles SET status = 'cancelled', finished_at = now(), updated_at = now()
      WHERE status IN ('waiting', 'countdown', 'running') AND expires_at <= now()
      RETURNING id
    `);
    for (const battle of expired.rows) {
      await this.broadcast(battle.id, 'match:finished', { cancelled: true });
      const ranked = await this.rankedService.recordNoContest(battle.id, 'battle_expired');
      this.logRankedApplication(ranked);
      await this.sandboxManager.destroyBattleSessions(battle.id, 'battle_expired');
    }
  }

  private async lockBattleUsers(client: PoolClient, userIds: string[]): Promise<void> {
    for (const userId of userIds) {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('clirace:battle:user:' || $1::text, 0))",
        [userId],
      );
    }
  }

  private async assertUsersActive(client: PoolClient, userIds: string[]): Promise<void> {
    const result = await client.query<{ id: string; account_status: 'active' | 'suspended' }>(`
      SELECT id, account_status FROM users
      WHERE id = ANY($1::bigint[])
      ORDER BY id
      FOR UPDATE
    `, [userIds]);
    for (const userId of userIds) {
      const user = result.rows.find((row) => row.id === userId);
      if (!user || user.account_status !== 'active') {
        throw new BattleAdmissionError('user_unavailable', userId, 'Пользователь больше не может участвовать в Battle.');
      }
    }
  }

  private async assertNoActiveBattle(client: PoolClient, userId: string, allowedBattleId?: string): Promise<void> {
    const result = await client.query<BattleRow>(`
      SELECT b.* FROM battles b
      JOIN battle_players bp ON bp.battle_id = b.id
      WHERE bp.user_id = $1
        AND b.status IN ('waiting', 'countdown', 'running')
        AND ($2::uuid IS NULL OR b.id <> $2)
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT 1
    `, [userId, allowedBattleId ?? null]);
    if (result.rows[0]) {
      throw new BattleAdmissionError(
        'active_battle',
        userId,
        'У пользователя уже есть активный Battle.',
        toBattleNavigation(result.rows[0]),
      );
    }
  }

  private async selectBattleChallenges(
    client: PoolClient,
    rounds: 3 | 5 | 10,
    categorySlug: string,
    mode: 'private' | 'quick' | 'ranked',
    userIds: string[],
  ): Promise<{ categoryId: number | null; challenges: SelectedBattleChallenge[] }> {
    const category = categorySlug === 'all' ? null : await client.query<{ id: number }>(
      'SELECT id FROM categories WHERE slug = $1 AND enabled', [categorySlug],
    ).then((result) => result.rows[0] ?? null);
    if (categorySlug !== 'all' && !category) throw new BattleStateError('Категория не найдена.', 400);

    const eligibleDefinitions = listBattleEligibleChallenges(mode)
      .filter((challenge) => categorySlug === 'all' || challenge.category === categorySlug);
    const databaseRows = await client.query<{ id: string; slug: string }>(`
      SELECT id, slug FROM challenges
      WHERE enabled AND type='real_shell' AND slug=ANY($1::varchar[])
    `, [eligibleDefinitions.map((challenge) => challenge.id)]);
    const databaseIds = new Map(databaseRows.rows.map((row) => [row.slug, row.id]));
    const available = eligibleDefinitions.filter((challenge) => databaseIds.has(challenge.id));
    if (available.length < rounds) {
      throw new BattleStateError(`В этой категории пока меньше ${rounds} Shell-заданий. Выберите меньше раундов или все категории.`, 422);
    }

    const recent = await client.query<{ canonical_challenge_id: string }>(`
      SELECT DISTINCT recent.canonical_challenge_id FROM (
        SELECT bcp.canonical_challenge_id, b.created_at
        FROM battle_challenge_pins bcp
        JOIN battles b ON b.id=bcp.battle_id
        JOIN battle_players bp ON bp.battle_id=b.id
        WHERE bp.user_id=ANY($1::bigint[])
        ORDER BY b.created_at DESC
        LIMIT 40
      ) recent
    `, [userIds]);
    const recentIds = new Set(recent.rows.map((row) => row.canonical_challenge_id));
    const selected = selectBattleChallengeDefinitions({ available, rounds, recentIds });
    return {
      categoryId: category?.id ?? null,
      challenges: selected.map((definition) => ({
        databaseId: databaseIds.get(definition.id)!,
        definition,
        snapshot: createBattleChallengeSnapshot(definition),
      })),
    };
  }

  private async insertBattle(client: PoolClient, options: {
    hostUserId: string;
    rounds: 3 | 5 | 10;
    categoryId: number | null;
    challenges: SelectedBattleChallenge[];
    expiresAt: Date;
    matchmakingId?: string;
    matchmakingPool?: string;
    mode: BattleRow['mode'];
  }): Promise<{ id: string; roomCode: string }> {
    const battleId = randomUUID();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const candidate = generateRoomCode();
      const inserted = await client.query<{ room_code: string }>(`
        INSERT INTO battles (
          id, room_code, host_user_id, category_id, round_count, challenge_ids, expires_at,
          matchmaking_id, matchmaking_pool, mode
        ) VALUES ($1, $2, $3, $4, $5, $6::bigint[], $7, $8, $9, $10)
        ON CONFLICT (room_code) DO NOTHING
        RETURNING room_code
      `, [
        battleId,
        candidate,
        options.hostUserId,
        options.categoryId,
        options.rounds,
        options.challenges.map((challenge) => challenge.databaseId),
        options.expiresAt,
        options.matchmakingId ?? null,
        options.matchmakingPool ?? null,
        options.mode,
      ]);
      const roomCode = inserted.rows[0]?.room_code;
      if (roomCode) {
        for (const [index, challenge] of options.challenges.entries()) {
          await client.query(`
            INSERT INTO battle_challenge_pins (
              battle_id, round_number, challenge_id, canonical_challenge_id,
              challenge_version, definition_hash, definition_snapshot
            ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
          `, [
            battleId,
            index + 1,
            challenge.databaseId,
            challenge.definition.id,
            challenge.definition.version,
            challenge.snapshot.definitionHash,
            JSON.stringify(challenge.snapshot),
          ]);
        }
        return { id: battleId, roomCode };
      }
    }
    throw new BattleStateError('Не удалось создать уникальный код комнаты. Повторите попытку.', 503);
  }

  private async ensureRound(
    client: PoolClient,
    battleId: string,
    playerId: string,
    challengeId: string,
    roundNumber: number,
    startedAt: Date,
  ): Promise<void> {
    await client.query(`
      INSERT INTO battle_rounds (battle_id, player_id, challenge_id, round_number, started_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (player_id, round_number)
      DO UPDATE SET started_at = COALESCE(battle_rounds.started_at, EXCLUDED.started_at)
    `, [battleId, playerId, challengeId, roundNumber, startedAt]);
  }

  private async findBattle(roomCode: string): Promise<BattleRow | undefined> {
    const result = await this.dependencies.postgres.query<BattleRow>(`
      SELECT b.*, c.slug AS category_slug, c.name AS category_name
      FROM battles b LEFT JOIN categories c ON c.id = b.category_id
      WHERE b.room_code = $1
    `, [roomCode]);
    return result.rows[0];
  }

  private async lockBattleByCode(client: PoolClient, roomCode: string): Promise<BattleRow | undefined> {
    const result = await client.query<BattleRow>('SELECT * FROM battles WHERE room_code = $1 FOR UPDATE', [roomCode]);
    return result.rows[0];
  }

  private async loadPlayers(battleId: string): Promise<PlayerRow[]> {
    const result = await this.dependencies.postgres.query<PlayerRow>(`
      SELECT bp.*, u.username FROM battle_players bp
      JOIN users u ON u.id = bp.user_id
      WHERE bp.battle_id = $1 ORDER BY bp.joined_at, bp.id
    `, [battleId]);
    return result.rows;
  }

  private async loadChallenge(battleId: string, roundNumber: number, challengeId: string | undefined): Promise<CurrentChallengeRow | undefined> {
    if (!challengeId) return undefined;
    const pinned = await this.dependencies.postgres.query<{
      definition_snapshot: unknown; definition_hash: string; challenge_version: number;
      category_slug: string; category_name: string;
    }>(`
      SELECT bcp.definition_snapshot, bcp.definition_hash, bcp.challenge_version,
             categories.slug AS category_slug, categories.name AS category_name
      FROM battle_challenge_pins bcp
      JOIN challenges c ON c.id=bcp.challenge_id
      JOIN categories ON categories.id=c.category_id
      WHERE bcp.battle_id=$1 AND bcp.round_number=$2 AND bcp.challenge_id=$3
    `, [battleId, roundNumber, challengeId]);
    if (pinned.rows[0]) {
      const snapshot = parseBattleChallengeSnapshot(pinned.rows[0].definition_snapshot);
      return {
        id: challengeId,
        slug: snapshot.id,
        title: snapshot.title,
        description: snapshot.description,
        difficulty: snapshot.difficulty,
        category_slug: pinned.rows[0].category_slug,
        category_name: pinned.rows[0].category_name,
        validation_config: {},
        challenge_version: snapshot.version,
        definition_hash: snapshot.definitionHash,
        tier: snapshot.tier,
        concepts: snapshot.concepts,
      };
    }
    const result = await this.dependencies.postgres.query<CurrentChallengeRow>(`
      SELECT c.id, c.slug, c.title, c.description, c.difficulty, c.validation_config,
             categories.slug AS category_slug, categories.name AS category_name
      FROM challenges c JOIN categories ON categories.id = c.category_id
      WHERE c.id = $1
    `, [challengeId]);
    return result.rows[0];
  }

  private async loadResults(battleId: string, players: PlayerRow[]) {
    const result = await this.dependencies.postgres.query<{
      player_id: string; round_number: number; duration_ms: number | null; success: boolean | null;
    }>(`
      SELECT player_id, round_number, duration_ms, success
      FROM battle_rounds WHERE battle_id = $1 ORDER BY round_number, player_id
    `, [battleId]);
    return players.map((player) => ({
      userId: player.user_id,
      username: player.username,
      result: player.result,
      completedRounds: player.completed_rounds,
      rounds: result.rows.filter((round) => round.player_id === player.id).map((round) => ({
        round: round.round_number,
        durationMs: round.duration_ms,
        success: round.success === true,
      })),
    }));
  }

  private logRankedApplication(application: RankedApplication): void {
    if (!['applied', 'already_applied'].includes(application.status)) return;
    console.info('Ranked result application', {
      battleId: application.battleId,
      idempotencyResult: application.status,
      outcome: application.result?.outcome,
      noContestReason: application.result?.noContestReason,
      players: application.result?.players.map((player) => ({
        userId: player.userId,
        oldRating: player.mmrBefore,
        newRating: player.mmrAfter,
      })),
    });
  }
}

function publicBattleState(
  battle: BattleRow,
  players: PlayerRow[],
  viewer: PlayerRow | undefined,
  challenge: CurrentChallengeRow | undefined,
  results: unknown,
  rankedResult: RankedBattleResult | null,
  rankedStats: PublicRankedStats | null,
) {
  const preparing = battle.status === 'waiting'
    && players.length === 2
    && players.every((player) => player.ready && player.connected);
  return {
    id: battle.id,
    roomCode: battle.room_code,
    status: battle.status,
    roundCount: battle.round_count,
    category: battle.category_slug
      ? { slug: battle.category_slug, name: battle.category_name }
      : { slug: 'all', name: 'Все Shell' },
    hostUserId: battle.host_user_id,
    matchmakingPool: battle.matchmaking_pool,
    mode: battle.mode,
    winnerUserId: battle.winner_user_id,
    countdownStartAt: battle.countdown_start_at?.toISOString() ?? null,
    startedAt: battle.started_at?.toISOString() ?? null,
    finishedAt: battle.finished_at?.toISOString() ?? null,
    createdAt: battle.created_at.toISOString(),
    expiresAt: battle.expires_at.toISOString(),
    preparing,
    participant: Boolean(viewer),
    me: viewer ? { playerId: viewer.id, userId: viewer.user_id } : null,
    players: players.map((player) => ({
      id: player.id,
      userId: player.user_id,
      username: player.username,
      isHost: player.user_id === battle.host_user_id,
      connected: player.connected,
      ready: player.ready,
      sandboxReady: player.sandbox_ready,
      currentRound: player.current_round,
      completedRounds: player.completed_rounds,
      finishedAt: player.finished_at?.toISOString() ?? null,
      result: player.result,
    })),
    challenge: challenge ? {
      slug: challenge.slug,
      title: challenge.title,
      description: challenge.description,
      difficulty: challenge.difficulty,
      version: challenge.challenge_version ?? 1,
      definitionHash: challenge.definition_hash ?? null,
      tier: challenge.tier ?? null,
      concepts: challenge.concepts ?? [],
      category: { slug: challenge.category_slug, name: challenge.category_name },
    } : null,
    ...(results ? { results } : {}),
    ...(rankedResult ? { rankedResult } : {}),
    ...(rankedStats ? { rankedStats } : {}),
  };
}

function toBattleNavigation(battle: BattleRow): BattleNavigation {
  return {
    id: battle.id,
    roomCode: battle.room_code,
    status: battle.status,
    matchmakingId: battle.matchmaking_id,
    matchmakingPool: battle.matchmaking_pool,
    mode: battle.mode,
  };
}

function generateRoomCode(): string {
  return Array.from({ length: 5 }, () => ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)]).join('');
}

function safeSend(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : 'unknown';
}
