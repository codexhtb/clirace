import Docker, { type Container } from 'dockerode';
import { Pool } from 'pg';
import { PassThrough } from 'node:stream';
import { listSandboxChallenges, type SandboxChallenge } from './sandbox-challenges.js';
import { CheckerService, type CheckerExecOptions, type CheckerExecResult } from './checker-service.js';
import { checkerContract, linuxCoreRuntime, type ChallengeCheckerContract } from './checker-contract.js';
import { getChallengeV2 } from './challenge-library-v2/catalog.js';
import { alternativeSolutionFixtures, trustedSolutionForChallenge } from './challenge-library-v2/test-solutions.js';

interface IntegrityResult {
  total: number;
  passed: number;
  alternativeSolutions: number;
  failed: Array<{ id: string; stage: string; output: string }>;
  durationMs: number;
}

export async function runRealShellIntegrity(options: {
  socketPath: string;
  image: string;
  concurrency?: number;
}): Promise<IntegrityResult> {
  const docker = new Docker({ socketPath: options.socketPath });
  const info = await docker.info();
  if (!info.SecurityOptions?.some((item: string) => item.includes('rootless'))) {
    throw new Error('Integrity suite refuses to use a non-rootless Docker daemon.');
  }
  await docker.getImage(options.image).inspect();
  const startedAt = performance.now();
  const challenges = [...listSandboxChallenges()];
  const failed: IntegrityResult['failed'] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 4, 8)) }, async () => {
    while (cursor < challenges.length) {
      const challenge = challenges[cursor++];
      if (!challenge) break;
      const failure = await verifyChallenge(docker, options.image, challenge);
      if (failure) failed.push(failure);
    }
  });
  await Promise.all(workers);
  const alternatives = Object.entries(alternativeSolutionFixtures).flatMap(([id, solutions]) =>
    solutions.map((solution, index) => ({ id, solution, index: index + 1 })));
  let alternativeCursor = 0;
  const alternativeWorkers = Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 4, 8)) }, async () => {
    while (alternativeCursor < alternatives.length) {
      const fixture = alternatives[alternativeCursor++];
      if (!fixture) break;
      const challenge = getSandboxChallengeForIntegrity(fixture.id);
      const failure = challenge
        ? await verifyChallenge(docker, options.image, challenge, fixture.solution, `alternative_${fixture.index}`)
        : { id: fixture.id, stage: 'alternative_fixture', output: 'challenge missing' };
      if (failure) failed.push(failure);
    }
  });
  await Promise.all(alternativeWorkers);
  return {
    total: challenges.length,
    passed: challenges.length - failed.filter((failure) => !failure.stage.startsWith('alternative_')).length,
    alternativeSolutions: alternatives.length,
    failed,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

async function verifyChallenge(
  docker: Docker,
  image: string,
  challenge: SandboxChallenge,
  solutionOverride?: string,
  stagePrefix = '',
): Promise<{ id: string; stage: string; output: string } | undefined> {
  let container: Container | undefined;
  const stage = (name: string) => stagePrefix ? `${stagePrefix}_${name}` : name;
  try {
    container = await docker.createContainer({
      Image: image,
      Cmd: ['/bin/bash', '-lc', `set -e\n${challenge.setupScript}\ntouch /tmp/clirace-integrity-ready\nexec /bin/bash`],
      Tty: true,
      OpenStdin: true,
      Labels: {
        'com.clirace.sandbox-test': 'integrity',
        'com.clirace.challenge': challenge.id,
      },
      HostConfig: {
        AutoRemove: false,
        NetworkMode: 'none',
        Memory: 256 * 1024 * 1024,
        NanoCpus: 250_000_000,
        PidsLimit: 64,
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
      },
    });
    await container.start();
    const ready = await exec(container, 'for i in $(seq 1 100); do [ -f /tmp/clirace-integrity-ready ] && exit 0; sleep 0.05; done; exit 1');
    if (ready.exitCode !== 0) return { id: challenge.id, stage: stage('setup'), output: ready.output };
    const inspection = await container.inspect();
    assertSecurityInvariants(inspection.HostConfig);
    if (challenge.source === 'library-v2') {
      const idempotentSetup = await exec(container, challenge.setupScript);
      if (idempotentSetup.exitCode !== 0) return { id: challenge.id, stage: stage('setup_idempotency'), output: idempotentSetup.output };
    }
    if (challenge.runtime && challenge.checks) {
      const initial = await evaluateContract(container, { runtime: challenge.runtime, checks: challenge.checks });
      if (initial.outcome !== 'failed') {
        return { id: challenge.id, stage: stage('initial_checker'), output: `expected failed, received ${initial.outcome}` };
      }
    }
    const v2 = challenge.source === 'library-v2' ? getChallengeV2(challenge.id, challenge.challengeVersion) : undefined;
    const trustedSolution = solutionOverride ?? (v2 ? trustedSolutionForChallenge(v2) : challenge.referenceSolution);
    if (!trustedSolution) return { id: challenge.id, stage: stage('reference_solution'), output: 'trusted test solution missing' };
    const solution = await exec(container, trustedSolution);
    if (solution.exitCode !== 0) return { id: challenge.id, stage: stage('reference_solution'), output: solution.output };
    if (challenge.runtime && challenge.checks) {
      const contractCheck = await evaluateContract(container, { runtime: challenge.runtime, checks: challenge.checks });
      if (contractCheck.outcome !== 'passed') {
        return { id: challenge.id, stage: stage('contract_checker'), output: JSON.stringify(contractCheck.results) };
      }
      if (challenge.id === 'secure-secret') {
        const reset = await exec(container, 'chmod 0644 /workspace/secret.env');
        if (reset.exitCode !== 0) return { id: challenge.id, stage: 'alternative_reset', output: reset.output };
        const alternative = await exec(container, 'chmod u=rw,go= /workspace/secret.env');
        if (alternative.exitCode !== 0) return { id: challenge.id, stage: 'alternative_solution', output: alternative.output };
        const alternativeCheck = await evaluateContract(container, { runtime: challenge.runtime, checks: challenge.checks });
        if (alternativeCheck.outcome !== 'passed') {
          return { id: challenge.id, stage: 'alternative_checker', output: JSON.stringify(alternativeCheck.results) };
        }
        const identityProbe = await evaluateContract(container, checkerContract(linuxCoreRuntime, [
          { id: 'root-user', type: 'user_exists', user: 'root' },
          { id: 'root-group', type: 'group_exists', group: 'root' },
          { id: 'root-membership', type: 'user_in_group', user: 'root', group: 'root' },
          { id: 'curl-package', type: 'package_installed', package: 'curl' },
        ]));
        if (identityProbe.outcome !== 'passed') {
          return { id: challenge.id, stage: 'identity_runtime_probe', output: JSON.stringify(identityProbe.results) };
        }
      }
    }
    if (challenge.source === 'legacy') {
      const check = await exec(container, challenge.checkScript);
      if (check.exitCode !== 0) return { id: challenge.id, stage: stage('checker'), output: check.output };
    }
    return undefined;
  } catch (error) {
    return { id: challenge.id, stage: stage('container'), output: error instanceof Error ? error.message : String(error) };
  } finally {
    await container?.remove({ force: true, v: true }).catch(() => undefined);
  }
}

function getSandboxChallengeForIntegrity(id: string): SandboxChallenge | undefined {
  return listSandboxChallenges().find((challenge) => challenge.id === id && challenge.source === 'library-v2');
}

async function evaluateContract(container: Container, contract: ChallengeCheckerContract) {
  return new CheckerService().evaluate(
    contract,
    (argv, options) => execArgv(container, argv, options),
  );
}

async function execArgv(
  container: Container,
  argv: readonly string[],
  options: CheckerExecOptions,
): Promise<CheckerExecResult> {
  const execution = await container.exec({
    Cmd: ['/usr/bin/timeout', '--signal=KILL', `${Math.max(100, options.timeoutMs) / 1_000}s`, ...argv],
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });
  const stream = await execution.start({ hijack: true, stdin: false });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const chunks: Buffer[] = [];
  let captured = 0;
  let truncated = false;
  const capture = (include: boolean) => (chunk: Buffer) => {
    const buffer = Buffer.from(chunk);
    const remaining = Math.max(0, options.maxOutputBytes - captured);
    if (buffer.length > remaining) truncated = true;
    if (include && remaining > 0) chunks.push(buffer.subarray(0, remaining));
    captured += Math.min(buffer.length, remaining);
  };
  stdout.on('data', capture(true));
  stderr.on('data', capture(false));
  container.modem.demuxStream(stream, stdout, stderr);
  await new Promise<void>((resolve, reject) => {
    stream.once('end', resolve);
    stream.once('error', reject);
  });
  const state = await waitForExecution(execution);
  return { exitCode: state.ExitCode ?? 125, output: Buffer.concat(chunks).toString('utf8'), truncated };
}

async function exec(container: Container, script: string): Promise<{ exitCode: number; output: string }> {
  const execution = await container.exec({
    Cmd: ['/usr/bin/timeout', '15', '/bin/bash', '-lc', script],
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
  const state = await waitForExecution(execution);
  return { exitCode: state.ExitCode ?? 1, output: Buffer.concat(chunks).toString('utf8').slice(-2_000) };
}

async function waitForExecution(execution: Docker.Exec): Promise<Docker.ExecInspectInfo> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const inspection = await execution.inspect();
    if (!inspection.Running && inspection.ExitCode !== null) return inspection;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return execution.inspect();
}

function assertSecurityInvariants(host: Docker.ContainerInspectInfo['HostConfig']): void {
  if (host.NetworkMode !== 'none') throw new Error('network must be disabled');
  if (host.Privileged) throw new Error('privileged mode must be disabled');
  if (host.PublishAllPorts || Object.keys(host.PortBindings ?? {}).length > 0) throw new Error('published ports are forbidden');
  if ((host.Binds?.length ?? 0) > 0) throw new Error('host mounts are forbidden');
  if ((host.Devices?.length ?? 0) > 0) throw new Error('devices are forbidden');
  if (!(host.CapDrop ?? []).includes('ALL')) throw new Error('all capabilities must be dropped');
  if (!(host.SecurityOpt ?? []).includes('no-new-privileges:true')) throw new Error('no-new-privileges is required');
  if (!host.Memory || !host.NanoCpus || !host.PidsLimit) throw new Error('resource limits are required');
}

if (process.argv[1]?.endsWith('sandbox-integrity.js')) {
  runRealShellIntegrity({
    socketPath: process.env.SANDBOX_DOCKER_SOCKET ?? '/run/clirace-sandbox/docker.sock',
    image: process.env.SANDBOX_IMAGE ?? 'clirace-sandbox:0.2.0',
    concurrency: Number(process.env.SANDBOX_INTEGRITY_CONCURRENCY ?? 4),
  }).then(async (result) => {
    console.log(JSON.stringify(result, null, 2));
    if (process.env.DATABASE_URL) {
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, application_name: 'clirace-integrity' });
      try {
        const mainFailures = result.total - result.passed;
        await pool.query(`
          INSERT INTO admin_integrity_runs
            (source, total, passed, failed, duration_ms, failed_challenge_ids)
          VALUES ('production_deploy', $1, $2, $3, $4, $5::text[])
        `, [result.total, result.passed, mainFailures, result.durationMs, result.failed.map((failure) => failure.id)]);
      } finally {
        await pool.end();
      }
    }
    if (result.failed.length > 0) process.exitCode = 1;
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
