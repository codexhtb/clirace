import { z } from 'zod';

export const REPLAY_FORMAT_VERSION = 1 as const;
export const REPLAY_MAX_LOGICAL_BYTES = 512 * 1024;
export const REPLAY_MAX_EVENTS = 4_096;
export const REPLAY_RETENTION_DAYS = 7;

const baseEventSchema = z.object({
  seq: z.number().int().min(0).max(REPLAY_MAX_EVENTS - 1),
  tMs: z.number().int().min(0).max(30 * 60 * 1_000),
}).strict();

const outputEventSchema = baseEventSchema.extend({
  type: z.literal('output'),
  data: z.string().max(Math.ceil(REPLAY_MAX_LOGICAL_BYTES * 4 / 3) + 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict();

const resizeEventSchema = baseEventSchema.extend({
  type: z.literal('resize'),
  cols: z.number().int().min(40).max(240),
  rows: z.number().int().min(10).max(80),
}).strict();

const checkerEventSchema = baseEventSchema.extend({
  type: z.literal('checker'),
  status: z.enum(['passed', 'failed', 'error']),
  passed: z.number().int().min(0).max(24),
  total: z.number().int().min(1).max(24),
  checks: z.array(z.object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
    status: z.enum(['passed', 'failed', 'error']),
  }).strict()).max(24).optional(),
}).strict().superRefine((event, context) => {
  if (event.passed > event.total) context.addIssue({ code: 'custom', message: 'passed cannot exceed total' });
});

const completedEventSchema = baseEventSchema.extend({
  type: z.literal('completed'),
  scoreAwarded: z.number().int().min(0).max(1_000_000),
  gameCompleted: z.boolean(),
}).strict();

export const replayEventSchema = z.discriminatedUnion('type', [
  outputEventSchema,
  resizeEventSchema,
  checkerEventSchema,
  completedEventSchema,
]);

export const terminalReplayV1Schema = z.object({
  version: z.literal(REPLAY_FORMAT_VERSION),
  initialCols: z.number().int().min(40).max(240),
  initialRows: z.number().int().min(10).max(80),
  events: z.array(replayEventSchema).max(REPLAY_MAX_EVENTS),
}).strict().superRefine((replay, context) => {
  let previousSeq = -1;
  let previousTime = -1;
  let logicalBytes = 0;
  for (const [index, event] of replay.events.entries()) {
    if (event.seq !== previousSeq + 1) {
      context.addIssue({ code: 'custom', path: ['events', index, 'seq'], message: 'seq must be contiguous and increasing' });
    }
    if (event.tMs < previousTime) {
      context.addIssue({ code: 'custom', path: ['events', index, 'tMs'], message: 'timestamps must be monotonic' });
    }
    if (event.type === 'output') {
      try {
        logicalBytes += Buffer.from(event.data, 'base64').length;
      } catch {
        context.addIssue({ code: 'custom', path: ['events', index, 'data'], message: 'invalid output encoding' });
      }
    } else {
      logicalBytes += 128;
    }
    previousSeq = event.seq;
    previousTime = event.tMs;
  }
  if (logicalBytes > REPLAY_MAX_LOGICAL_BYTES) {
    context.addIssue({ code: 'custom', path: ['events'], message: 'replay exceeds the logical size limit' });
  }
});

export type ReplayEventV1 = z.infer<typeof replayEventSchema>;
export type TerminalReplayV1 = z.infer<typeof terminalReplayV1Schema>;

