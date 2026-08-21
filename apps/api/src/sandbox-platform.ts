export const SANDBOX_LIFECYCLE_STATES = [
  'requested',
  'queued',
  'starting',
  'ready',
  'attached',
  'idle',
  'terminating',
  'terminated',
  'failed',
] as const;

export type SandboxLifecycleState = typeof SANDBOX_LIFECYCLE_STATES[number];

const transitions: Readonly<Record<SandboxLifecycleState, readonly SandboxLifecycleState[]>> = {
  requested: ['queued', 'starting', 'terminating', 'failed'],
  queued: ['starting', 'terminating', 'failed'],
  starting: ['ready', 'terminating', 'failed'],
  ready: ['attached', 'idle', 'terminating', 'failed'],
  attached: ['idle', 'terminating', 'failed'],
  idle: ['attached', 'terminating', 'failed'],
  terminating: ['terminated', 'failed'],
  terminated: [],
  failed: [],
};

export const LIVE_SANDBOX_STATES: readonly SandboxLifecycleState[] = [
  'requested', 'queued', 'starting', 'ready', 'attached', 'idle', 'terminating',
];

export function canTransitionSandbox(from: SandboxLifecycleState, to: SandboxLifecycleState): boolean {
  return from === to || transitions[from].includes(to);
}

export function assertSandboxTransition(from: SandboxLifecycleState, to: SandboxLifecycleState): void {
  if (!canTransitionSandbox(from, to)) {
    throw new Error(`Invalid sandbox lifecycle transition: ${from} -> ${to}`);
  }
}

export interface SandboxCapacitySnapshot {
  maxCapacity: number;
  perUserCapacity: number;
  running: number;
  starting: number;
  warm: number;
  available: number;
  failed: number;
}

export type CapacityDecision =
  | { allowed: true }
  | { allowed: false; code: 'capacity_full' | 'user_capacity_full' };

export function evaluateSandboxCapacity(input: {
  maxCapacity: number;
  perUserCapacity: number;
  globalLive: number;
  userLive: number;
}): CapacityDecision {
  if (input.userLive >= input.perUserCapacity) return { allowed: false, code: 'user_capacity_full' };
  if (input.globalLive >= input.maxCapacity) return { allowed: false, code: 'capacity_full' };
  return { allowed: true };
}

export class SandboxMetrics {
  private failedTotal = 0;
  private cleanupTotal = 0;
  private orphanTotal = 0;
  private readonly createDurations: number[] = [];

  recordCreateDuration(seconds: number): void {
    this.createDurations.push(Math.max(0, seconds));
    if (this.createDurations.length > 512) this.createDurations.shift();
  }

  recordFailure(): void { this.failedTotal += 1; }
  recordCleanup(count = 1): void { this.cleanupTotal += count; }
  recordOrphan(count = 1): void { this.orphanTotal += count; }

  render(snapshot: SandboxCapacitySnapshot): string {
    const durations = [...this.createDurations].sort((a, b) => a - b);
    const sum = durations.reduce((total, value) => total + value, 0);
    const lines = [
      gauge('sandbox_active', snapshot.running, 'Attached or idle sandbox sessions'),
      gauge('sandbox_starting', snapshot.starting, 'Sandbox sessions being created'),
      gauge('sandbox_capacity', snapshot.maxCapacity, 'Configured global sandbox capacity'),
      gauge('sandbox_available', snapshot.available, 'Available sandbox capacity'),
      gauge('sandbox_warm_ready', snapshot.warm, 'Ready containers in the warm pool'),
      counter('sandbox_failed_total', this.failedTotal, 'Sandbox operations that failed'),
      counter('sandbox_cleanup_total', this.cleanupTotal, 'Sandbox containers cleaned up'),
      counter('sandbox_orphan_total', this.orphanTotal, 'Orphan sandbox containers found'),
      '# HELP sandbox_create_duration Sandbox startup duration in seconds',
      '# TYPE sandbox_create_duration summary',
      `sandbox_create_duration{quantile="0.5"} ${quantile(durations, 0.5)}`,
      `sandbox_create_duration{quantile="0.95"} ${quantile(durations, 0.95)}`,
      `sandbox_create_duration_sum ${sum.toFixed(6)}`,
      `sandbox_create_duration_count ${durations.length}`,
    ];
    return `${lines.join('\n')}\n`;
  }
}

function gauge(name: string, value: number, help: string): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}`;
}

function counter(name: string, value: number, help: string): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} counter\n${name} ${value}`;
}

function quantile(sorted: readonly number[], ratio: number): string {
  if (sorted.length === 0) return '0';
  return (sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))] ?? 0).toFixed(6);
}
