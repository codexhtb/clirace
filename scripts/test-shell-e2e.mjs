import WebSocket from 'ws';

const base = process.env.CLIRACE_URL ?? 'http://localhost:8080';
const origin = new URL(base).origin;
const wsBase = origin.replace(/^http/, 'ws');
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const username = `shell_e2e_${suffix}`;
const password = 'Shell-E2E-2026!';
let cookie = '';

async function request(path, options = {}) {
  return fetch(`${base}${path}`, {
    ...options,
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  });
}

try {
  const registration = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, email: `${username}@example.test`, password }),
  });
  if (!registration.ok) throw new Error(`Registration failed: ${registration.status}`);
  cookie = registration.headers.get('set-cookie')?.split(';')[0] ?? '';
  if (!cookie) throw new Error('Registration did not return an auth cookie.');

  const session = await request('/api/sandbox/sessions', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  const ticket = await session.json().catch(() => ({}));
  if (session.status !== 201) throw new Error(`Sandbox ticket failed: ${session.status} ${ticket.message ?? ''}`);

  const socket = new WebSocket(`${wsBase}${ticket.websocketPath}`, {
    headers: { Origin: origin, Cookie: cookie },
  });
  let ready = false;
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Shell timed out. Output: ${output.slice(-500)}`)), 30_000);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'auth', token: ticket.token, cols: 100, rows: 28 })));
    socket.on('message', (data, binary) => {
      if (binary) {
        output += data.toString();
        if (output.includes('SHELL_E2E_OK')) {
          clearTimeout(timer);
          resolve();
        }
        return;
      }
      const message = JSON.parse(data.toString());
      if (message.type === 'ready' && !ready) {
        ready = true;
        socket.send(JSON.stringify({ type: 'input', data: "printf 'SHELL_E2E_OK\\n'\r" }));
      }
    });
    socket.on('error', reject);
    socket.on('close', (code, reason) => {
      if (!output.includes('SHELL_E2E_OK')) reject(new Error(`Shell closed: ${code} ${reason.toString()}`));
    });
  });
  socket.close(1000, 'e2e_done');

  console.log(JSON.stringify({
    ok: true,
    sessionId: ticket.sessionId,
    challenge: ticket.challenge?.id,
    commandExecuted: true,
  }, null, 2));
} finally {
  if (cookie) {
    await request('/api/auth/account', { method: 'DELETE', body: JSON.stringify({ password }) }).catch(() => undefined);
  }
}
