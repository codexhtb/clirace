import { z } from 'zod';

export const CHECKER_RUNTIME_VERSION = 1 as const;
export const DEFAULT_CHECKER_ENVIRONMENT = 'linux-core-v1' as const;

export type CheckerCapability = 'filesystem' | 'identity' | 'processes' | 'network' | 'packages';

export interface CheckerEnvironmentTemplate {
  id: string;
  runtimeVersion: 1;
  capabilities: ReadonlySet<CheckerCapability>;
  packageManager: 'dpkg';
}

export const CHECKER_ENVIRONMENTS: Readonly<Record<string, CheckerEnvironmentTemplate>> = Object.freeze({
  [DEFAULT_CHECKER_ENVIRONMENT]: Object.freeze({
    id: DEFAULT_CHECKER_ENVIRONMENT,
    runtimeVersion: CHECKER_RUNTIME_VERSION,
    capabilities: new Set<CheckerCapability>(['filesystem', 'identity', 'processes', 'network', 'packages']),
    packageManager: 'dpkg' as const,
  }),
});

const checkerId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const failureHint = z.string().trim().min(1).max(240).optional();
const linuxPath = z.string().min(1).max(512).refine((value) => value.startsWith('/') && !/[\0\r\n]/.test(value), 'Expected a bounded absolute Linux path.');
const linuxName = z.string().regex(/^[a-z_][a-z0-9_-]{0,30}[a-z0-9_$-]?$/);
const processName = z.string().regex(/^[A-Za-z0-9_.+-]{1,64}$/);
const packageName = z.string().regex(/^[a-z0-9][a-z0-9+.-]{0,127}(?::[a-z0-9][a-z0-9-]{0,31})?$/);
const mode = z.string().regex(/^0[0-7]{3}$/);
const expectedText = z.string().max(4_096);
const bindAddress = z.string().min(1).max(64).regex(/^[A-Fa-f0-9:.]+$/).optional();

const common = { id: checkerId, failureHint };
const fileExists = z.object({ ...common, type: z.literal('file_exists'), path: linuxPath, kind: z.enum(['file', 'directory', 'any']).default('any') }).strict();
const fileNotExists = z.object({ ...common, type: z.literal('file_not_exists'), path: linuxPath }).strict();
const fileContains = z.object({ ...common, type: z.literal('file_contains'), path: linuxPath, expected: expectedText }).strict();
const permissionEquals = z.object({ ...common, type: z.literal('permission_equals'), path: linuxPath, mode }).strict();
const ownerEquals = z.object({ ...common, type: z.literal('owner_equals'), path: linuxPath, user: linuxName, group: linuxName.optional() }).strict();
const symlinkPointsTo = z.object({ ...common, type: z.literal('symlink_points_to'), path: linuxPath, target: linuxPath }).strict();
const userExists = z.object({ ...common, type: z.literal('user_exists'), user: linuxName }).strict();
const groupExists = z.object({ ...common, type: z.literal('group_exists'), group: linuxName }).strict();
const userInGroup = z.object({ ...common, type: z.literal('user_in_group'), user: linuxName, group: linuxName }).strict();
const processRunning = z.object({ ...common, type: z.literal('process_running'), process: processName }).strict();
const processNotRunning = z.object({ ...common, type: z.literal('process_not_running'), process: processName }).strict();
const portListening = z.object({ ...common, type: z.literal('port_listening'), protocol: z.enum(['tcp', 'udp']), port: z.number().int().min(1).max(65_535), bindAddress }).strict();
const packageInstalled = z.object({ ...common, type: z.literal('package_installed'), package: packageName }).strict();

export const challengeCheckerSchema = z.discriminatedUnion('type', [
  fileExists, fileNotExists, fileContains, permissionEquals, ownerEquals, symlinkPointsTo,
  userExists, groupExists, userInGroup, processRunning, processNotRunning, portListening,
  packageInstalled,
]);

export type ChallengeChecker = z.infer<typeof challengeCheckerSchema>;

export const runtimeContractSchema = z.object({
  version: z.literal(CHECKER_RUNTIME_VERSION),
  type: z.literal('real_shell'),
  environment: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
}).strict();

export type ChallengeRuntimeContract = z.infer<typeof runtimeContractSchema>;

const challengeContractBaseSchema = z.object({
  runtime: runtimeContractSchema,
  checks: z.array(challengeCheckerSchema).min(1).max(24),
}).strict();

function contractSchema(environments: Readonly<Record<string, CheckerEnvironmentTemplate>>) {
  return challengeContractBaseSchema.superRefine((contract, context) => {
  const environment = environments[contract.runtime.environment];
  if (!environment) {
    context.addIssue({ code: 'custom', path: ['runtime', 'environment'], message: 'Unknown checker environment.' });
    return;
  }
  const ids = new Set<string>();
  contract.checks.forEach((checker, index) => {
    if (ids.has(checker.id)) context.addIssue({ code: 'custom', path: ['checks', index, 'id'], message: 'Duplicate checker id.' });
    ids.add(checker.id);
    const capability = checkerCapability(checker.type);
    if (!environment.capabilities.has(capability)) {
      context.addIssue({ code: 'custom', path: ['checks', index, 'type'], message: `Environment does not support ${capability}.` });
    }
  });
  });
}

export interface ChallengeCheckerContract {
  runtime: ChallengeRuntimeContract;
  checks: ChallengeChecker[];
}

export function parseChallengeCheckerContract(
  input: unknown,
  environments: Readonly<Record<string, CheckerEnvironmentTemplate>> = CHECKER_ENVIRONMENTS,
): ChallengeCheckerContract {
  return contractSchema(environments).parse(input);
}

export function checkerCapability(type: ChallengeChecker['type']): CheckerCapability {
  if (['file_exists', 'file_not_exists', 'file_contains', 'permission_equals', 'owner_equals', 'symlink_points_to'].includes(type)) return 'filesystem';
  if (['user_exists', 'group_exists', 'user_in_group'].includes(type)) return 'identity';
  if (['process_running', 'process_not_running'].includes(type)) return 'processes';
  if (type === 'port_listening') return 'network';
  return 'packages';
}

export function checkerContract(runtime: ChallengeRuntimeContract, checks: ChallengeChecker[]): ChallengeCheckerContract {
  return parseChallengeCheckerContract({ runtime, checks });
}

export const linuxCoreRuntime: ChallengeRuntimeContract = Object.freeze({
  version: CHECKER_RUNTIME_VERSION,
  type: 'real_shell',
  environment: DEFAULT_CHECKER_ENVIRONMENT,
});
