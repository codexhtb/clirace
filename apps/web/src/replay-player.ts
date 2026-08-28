export type ReplayEvent =
  | { seq: number; tMs: number; type: 'output'; data: string }
  | { seq: number; tMs: number; type: 'resize'; cols: number; rows: number }
  | { seq: number; tMs: number; type: 'checker'; status: 'passed' | 'failed' | 'error'; passed: number; total: number; checks?: Array<{ id: string; status: 'passed' | 'failed' | 'error' }> }
  | { seq: number; tMs: number; type: 'completed'; scoreAwarded: number; gameCompleted: boolean };

export interface ReplayPayload {
  version: 1;
  initialCols: number;
  initialRows: number;
  events: ReplayEvent[];
}

export function parseReplayPayload(value: unknown): ReplayPayload | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<ReplayPayload>;
  if (candidate.version !== 1 || !validSize(candidate.initialCols, 40, 240) || !validSize(candidate.initialRows, 10, 80)
    || !Array.isArray(candidate.events) || candidate.events.length > 4_096) return undefined;
  let previousTime = -1;
  for (const [index, raw] of candidate.events.entries()) {
    if (!raw || typeof raw !== 'object') return undefined;
    const event = raw as ReplayEvent;
    if (event.seq !== index || !Number.isInteger(event.tMs) || event.tMs < previousTime || event.tMs < 0) return undefined;
    if (event.type === 'output') {
      if (typeof event.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.data)) return undefined;
    } else if (event.type === 'resize') {
      if (!validSize(event.cols, 40, 240) || !validSize(event.rows, 10, 80)) return undefined;
    } else if (event.type === 'checker') {
      if (!['passed', 'failed', 'error'].includes(event.status) || !Number.isInteger(event.passed)
        || !Number.isInteger(event.total) || event.total < 1 || event.passed < 0 || event.passed > event.total) return undefined;
    } else if (event.type === 'completed') {
      if (!Number.isInteger(event.scoreAwarded) || event.scoreAwarded < 0 || typeof event.gameCompleted !== 'boolean') return undefined;
    } else return undefined;
    previousTime = event.tMs;
  }
  return candidate as ReplayPayload;
}

export function decodeReplayOutput(data: string): Uint8Array {
  const binary = window.atob(data);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function playbackPosition(anchorPosition: number, anchorTime: number, now: number, speed: number, duration: number): number {
  return Math.min(duration, Math.max(0, anchorPosition + (now - anchorTime) * speed));
}

export function replayMarkerLabel(event: Extract<ReplayEvent, { type: 'checker' | 'completed' }>): string {
  if (event.type === 'completed') return 'Задача выполнена';
  if (event.status === 'error') return 'Не удалось проверить среду';
  return `Проверка: ${event.passed}/${event.total}`;
}

function validSize(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

