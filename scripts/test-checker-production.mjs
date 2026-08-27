import assert from 'node:assert/strict';
import WebSocket from 'ws';

const base = (process.env.CLIRACE_URL ?? '').replace(/\/$/, '');
assert.ok(base.startsWith('https://'), 'Set CLIRACE_URL=https://your-domain.example');
const origin = new URL(base).origin;
const wsBase = origin.replace(/^https:/, 'wss:');
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const username = `checker_e2e_${suffix}`;
const password = 'Checker-E2E-2026!';
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

async function json(response, expected, label) {
  const body = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `${label}: ${response.status} ${body.message ?? body.error ?? ''}`);
  return body;
}

try {
  const registration = await request('/api/auth/register', {
    method: 'POST', body: JSON.stringify({ username, email: `${username}@e2e.invalid`, password }),
  });
  assert.equal(registration.status, 201);
  cookie = (registration.headers.get('set-cookie') ?? '').split(';')[0];
  assert.ok(cookie, 'registration returned an auth cookie');

  const game = await json(await request('/api/game/sessions', {
    method: 'POST',
    body: JSON.stringify({ category: 'all', difficulty: 'all', mode: 'real_shell', taskCount: 5, challengeSlug: 'shell-secure-secret' }),
  }), 201, 'create checker game');
  assert.equal(game.task.slug, 'shell-secure-secret');

  const ticket = await json(await request('/api/sandbox/sessions', {
    method: 'POST', body: JSON.stringify({ gameSessionId: game.session.id }),
  }), 201, 'create checker sandbox');
  assert.equal(ticket.challenge.id, 'secure-secret');

  const observations = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`${wsBase}${ticket.websocketPath}`, { headers: { Origin: origin, Cookie: cookie } });
    const state = { failed: undefined, passed: undefined, repeated: undefined };
    let output = '';
    let commandSent = false;
    let solutionCheckSent = false;
    let secondCheckSent = false;
    const timer = setTimeout(() => reject(new Error(`Checker E2E timed out. Output: ${output.slice(-500)}`)), 45_000);
    const finish = () => {
      clearTimeout(timer);
      socket.close(1000, 'checker_e2e_complete');
      resolve(state);
    };
    socket.on('open', () => socket.send(JSON.stringify({ type: 'auth', token: ticket.token, cols: 100, rows: 28 })));
    socket.on('message', (data, binary) => {
      if (binary) {
        output += data.toString();
        if (commandSent && output.includes('CHECKER_SOLUTION_READY') && !solutionCheckSent) {
          solutionCheckSent = true;
          socket.send(JSON.stringify({ type: 'check' }));
        }
        return;
      }
      const message = JSON.parse(data.toString());
      if (message.type === 'ready') socket.send(JSON.stringify({ type: 'check' }));
      if (message.type !== 'check_result') return;
      if (!state.failed) {
        state.failed = message;
        assert.equal(message.passed, false);
        assert.equal(message.error, false);
        assert.ok(Array.isArray(message.checks) && message.checks.some((check) => check.passed === false));
        commandSent = true;
        socket.send(JSON.stringify({ type: 'input', data: "chmod u=rw,go= /workspace/secret.env && printf 'CHECKER_SOLUTION_READY\\n'\r" }));
        return;
      }
      if (!state.passed) {
        state.passed = message;
        assert.equal(message.passed, true);
        assert.ok(message.scoreAwarded > 0);
        secondCheckSent = true;
        socket.send(JSON.stringify({ type: 'check' }));
        return;
      }
      if (secondCheckSent) {
        state.repeated = message;
        assert.equal(message.passed, true);
        assert.equal(message.scoreAwarded, state.passed.scoreAwarded);
        assert.equal(message.alreadyCompleted, true);
        finish();
      }
    });
    socket.on('error', reject);
    socket.on('close', (code, reason) => {
      if (!state.repeated) reject(new Error(`Checker socket closed early: ${code} ${reason.toString()}`));
    });
  });

  await new Promise((resolve) => setTimeout(resolve, 1_800));
  const persisted = await json(await request(`/api/game/sessions/${game.session.id}`), 200, 'reload checker game');
  assert.equal(persisted.session.status, 'completed');
  assert.equal(persisted.session.score, observations.passed.scoreAwarded);

  console.log(JSON.stringify({
    ok: true,
    challenge: ticket.challenge.id,
    initialFailure: true,
    solvedByAlternativeCommand: true,
    declarativeChecks: observations.passed.checks.length,
    repeatedCompletionIdempotent: true,
    persistedScore: persisted.session.score,
  }, null, 2));
} finally {
  if (cookie) {
    await request('/api/auth/account', { method: 'DELETE', body: JSON.stringify({ password }) }).catch(() => undefined);
  }
}
