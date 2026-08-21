import Docker, { type Container } from 'dockerode';
import { listSandboxChallenges, type SandboxChallenge } from './sandbox-challenges.js';

interface IntegrityResult {
  total: number;
  passed: number;
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
  return {
    total: challenges.length,
    passed: challenges.length - failed.length,
    failed,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

async function verifyChallenge(
  docker: Docker,
  image: string,
  challenge: SandboxChallenge,
): Promise<{ id: string; stage: string; output: string } | undefined> {
  let container: Container | undefined;
  try {
    container = await docker.createContainer({
      Image: image,
      Cmd: ['/bin/bash', '-lc', `set -e\n${challenge.setupScript}\ntouch /tmp/clirace-integrity-ready\nexec sleep 120`],
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
    if (ready.exitCode !== 0) return { id: challenge.id, stage: 'setup', output: ready.output };
    const inspection = await container.inspect();
    assertSecurityInvariants(inspection.HostConfig);
    const solution = await exec(container, challenge.referenceSolution);
    if (solution.exitCode !== 0) return { id: challenge.id, stage: 'reference_solution', output: solution.output };
    const check = await exec(container, challenge.checkScript);
    if (check.exitCode !== 0) return { id: challenge.id, stage: 'checker', output: check.output };
    return undefined;
  } catch (error) {
    return { id: challenge.id, stage: 'container', output: error instanceof Error ? error.message : String(error) };
  } finally {
    await container?.remove({ force: true, v: true }).catch(() => undefined);
  }
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
  }).then((result) => {
    console.log(JSON.stringify(result, null, 2));
    if (result.failed.length > 0) process.exitCode = 1;
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
