import type { ChallengeSetupOperation, ChallengeV2 } from './model.js';

export function compileDeclarativeSetup(setup: ChallengeV2['setup']): string {
  return [
    'set -euo pipefail',
    ...setup.operations.map(compileOperation),
  ].join('\n');
}

function compileOperation(operation: ChallengeSetupOperation): string {
  switch (operation.type) {
    case 'create_directory':
      return `install -d${operation.mode ? ` -m ${operation.mode}` : ''} -- ${quote(operation.path)}`;
    case 'create_file': {
      const parent = operation.path.slice(0, operation.path.lastIndexOf('/')) || '/workspace';
      const payload = Buffer.from(operation.content, 'utf8').toString('base64');
      return [
        `install -d -- ${quote(parent)}`,
        `printf %s ${quote(payload)} | base64 -d > ${quote(operation.path)}`,
        ...(operation.mode ? [`chmod ${operation.mode} -- ${quote(operation.path)}`] : []),
      ].join('\n');
    }
    case 'create_sized_file': {
      const parent = operation.path.slice(0, operation.path.lastIndexOf('/')) || '/workspace';
      return [
        `install -d -- ${quote(parent)}`,
        `truncate -s ${operation.sizeBytes} -- ${quote(operation.path)}`,
        ...(operation.mode ? [`chmod ${operation.mode} -- ${quote(operation.path)}`] : []),
      ].join('\n');
    }
    case 'remove_path':
      return `rm -rf -- ${quote(operation.path)}`;
    case 'symlink': {
      const parent = operation.path.slice(0, operation.path.lastIndexOf('/')) || '/workspace';
      return `install -d -- ${quote(parent)}\nln -sfn -- ${quote(operation.target)} ${quote(operation.path)}`;
    }
    case 'set_permissions':
      return `chmod ${operation.mode} -- ${quote(operation.path)}`;
    case 'set_owner':
      return `chown -- ${quote(`${operation.user}${operation.group ? `:${operation.group}` : ''}`)} ${quote(operation.path)}`;
    case 'create_group':
      return `getent group ${quote(operation.group)} >/dev/null || groupadd -- ${quote(operation.group)}`;
    case 'create_user':
      return `id -u ${quote(operation.user)} >/dev/null 2>&1 || useradd -M -s /bin/bash${operation.primaryGroup ? ` -g ${quote(operation.primaryGroup)}` : ''} -- ${quote(operation.user)}`;
    case 'add_user_to_group':
      return `id -nG ${quote(operation.user)} | tr ' ' '\\n' | grep -Fxq -- ${quote(operation.group)} || usermod -aG ${quote(operation.group)} -- ${quote(operation.user)}`;
    case 'start_trusted_process':
      return compileTrustedProcess(operation);
    case 'start_trusted_listener':
      return compileTrustedListener(operation);
  }
}

function compileTrustedProcess(operation: Extract<ChallengeSetupOperation, { type: 'start_trusted_process' }>): string {
  const argv = operation.processId === 'idle-worker-v1'
    ? 'sleep 900'
    : 'tail -f /dev/null';
  return backgroundProcess(argv, operation.pidFile);
}

function compileTrustedListener(operation: Extract<ChallengeSetupOperation, { type: 'start_trusted_listener' }>): string {
  const host = quote(operation.bindAddress);
  const port = String(operation.port);
  if (operation.listenerId === 'http-status-v1') {
    const python = [
      'import http.server,socketserver',
      `class H(http.server.BaseHTTPRequestHandler):`,
      ` def do_GET(self): self.send_response(200); self.end_headers(); self.wfile.write(b"CLIRace status: ready\\n")`,
      ` def log_message(self,*args): pass`,
      `socketserver.TCPServer((${JSON.stringify(operation.bindAddress)},${port}),H).serve_forever()`,
    ].join('\n');
    return backgroundProcess(`python3 -c ${quote(python)}`, operation.pidFile);
  }
  const protocol = operation.listenerId === 'udp-listener-v1' ? 'SOCK_DGRAM' : 'SOCK_STREAM';
  const listen = operation.listenerId === 'udp-listener-v1' ? '' : ';s.listen(8)';
  const python = `import socket,time;s=socket.socket(socket.AF_INET,socket.${protocol});s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind((${host},${port}))${listen};time.sleep(900)`;
  return backgroundProcess(`python3 -c ${quote(python)}`, operation.pidFile);
}

function backgroundProcess(argv: string, pidFile: string): string {
  const parent = pidFile.slice(0, pidFile.lastIndexOf('/')) || '/workspace';
  return [
    `install -d -- ${quote(parent)}`,
    `if [ -s ${quote(pidFile)} ] && kill -0 "$(cat ${quote(pidFile)})" 2>/dev/null; then :`,
    'else',
    `  ${argv} </dev/null >/dev/null 2>&1 &`,
    `  printf '%s\\n' "$!" > ${quote(pidFile)}`,
    'fi',
  ].join('\n');
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
