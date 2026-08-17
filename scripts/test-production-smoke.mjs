import assert from 'node:assert/strict';
import WebSocket from 'ws';

const base = (process.env.CLIRACE_URL ?? '').replace(/\/$/, '');
assert.ok(base.startsWith('https://'), 'Set CLIRACE_URL=https://your-domain.example');
const origin = new URL(base).origin;
const wsBase = origin.replace(/^https:/, 'wss:');
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const username = `prod_e2e_${suffix}`;
const password = 'Production-E2E-2026!';
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

async function runTerminal(ticket, marker) {
  const socket = new WebSocket(`${wsBase}${ticket.websocketPath}`, {
    headers: { Origin: origin, Cookie: cookie },
  });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Terminal timed out: ${output.slice(-500)}`)), 30_000);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'auth', token: ticket.token, cols: 100, rows: 28 })));
    socket.on('message', (data, binary) => {
      if (binary) {
        output += data.toString();
        if (output.includes(marker)) {
          clearTimeout(timer);
          resolve();
        }
        return;
      }
      const message = JSON.parse(data.toString());
      if (message.type === 'ready') {
        socket.send(JSON.stringify({ type: 'input', data: `printf '${marker}\\n'\r` }));
      }
    });
    socket.on('error', reject);
    socket.on('close', (code, reason) => {
      if (!output.includes(marker)) reject(new Error(`Terminal closed: ${code} ${reason.toString()}`));
    });
  });
  socket.close(1000, 'production_smoke_complete');
  await new Promise((resolve) => setTimeout(resolve, 750));
}

async function createSandboxTicketWithRetry() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await request('/api/sandbox/sessions', { method: 'POST', body: '{}' });
    const body = await response.json().catch(() => ({}));
    if (response.status === 201) return body;
    if (response.status !== 409) throw new Error(`Sandbox ticket failed: ${response.status} ${body.message ?? ''}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Previous sandbox session was not cleaned up.');
}

try {
  const frontend = await request('/');
  assert.equal(frontend.status, 200);
  assert.match(frontend.headers.get('strict-transport-security') ?? '', /max-age=/);
  assert.equal(frontend.headers.get('x-content-type-options'), 'nosniff');

  const health = await request('/api/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ready');
  const sandboxStatus = await request('/api/sandbox/status');
  assert.equal(sandboxStatus.status, 200);
  assert.equal((await sandboxStatus.json()).enabled, true);

  const registration = await request('/api/auth/register', {
    method: 'POST', body: JSON.stringify({ username, email: `${username}@example.test`, password }),
  });
  assert.equal(registration.status, 201);
  const registrationCookie = registration.headers.get('set-cookie') ?? '';
  assert.match(registrationCookie, /HttpOnly/i);
  assert.match(registrationCookie, /Secure/i);
  assert.match(registrationCookie, /SameSite=Lax/i);
  cookie = registrationCookie.split(';')[0];

  const logout = await request('/api/auth/logout', { method: 'POST' });
  assert.equal(logout.status, 204);
  cookie = '';
  const login = await request('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ identifier: username, password }),
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  assert.ok(cookie);
  const me = await request('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.username, username);

  const firstTicket = await createSandboxTicketWithRetry();
  await runTerminal(firstTicket, 'CLIRACE_PRODUCTION_OK');
  const secondTicket = await createSandboxTicketWithRetry();
  await runTerminal(secondTicket, 'CLIRACE_CLEANUP_OK');

  console.log(JSON.stringify({
    ok: true,
    url: base,
    https: true,
    authentication: true,
    secureCookie: true,
    terminalWebSocket: true,
    shellCommand: true,
    sessionCleanup: true,
  }, null, 2));
} finally {
  if (cookie) {
    await request('/api/auth/account', { method: 'DELETE', body: JSON.stringify({ password }) }).catch(() => undefined);
  }
}
