import {
  REPLAY_FORMAT_VERSION,
  REPLAY_MAX_EVENTS,
  REPLAY_MAX_LOGICAL_BYTES,
  terminalReplayV1Schema,
  type ReplayEventV1,
  type TerminalReplayV1,
} from './terminal-replay-format.js';

export interface ReplayCheckerMarker {
  status: 'passed' | 'failed' | 'error';
  checks: Array<{ id: string; status: 'passed' | 'failed' | 'error' }>;
}

export interface FinalizedReplay {
  payload: TerminalReplayV1;
  durationMs: number;
  eventCount: number;
  sizeBytes: number;
  truncated: boolean;
}

type WithoutTiming<T> = T extends unknown ? Omit<T, 'seq' | 'tMs'> : never;
type ReplayEventInput = WithoutTiming<ReplayEventV1>;

export class TerminalReplayRecorder {
  private readonly startedAt = performance.now();
  private readonly events: ReplayEventV1[] = [];
  private logicalBytes = 0;
  private lastTime = 0;
  private truncated = false;
  private finalized: FinalizedReplay | undefined;

  constructor(
    private readonly initialCols: number,
    private readonly initialRows: number,
    private readonly maxBytes = REPLAY_MAX_LOGICAL_BYTES,
    private readonly maxEvents = REPLAY_MAX_EVENTS,
  ) {}

  recordOutput(chunk: Buffer): void {
    if (this.finalized || this.truncated || chunk.length === 0) return;
    if (!this.reserve(chunk.length, 'output')) return;
    this.push({ type: 'output', data: chunk.toString('base64') });
  }

  recordResize(cols: number, rows: number): void {
    if (this.finalized || this.truncated) return;
    if (!this.reserve(128, 'output')) return;
    this.push({ type: 'resize', cols, rows });
  }

  recordChecker(marker: ReplayCheckerMarker): void {
    if (this.finalized) return;
    if (!this.reserve(128 + marker.checks.length * 64, 'checker')) return;
    this.push({
      type: 'checker',
      status: marker.status,
      passed: marker.checks.filter((check) => check.status === 'passed').length,
      total: marker.checks.length,
      checks: marker.checks,
    });
  }

  finalize(scoreAwarded: number, gameCompleted: boolean): FinalizedReplay {
    if (this.finalized) return this.finalized;
    if (this.reserve(128, 'completion')) {
      this.push({ type: 'completed', scoreAwarded, gameCompleted });
    }
    const payload = terminalReplayV1Schema.parse({
      version: REPLAY_FORMAT_VERSION,
      initialCols: this.initialCols,
      initialRows: this.initialRows,
      events: this.events,
    });
    this.finalized = Object.freeze({
      payload,
      durationMs: this.now(),
      eventCount: this.events.length,
      sizeBytes: this.logicalBytes,
      truncated: this.truncated,
    });
    return this.finalized;
  }

  private reserve(bytes: number, kind: 'output' | 'checker' | 'completion'): boolean {
    const semanticByteReserve = Math.min(4_096, Math.floor(this.maxBytes / 2));
    const semanticEventReserve = Math.min(16, Math.floor(this.maxEvents / 2));
    const byteLimit = kind === 'output'
      ? Math.max(0, this.maxBytes - semanticByteReserve)
      : kind === 'checker'
        ? Math.max(0, this.maxBytes - 128)
        : this.maxBytes;
    const eventLimit = kind === 'output'
      ? Math.max(0, this.maxEvents - semanticEventReserve)
      : kind === 'checker'
        ? Math.max(0, this.maxEvents - 1)
        : this.maxEvents;
    if (this.events.length >= eventLimit || this.logicalBytes + bytes > byteLimit) {
      this.truncated = true;
      return false;
    }
    this.logicalBytes += bytes;
    return true;
  }

  private push(event: ReplayEventInput): void {
    this.events.push({ ...event, seq: this.events.length, tMs: this.now() } as ReplayEventV1);
  }

  private now(): number {
    this.lastTime = Math.max(this.lastTime, Math.floor(performance.now() - this.startedAt));
    return this.lastTime;
  }
}
