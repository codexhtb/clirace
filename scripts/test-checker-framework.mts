import assert from 'node:assert/strict';
import {
  CHECKER_ENVIRONMENTS,
  DEFAULT_CHECKER_ENVIRONMENT,
  linuxCoreRuntime,
  parseChallengeCheckerContract,
  type ChallengeChecker,
  type CheckerEnvironmentTemplate,
} from '../apps/api/src/checker-contract.js';
import {
  CHECKER_COMMAND_TIMEOUT_MS,
  CHECKER_FILE_LIMIT_BYTES,
  CheckerService,
  type CheckerExecutor,
} from '../apps/api/src/checker-service.js';
import { listSandboxChallenges } from '../apps/api/src/sandbox-challenges.js';

let passed = 0;

async function test(name: string, body: () => void | Promise<void>) {
  await body();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

const service = new CheckerService();
const ok = (output = '') => ({ exitCode: 0, output, truncated: false });
const no = (output = '') => ({ exitCode: 1, output, truncated: false });

async function evaluate(checker: ChallengeChecker, executor: CheckerExecutor) {
  return service.evaluate(parseChallengeCheckerContract({ runtime: linuxCoreRuntime, checks: [checker] }), executor);
}

interface CheckerCase {
  name: string;
  checker: ChallengeChecker;
  passing: CheckerExecutor;
  failing: CheckerExecutor;
}

const checkerCases: CheckerCase[] = [
  { name: 'file_exists', checker: { id: 'check', type: 'file_exists', path: '/workspace/a', kind: 'file' }, passing: async () => ok(), failing: async () => no() },
  { name: 'file_not_exists', checker: { id: 'check', type: 'file_not_exists', path: '/workspace/a' }, passing: async () => ok(), failing: async () => no() },
  {
    name: 'file_contains', checker: { id: 'check', type: 'file_contains', path: '/workspace/a', expected: 'ready' },
    passing: async (argv) => argv[0] === '/usr/bin/stat' ? ok('12\n') : ok('service ready\n'),
    failing: async (argv) => argv[0] === '/usr/bin/stat' ? ok('12\n') : ok('not yet\n'),
  },
  { name: 'permission_equals', checker: { id: 'check', type: 'permission_equals', path: '/workspace/a', mode: '0750' }, passing: async () => ok('750\n'), failing: async () => ok('755\n') },
  { name: 'owner_equals', checker: { id: 'check', type: 'owner_equals', path: '/workspace/a', user: 'root', group: 'root' }, passing: async () => ok('root:root\n'), failing: async () => ok('root:users\n') },
  { name: 'symlink_points_to', checker: { id: 'check', type: 'symlink_points_to', path: '/workspace/link', target: '/workspace/target' }, passing: async () => ok('/workspace/target\n'), failing: async () => ok('/workspace/other\n') },
  { name: 'user_exists', checker: { id: 'check', type: 'user_exists', user: 'runner' }, passing: async () => ok('runner:x:1000:1000::/home/runner:/bin/bash'), failing: async () => ({ exitCode: 2, output: '', truncated: false }) },
  { name: 'group_exists', checker: { id: 'check', type: 'group_exists', group: 'devops' }, passing: async () => ok('devops:x:1001:'), failing: async () => ({ exitCode: 2, output: '', truncated: false }) },
  { name: 'user_in_group', checker: { id: 'check', type: 'user_in_group', user: 'runner', group: 'devops' }, passing: async () => ok('runner devops\n'), failing: async () => ok('runner\n') },
  { name: 'process_running', checker: { id: 'check', type: 'process_running', process: 'worker' }, passing: async () => ok('S\n'), failing: async () => no() },
  { name: 'process_not_running', checker: { id: 'check', type: 'process_not_running', process: 'worker' }, passing: async () => ok('Z\n'), failing: async () => ok('S\n') },
  { name: 'port_listening', checker: { id: 'check', type: 'port_listening', protocol: 'tcp', port: 8081, bindAddress: '127.0.0.1' }, passing: async () => ok('LISTEN 0 128 127.0.0.1:8081 0.0.0.0:*\n'), failing: async () => ok('LISTEN 0 128 127.0.0.1:3000 0.0.0.0:*\n') },
  { name: 'package_installed', checker: { id: 'check', type: 'package_installed', package: 'curl' }, passing: async () => ok('install ok installed'), failing: async () => no() },
];

for (const checkerCase of checkerCases) {
  await test(`${checkerCase.name} passes`, async () => {
    assert.equal((await evaluate(checkerCase.checker, checkerCase.passing)).outcome, 'passed');
  });
  await test(`${checkerCase.name} fails without becoming a system error`, async () => {
    assert.equal((await evaluate(checkerCase.checker, checkerCase.failing)).outcome, 'failed');
  });
}

const validFileCheck = { id: 'file', type: 'file_exists', path: '/workspace/file', kind: 'file' } as const;
const baseContract = { runtime: linuxCoreRuntime, checks: [validFileCheck] };

await test('strict schema rejects an unknown checker type', () => {
  assert.throws(() => parseChallengeCheckerContract({ ...baseContract, checks: [{ id: 'bad', type: 'service_active', service: 'nginx' }] }));
});
await test('strict schema rejects unknown checker fields', () => {
  assert.throws(() => parseChallengeCheckerContract({ ...baseContract, checks: [{ ...validFileCheck, surprise: true }] }));
});
await test('contract and checker reject arbitrary executable fields', () => {
  assert.throws(() => parseChallengeCheckerContract({ ...baseContract, script: 'id' }));
  assert.throws(() => parseChallengeCheckerContract({ ...baseContract, checks: [{ ...validFileCheck, command: 'id' }] }));
});
await test('checker IDs must be unique within a challenge', () => {
  assert.throws(() => parseChallengeCheckerContract({ ...baseContract, checks: [validFileCheck, validFileCheck] }));
});
await test('unknown runtime environments are rejected', () => {
  assert.throws(() => parseChallengeCheckerContract({ ...baseContract, runtime: { ...linuxCoreRuntime, environment: 'unknown-v1' } }));
});
await test('runtime and checker capability mismatches are rejected', () => {
  const filesystemOnly: CheckerEnvironmentTemplate = {
    id: 'filesystem-v1', runtimeVersion: 1, capabilities: new Set(['filesystem']), packageManager: 'dpkg',
  };
  assert.throws(() => parseChallengeCheckerContract({
    runtime: { ...linuxCoreRuntime, environment: filesystemOnly.id },
    checks: [{ id: 'user', type: 'user_exists', user: 'runner' }],
  }, { [filesystemOnly.id]: filesystemOnly }));
});
await test('relative filesystem paths are rejected', () => {
  assert.throws(() => parseChallengeCheckerContract({ ...baseContract, checks: [{ ...validFileCheck, path: 'workspace/file' }] }));
});
await test('control characters in filesystem paths are rejected', () => {
  assert.throws(() => parseChallengeCheckerContract({ ...baseContract, checks: [{ ...validFileCheck, path: '/workspace/a\n/tmp/b' }] }));
});
await test('shell-shaped Linux account names are rejected', () => {
  assert.throws(() => parseChallengeCheckerContract({ ...baseContract, checks: [{ id: 'user', type: 'user_exists', user: 'root;id' }] }));
});
await test('shell-shaped process and package names are rejected', () => {
  assert.throws(() => parseChallengeCheckerContract({ ...baseContract, checks: [{ id: 'process', type: 'process_running', process: 'sleep $(id)' }] }));
  assert.throws(() => parseChallengeCheckerContract({ ...baseContract, checks: [{ id: 'package', type: 'package_installed', package: 'curl;id' }] }));
});
await test('contracts reject more than 24 checks', () => {
  assert.throws(() => parseChallengeCheckerContract({ ...baseContract, checks: Array.from({ length: 25 }, (_, index) => ({ ...validFileCheck, id: `file-${index}` })) }));
});

await test('oversized files produce a bounded system error', async () => {
  const evaluation = await evaluate(
    { id: 'content', type: 'file_contains', path: '/workspace/a', expected: 'ready' },
    async () => ok(String(CHECKER_FILE_LIMIT_BYTES + 1)),
  );
  assert.equal(evaluation.outcome, 'error');
  assert.equal(evaluation.results[0]?.code, 'file_too_large');
});
await test('truncated command output is never treated as a pass', async () => {
  const evaluation = await evaluate(validFileCheck, async () => ({ exitCode: 0, output: '', truncated: true }));
  assert.equal(evaluation.outcome, 'error');
  const permission = await evaluate({ id: 'mode', type: 'permission_equals', path: '/workspace/a', mode: '0755' }, async () => ({ exitCode: 0, output: '755', truncated: true }));
  assert.equal(permission.outcome, 'error');
});
await test('executor exceptions become checker system errors', async () => {
  assert.equal((await evaluate(validFileCheck, async () => { throw new Error('timeout'); })).outcome, 'error');
});
await test('all required checks must pass', async () => {
  const contract = parseChallengeCheckerContract({ runtime: linuxCoreRuntime, checks: [
    { id: 'one', type: 'file_exists', path: '/workspace/one' },
    { id: 'two', type: 'file_exists', path: '/workspace/two' },
  ] });
  let call = 0;
  assert.equal((await service.evaluate(contract, async () => call++ === 0 ? ok() : no())).outcome, 'failed');
});
await test('checker command timeouts are bounded by policy', async () => {
  await evaluate(validFileCheck, async (_argv, options) => {
    assert.ok(options.timeoutMs > 0 && options.timeoutMs <= CHECKER_COMMAND_TIMEOUT_MS);
    return ok();
  });
});
await test('checker execution uses fixed argv and no shell interpreter', async () => {
  const calls: readonly string[][] = [];
  await evaluate({ id: 'literal', type: 'file_exists', path: '/workspace/name;echo-pwned' }, async (argv) => {
    (calls as string[][]).push([...argv]);
    return no();
  });
  assert.deepEqual(calls[0], ['/usr/bin/test', '-e', '/workspace/name;echo-pwned']);
  assert.ok(!calls[0]?.includes('/bin/sh') && !calls[0]?.includes('/bin/bash'));
});

await test('default environment is registered and versioned', () => {
  assert.equal(CHECKER_ENVIRONMENTS[DEFAULT_CHECKER_ENVIRONMENT]?.runtimeVersion, 1);
});
await test('legacy migrations and all 150 V2 challenges use Runtime Contract V1', () => {
  const runtimeChallenges = listSandboxChallenges().filter((challenge) => challenge.runtime?.version === 1);
  assert.equal(runtimeChallenges.filter((challenge) => challenge.source === 'library-v2').length, 150);
  assert.equal(runtimeChallenges.length, 164);
});
await test('every migrated challenge has non-empty validated checks', () => {
  for (const challenge of listSandboxChallenges().filter((item) => item.runtime)) {
    assert.doesNotThrow(() => parseChallengeCheckerContract({ runtime: challenge.runtime, checks: challenge.checks }));
  }
});
await test('legacy challenges retain trusted checkScript fallback', () => {
  const legacy = listSandboxChallenges().filter((challenge) => !challenge.runtime);
  assert.ok(legacy.length > 0);
  assert.ok(legacy.every((challenge) => challenge.checkScript.trim().length > 0));
});

assert.equal(passed, 47);
console.log(`checker-framework: ${passed}/47 checks passed`);
