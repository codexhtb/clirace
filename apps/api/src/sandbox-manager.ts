import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
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
  battle?: BattleSandboxMetadata;
  inputLocked: boolean;
  checking: boolean;
  closing: boolean;
}

interface TerminalMessage {
  type: 'auth' | 'input' | 'resize' | 'check';
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

export class SandboxUnavailableError extends Error {}
export class SandboxCapacityError extends Error {}
export class SandboxUserSessionError extends Error {}

export class SandboxManager {
  private readonly docker: Docker;
  private readonly sessions = new Map<string, ActiveSession>();
  private battleHooks: BattleSandboxHooks | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly dependencies: Dependencies,
  ) {
    this.docker = new Docker({ socketPath: config.SANDBOX_DOCKER_SOCKET });
  }

  get enabled(): boolean {
    return this.config.SANDBOX_ENABLED;
  }

  setBattleHooks(hooks: BattleSandboxHooks): void {
    this.battleHooks = hooks;
  }

  async createTicket(options: CreateSandboxTicketOptions): Promise<SessionTicket> {
    if (!this.enabled) {
      throw new SandboxUnavailableError('Sandbox terminal is disabled.');
    }

    const requestedBattle = options.battle;
    if (requestedBattle) {
      const existing = [...this.sessions.values()].find((session) =>
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

    if (this.sessions.size >= this.config.SANDBOX_MAX_SESSIONS) {
      throw new SandboxCapacityError('Sandbox capacity is exhausted.');
    }

    await this.assertDaemonReady();

    await this.dependencies.postgres.query(`
      UPDATE sandbox_sessions
      SET status = 'expired', destroyed_at = COALESCE(destroyed_at, now())
      WHERE status IN ('pending', 'active') AND expires_at <= now()
    `);
    const liveSessions = await this.dependencies.postgres.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM sandbox_sessions WHERE status IN ('pending', 'active')
    `);
    if ((liveSessions.rows[0]?.count ?? 0) >= this.config.SANDBOX_MAX_SESSIONS) {
      throw new SandboxCapacityError('Sandbox capacity is exhausted.');
    }

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
      } : {}),
      ...(options.battle ? { battle: options.battle } : {}),
    };

    try {
      await this.dependencies.postgres.query(`
        INSERT INTO sandbox_sessions (
          id, user_id, game_session_id, challenge_id, battle_id, battle_player_id,
          battle_round_number, status, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
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
      await this.dependencies.redis.set(
        `${SESSION_PREFIX}${sessionId}`,
        JSON.stringify(pending),
        { EX: 30 },
      );
    } catch (error) {
      await this.dependencies.postgres.query('DELETE FROM sandbox_sessions WHERE id = $1 AND status = \'pending\'', [sessionId]).catch(() => undefined);
      if (isUniqueViolation(error)) throw new SandboxUserSessionError('User already has an active sandbox.');
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
            void this.markSessionStatus(sessionId, 'failed');
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
      WHERE battle_id = $1 AND status IN ('pending', 'active')
    `, [battleId]);
    await Promise.allSettled(pending.rows.map((row) => this.dependencies.redis.del(`${SESSION_PREFIX}${row.id}`)));
    await Promise.allSettled(
      [...this.sessions.values()]
        .filter((session) => session.battle?.battleId === battleId)
        .map((session) => this.destroySession(session.id, reason)),
    );
    await this.dependencies.postgres.query(`
      UPDATE sandbox_sessions SET status = 'expired', destroyed_at = COALESCE(destroyed_at, now())
      WHERE battle_id = $1 AND status IN ('pending', 'active')
    `, [battleId]).catch(() => undefined);
  }

  private async handleSocketClosed(sessionId: string, socket: WebSocket, reason: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.closing || session.socket !== socket) return;
    if (!session.battle) {
      await this.destroySession(sessionId, reason);
      return;
    }
    session.socket = null;
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    session.reconnectTimer = setTimeout(
      () => void this.destroySession(sessionId, 'reconnect_timeout'),
      this.config.BATTLE_RECONNECT_GRACE_SECONDS * 1_000,
    );
    session.reconnectTimer.unref();
  }

  private async assertDaemonReady(): Promise<void> {
    try {
      const info = await this.docker.info();
      if (!info.SecurityOptions?.some((option: string) => option.includes('rootless'))) {
        throw new Error('Sandbox Docker daemon is not rootless.');
      }
      await this.docker.getImage(this.config.SANDBOX_IMAGE).inspect();
    } catch (error) {
      throw new SandboxUnavailableError(
        error instanceof Error ? error.message : 'Sandbox daemon is unavailable.',
      );
    }
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
      if (!pending.reconnect || !reconnecting.battle || pending.userId !== reconnecting.userId
        || pending.battle?.battleId !== reconnecting.battle.battleId
        || pending.battle.roundNumber !== reconnecting.battle.roundNumber) {
        throw new Error('Reconnect ticket does not match the active session.');
      }
      if (reconnecting.reconnectTimer) {
        clearTimeout(reconnecting.reconnectTimer);
        reconnecting.reconnectTimer = undefined;
      }
      const previous = reconnecting.socket;
      reconnecting.socket = socket;
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

    if (this.sessions.size >= this.config.SANDBOX_MAX_SESSIONS) {
      throw new Error('Sandbox capacity is exhausted.');
    }

    let startupStage = 'create_container';
    const container = await this.docker.createContainer({
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
        SET status = 'active', container_id = $1, expires_at = $2
        WHERE id = $3 AND status = 'pending'
      `, [container.id, new Date(Date.now() + this.config.SANDBOX_MAX_LIFETIME_SECONDS * 1_000), sessionId]);

      const now = Date.now();
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
        ...(pending.battle ? { battle: pending.battle } : {}),
        inputLocked: pending.battle?.inputLocked ?? false,
        reconnectTimer: undefined,
        checking: false,
        closing: false,
      };

      this.sessions.set(sessionId, session);
      stream.off('data', captureStartup);
      stream.on('data', (chunk: Buffer) => this.forwardOutput(session, chunk));
      stream.once('end', () => void this.destroySession(sessionId, 'shell_exited'));
      stream.once('error', () => void this.destroySession(sessionId, 'stream_error'));
      void container.wait().then(() => this.destroySession(sessionId, 'container_stopped')).catch(() => undefined);

      socket.send(JSON.stringify({
        type: 'ready',
        sessionId,
        expiresInSeconds: this.config.SANDBOX_MAX_LIFETIME_SECONDS,
        inputLocked: session.inputLocked,
      }));
      const startupOutput = Buffer.concat(startupChunks);
      if (startupOutput.length > 0) this.forwardOutput(session, startupOutput);
      startupStage = 'notify_battle_ready';
      if (session.battle) await this.battleHooks?.onBattleSandboxReady(session.battle);
    } catch (error) {
      stream?.off('data', captureStartup);
      const inspection = await container.inspect().catch(() => undefined);
      const state = inspection?.State;
      const output = Buffer.concat(startupChunks).toString('utf8').trim().slice(-1_000);
      await container.remove({ force: true }).catch(() => undefined);
      await this.markSessionStatus(sessionId, 'failed');
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
      await session.container.resize({
        h: clamp(message.rows ?? 28, 10, 80),
        w: clamp(message.cols ?? 100, 40, 240),
      });
      return;
    }

    if (message.type === 'check' && !session.checking) {
      session.checking = true;
      try {
        const result = await runContainerCommand(session.container, session.challenge.checkScript);
        const passed = result.exitCode === 0;
        let completion: BattleRoundCompletion | { scoreAwarded: number; gameCompleted: boolean } | undefined;
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
          } else {
            await recordFailedShellCheck(
              this.dependencies,
              session.gameSessionId,
              session.sessionTaskId,
              session.userId,
            );
          }
        }
        if (session.socket?.readyState === session.socket?.OPEN) {
          session.socket.send(JSON.stringify({
            type: 'check_result',
            passed,
            message: passed
              ? session.challenge.successMessage
              : 'Условие пока не выполнено. Проверьте результат и попробуйте ещё раз.',
            ...(completion ?? {}),
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
    if (session.closing || !socket || socket.readyState !== socket.OPEN) return;

    const now = Date.now();
    if (now - session.outputWindowStartedAt >= 1_000) {
      session.outputWindowStartedAt = now;
      session.outputBytes = 0;
    }
    session.outputBytes += chunk.length;

    if (session.outputBytes > OUTPUT_BYTES_PER_SECOND || socket.bufferedAmount > MAX_SOCKET_BUFFER) {
      void this.destroySession(session.id, 'output_rate_limit');
      return;
    }

    this.refreshIdleTimer(session);
    socket.send(chunk, { binary: true });
  }

  private refreshIdleTimer(session: ActiveSession): void {
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(
      () => void this.destroySession(session.id, 'idle_timeout'),
      this.config.SANDBOX_IDLE_TIMEOUT_SECONDS * 1_000,
    );
  }

  private async destroySession(sessionId: string, reason: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.closing) return;
    session.closing = true;
    this.sessions.delete(sessionId);
    clearTimeout(session.lifetimeTimer);
    clearTimeout(session.idleTimer);
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    session.stream.destroy();

    const socket = session.socket;
    if (socket && socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ type: 'closed', reason }));
      socket.close(1000, reason.slice(0, 120));
    }

    await this.markSessionStatus(sessionId, reason === 'challenge_completed' ? 'completed' : terminalStatusForReason(reason));
    await session.container.remove({ force: true, v: true }).catch(() => undefined);
  }

  private async markSessionStatus(sessionId: string, status: 'completed' | 'expired' | 'failed'): Promise<void> {
    await this.dependencies.postgres.query(`
      UPDATE sandbox_sessions
      SET status = $1, destroyed_at = COALESCE(destroyed_at, now())
      WHERE id = $2 AND status IN ('pending', 'active')
    `, [status, sessionId]).catch(() => undefined);
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
  const chunks: Buffer[] = [];

  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.once('end', resolve);
    stream.once('error', reject);
  });

  const inspection = await execution.inspect();
  return {
    exitCode: inspection.ExitCode ?? 1,
    output: Buffer.concat(chunks).toString('utf8').trim().slice(0, 2_000),
  };
}

function terminalStatusForReason(reason: string): 'expired' | 'failed' {
  return ['maximum_lifetime', 'idle_timeout', 'socket_closed', 'shell_exited', 'container_stopped', 'reconnect_timeout', 'battle_finished', 'battle_expired'].includes(reason)
    ? 'expired'
    : 'failed';
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
