import assert from 'node:assert/strict';
import WebSocket from 'ws';

const base = (process.env.CLIRACE_URL ?? '').replace(/\/$/, '');
assert.ok(base.startsWith('https://'), 'Set CLIRACE_URL=https://your-domain.example');
const origin = new URL(base).origin;
const wsBase = origin.replace(/^https:/, 'wss:');
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const usernameA = `rpl_${suffix}`;
const usernameB = `rpb_${suffix}`;
const password = 'Replay-E2E-2026!';
let cookieA = '';
let cookieB = '';

async function request(path, options = {}, cookie = cookieA) {
  return fetch(`${base}${path}`, {
    ...options,
    headers: { origin, ...(cookie ? { cookie } : {}), ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers ?? {}) },
  });
}

async function body(response, expected, label) {
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `${label}: ${response.status} ${payload.message ?? payload.error ?? ''}`);
  return payload;
}

async function register(username) {
  const response = await request('/api/auth/register', {
    method: 'POST', body: JSON.stringify({ username, email: `${username}@replay-e2e.invalid`, password }),
  }, '');
  assert.equal(response.status, 201);
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
  assert.ok(cookie);
  return cookie;
}

async function startSecureSecret(cookie = cookieA) {
  const game = await body(await request('/api/game/sessions', {
    method: 'POST', body: JSON.stringify({ category: 'all', difficulty: 'all', mode: 'real_shell', taskCount: 5, challengeSlug: 'shell-secure-secret' }),
  }, cookie), 201, 'create replay game');
  const ticket = await body(await request('/api/sandbox/sessions', {
    method: 'POST', body: JSON.stringify({ gameSessionId: game.session.id }),
  }, cookie), 201, 'create replay sandbox');
  return { game, ticket };
}

async function openTerminal(ticket, cookie = cookieA) {
  const socket = new WebSocket(`${wsBase}${ticket.websocketPath}`, { headers: { Origin: origin, Cookie: cookie } });
  let output = '';
  const messages = [];
  const listeners = new Set();
  const notify = () => { for (const listener of listeners) listener(); };
  socket.on('message', (data, binary) => {
    if (binary) output += data.toString();
    else messages.push(JSON.parse(data.toString()));
    notify();
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('terminal open timeout')), 15_000);
    socket.once('open', () => {
      clearTimeout(timer);
      socket.send(JSON.stringify({ type: 'auth', token: ticket.token, cols: 100, rows: 28 }));
      resolve();
    });
    socket.once('error', reject);
  });
  const wait = (predicate, label, timeout = 30_000) => new Promise((resolve, reject) => {
    const evaluate = () => {
      const value = predicate({ output, messages });
      if (value !== undefined && value !== false) {
        clearTimeout(timer);
        listeners.delete(evaluate);
        resolve(value);
      }
    };
    const timer = setTimeout(() => { listeners.delete(evaluate); reject(new Error(`${label} timeout; output=${output.slice(-300)}`)); }, timeout);
    listeners.add(evaluate);
    evaluate();
  });
  await wait(({ messages: items }) => items.find((item) => item.type === 'ready'), 'ready');
  return {
    socket,
    input: (data) => socket.send(JSON.stringify({ type: 'input', data })),
    check: () => socket.send(JSON.stringify({ type: 'check' })),
    waitOutput: (marker, count = 1, timeout) => wait(({ output: value }) => value.split(marker).length - 1 >= count ? value : undefined, marker, timeout),
    waitCheck: (after = 0) => wait(({ messages: items }) => items.filter((item) => item.type === 'check_result').slice(after)[0], 'check_result'),
    close: () => new Promise((resolve) => { socket.once('close', resolve); socket.close(1000, 'reconnect_test'); }),
  };
}

async function completeRegularReplay() {
  const { game, ticket } = await startSecureSecret();
  const first = await openTerminal(ticket);
  first.input("printf 'CLIRACE_REPLAY_TEST_VALUE\\n'; printf 'REPLAY_A_DONE\\n'\r");
  await first.waitOutput('REPLAY_A_DONE', 2);
  await first.close();

  const reconnectTicket = await body(await request('/api/sandbox/sessions', {
    method: 'POST', body: JSON.stringify({ gameSessionId: game.session.id }),
  }), 201, 'reconnect replay sandbox');
  assert.equal(reconnectTicket.sessionId, ticket.sessionId, 'reconnect must retain the authoritative sandbox session');
  const second = await openTerminal(reconnectTicket);
  second.input("stty -echo; read SECRET; stty echo; printf '\\nHIDDEN_DONE\\n'\r");
  await second.waitOutput('HIDDEN_DONE');
  second.input('CLIRACE_HIDDEN_TEST\r');
  await second.waitOutput('HIDDEN_DONE', 2);
  second.input("printf 'REPLAY_B_DONE\\n'\r");
  await second.waitOutput('REPLAY_B_DONE', 2);
  second.check();
  const failed = await second.waitCheck(0);
  assert.equal(failed.passed, false);
  second.input("chmod u=rw,go= /workspace/secret.env && printf 'SOLUTION_READY\\n'\r");
  await second.waitOutput('SOLUTION_READY', 2);
  second.check();
  const passed = await second.waitCheck(1);
  assert.equal(passed.passed, true);
  assert.ok(passed.replayId);

  const replay = (await body(await request(`/api/practice/replays/${passed.replayId}`), 200, 'owner replay GET')).replay;
  const visible = replay.payload.events.filter((event) => event.type === 'output').map((event) => Buffer.from(event.data, 'base64').toString()).join('');
  assert.equal(visible.split('REPLAY_A_DONE').length - 1, 2, 'reconnect duplicated command A output');
  assert.equal(visible.split('REPLAY_B_DONE').length - 1, 2, 'reconnect duplicated command B output');
  assert.ok(visible.includes('CLIRACE_REPLAY_TEST_VALUE'));
  assert.ok(!visible.includes('CLIRACE_HIDDEN_TEST'), 'no-echo input leaked into replay');
  assert.ok(replay.payload.events.every((event) => event.type !== 'input'));
  assert.ok(replay.payload.events.some((event) => event.type === 'checker' && event.status === 'failed'));
  assert.ok(replay.payload.events.some((event) => event.type === 'checker' && event.status === 'passed'));
  assert.ok(replay.payload.events.some((event) => event.type === 'completed'));
  return { replayId: passed.replayId, replay, game };
}

async function completeTruncatedReplay() {
  const { ticket } = await startSecureSecret();
  const terminal = await openTerminal(ticket);
  terminal.input("for i in $(seq 1 70); do yes X | head -c 8192; sleep 0.04; done; printf '\\nTRUNC_DONE\\n'\r");
  await terminal.waitOutput('TRUNC_DONE', 2, 45_000);
  terminal.check();
  const failed = await terminal.waitCheck(0);
  assert.equal(failed.passed, false);
  terminal.input("chmod 600 /workspace/secret.env && printf 'TRUNC_SOLUTION_READY\\n'\r");
  await terminal.waitOutput('TRUNC_SOLUTION_READY', 2);
  terminal.check();
  const passed = await terminal.waitCheck(1);
  assert.equal(passed.passed, true);
  const replay = (await body(await request(`/api/practice/replays/${passed.replayId}`), 200, 'truncated replay GET')).replay;
  assert.equal(replay.truncated, true);
  assert.ok(replay.payload.events.some((event) => event.type === 'checker' && event.status === 'passed'));
  assert.ok(replay.payload.events.some((event) => event.type === 'completed'));
  await body(await request(`/api/practice/replays/${passed.replayId}`, { method: 'DELETE' }), 204, 'delete truncated replay');
  return replay;
}

try {
  cookieA = await register(usernameA);
  cookieB = await register(usernameB);
  const regular = await completeRegularReplay();
  assert.equal((await request(`/api/practice/replays/${regular.replayId}`, {}, cookieB)).status, 404, 'other user read must be hidden');
  assert.equal((await request(`/api/practice/replays/${regular.replayId}`, { method: 'DELETE' }, cookieB)).status, 204, 'other user delete remains non-enumerating');
  assert.equal((await request(`/api/practice/replays/${regular.replayId}`)).status, 200, 'other user delete must not remove owner replay');
  assert.equal((await request(`/practice/replay/${regular.replayId}`)).status, 200, 'SPA replay route must resolve');
  await body(await request(`/api/practice/replays/${regular.replayId}`, { method: 'DELETE' }), 204, 'owner replay delete');
  assert.equal((await request(`/api/practice/replays/${regular.replayId}`)).status, 404);
  const truncated = await completeTruncatedReplay();
  console.log(JSON.stringify({
    ok: true,
    reconnectSameSession: true,
    rawInputEvents: false,
    hiddenInputAbsent: true,
    checkerMarkers: ['failed', 'passed'],
    completionMarker: true,
    ownerOnly: true,
    deleteVerified: true,
    truncated: truncated.truncated,
    truncatedBytes: truncated.sizeBytes,
    truncatedEvents: truncated.eventCount,
  }, null, 2));
} finally {
  if (cookieB) await request('/api/auth/account', { method: 'DELETE', body: JSON.stringify({ password }) }, cookieB).catch(() => undefined);
  if (cookieA) await request('/api/auth/account', { method: 'DELETE', body: JSON.stringify({ password }) }, cookieA).catch(() => undefined);
}

