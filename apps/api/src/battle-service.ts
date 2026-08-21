import { randomInt, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { RawData, WebSocket } from 'ws';
import type { AuthUser } from './auth-service.js';
import type { BattleRoundCompletion, BattleSandboxHooks, BattleSandboxMetadata } from './battle-types.js';
import type { AppConfig } from './config.js';
import type { SandboxManager, SessionTicket } from './sandbox-manager.js';
import type { Dependencies } from './services.js';

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
}

export class BattleStateError extends Error {
  constructor(message: string, readonly statusCode = 409) {
    super(message);
  }
}

export class BattleManager implements BattleSandboxHooks {
  private readonly sockets = new Map<string, Map<string, Set<WebSocket>>>();
  private readonly countdownTimers = new Map<string, NodeJS.Timeout>();
  private cleanupTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly dependencies: Dependencies,
    private readonly sandboxManager: SandboxManager,
  ) {}

  async start(): Promise<void> {
    await this.dependencies.postgres.query('UPDATE battle_players SET connected = false, disconnected_at = now() WHERE connected');
    const countdowns = await this.dependencies.postgres.query<{ id: string; countdown_start_at: Date }>(`
      SELECT id, countdown_start_at FROM battles
      WHERE status = 'countdown' AND countdown_start_at IS NOT NULL
    `);
    for (const battle of countdowns.rows) this.scheduleCountdown(battle.id, battle.countdown_start_at);
    this.cleanupTimer = setInterval(() => void this.cleanupExpiredBattles(), 60_000);
    this.cleanupTimer.unref();
  }

  async close(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    for (const timer of this.countdownTimers.values()) clearTimeout(timer);
    this.countdownTimers.clear();
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
    await this.sandboxManager.destroyBattleSessions(battleId, 'battle_admin_terminated');
    return true;
  }

  async options(): Promise<{ categories: Array<{ slug: string; name: string; challengeCount: number }> }> {
    const result = await this.dependencies.postgres.query<{ slug: string; name: string; challenge_count: number }>(`
      SELECT categories.slug, categories.name, count(challenges.id)::int AS challenge_count
      FROM categories
      JOIN challenges ON challenges.category_id = categories.id
        AND challenges.enabled AND challenges.type = 'real_shell'
        AND NOT EXISTS (
          SELECT 1 FROM challenge_collection_items ci
          JOIN challenge_collections cc ON cc.id = ci.collection_id
          WHERE ci.challenge_id = challenges.id AND cc.slug = 'interview-100'
        )
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

  async createBattle(user: AuthUser, rounds: 3 | 5 | 10, categorySlug: string): Promise<unknown> {
    const client = await this.dependencies.postgres.connect();
    try {
      await client.query('BEGIN');
      const category = categorySlug === 'all' ? null : await client.query<{ id: number }>(
        'SELECT id FROM categories WHERE slug = $1 AND enabled', [categorySlug],
      ).then((result) => result.rows[0] ?? null);
      if (categorySlug !== 'all' && !category) throw new BattleStateError('Категория не найдена.', 400);

      const challenges = await client.query<{ id: string }>(`
        SELECT id FROM challenges
        WHERE enabled AND type = 'real_shell'
          AND ($1::smallint IS NULL OR category_id = $1)
          AND NOT EXISTS (
            SELECT 1 FROM challenge_collection_items ci
            JOIN challenge_collections cc ON cc.id = ci.collection_id
            WHERE ci.challenge_id = challenges.id AND cc.slug = 'interview-100'
          )
        ORDER BY random()
        LIMIT $2
      `, [category?.id ?? null, rounds]);
      if (challenges.rows.length !== rounds) {
        throw new BattleStateError(`В этой категории пока меньше ${rounds} Shell-заданий. Выберите меньше раундов или все категории.`, 422);
      }

      const battleId = randomUUID();
      const challengeIds = challenges.rows.map((challenge) => challenge.id);
      const expiresAt = new Date(Date.now() + this.config.BATTLE_WAITING_TTL_SECONDS * 1_000);
      let roomCode: string | undefined;
      for (let attempt = 0; attempt < 12 && !roomCode; attempt += 1) {
        const candidate = generateRoomCode();
        const inserted = await client.query<{ room_code: string }>(`
          INSERT INTO battles (
            id, room_code, host_user_id, category_id, round_count, challenge_ids, expires_at
          ) VALUES ($1, $2, $3, $4, $5, $6::bigint[], $7)
          ON CONFLICT (room_code) DO NOTHING
          RETURNING room_code
        `, [battleId, candidate, user.id, category?.id ?? null, rounds, challengeIds, expiresAt]);
        roomCode = inserted.rows[0]?.room_code;
      }
      if (!roomCode) throw new BattleStateError('Не удалось создать уникальный код комнаты. Повторите попытку.', 503);
      await client.query(`
        INSERT INTO battle_players (id, battle_id, user_id)
        VALUES ($1, $2, $3)
      `, [randomUUID(), battleId, user.id]);
      await client.query('COMMIT');
      return this.loadState(roomCode, user.id);
    } catch (error) {
      await client.query('ROLLBACK');
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
      ? await this.loadChallenge(battle.challenge_ids[viewer.current_round - 1])
      : undefined;
    const results = battle.status === 'finished' ? await this.loadResults(battle.id, players) : undefined;
    return publicBattleState(battle, players, viewer, challenge, results);
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
    }>(`
      SELECT b.id AS battle_id, b.status, b.round_count,
             bp.id AS player_id, bp.current_round, bp.completed_rounds, bp.ready,
             c.id AS challenge_id, c.validation_config
      FROM battles b
      JOIN battle_players bp ON bp.battle_id = b.id AND bp.user_id = $2
      JOIN challenges c ON c.id = b.challenge_ids[bp.current_round]
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
    const sandboxChallengeId = row.validation_config.sandboxChallengeId;
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
      await this.sandboxManager.destroyBattleSessions(battle.id, 'battle_expired');
    }
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

  private async loadChallenge(challengeId: string | undefined): Promise<CurrentChallengeRow | undefined> {
    if (!challengeId) return undefined;
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
}

function publicBattleState(
  battle: BattleRow,
  players: PlayerRow[],
  viewer: PlayerRow | undefined,
  challenge: CurrentChallengeRow | undefined,
  results: unknown,
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
      category: { slug: challenge.category_slug, name: challenge.category_name },
    } : null,
    ...(results ? { results } : {}),
  };
}

function generateRoomCode(): string {
  return Array.from({ length: 5 }, () => ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)]).join('');
}

function safeSend(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
}
