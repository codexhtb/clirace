import type { ChallengeChecker } from '../checker-contract.js';
import type { ChallengeV2 } from './model.js';

/**
 * Trusted content-test fixture. This module is imported only by integrity tests;
 * it is never referenced by an HTTP route or serialized into challenge metadata.
 */
export function trustedSolutionForChallenge(challenge: ChallengeV2): string {
  return [
    'set -euo pipefail',
    ...challenge.checks.flatMap(solutionForChecker),
  ].join('\n');
}

export const alternativeSolutionFixtures: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  'filesystem-build-release-tree': [
    'mkdir -p /workspace/releases/2026-08/assets /workspace/releases/2026-08/config',
    'mkdir -p /workspace/releases/2026-08/{assets,config}',
  ],
  'filesystem-switch-current-release': [
    'ln -sfn /workspace/releases/v2 /workspace/current',
    'rm -f /workspace/current && ln -s /workspace/releases/v2 /workspace/current',
  ],
  'permissions-lock-private-key': [
    'chmod 600 /workspace/keys/deploy.key',
    'chmod u=rw,go= /workspace/keys/deploy.key',
  ],
  'permissions-secure-secret-layout': [
    'chmod 700 /workspace/secrets && chmod 600 /workspace/secrets/credentials.ini',
    'chmod u=rwx,go= /workspace/secrets && chmod u=rw,go= /workspace/secrets/credentials.ini',
  ],
  'users-add-deploy-to-releases': [
    'usermod -aG releases deploy',
    'gpasswd -a deploy releases',
  ],
  'process-stop-stalled-worker': [
    'kill "$(cat /workspace/run/worker.pid)"',
    'pkill -x sleep',
  ],
  'networking-start-local-tcp-service': [
    "python3 -m http.server 18200 --bind 127.0.0.1 >/dev/null 2>&1 &",
    "python3 -c 'import socket,time;s=socket.socket();s.bind((\"127.0.0.1\",18200));s.listen();time.sleep(900)' >/dev/null 2>&1 &",
  ],
  'text-extract-failing-client-ip': [
    "awk '$4 == 503 {print $1}' /workspace/logs/access.log > /workspace/result.txt",
    "grep ' 503$' /workspace/logs/access.log | cut -d' ' -f1 > /workspace/result.txt",
  ],
  'shell-build-unique-user-pipeline': [
    "cut -d' ' -f1 /workspace/events.log | sort -u > /workspace/event-users.txt",
    "awk '{print $1}' /workspace/events.log | sort | uniq > /workspace/event-users.txt",
  ],
  'packages-audit-bash-runtime': [
    "dpkg-query -W bash >/dev/null && printf 'bash=installed\\n' > /workspace/package-status.txt",
    "dpkg -s bash >/dev/null && echo bash=installed > /workspace/package-status.txt",
  ],
});

function solutionForChecker(checker: ChallengeChecker): string[] {
  switch (checker.type) {
    case 'file_exists': {
      if (checker.kind === 'directory') return [`mkdir -p -- ${quote(checker.path)}`];
      return [ensureParent(checker.path), `touch -- ${quote(checker.path)}`];
    }
    case 'file_not_exists':
      return [`rm -rf -- ${quote(checker.path)}`];
    case 'file_contains': {
      const payload = Buffer.from(`${checker.expected}\n`, 'utf8').toString('base64');
      return [ensureParent(checker.path), `printf %s ${quote(payload)} | base64 -d >> ${quote(checker.path)}`];
    }
    case 'permission_equals':
      return [ensureParent(checker.path), `touch -- ${quote(checker.path)}`, `chmod ${checker.mode} -- ${quote(checker.path)}`];
    case 'owner_equals':
      if (checker.user === 'root' && (!checker.group || checker.group === 'root')) {
        return [ensureParent(checker.path), `touch -- ${quote(checker.path)}`];
      }
      return [ensureParent(checker.path), `touch -- ${quote(checker.path)}`, `chown -- ${quote(`${checker.user}${checker.group ? `:${checker.group}` : ''}`)} ${quote(checker.path)}`];
    case 'symlink_points_to':
      return [ensureParent(checker.path), `ln -sfn -- ${quote(checker.target)} ${quote(checker.path)}`];
    case 'user_exists':
      return [`id -u ${quote(checker.user)} >/dev/null 2>&1 || useradd -M -s /bin/bash -- ${quote(checker.user)}`];
    case 'group_exists':
      return [`getent group ${quote(checker.group)} >/dev/null || groupadd -- ${quote(checker.group)}`];
    case 'user_in_group':
      return [
        `getent group ${quote(checker.group)} >/dev/null || groupadd -- ${quote(checker.group)}`,
        `id -u ${quote(checker.user)} >/dev/null 2>&1 || useradd -M -s /bin/bash -- ${quote(checker.user)}`,
        `id -nG ${quote(checker.user)} | tr ' ' '\\n' | grep -Fxq -- ${quote(checker.group)} || usermod -aG ${quote(checker.group)} -- ${quote(checker.user)}`,
      ];
    case 'process_running':
      if (checker.process === 'sleep') return ['sleep 900 </dev/null >/dev/null 2>&1 &'];
      if (checker.process === 'tail') return ['tail -f /dev/null </dev/null >/dev/null 2>&1 &'];
      return ["python3 -c 'import time;time.sleep(900)' </dev/null >/dev/null 2>&1 &"];
    case 'process_not_running':
      return [`pkill -x -- ${quote(checker.process)} 2>/dev/null || true`, 'sleep 0.05'];
    case 'port_listening':
      return [trustedListenerCommand(checker.protocol, checker.port, checker.bindAddress ?? '127.0.0.1')];
    case 'package_installed':
      return [`dpkg-query -W ${quote(checker.package)} >/dev/null`];
  }
}

function trustedListenerCommand(protocol: 'tcp' | 'udp', port: number, bindAddress: string): string {
  const socketType = protocol === 'udp' ? 'SOCK_DGRAM' : 'SOCK_STREAM';
  const listen = protocol === 'udp' ? '' : ';s.listen(8)';
  const program = `import socket,time;s=socket.socket(socket.AF_INET,socket.${socketType});s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind((${JSON.stringify(bindAddress)},${port}))${listen};time.sleep(900)`;
  return `python3 -c ${quote(program)} </dev/null >/dev/null 2>&1 &`;
}

function ensureParent(path: string): string {
  const parent = path.slice(0, path.lastIndexOf('/')) || '/workspace';
  return `mkdir -p -- ${quote(parent)}`;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
