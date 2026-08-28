import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  CHECKER_ENVIRONMENTS,
  challengeCheckerSchema,
  checkerCapability,
  runtimeContractSchema,
  type ChallengeChecker,
  type ChallengeRuntimeContract,
} from '../checker-contract.js';

export const CHALLENGE_LIBRARY_VERSION = 2 as const;
export const CHALLENGE_TIERS = ['foundation', 'operator', 'engineer', 'troubleshooter'] as const;
export const CHALLENGE_CATEGORIES = [
  'filesystem',
  'permissions',
  'users-groups',
  'processes',
  'networking',
  'text-processing',
  'shell',
  'packages',
  'troubleshooting',
] as const;

export type ChallengeTier = typeof CHALLENGE_TIERS[number];
export type ChallengeCategory = typeof CHALLENGE_CATEGORIES[number];
export type ChallengeAvailabilityMode = 'practice' | 'quick' | 'ranked' | 'private';

const linuxPath = z.string().min(1).max(512)
  .refine((value) => value === '/workspace' || value.startsWith('/workspace/'), 'Setup paths must stay inside /workspace.')
  .refine((value) => !value.split('/').includes('..') && !/[\0\r\n]/.test(value), 'Unsafe setup path.');
const linuxName = z.string().regex(/^[a-z_][a-z0-9_-]{0,30}[a-z0-9_$-]?$/);
const mode = z.string().regex(/^0[0-7]{3}$/);
const setupBase = { type: z.string() };

const setupOperationSchema = z.discriminatedUnion('type', [
  z.object({ ...setupBase, type: z.literal('create_directory'), path: linuxPath, mode: mode.optional() }).strict(),
  z.object({ ...setupBase, type: z.literal('create_file'), path: linuxPath, content: z.string().max(8_192), mode: mode.optional() }).strict(),
  z.object({ ...setupBase, type: z.literal('create_sized_file'), path: linuxPath, sizeBytes: z.number().int().min(1).max(8 * 1024 * 1024), mode: mode.optional() }).strict(),
  z.object({ ...setupBase, type: z.literal('remove_path'), path: linuxPath }).strict(),
  z.object({ ...setupBase, type: z.literal('symlink'), path: linuxPath, target: linuxPath }).strict(),
  z.object({ ...setupBase, type: z.literal('set_permissions'), path: linuxPath, mode }).strict(),
  z.object({ ...setupBase, type: z.literal('set_owner'), path: linuxPath, user: linuxName, group: linuxName.optional() }).strict(),
  z.object({ ...setupBase, type: z.literal('create_group'), group: linuxName }).strict(),
  z.object({ ...setupBase, type: z.literal('create_user'), user: linuxName, primaryGroup: linuxName.optional() }).strict(),
  z.object({ ...setupBase, type: z.literal('add_user_to_group'), user: linuxName, group: linuxName }).strict(),
  z.object({
    ...setupBase,
    type: z.literal('start_trusted_process'),
    processId: z.enum(['idle-worker-v1', 'log-follower-v1']),
    pidFile: linuxPath,
  }).strict(),
  z.object({
    ...setupBase,
    type: z.literal('start_trusted_listener'),
    listenerId: z.enum(['tcp-listener-v1', 'udp-listener-v1', 'http-status-v1']),
    port: z.number().int().min(1_024).max(65_535),
    bindAddress: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
    pidFile: linuxPath,
  }).strict(),
]);

export type ChallengeSetupOperation = z.infer<typeof setupOperationSchema>;

const availabilitySchema = z.object({
  practice: z.boolean(),
  quick: z.boolean(),
  ranked: z.boolean(),
  private: z.boolean(),
}).strict();

const challengeV2Schema = z.object({
  libraryVersion: z.literal(CHALLENGE_LIBRARY_VERSION),
  id: z.string().regex(/^[a-z][a-z0-9-]{2,99}$/),
  version: z.number().int().min(1),
  title: z.string().trim().min(4).max(160),
  description: z.string().trim().min(20).max(800),
  learningObjective: z.string().trim().min(10).max(300),
  category: z.enum(CHALLENGE_CATEGORIES),
  concepts: z.array(z.string().regex(/^[a-z][a-z0-9-]{1,63}$/)).min(1).max(8),
  tier: z.enum(CHALLENGE_TIERS),
  difficulty: z.enum(['Easy', 'Medium', 'Hard']),
  runtime: runtimeContractSchema,
  setup: z.object({
    version: z.literal(1),
    kind: z.literal('declarative'),
    operations: z.array(setupOperationSchema).max(32),
  }).strict(),
  checks: z.array(challengeCheckerSchema).min(1).max(24),
  hint: z.string().trim().min(8).max(240),
  successMessage: z.string().trim().min(4).max(240),
  estimatedDurationSeconds: z.number().int().min(20).max(300),
  availability: availabilitySchema,
  allowInitiallySolved: z.boolean().default(false),
}).strict().superRefine((challenge, context) => {
  const checkerIds = new Set<string>();
  challenge.checks.forEach((check, index) => {
    if (checkerIds.has(check.id)) {
      context.addIssue({ code: 'custom', path: ['checks', index, 'id'], message: 'Duplicate checker id.' });
    }
    checkerIds.add(check.id);
  });
  if (!CHECKER_ENVIRONMENTS[challenge.runtime.environment]) {
    context.addIssue({ code: 'custom', path: ['runtime', 'environment'], message: 'Unknown runtime environment.' });
  }
});

export type ChallengeV2 = z.infer<typeof challengeV2Schema>;

export interface ChallengeV2Input extends Omit<ChallengeV2, 'libraryVersion' | 'version' | 'runtime' | 'availability' | 'allowInitiallySolved'> {
  version?: number;
  runtime?: ChallengeRuntimeContract;
  availability?: Partial<ChallengeV2['availability']>;
  allowInitiallySolved?: boolean;
}

const defaultAvailability: ChallengeV2['availability'] = Object.freeze({
  practice: true,
  quick: true,
  ranked: true,
  private: true,
});

export function defineChallengeV2(input: ChallengeV2Input): ChallengeV2 {
  return challengeV2Schema.parse({
    ...input,
    libraryVersion: CHALLENGE_LIBRARY_VERSION,
    version: input.version ?? 1,
    runtime: input.runtime ?? { version: 1, type: 'real_shell', environment: 'linux-core-v1' },
    availability: { ...defaultAvailability, ...input.availability },
    allowInitiallySolved: input.allowInitiallySolved ?? false,
  });
}

export type BattleEligibilityReason =
  | 'availability_disabled'
  | 'unsupported_runtime'
  | 'unsupported_environment'
  | 'legacy_validation'
  | 'nondeterministic_setup'
  | 'unsupported_capability'
  | 'unbounded_duration'
  | 'invalid_content_version';

export interface BattleEligibilityResult {
  eligible: boolean;
  reasons: BattleEligibilityReason[];
}

export function evaluateBattleEligibility(
  challenge: ChallengeV2,
  modeName: Exclude<ChallengeAvailabilityMode, 'practice'> = 'quick',
): BattleEligibilityResult {
  const reasons: BattleEligibilityReason[] = [];
  if (!challenge.availability[modeName]) reasons.push('availability_disabled');
  if (challenge.runtime.type !== 'real_shell' || challenge.runtime.version !== 1) reasons.push('unsupported_runtime');
  const environment = CHECKER_ENVIRONMENTS[challenge.runtime.environment];
  if (!environment) reasons.push('unsupported_environment');
  if (!challenge.checks.length) reasons.push('legacy_validation');
  if (challenge.setup.kind !== 'declarative' || challenge.setup.version !== 1) reasons.push('nondeterministic_setup');
  if (challenge.version < 1) reasons.push('invalid_content_version');
  if (challenge.estimatedDurationSeconds < 20 || challenge.estimatedDurationSeconds > 300) reasons.push('unbounded_duration');
  if (environment && challenge.checks.some((check) => !environment.capabilities.has(checkerCapability(check.type)))) {
    reasons.push('unsupported_capability');
  }
  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)] };
}

export interface BattleChallengeSnapshot {
  libraryVersion: 2;
  id: string;
  version: number;
  definitionHash: string;
  title: string;
  description: string;
  category: ChallengeCategory;
  concepts: string[];
  tier: ChallengeTier;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  runtime: ChallengeRuntimeContract;
  setup: ChallengeV2['setup'];
  checks: ChallengeChecker[];
  hint: string;
  successMessage: string;
  estimatedDurationSeconds: number;
}

export function challengeDefinitionHash(challenge: ChallengeV2): string {
  const gameplayDefinition = {
    id: challenge.id,
    version: challenge.version,
    runtime: challenge.runtime,
    setup: challenge.setup,
    checks: challenge.checks,
  };
  return createHash('sha256').update(stableSerialize(gameplayDefinition)).digest('hex');
}

export function createBattleChallengeSnapshot(challenge: ChallengeV2): BattleChallengeSnapshot {
  return {
    libraryVersion: CHALLENGE_LIBRARY_VERSION,
    id: challenge.id,
    version: challenge.version,
    definitionHash: challengeDefinitionHash(challenge),
    title: challenge.title,
    description: challenge.description,
    category: challenge.category,
    concepts: [...challenge.concepts],
    tier: challenge.tier,
    difficulty: challenge.difficulty,
    runtime: structuredClone(challenge.runtime),
    setup: structuredClone(challenge.setup),
    checks: structuredClone(challenge.checks),
    hint: challenge.hint,
    successMessage: challenge.successMessage,
    estimatedDurationSeconds: challenge.estimatedDurationSeconds,
  };
}

export function parseBattleChallengeSnapshot(input: unknown): BattleChallengeSnapshot {
  const candidate = input as Partial<BattleChallengeSnapshot>;
  if (!candidate.runtime || candidate.version === undefined) throw new Error('Pinned challenge definition is incomplete.');
  const definition = defineChallengeV2({
    id: candidate.id ?? '',
    version: candidate.version,
    title: candidate.title ?? '',
    description: candidate.description ?? '',
    learningObjective: 'Pinned immutable Battle challenge definition.',
    category: candidate.category ?? 'filesystem',
    concepts: candidate.concepts ?? [],
    tier: candidate.tier ?? 'foundation',
    difficulty: candidate.difficulty ?? 'Easy',
    runtime: candidate.runtime,
    setup: candidate.setup ?? { version: 1, kind: 'declarative', operations: [] },
    checks: candidate.checks ?? [],
    hint: candidate.hint ?? '',
    successMessage: candidate.successMessage ?? '',
    estimatedDurationSeconds: candidate.estimatedDurationSeconds ?? 0,
  });
  const snapshot = createBattleChallengeSnapshot(definition);
  if (candidate.libraryVersion !== 2 || candidate.definitionHash !== snapshot.definitionHash) {
    throw new Error('Pinned challenge definition hash mismatch.');
  }
  return snapshot;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
