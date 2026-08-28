import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { PassThrough } from 'node:stream';
import Docker, { type Container } from 'dockerode';
import type { RawData, WebSocket } from 'ws';
import type { AppConfig } from './config.js';
import type { BattleRoundCompletion, BattleSandboxHooks, BattleSandboxMetadata } from './battle-types.js';
import {
  getSandboxChallenge,
  pickSandboxChallenge,
  toPublicChallenge,
  type PublicSandboxChallenge,
  type SandboxChallenge,
} from './sandbox-challenges.js';
import type { Dependencies } from './services.js';
import { completeShellTask, recordFailedShellCheck } from './shell-game-service.js';
import { TerminalReplayRecorder } from './terminal-replay-recorder.js';
import { TerminalReplayService } from './terminal-replay-service.js';
import {
  CheckerService,
  type CheckerEvaluation,
  type CheckerExecOptions,
  type CheckerExecResult,
} from './checker-service.js';
import {
  LIVE_SANDBOX_STATES,
  SANDBOX_LIFECYCLE_STATES,
  SandboxMetrics,
  assertSandboxTransition,
  evaluateSandboxCapacity,
  type SandboxCapacitySnapshot,
  type SandboxLifecycleState,
} from './sandbox-platform.js';

const SESSION_PREFIX = 'clirace:sandbox:session:';
const INPUT_BYTES_PER_SECOND = 32 * 1024;
const OUTPUT_BYTES_PER_SECOND = 256 * 1024;
const MAX_SOCKET_BUFFER = 1024 * 1024;

type DockerStream = NodeJS.ReadWriteStream & { destroy(): void };

interface PendingSession {
  tokenHash: string;
  expiresAt: number;
  challengeId: string;
  userId: string;
  gameSessionId?: string;
  sessionTaskId?: string;
  databaseChallengeId?: string;
  reconnect?: boolean;
  battle?: BattleSandboxMetadata;
}

interface ActiveSession {
  id: string;
  container: Container;
  stream: DockerStream;
  socket: WebSocket | null;
  lifetimeTimer: NodeJS.Timeout;
  idleTimer: NodeJS.Timeout;
  reconnectTimer: NodeJS.Timeout | undefined;
  inputWindowStartedAt: number;
  inputBytes: number;
  outputWindowStartedAt: number;
  outputBytes: number;
  challenge: SandboxChallenge;
  userId: string;
  gameSessionId?: string;
  sessionTaskId?: string;
  databaseChallengeId?: string;
  replayRecorder?: TerminalReplayRecorder;
  battle?: BattleSandboxMetadata;
  inputLocked: boolean;
  checking: boolean;
  closing: boolean;
  lifecycleState: SandboxLifecycleState;
  lastActivityPersistedAt: number;
}

interface TerminalMessage {
  type: 'auth' | 'input' | 'resize' | 'check' | 'stop';
  token?: string;
  data?: string;
  cols?: number;
  rows?: number;
}

export interface SessionTicket {
  sessionId: string;
  token: string;
  expiresAt: string;
  websocketPath: string;
  challenge: PublicSandboxChallenge;
}

export interface CreateSandboxTicketOptions {
  userId: string;
  excludeChallengeId?: string;
  game?: {
    gameSessionId: string;
    sessionTaskId: string;
    challengeId: string;
    sandboxChallengeId: string;
  };
  battle?: BattleSandboxMetadata;
}

export type SandboxFailureCode =
  | 'feature_disabled'
  | 'socket_unavailable'
  | 'permission_denied'
  | 'daemon_unavailable'
  | 'daemon_not_rootless'
  | 'image_missing'
  | 'capacity_full'
  | 'user_capacity_full'
  | 'container_start_failed';

export class SandboxUnavailableError extends Error {
  constructor(message: string, readonly code: SandboxFailureCode = 'daemon_unavailable') { super(message); }
}
export class SandboxCapacityError extends Error {
  readonly code = 'capacity_full';
  readonly queued = false;
}
export class SandboxUserSessionError extends Error {}

export interface SandboxPlatformStatus {
  enabled: boolean;
  healthy: boolean;
  code: 'ok' | SandboxFailureCode;
  capacity: SandboxCapacitySnapshot;
  lifecycle: readonly SandboxLifecycleState[];
  warmPool: { configured: number; ready: number; enabled: boolean };
  runtime: { socketPath: string; image: string; rootless: boolean };
}

export interface SandboxReconciliationResult {
  containersDiscovered: number;
  sessionsMatched: number;
  orphansRemoved: number;
  staleSessionsTerminated: number;
  recentContainersProtected: number;
  errors: number;
}

export class SandboxManager {
  private readonly docker: Docker;
  private readonly checkerService = new CheckerService();
  private readonly replayService: TerminalReplayService;
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly closingSessions = new Map<string, Promise<void>>();
  private readonly metrics = new SandboxMetrics();
  private battleHooks: BattleSandboxHooks | undefined;
  private maintenanceTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly dependencies: Dependencies,
  ) {
    this.docker = new Docker({ socketPath: config.SANDBOX_DOCKER_SOCKET });
    this.replayService = new TerminalReplayService(dependencies);
  }

  get enabled(): boolean {
    return this.config.SANDBOX_ENABLED;
  }

  async start(): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.inspectDaemon();
      await this.reconcileAfterRestart();
      await this.replayService.cleanupExpired().catch(() => undefined);
      this.maintenanceTimer = setInterval(() => {
        void this.sweepExpiredTickets();
        void this.replayService.cleanupExpired().catch((error: unknown) => {
          console.error('terminal_replay_cleanup_failed', { reason: error instanceof Error ? error.message : 'unknown' });
        });
      }, 30_000);
      this.maintenanceTimer.unref();
    } catch (error) {
      // Sandbox is a degradable subsystem. The API remains available and the
      // status endpoint exposes the precise failure until Docker recovers.
      this.metrics.recordFailure();
      console.error('Sandbox startup reconciliation deferred', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  async getPlatformStatus(): Promise<SandboxPlatformStatus> {
    const capacity = await this.getCapacitySnapshot();
    if (!this.enabled) {
      return {
        enabled: false,
        healthy: false,
        code: 'feature_disabled',
        capacity,
        lifecycle: SANDBOX_LIFECYCLE_STATES,
        warmPool: { configured: this.config.SANDBOX_WARM_POOL_SIZE, ready: 0, enabled: false },
        runtime: { socketPath: this.config.SANDBOX_DOCKER_SOCKET, image: this.config.SANDBOX_IMAGE, rootless: false },
      };
    }
    try {
      await this.inspectDaemon();
      return {
        enabled: true,
        healthy: true,
        code: 'ok',
        capacity,
        lifecycle: SANDBOX_LIFECYCLE_STATES,
        warmPool: { configured: this.config.SANDBOX_WARM_POOL_SIZE, ready: 0, enabled: false },
        runtime: { socketPath: this.config.SANDBOX_DOCKER_SOCKET, image: this.config.SANDBOX_IMAGE, rootless: true },
      };
    } catch (error) {
      const failure = toSandboxUnavailable(error);
      return {
        enabled: true,
        healthy: false,
        code: failure.code,
        capacity,
        lifecycle: SANDBOX_LIFECYCLE_STATES,
        warmPool: { configured: this.config.SANDBOX_WARM_POOL_SIZE, ready: 0, enabled: false },
        runtime: { socketPath: this.config.SANDBOX_DOCKER_SOCKET, image: this.config.SANDBOX_IMAGE, rootless: false },
      };
    }
  }

  async prometheusMetrics(): Promise<string> {
    return this.metrics.render(await this.getCapacitySnapshot());
  }

  async getOperationsSnapshot(): Promise<{
    platform: SandboxPlatformStatus;
    metrics: ReturnType<SandboxMetrics['snapshot']>;
    lifecycleCounts: Record<SandboxLifecycleState, number>;
  }> {
    const counts = await this.dependencies.postgres.query<{ lifecycle_state: SandboxLifecycleState; count: number }>(`
      SELECT lifecycle_state, count(*)::int AS count
      FROM sandbox_sessions GROUP BY lifecycle_state
    `);
    const lifecycleCounts = Object.fromEntries(
      SANDBOX_LIFECYCLE_STATES.map((state) => [state, counts.rows.find((row) => row.lifecycle_state === state)?.count ?? 0]),
    ) as Record<SandboxLifecycleState, number>;
    return { platform: await this.getPlatformStatus(), metrics: this.metrics.snapshot(), lifecycleCounts };
  }

  async hasLiveSessionForUser(userId: string): Promise<boolean> {
    const result = await this.dependencies.postgres.query<{ active: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM sandbox_sessions
        WHERE user_id = $1 AND lifecycle_state = ANY($2::varchar[])
      ) AS active
    `, [userId, LIVE_SANDBOX_STATES]);
    return result.rows[0]?.active === true;
  }

  setBattleHooks(hooks: BattleSandboxHooks): void {
    this.battleHooks = hooks;
  }

  async createTicket(options: CreateSandboxTicketOptions): Promise<SessionTicket> {
    if (!this.enabled) {
      throw new SandboxUnavailableError('Sandbox terminal is disabled.', 'feature_disabled');
    }

    const requestedBattle = options.battle;
    if (options.game) {
      const existing = [...this.sessions.values()].find((session) =>
        !session.closing && !session.battle
        && session.userId === options.userId
        && session.gameSessionId === options.game?.gameSessionId
        && session.sessionTaskId === options.game?.sessionTaskId,
      );
      if (existing) return this.issueReconnectTicket(existing);
    }
    if (requestedBattle) {
      const existing = [...this.sessions.values()].find((session) =>
        !session.closing
        &&
        session.userId === options.userId
        && session.battle?.battleId === requestedBattle.battleId
        && session.battle?.battlePlayerId === requestedBattle.battlePlayerId
        && session.battle?.roundNumber === requestedBattle.roundNumber,
      );
      if (existing) return this.issueReconnectTicket(existing);

      const completedRoundSessions = [...this.sessions.values()].filter((session) =>
        session.userId === options.userId
        && session.battle?.battleId === requestedBattle.battleId
        && session.battle?.battlePlayerId === requestedBattle.battlePlayerId
        && session.battle.roundNumber !== requestedBattle.roundNumber,
      );
      for (const completedSession of completedRoundSessions) {
        await this.destroySession(completedSession.id, 'challenge_completed');
      }
    }

    await this.assertDaemonReady();

    const challenge = options.game
      ? getSandboxChallenge(options.game.sandboxChallengeId)
      : options.battle
        ? getSandboxChallenge(options.battle.sandboxChallengeId)
        : pickSandboxChallenge(options.excludeChallengeId);
    if (!challenge) throw new SandboxUnavailableError('Sandbox challenge does not exist.');
    const sessionId = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 30_000;
    const pending: PendingSession = {
      tokenHash: hashToken(token),
      expiresAt,
      challengeId: challenge.id,
      userId: options.userId,
      ...(options.game ? {
        gameSessionId: options.game.gameSessionId,
        sessionTaskId: options.game.sessionTaskId,
        databaseChallengeId: options.game.challengeId,
      } : {}),
      ...(options.battle ? { battle: options.battle } : {}),
    };

    try {
      await this.reserveCapacity(sessionId, options, expiresAt);
      await this.dependencies.redis.set(
        `${SESSION_PREFIX}${sessionId}`,
        JSON.stringify(pending),
        { EX: 30 },
      );
    } catch (error) {
      await this.dependencies.postgres.query(`
        UPDATE sandbox_sessions
        SET status = 'failed', lifecycle_state = 'failed', failure_code = 'reservation_failed',
            status_changed_at = now(), destroyed_at = COALESCE(destroyed_at, now())
        WHERE id = $1 AND lifecycle_state = 'requested'
      `, [sessionId]).catch(() => undefined);
      throw error;
    }

    return {
      sessionId,
      token,
      expiresAt: new Date(expiresAt).toISOString(),
      websocketPath: `/ws/terminal/${sessionId}`,
      challenge: toPublicChallenge(challenge),
    };
  }

  private async reserveCapacity(
    sessionId: string,
    options: CreateSandboxTicketOptions,
    expiresAt: number,
  ): Promise<void> {
    const client = await this.dependencies.postgres.connect();
    try {
      await client.query('BEGIN');
      // One global transaction lock makes the count-and-reserve operation
      // atomic across concurrent requests and future API replicas.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('clirace:sandbox:capacity'))");
      await client.query(`
        UPDATE sandbox_sessions
        SET status = 'expired', lifecycle_state = 'terminated',
            termination_reason = 'ticket_expired', status_changed_at = now(),
            destroyed_at = COALESCE(destroyed_at, now())
        WHERE lifecycle_state IN ('requested', 'queued') AND expires_at <= now()
      `);
      const counts = await client.query<{ global_live: number; user_live: number }>(`
        SELECT
          count(*) FILTER (WHERE lifecycle_state = ANY($1::varchar[]))::int AS global_live,
          count(*) FILTER (WHERE lifecycle_state = ANY($1::varchar[]) AND user_id = $2)::int AS user_live
        FROM sandbox_sessions
      `, [LIVE_SANDBOX_STATES, options.userId]);
      const decision = evaluateSandboxCapacity({
        maxCapacity: this.config.SANDBOX_MAX_SESSIONS,
        perUserCapacity: this.config.SANDBOX_MAX_SESSIONS_PER_USER,
        globalLive: counts.rows[0]?.global_live ?? 0,
        userLive: counts.rows[0]?.user_live ?? 0,
      });
      if (!decision.allowed) {
        if (decision.code === 'user_capacity_full') {
          throw new SandboxUserSessionError('User sandbox capacity is exhausted.');
        }
        throw new SandboxCapacityError('Sandbox capacity is exhausted.');
      }
      await client.query(`
        INSERT INTO sandbox_sessions (
          id, user_id, game_session_id, challenge_id, battle_id, battle_player_id,
          battle_round_number, status, lifecycle_state, status_changed_at, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 'requested', now(), $8)
      `, [
        sessionId,
        options.userId,
        options.game?.gameSessionId ?? null,
        options.game?.challengeId ?? options.battle?.challengeId ?? null,
        options.battle?.battleId ?? null,
        options.battle?.battlePlayerId ?? null,
        options.battle?.roundNumber ?? null,
        new Date(expiresAt),
      ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getCapacitySnapshot(): Promise<SandboxCapacitySnapshot> {
    if (!this.enabled) {
      return {
        maxCapacity: this.config.SANDBOX_MAX_SESSIONS,
        perUserCapacity: this.config.SANDBOX_MAX_SESSIONS_PER_USER,
        running: 0,
        starting: 0,
        warm: 0,
        available: this.config.SANDBOX_MAX_SESSIONS,
        failed: 0,
      };
    }
    const result = await this.dependencies.postgres.query<{
      running: number; starting: number; failed: number; live: number;
    }>(`
      SELECT
        count(*) FILTER (WHERE lifecycle_state IN ('ready', 'attached', 'idle'))::int AS running,
        count(*) FILTER (WHERE lifecycle_state IN ('requested', 'queued', 'starting'))::int AS starting,
        count(*) FILTER (WHERE lifecycle_state = 'failed' AND status_changed_at > now() - interval '1 hour')::int AS failed,
        count(*) FILTER (WHERE lifecycle_state = ANY($1::varchar[]))::int AS live
      FROM sandbox_sessions
    `, [LIVE_SANDBOX_STATES]);
    const row = result.rows[0];
    const live = row?.live ?? 0;
    return {
      maxCapacity: this.config.SANDBOX_MAX_SESSIONS,
      perUserCapacity: this.config.SANDBOX_MAX_SESSIONS_PER_USER,
      running: row?.running ?? 0,
      starting: row?.starting ?? 0,
      warm: 0,
      available: Math.max(0, this.config.SANDBOX_MAX_SESSIONS - live),
      failed: row?.failed ?? 0,
    };
  }

  private async issueReconnectTicket(session: ActiveSession): Promise<SessionTicket> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 30_000;
    const pending: PendingSession = {
      tokenHash: hashToken(token),
      expiresAt,
      challengeId: session.challenge.id,
      userId: session.userId,
      reconnect: true,
      ...(session.gameSessionId ? { gameSessionId: session.gameSessionId } : {}),
      ...(session.sessionTaskId ? { sessionTaskId: session.sessionTaskId } : {}),
      ...(session.databaseChallengeId ? { databaseChallengeId: session.databaseChallengeId } : {}),
      ...(session.battle ? { battle: session.battle } : {}),
    };
    await this.dependencies.redis.set(`${SESSION_PREFIX}${session.id}`, JSON.stringify(pending), { EX: 30 });
    return {
      sessionId: session.id,
      token,
      expiresAt: new Date(expiresAt).toISOString(),
      websocketPath: `/ws/terminal/${session.id}`,
      challenge: toPublicChallenge(session.challenge),
    };
  }

  bindSocket(sessionId: string, socket: WebSocket): void {
    if (!this.enabled) {
      socket.close(1013, 'Sandbox disabled');
      return;
    }

    let authenticated = false;
    let authInProgress = false;
    const authTimer = setTimeout(() => socket.close(1008, 'Authentication timeout'), 15_000);

    socket.on('message', (raw, isBinary) => {
      const payload = rawDataToBuffer(raw);
      if (isBinary || payload.length > 16 * 1024) {
        socket.close(1009, 'Message too large');
        return;
      }

      let message: TerminalMessage;
      try {
        message = JSON.parse(payload.toString()) as TerminalMessage;
      } catch {
        socket.close(1003, 'Invalid message');
        return;
      }

      if (!authenticated) {
        if (authInProgress) return;
        if (message.type !== 'auth' || typeof message.token !== 'string') {
          socket.close(1008, 'Authentication required');
          return;
        }

        authInProgress = true;
        void this.authenticateAndStart(sessionId, message.token, socket, message.cols, message.rows)
          .then(() => {
            authenticated = true;
            clearTimeout(authTimer);
          })
          .catch((error: unknown) => {
            clearTimeout(authTimer);
            void this.markSessionFailed(sessionId, 'container_start_failed');
            const reason = error instanceof Error ? error.message : 'Session startup failed';
            console.error('Sandbox session startup failed', { sessionId, reason });
            socket.close(1011, `Sandbox startup failed: ${reason}`.slice(0, 120));
          });
        return;
      }

      void this.handleMessage(sessionId, socket, message).catch(() => {
        void this.destroySession(sessionId, 'sandbox_operation_failed');
      });
    });

    socket.once('close', () => {
      clearTimeout(authTimer);
      void this.handleSocketClosed(sessionId, socket, 'socket_closed');
    });

    socket.once('error', () => {
      clearTimeout(authTimer);
      void this.handleSocketClosed(sessionId, socket, 'socket_error');
    });
  }

  async close(): Promise<void> {
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    await Promise.allSettled(
      [...this.sessions.keys()].map((sessionId) => this.destroySession(sessionId, 'api_shutdown')),
    );
  }

  unlockBattle(battleId: string): void {
    for (const session of this.sessions.values()) {
      if (session.battle?.battleId !== battleId || session.closing) continue;
      session.inputLocked = false;
      const socket = session.socket;
      if (socket && socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: 'battle_unlocked' }));
      }
    }
  }

  async destroyBattleSessions(battleId: string, reason: string): Promise<void> {
    const pending = await this.dependencies.postgres.query<{ id: string }>(`
      SELECT id FROM sandbox_sessions
      WHERE battle_id = $1 AND lifecycle_state = ANY($2::varchar[])
    `, [battleId, LIVE_SANDBOX_STATES]);
    await Promise.allSettled(pending.rows.map((row) => this.dependencies.redis.del(`${SESSION_PREFIX}${row.id}`)));
    await Promise.allSettled(
      [...this.sessions.values()]
        .filter((session) => session.battle?.battleId === battleId)
        .map((session) => this.destroySession(session.id, reason)),
    );
    await this.dependencies.postgres.query(`
      UPDATE sandbox_sessions
      SET status = 'expired', lifecycle_state = 'terminated',
          termination_reason = $2, status_changed_at = now(),
          destroyed_at = COALESCE(destroyed_at, now())
      WHERE battle_id = $1 AND lifecycle_state = ANY($3::varchar[])
    `, [battleId, reason.slice(0, 64), LIVE_SANDBOX_STATES]).catch(() => undefined);
  }

  private async handleSocketClosed(sessionId: string, socket: WebSocket, reason: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.closing || session.socket !== socket) return;
    if (!session.battle && !session.replayRecorder) {
      await this.destroySession(sessionId, reason);
      return;
    }
    session.socket = null;
    await this.transitionLifecycle(sessionId, session.lifecycleState, 'idle').catch(() => undefined);
    session.lifecycleState = 'idle';
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    session.reconnectTimer = setTimeout(
      () => void this.destroySession(sessionId, 'reconnect_timeout'),
      this.config.BATTLE_RECONNECT_GRACE_SECONDS * 1_000,
    );
    session.reconnectTimer.unref();
  }

  private async assertDaemonReady(): Promise<void> {
    try {
      await this.inspectDaemon();
    } catch (error) {
      throw toSandboxUnavailable(error);
    }
  }

  async terminateSession(sessionId: string, reason = 'admin_terminated'): Promise<boolean> {
    const existing = await this.dependencies.postgres.query<{ id: string; container_id: string | null }>(`
      SELECT id, container_id FROM sandbox_sessions
      WHERE id = $1 AND lifecycle_state = ANY($2::varchar[])
    `, [sessionId, LIVE_SANDBOX_STATES]);
    if (!existing.rows[0]) return false;
    await this.dependencies.redis.del(`${SESSION_PREFIX}${sessionId}`);
    if (this.sessions.has(sessionId)) {
      await this.destroySession(sessionId, reason);
      return true;
    }
    const containerId = existing.rows[0].container_id;
    if (containerId) {
      const removed = await this.docker.getContainer(containerId).remove({ force: true, v: true })
        .then(() => true)
        .catch((error: unknown) => dockerStatusCode(error) === 404);
      if (!removed) throw new Error('Sandbox container could not be removed safely.');
      this.metrics.recordCleanup();
    }
    await this.dependencies.postgres.query(`
      UPDATE sandbox_sessions
      SET status = 'expired', lifecycle_state = 'terminated', termination_reason = $2,
          status_changed_at = now(), destroyed_at = COALESCE(destroyed_at, now())
      WHERE id = $1 AND lifecycle_state = ANY($3::varchar[])
    `, [sessionId, reason.slice(0, 64), LIVE_SANDBOX_STATES]);
    return true;
  }

  async destroyUserSessions(userId: string, reason = 'account_suspended'): Promise<number> {
    const pending = await this.dependencies.postgres.query<{ id: string }>(`
      SELECT id FROM sandbox_sessions
      WHERE user_id = $1 AND lifecycle_state = ANY($2::varchar[])
    `, [userId, LIVE_SANDBOX_STATES]);
    await Promise.allSettled(pending.rows.map((row) => this.terminateSession(row.id, reason)));
    return pending.rows.length;
  }

  async runReconciliation(): Promise<SandboxReconciliationResult> {
    await this.inspectDaemon();
    const [containers, live] = await Promise.all([
      this.docker.listContainers({ all: true, filters: { label: ['com.clirace.sandbox=true'] } }),
      this.dependencies.postgres.query<{ id: string; container_id: string | null }>(`
        SELECT id, container_id FROM sandbox_sessions
        WHERE lifecycle_state = ANY($1::varchar[])
      `, [LIVE_SANDBOX_STATES]),
    ]);
    const knownContainerIds = new Set([
      ...live.rows.map((row) => row.container_id).filter((id): id is string => Boolean(id)),
      ...[...this.sessions.values()].map((session) => session.container.id),
    ]);
    const discoveredIds = new Set(containers.map((entry) => entry.Id));
    // A container may be visible before its ID is persisted during startup.
    // The grace window prevents reconciliation from racing that legitimate flow.
    const recentCutoffSeconds = Math.floor(Date.now() / 1_000) - 120;
    const unknown = containers.filter((entry) => !knownContainerIds.has(entry.Id));
    const recentContainersProtected = unknown.filter((entry) => entry.Created >= recentCutoffSeconds).length;
    const orphans = unknown.filter((entry) => entry.Created < recentCutoffSeconds);
    const activeContainerIds = new Set([...this.sessions.values()].map((session) => session.container.id));
    const stoppedKnown = containers.filter((entry) =>
      knownContainerIds.has(entry.Id) && entry.State !== 'running' && !activeContainerIds.has(entry.Id),
    );
    const removals = await Promise.allSettled(
      [...orphans, ...stoppedKnown].map((entry) => this.docker.getContainer(entry.Id).remove({ force: true, v: true })),
    );
    const orphansRemoved = removals.slice(0, orphans.length).filter((result) => result.status === 'fulfilled').length;
    const cleanupCount = removals.filter((result) => result.status === 'fulfilled').length;
    const errors = removals.length - cleanupCount;
    if (orphans.length) this.metrics.recordOrphan(orphans.length);
    if (cleanupCount) this.metrics.recordCleanup(cleanupCount);

    const stoppedIds = new Set(stoppedKnown.map((entry) => entry.Id));
    const staleIds = live.rows
      .filter((row) => row.container_id && (!discoveredIds.has(row.container_id) || stoppedIds.has(row.container_id)) && !this.sessions.has(row.id))
      .map((row) => row.id);
    let staleSessionsTerminated = 0;
    if (staleIds.length > 0) {
      const stale = await this.dependencies.postgres.query(`
        UPDATE sandbox_sessions
        SET status = 'expired', lifecycle_state = 'terminated',
            termination_reason = 'admin_reconciliation', status_changed_at = now(),
            destroyed_at = COALESCE(destroyed_at, now())
        WHERE id = ANY($1::uuid[]) AND lifecycle_state = ANY($2::varchar[])
      `, [staleIds, LIVE_SANDBOX_STATES]);
      staleSessionsTerminated = stale.rowCount ?? 0;
    }
    return {
      containersDiscovered: containers.length,
      sessionsMatched: containers.filter((entry) => knownContainerIds.has(entry.Id)).length,
      orphansRemoved,
      staleSessionsTerminated,
      recentContainersProtected,
      errors,
    };
  }

  private async inspectDaemon(): Promise<void> {
    await this.docker.ping();
    const info = await this.docker.info();
    if (!info.SecurityOptions?.some((option: string) => option.includes('rootless'))) {
      throw new SandboxUnavailableError('Sandbox Docker daemon is not rootless.', 'daemon_not_rootless');
    }
    try {
      await this.docker.getImage(this.config.SANDBOX_IMAGE).inspect();
    } catch (error) {
      if (dockerStatusCode(error) === 404) {
        throw new SandboxUnavailableError(`Sandbox image is missing: ${this.config.SANDBOX_IMAGE}`, 'image_missing');
      }
      throw error;
    }
  }

  private async reconcileAfterRestart(): Promise<void> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: ['com.clirace.sandbox=true'] },
    });
    if (containers.length > 0) {
      this.metrics.recordOrphan(containers.length);
      const removals = await Promise.allSettled(
        containers.map((entry) => this.docker.getContainer(entry.Id).remove({ force: true, v: true })),
      );
      this.metrics.recordCleanup(removals.filter((result) => result.status === 'fulfilled').length);
    }
    const live = await this.dependencies.postgres.query<{ id: string }>(`
      SELECT id FROM sandbox_sessions WHERE lifecycle_state = ANY($1::varchar[])
    `, [LIVE_SANDBOX_STATES]);
    await Promise.allSettled(live.rows.map((row) => this.dependencies.redis.del(`${SESSION_PREFIX}${row.id}`)));
    await this.dependencies.postgres.query(`
      UPDATE sandbox_sessions
      SET status = 'expired', lifecycle_state = 'terminated',
          termination_reason = 'api_restart_reconciliation', status_changed_at = now(),
          destroyed_at = COALESCE(destroyed_at, now())
      WHERE lifecycle_state = ANY($1::varchar[])
    `, [LIVE_SANDBOX_STATES]);
  }

  private async sweepExpiredTickets(): Promise<void> {
    const expired = await this.dependencies.postgres.query<{ id: string }>(`
      UPDATE sandbox_sessions
      SET status = 'expired', lifecycle_state = 'terminated',
          termination_reason = 'ticket_expired', status_changed_at = now(),
          destroyed_at = COALESCE(destroyed_at, now())
      WHERE lifecycle_state IN ('requested', 'queued') AND expires_at <= now()
      RETURNING id
    `);
    await Promise.allSettled(expired.rows.map((row) => this.dependencies.redis.del(`${SESSION_PREFIX}${row.id}`)));
  }

  private async authenticateAndStart(
    sessionId: string,
    token: string,
    socket: WebSocket,
    cols = 100,
    rows = 28,
  ): Promise<void> {
    const serialized = await this.dependencies.redis.getDel(`${SESSION_PREFIX}${sessionId}`);
    if (!serialized) throw new Error('Session does not exist.');

    const pending = JSON.parse(serialized) as PendingSession;
    if (pending.expiresAt < Date.now() || !safeTokenMatch(pending.tokenHash, token)) {
      throw new Error('Session token is invalid.');
    }
    const challenge = getSandboxChallenge(pending.challengeId);
    if (!challenge) throw new Error('Session challenge does not exist.');
    if (socket.readyState !== socket.OPEN) throw new Error('Socket is already closed.');

    const reconnecting = this.sessions.get(sessionId);
    if (reconnecting) {
      const battleMatches = Boolean(reconnecting.battle
        && pending.battle?.battleId === reconnecting.battle.battleId
        && pending.battle.roundNumber === reconnecting.battle.roundNumber);
      const practiceMatches = Boolean(!reconnecting.battle
        && pending.gameSessionId === reconnecting.gameSessionId
        && pending.sessionTaskId === reconnecting.sessionTaskId);
      if (!pending.reconnect || pending.userId !== reconnecting.userId || (!battleMatches && !practiceMatches)) {
        throw new Error('Reconnect ticket does not match the active session.');
      }
      if (reconnecting.reconnectTimer) {
        clearTimeout(reconnecting.reconnectTimer);
        reconnecting.reconnectTimer = undefined;
      }
      const previous = reconnecting.socket;
      reconnecting.socket = socket;
      if (reconnecting.lifecycleState !== 'attached') {
        await this.transitionLifecycle(sessionId, reconnecting.lifecycleState, 'attached');
      }
      reconnecting.lifecycleState = 'attached';
      if (previous && previous !== socket && previous.readyState === previous.OPEN) {
        previous.close(1000, 'reconnected_elsewhere');
      }
      socket.send(JSON.stringify({
        type: 'ready',
        sessionId,
        expiresInSeconds: this.config.SANDBOX_MAX_LIFETIME_SECONDS,
        reconnected: true,
        inputLocked: reconnecting.inputLocked,
      }));
      return;
    }

    await this.transitionLifecycle(sessionId, 'requested', 'starting');
    const startupStartedAt = performance.now();
    let startupStage = 'create_container';
    let container: Container;
    try {
      container = await this.docker.createContainer({
      Image: this.config.SANDBOX_IMAGE,
      Cmd: ['/bin/bash', '-lc', buildSandboxBootstrap(challenge.setupScript)],
      Tty: true,
      OpenStdin: true,
      StdinOnce: false,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      StopTimeout: 1,
      Labels: {
        'com.clirace.sandbox': 'true',
        'com.clirace.namespace': 'sandbox-v2',
        'com.clirace.session': sessionId,
        ...(pending.battle ? {
          'com.clirace.battle': pending.battle.battleId,
          'com.clirace.battle-player': pending.battle.battlePlayerId,
          'com.clirace.battle-round': String(pending.battle.roundNumber),
          'com.clirace.challenge': pending.battle.challengeId,
        } : {}),
      },
      HostConfig: {
        AutoRemove: false,
        Init: true,
        NetworkMode: 'none',
        Memory: this.config.SANDBOX_MEMORY_MB * 1024 * 1024,
        NanoCpus: Math.floor(this.config.SANDBOX_CPUS * 1_000_000_000),
        PidsLimit: this.config.SANDBOX_PIDS,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Privileged: false,
        PublishAllPorts: false,
        IpcMode: 'private',
        ShmSize: 16 * 1024 * 1024,
        LogConfig: { Type: 'none', Config: {} },
        Tmpfs: {
          '/tmp': 'rw,noexec,nosuid,nodev,size=16m',
          '/workspace': 'rw,nosuid,nodev,size=64m,mode=0755',
        },
        Ulimits: [
          { Name: 'nofile', Soft: 256, Hard: 256 },
          { Name: 'fsize', Soft: 268_435_456, Hard: 268_435_456 },
        ],
      },
      });
    } catch (error) {
      this.metrics.recordFailure();
      await this.markSessionFailed(sessionId, 'container_start_failed');
      throw new SandboxUnavailableError(
        error instanceof Error ? error.message : 'Container creation failed.',
        'container_start_failed',
      );
    }

    const startupChunks: Buffer[] = [];
    let startupBytes = 0;
    let stream: DockerStream | undefined;
    const captureStartup = (chunk: Buffer) => {
      if (startupBytes >= 16 * 1024) return;
      const captured = Buffer.from(chunk).subarray(0, 16 * 1024 - startupBytes);
      startupChunks.push(captured);
      startupBytes += captured.length;
    };

    try {
      startupStage = 'attach_terminal';
      stream = await container.attach({
        stream: true,
        stdin: true,
        stdout: true,
        stderr: true,
        hijack: true,
      }) as DockerStream;
      stream.on('data', captureStartup);

      startupStage = 'start_container';
      await container.start();
      startupStage = 'wait_for_setup';
      const setup = await runContainerCommand(container, `
        for attempt in $(seq 1 80); do
          [ -f /tmp/clirace-setup-ready ] && exit 0
          if [ -f /tmp/clirace-setup-failed ]; then
            cat /tmp/clirace-setup.log 2>/dev/null
            exit 1
          fi
          sleep 0.05
        done
        cat /tmp/clirace-setup.log 2>/dev/null
        exit 1
      `);
      if (setup.exitCode !== 0) {
        throw new Error(`Challenge setup failed: ${setup.output}`);
      }
      startupStage = 'resize_terminal';
      await container.resize({ h: clamp(rows, 10, 80), w: clamp(cols, 40, 240) });
      if (socket.readyState !== socket.OPEN) throw new Error('Socket closed during startup.');

      startupStage = 'activate_session';
      await this.dependencies.postgres.query(`
        UPDATE sandbox_sessions
        SET status = 'active', lifecycle_state = 'ready', container_id = $1,
            status_changed_at = now(), last_activity_at = now(), expires_at = $2
        WHERE id = $3 AND lifecycle_state = 'starting'
      `, [container.id, new Date(Date.now() + this.config.SANDBOX_MAX_LIFETIME_SECONDS * 1_000), sessionId]);

      await this.transitionLifecycle(sessionId, 'ready', 'attached');
      const now = Date.now();
      const normalizedCols = clamp(cols, 40, 240);
      const normalizedRows = clamp(rows, 10, 80);
      const session: ActiveSession = {
        id: sessionId,
        container,
        stream,
        socket,
        lifetimeTimer: setTimeout(
          () => void this.destroySession(sessionId, 'maximum_lifetime'),
          this.config.SANDBOX_MAX_LIFETIME_SECONDS * 1_000,
        ),
        idleTimer: setTimeout(
          () => void this.destroySession(sessionId, 'idle_timeout'),
          this.config.SANDBOX_IDLE_TIMEOUT_SECONDS * 1_000,
        ),
        inputWindowStartedAt: now,
        inputBytes: 0,
        outputWindowStartedAt: now,
        outputBytes: 0,
        challenge,
        userId: pending.userId,
        ...(pending.gameSessionId ? { gameSessionId: pending.gameSessionId } : {}),
        ...(pending.sessionTaskId ? { sessionTaskId: pending.sessionTaskId } : {}),
        ...(pending.databaseChallengeId ? { databaseChallengeId: pending.databaseChallengeId } : {}),
        ...(!pending.battle && pending.gameSessionId && pending.sessionTaskId
          ? { replayRecorder: new TerminalReplayRecorder(normalizedCols, normalizedRows) }
          : {}),
        ...(pending.battle ? { battle: pending.battle } : {}),
        inputLocked: pending.battle?.inputLocked ?? false,
        reconnectTimer: undefined,
        checking: false,
        closing: false,
        lifecycleState: 'attached',
        lastActivityPersistedAt: now,
      };

      stream.off('data', captureStartup);
      stream.on('data', (chunk: Buffer) => this.forwardOutput(session, chunk));
      stream.once('end', () => void this.destroySession(sessionId, 'shell_exited'));
      stream.once('error', () => void this.destroySession(sessionId, 'stream_error'));
      void container.wait().then(() => this.destroySession(sessionId, 'container_stopped')).catch(() => undefined);

      this.sessions.set(sessionId, session);
      socket.send(JSON.stringify({
        type: 'ready',
        sessionId,
        expiresInSeconds: this.config.SANDBOX_MAX_LIFETIME_SECONDS,
        inputLocked: session.inputLocked,
      }));
      this.metrics.recordCreateDuration((performance.now() - startupStartedAt) / 1_000);
      const startupOutput = Buffer.concat(startupChunks);
      if (startupOutput.length > 0) this.forwardOutput(session, startupOutput);
      startupStage = 'notify_battle_ready';
      if (session.battle) await this.battleHooks?.onBattleSandboxReady(session.battle);
    } catch (error) {
      stream?.off('data', captureStartup);
      const inspection = await container.inspect().catch(() => undefined);
      const state = inspection?.State;
      const output = Buffer.concat(startupChunks).toString('utf8').trim().slice(-1_000);
      this.sessions.delete(sessionId);
      await container.remove({ force: true }).catch(() => undefined);
      this.metrics.recordFailure();
      await this.markSessionFailed(sessionId, 'container_start_failed');
      const reason = error instanceof Error ? error.message : 'Unknown sandbox startup error.';
      const diagnostics = [
        `exit=${state?.ExitCode ?? 'unknown'}`,
        state?.OOMKilled ? 'oom=true' : '',
        state?.Error ? `docker=${state.Error}` : '',
        output ? `output=${output.replace(/\s+/g, ' ').slice(-300)}` : '',
      ].filter(Boolean).join('; ');
      throw new Error(`${startupStage} [${diagnostics || 'no-state'}]: ${reason}`);
    }
  }

  private async handleMessage(sessionId: string, socket: WebSocket, message: TerminalMessage): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.closing || session.socket !== socket) return;

    this.refreshIdleTimer(session);

    if (message.type === 'stop') {
      await this.destroySession(sessionId, 'user_stopped');
      return;
    }

    if (message.type === 'input') {
      if (session.inputLocked) return;
      if (typeof message.data !== 'string' || Buffer.byteLength(message.data) > 16 * 1024) {
        await this.destroySession(sessionId, 'invalid_input');
        return;
      }

      const now = Date.now();
      if (now - session.inputWindowStartedAt >= 1_000) {
        session.inputWindowStartedAt = now;
        session.inputBytes = 0;
      }
      session.inputBytes += Buffer.byteLength(message.data);
      if (session.inputBytes > INPUT_BYTES_PER_SECOND) {
        await this.destroySession(sessionId, 'input_rate_limit');
        return;
      }

      session.stream.write(message.data);
      return;
    }

    if (message.type === 'resize') {
      const rows = clamp(message.rows ?? 28, 10, 80);
      const cols = clamp(message.cols ?? 100, 40, 240);
      await session.container.resize({
        h: rows,
        w: cols,
      });
      session.replayRecorder?.recordResize(cols, rows);
      return;
    }

    if (message.type === 'check' && !session.checking) {
      session.checking = true;
      try {
        const evaluation = session.challenge.runtime && session.challenge.checks
          ? await this.checkerService.evaluate(
              { runtime: session.challenge.runtime, checks: session.challenge.checks },
              (argv, options) => runContainerArgv(session.container, argv, options),
            )
          : await evaluateLegacyCheck(session.container, session.challenge.checkScript);
        const passed = evaluation.outcome === 'passed';
        const systemError = evaluation.outcome === 'error';
        session.replayRecorder?.recordChecker({
          status: evaluation.outcome,
          checks: evaluation.results.map((item) => ({ id: item.id, status: item.status })),
        });
        let completion: BattleRoundCompletion | { scoreAwarded: number; gameCompleted: boolean } | undefined;
        let replayId: string | undefined;
        if (session.battle && passed) {
          completion = await this.battleHooks?.onBattleRoundCompleted(session.battle, session.userId);
        } else if (session.gameSessionId && session.sessionTaskId) {
          if (passed) {
            completion = await completeShellTask(
              this.dependencies,
              session.gameSessionId,
              session.sessionTaskId,
              session.userId,
              session.challenge.id,
            );
            if (session.replayRecorder && session.databaseChallengeId) {
              replayId = await this.replayService.persistCompleted({
                recorder: session.replayRecorder,
                userId: session.userId,
                gameSessionId: session.gameSessionId,
                sessionTaskId: session.sessionTaskId,
                sandboxSessionId: session.id,
                challengeId: session.databaseChallengeId,
                scoreAwarded: completion.scoreAwarded,
                gameCompleted: completion.gameCompleted,
              }).catch((error: unknown) => {
                console.error('terminal_replay_persist_failed', {
                  sessionId: session.id,
                  challengeId: session.challenge.id,
                  reason: error instanceof Error ? error.message : 'unknown',
                });
                return undefined;
              });
            }
          } else if (!systemError) {
            await recordFailedShellCheck(
              this.dependencies,
              session.gameSessionId,
              session.sessionTaskId,
              session.userId,
            );
          }
        }
        console.info('sandbox_checker_evaluated', {
          sessionId: session.id,
          challengeId: session.challenge.id,
          contractVersion: session.challenge.runtime?.version ?? 'legacy',
          outcome: evaluation.outcome,
          passedChecks: evaluation.results.filter((item) => item.status === 'passed').length,
          totalChecks: evaluation.results.length,
          durationMs: evaluation.durationMs,
        });
        if (session.socket?.readyState === session.socket?.OPEN) {
          session.socket.send(JSON.stringify({
            type: 'check_result',
            passed,
            error: systemError,
            message: systemError
              ? 'Не удалось проверить среду. Попробуйте ещё раз.'
              : passed
              ? session.challenge.successMessage
              : 'Условие пока не выполнено. Проверьте результат и попробуйте ещё раз.',
            checks: evaluation.results.map((item) => ({
              id: item.id,
              passed: item.status === 'passed',
              status: item.status,
              ...(item.failureHint ? { hint: item.failureHint } : {}),
            })),
            ...(completion ?? {}),
            ...(replayId ? { replayId } : {}),
          }));
        }
        if (passed) {
          setTimeout(() => void this.destroySession(sessionId, 'challenge_completed'), session.battle ? 500 : 1_500);
        }
      } finally {
        session.checking = false;
      }
    }
  }

  private forwardOutput(session: ActiveSession, chunk: Buffer): void {
    const socket = session.socket;
    if (session.closing) return;

    session.replayRecorder?.recordOutput(chunk);

    const now = Date.now();
    if (now - session.outputWindowStartedAt >= 1_000) {
      session.outputWindowStartedAt = now;
      session.outputBytes = 0;
    }
    session.outputBytes += chunk.length;

    if (session.outputBytes > OUTPUT_BYTES_PER_SECOND || (socket && socket.bufferedAmount > MAX_SOCKET_BUFFER)) {
      void this.destroySession(session.id, 'output_rate_limit');
      return;
    }

    this.refreshIdleTimer(session);
    if (!socket || socket.readyState !== socket.OPEN) return;
    socket.send(chunk, { binary: true });
  }

  private refreshIdleTimer(session: ActiveSession): void {
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(
      () => void this.destroySession(session.id, 'idle_timeout'),
      this.config.SANDBOX_IDLE_TIMEOUT_SECONDS * 1_000,
    );
    const now = Date.now();
    if (now - session.lastActivityPersistedAt >= 15_000) {
      session.lastActivityPersistedAt = now;
      void this.dependencies.postgres.query(`
        UPDATE sandbox_sessions SET last_activity_at = now() WHERE id = $1
      `, [session.id]).catch(() => undefined);
    }
  }

  private async destroySession(sessionId: string, reason: string): Promise<void> {
    const pendingCleanup = this.closingSessions.get(sessionId);
    if (pendingCleanup) {
      await pendingCleanup;
      return;
    }
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const cleanup = this.performDestroySession(session, reason);
    this.closingSessions.set(sessionId, cleanup);
    try {
      await cleanup;
    } finally {
      this.closingSessions.delete(sessionId);
    }
  }

  private async performDestroySession(session: ActiveSession, reason: string): Promise<void> {
    const sessionId = session.id;
    session.closing = true;
    await this.transitionLifecycle(sessionId, session.lifecycleState, 'terminating').catch(() => undefined);
    session.lifecycleState = 'terminating';
    clearTimeout(session.lifetimeTimer);
    clearTimeout(session.idleTimer);
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    session.stream.destroy();

    const socket = session.socket;
    if (socket && socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ type: 'closed', reason }));
      socket.close(1000, reason.slice(0, 120));
    }

    const legacyStatus = reason === 'challenge_completed' ? 'completed' : terminalStatusForReason(reason);
    const removal = await session.container.remove({ force: true, v: true }).then(() => true).catch(() => false);
    if (removal) this.metrics.recordCleanup();
    await this.dependencies.postgres.query(`
      UPDATE sandbox_sessions
      SET status = $1, lifecycle_state = 'terminated', termination_reason = $2,
          status_changed_at = now(), destroyed_at = COALESCE(destroyed_at, now())
      WHERE id = $3 AND lifecycle_state = ANY($4::varchar[])
    `, [legacyStatus, reason.slice(0, 64), sessionId, LIVE_SANDBOX_STATES]).catch(() => undefined);
    this.sessions.delete(sessionId);
  }

  private async markSessionFailed(sessionId: string, code: SandboxFailureCode): Promise<void> {
    await this.dependencies.postgres.query(`
      UPDATE sandbox_sessions
      SET status = 'failed', lifecycle_state = 'failed', failure_code = $1,
          status_changed_at = now(), destroyed_at = COALESCE(destroyed_at, now())
      WHERE id = $2 AND lifecycle_state = ANY($3::varchar[])
    `, [code, sessionId, LIVE_SANDBOX_STATES]).catch(() => undefined);
  }

  private async transitionLifecycle(
    sessionId: string,
    from: SandboxLifecycleState,
    to: SandboxLifecycleState,
  ): Promise<void> {
    assertSandboxTransition(from, to);
    const result = await this.dependencies.postgres.query(`
      UPDATE sandbox_sessions
      SET lifecycle_state = $1, status_changed_at = now()
      WHERE id = $2 AND lifecycle_state = $3
      RETURNING id
    `, [to, sessionId, from]);
    if (result.rowCount !== 1) throw new Error(`Sandbox lifecycle state changed concurrently for ${sessionId}.`);
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function safeTokenMatch(expectedHash: string, token: string): boolean {
  const actual = Buffer.from(hashToken(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function rawDataToBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}

function buildSandboxBootstrap(setupScript: string): string {
  return `
    trap 'code=$?; printf "%s\\n" "$code" > /tmp/clirace-setup-failed; exec /bin/bash -l' ERR
    set -e
    ${setupScript}
    touch /tmp/clirace-setup-ready
    trap - ERR
    exec /bin/bash -l
  `;
}

async function runContainerCommand(
  container: Container,
  script: string,
): Promise<{ exitCode: number; output: string }> {
  const execution = await container.exec({
    Cmd: ['/usr/bin/timeout', '5', '/bin/bash', '-lc', script],
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
  });
  const stream = await execution.start({ hijack: true, stdin: false });
  const capture = await captureBoundedStream(stream, 2_000);

  const inspection = await waitForExecution(execution);
  return {
    exitCode: inspection.ExitCode ?? 1,
    output: capture.output.trim(),
  };
}

async function evaluateLegacyCheck(container: Container, script: string): Promise<CheckerEvaluation> {
  const startedAt = performance.now();
  try {
    const result = await runContainerCommand(container, script);
    return {
      outcome: result.exitCode === 0 ? 'passed' : 'failed',
      results: [{
        id: 'legacy-check',
        type: 'file_exists',
        status: result.exitCode === 0 ? 'passed' : 'failed',
        code: result.exitCode === 0 ? 'ok' : 'legacy_condition_failed',
      }],
      durationMs: Math.round(performance.now() - startedAt),
    };
  } catch {
    return {
      outcome: 'error',
      results: [{ id: 'legacy-check', type: 'file_exists', status: 'error', code: 'legacy_execution_error' }],
      durationMs: Math.round(performance.now() - startedAt),
    };
  }
}

async function runContainerArgv(
  container: Container,
  argv: readonly string[],
  options: CheckerExecOptions,
): Promise<CheckerExecResult> {
  const timeout = `${Math.max(100, options.timeoutMs) / 1_000}s`;
  const execution = await container.exec({
    Cmd: ['/usr/bin/timeout', '--signal=KILL', timeout, ...argv],
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });
  const stream = await execution.start({ hijack: true, stdin: false });
  const capture = await captureBoundedDockerStream(container, stream, options.maxOutputBytes);
  const inspection = await waitForExecution(execution);
  return {
    exitCode: inspection.ExitCode ?? 125,
    output: capture.output,
    truncated: capture.truncated,
  };
}

async function captureBoundedDockerStream(
  container: Container,
  stream: NodeJS.ReadableStream,
  maxBytes: number,
): Promise<{ output: string; truncated: boolean }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  let truncated = false;
  const capture = (include: boolean) => (chunk: Buffer) => {
    const buffer = Buffer.from(chunk);
    const remaining = Math.max(0, maxBytes - capturedBytes);
    if (buffer.length > remaining) truncated = true;
    if (include && remaining > 0) chunks.push(buffer.subarray(0, remaining));
    capturedBytes += Math.min(buffer.length, remaining);
  };
  stdout.on('data', capture(true));
  stderr.on('data', capture(false));
  container.modem.demuxStream(stream, stdout, stderr);
  await new Promise<void>((resolve, reject) => {
    stream.once('end', resolve);
    stream.once('error', reject);
  });
  return { output: Buffer.concat(chunks).toString('utf8'), truncated };
}

async function captureBoundedStream(
  stream: NodeJS.ReadableStream,
  maxBytes: number,
): Promise<{ output: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  let truncated = false;
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => {
      const buffer = Buffer.from(chunk);
      const remaining = Math.max(0, maxBytes - capturedBytes);
      if (buffer.length > remaining) truncated = true;
      if (remaining > 0) {
        const captured = buffer.subarray(0, remaining);
        chunks.push(captured);
        capturedBytes += captured.length;
      }
    });
    stream.once('end', resolve);
    stream.once('error', reject);
  });
  return { output: Buffer.concat(chunks).toString('utf8'), truncated };
}

function terminalStatusForReason(reason: string): 'expired' | 'failed' {
  return ['maximum_lifetime', 'idle_timeout', 'socket_closed', 'shell_exited', 'container_stopped', 'reconnect_timeout', 'battle_finished', 'battle_expired'].includes(reason)
    ? 'expired'
    : 'failed';
}

function toSandboxUnavailable(error: unknown): SandboxUnavailableError {
  if (error instanceof SandboxUnavailableError) return error;
  const code = dockerErrorCode(error);
  const message = error instanceof Error ? error.message : 'Sandbox daemon is unavailable.';
  if (code === 'EACCES' || code === 'EPERM' || /permission denied/i.test(message)) {
    return new SandboxUnavailableError(message, 'permission_denied');
  }
  if (code === 'ENOENT' || /no such file|connect enoent/i.test(message)) {
    return new SandboxUnavailableError(message, 'socket_unavailable');
  }
  return new SandboxUnavailableError(message, 'daemon_unavailable');
}

async function waitForExecution(execution: Docker.Exec): Promise<Docker.ExecInspectInfo> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const inspection = await execution.inspect();
    if (!inspection.Running && inspection.ExitCode !== null) return inspection;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return execution.inspect();
}

function dockerErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function dockerStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return undefined;
  return typeof error.statusCode === 'number' ? error.statusCode : undefined;
}
