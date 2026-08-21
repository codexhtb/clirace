import WebSocket from 'ws';

const base = process.env.CLIRACE_URL ?? 'http://localhost:8080';
const origin = new URL(base).origin;
const wsBase = origin.replace(/^http/, 'ws');
const entry = process.env.CLIRACE_BATTLE_ENTRY === 'matchmaking' ? 'matchmaking' : 'private';
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const password = 'Battle-E2E-2026!';

class UserClient {
  constructor(username) { this.username = username; this.cookie = ''; }
  async register() {
    const response = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ username: this.username, email: `${this.username}@example.test`, password }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`register ${this.username}: ${response.status} ${body.message ?? ''}`);
    this.cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
    if (!this.cookie) throw new Error('Registration did not return an auth cookie.');
  }
  async request(path, options = {}) {
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: { origin, cookie: this.cookie, ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers ?? {}) },
    });
    const body = response.status === 204 ? null : await response.json().catch(() => ({}));
    return { response, body };
  }
  async delete() {
    if (!this.cookie) return;
    await this.request('/api/auth/account', { method: 'DELETE', body: JSON.stringify({ password }) }).catch(() => undefined);
  }
}

class JsonSocket {
  constructor(socket) {
    this.socket = socket;
    this.messages = [];
    this.waiters = [];
    socket.on('message', (data, binary) => {
      if (binary) return;
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      this.messages.push(message);
      if (message.type === 'battle:state' && message.state) this.state = message.state;
      const pending = this.waiters.splice(0);
      for (const waiter of pending) {
        if (waiter.predicate(message, this)) waiter.resolve(message);
        else this.waiters.push(waiter);
      }
    });
    socket.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      const pending = this.waiters.splice(0);
      for (const waiter of pending) waiter.reject(new Error(`WebSocket closed: ${code} ${reason.toString()}`));
    });
  }
  send(payload) { this.socket.send(JSON.stringify(payload)); }
  waitFor(predicate, timeout = 20_000) {
    const existing = this.messages.find((message) => predicate(message, this));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`WebSocket wait timed out. Last state: ${JSON.stringify(this.state ?? null)}`));
      }, timeout);
      const originalResolve = waiter.resolve;
      waiter.resolve = (value) => { clearTimeout(timer); originalResolve(value); };
    });
  }
  close() { if (this.socket.readyState < WebSocket.CLOSING) this.socket.close(1000, 'e2e_done'); }
}

async function openSocket(path, user, authMessage) {
  const socket = new WebSocket(`${wsBase}${path}`, { headers: { Origin: origin, ...(user ? { Cookie: user.cookie } : {}) } });
  const client = new JsonSocket(socket);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  if (authMessage) client.send(authMessage);
  return client;
}

async function getTerminal(user, roomCode) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { response, body } = await user.request(`/api/battles/${roomCode}/terminal`, { method: 'POST' });
    if (response.ok) return body;
    if (response.status !== 409) throw new Error(`terminal ticket: ${response.status} ${body.message ?? ''}`);
    await delay(350);
  }
  throw new Error('Terminal ticket stayed unavailable.');
}

async function openTerminal(user, ticket) {
  const terminal = await openSocket(ticket.websocketPath, user, { type: 'auth', token: ticket.token, cols: 100, rows: 28 });
  const ready = await terminal.waitFor((message) => message.type === 'ready', 30_000);
  return { terminal, ready };
}

async function solveRound(terminal, slug) {
  const command = commands[slug];
  if (!command) throw new Error(`No E2E solution for ${slug}`);
  terminal.send({ type: 'input', data: `${command}\r` });
  await delay(300);
  terminal.send({ type: 'check' });
  const result = await terminal.waitFor((message) => message.type === 'check_result', 15_000);
  if (!result.passed) throw new Error(`Challenge ${slug} did not pass: ${result.message ?? ''}`);
}

const commands = {
  'shell-first-story-line': 'head -n 1 /workspace/story.txt > /workspace/answer.txt',
  'shell-banana-count': "grep -c '^banana$' /workspace/fruits.txt > /workspace/answer.txt",
  'shell-sort-pets': 'sort /workspace/pets.txt > /workspace/sorted.txt',
  'shell-rainbow-files': 'cat /workspace/red.txt /workspace/blue.txt > /workspace/rainbow.txt',
  'shell-name-robot': "echo 'BEEP-42' > /workspace/robot.txt",
  'shell-feed-dragon': "echo 'pizza' >> /workspace/dragon-menu.txt",
  'shell-make-playlist': 'cat /workspace/song-a.txt /workspace/song-b.txt > /workspace/playlist.txt',
  'shell-count-stars': 'wc -l < /workspace/stars.txt > /workspace/answer.txt',
  'shell-find-unicorn': 'grep unicorn /workspace/zoo.txt > /workspace/found.txt',
  'shell-shout-message': "tr 'a-z' 'A-Z' < /workspace/whisper.txt > /workspace/shout.txt",
  'shell-last-cookie': 'tail -n 1 /workspace/cookies.txt > /workspace/last.txt',
  'shell-first-planets': 'head -n 3 /workspace/planets.txt > /workspace/first.txt',
  'shell-csv-names': "cut -d',' -f1 /workspace/players.csv > /workspace/names.txt",
  'shell-unique-colors': 'sort -u /workspace/colors.txt > /workspace/unique.txt',
  'shell-replace-moon': "sed -i 's/moon/mars/' /workspace/sky.txt",
  'shell-archive-logs': 'cd /workspace && tar -czf logs.tar.gz logs',
  'shell-production-config': "sed -i 's/debug=true/debug=false/' /workspace/app.conf",
  'shell-filter-json': "jq -r '.[] | select(.enabled) | .name' /workspace/services.json > /workspace/enabled.txt",
  'shell-rename-backups': "for f in /workspace/backups/*.conf.bak; do mv \"$f\" \"${f%.bak}\"; done",
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const a = new UserClient(`${entry === 'matchmaking' ? 'match_a' : 'battle_a'}_${suffix}`.slice(0, 24));
const b = new UserClient(`${entry === 'matchmaking' ? 'match_b' : 'battle_b'}_${suffix}`.slice(0, 24));
const sockets = [];
let roomCode;

try {
  await Promise.all([a.register(), b.register()]);
  console.log('[battle-e2e] users registered');
  let matchmakingBattleId;
  if (entry === 'matchmaking') {
    const duplicateEnqueue = await Promise.all([
      a.request('/api/matchmaking/queue', { method: 'POST' }),
      a.request('/api/matchmaking/queue', { method: 'POST' }),
    ]);
    if (duplicateEnqueue.some(({ response }) => !response.ok)) throw new Error('Idempotent matchmaking enqueue failed.');
    const secondEnqueue = await b.request('/api/matchmaking/queue', { method: 'POST' });
    if (!secondEnqueue.response.ok) throw new Error(`second matchmaking enqueue: ${secondEnqueue.response.status} ${secondEnqueue.body.message ?? ''}`);
    const [statusA, statusB] = await Promise.all([waitForMatch(a), waitForMatch(b)]);
    if (statusA.battleId !== statusB.battleId || statusA.roomCode !== statusB.roomCode) {
      throw new Error(`Players received different matches: ${JSON.stringify(statusA)} / ${JSON.stringify(statusB)}`);
    }
    if (statusA.opponent?.username !== b.username || statusB.opponent?.username !== a.username) {
      throw new Error('Matchmaking returned the wrong opponents.');
    }
    matchmakingBattleId = statusA.battleId;
    roomCode = statusA.roomCode;
    const [stateA, stateB] = await Promise.all([
      a.request(`/api/battles/${roomCode}`),
      b.request(`/api/battles/${roomCode}`),
    ]);
    if (!stateA.response.ok || !stateB.response.ok || stateA.body.battle.players.length !== 2 || stateB.body.battle.id !== matchmakingBattleId) {
      throw new Error('Matched Battle is not available to both players.');
    }
    console.log(`[matchmaking-e2e] exactly one Battle ${matchmakingBattleId} / ${roomCode}`);
  } else {
    const created = await a.request('/api/battles', { method: 'POST', body: JSON.stringify({ rounds: 3, category: 'bash' }) });
    if (!created.response.ok) throw new Error(`create battle: ${created.response.status} ${created.body.message ?? ''}`);
    roomCode = created.body.battle.roomCode;
    console.log(`[battle-e2e] room ${roomCode} created`);

    const joins = await Promise.all([
      b.request(`/api/battles/${roomCode}/join`, { method: 'POST' }),
      b.request(`/api/battles/${roomCode}/join`, { method: 'POST' }),
    ]);
    if (joins.some(({ response }) => !response.ok) || joins[0].body.battle.players.length !== 2) throw new Error('Idempotent double join failed.');
    console.log('[battle-e2e] idempotent join passed');
  }

  const controlA = await openSocket(`/ws/battle/${roomCode}`, a);
  const controlB = await openSocket(`/ws/battle/${roomCode}`, b);
  console.log('[battle-e2e] control sockets opened');
  sockets.push(controlA, controlB);
  await Promise.all([
    controlA.waitFor((_message, client) => client.state?.players?.every((player) => player.connected)),
    controlB.waitFor((_message, client) => client.state?.players?.every((player) => player.connected)),
  ]);
  console.log('[battle-e2e] both control sockets report connected');

  controlA.send({ type: 'player:ready', ready: true });
  controlA.send({ type: 'player:ready', ready: true });
  controlB.send({ type: 'player:ready', ready: true });
  controlB.send({ type: 'player:ready', ready: true });
  await Promise.all([
    controlA.waitFor((_message, client) => client.state?.preparing === true),
    controlB.waitFor((_message, client) => client.state?.preparing === true),
  ]);
  console.log('[battle-e2e] duplicate ready passed');
  console.log(`[battle-e2e] first challenge ${controlA.state.challenge?.slug}`);

  let ticketA = await getTerminal(a, roomCode);
  let ticketB = await getTerminal(b, roomCode);
  console.log(`[battle-e2e] terminal tickets ${ticketA.sessionId} / ${ticketB.sessionId}`);
  if (ticketA.sessionId === ticketB.sessionId) throw new Error('Players received the same sandbox session.');
  let termA = await openTerminal(a, ticketA);
  let termB = await openTerminal(b, ticketB);
  console.log('[battle-e2e] both terminals ready');
  sockets.push(termA.terminal, termB.terminal);
  const countdownA = await controlA.waitFor((_message, client) => client.state?.status === 'countdown');
  const countdownB = await controlB.waitFor((_message, client) => client.state?.status === 'countdown');
  if (countdownA.state.countdownStartAt !== countdownB.state.countdownStartAt) throw new Error('Countdown timestamps differ.');
  await Promise.all([
    controlA.waitFor((_message, client) => client.state?.status === 'running'),
    controlB.waitFor((_message, client) => client.state?.status === 'running'),
    termA.terminal.waitFor((message) => message.type === 'battle_unlocked'),
    termB.terminal.waitFor((message) => message.type === 'battle_unlocked'),
  ]);

  const rounds = [];
  for (let round = 1; round <= 3; round += 1) {
    const slugA = controlA.state.challenge.slug;
    const slugB = controlB.state.challenge.slug;
    if (slugA !== slugB) throw new Error(`Round ${round} challenges differ: ${slugA} / ${slugB}`);
    rounds.push(slugA);

    if (round === 2) {
      const originalSession = ticketA.sessionId;
      termA.terminal.socket.close(1000, 'e2e_refresh');
      await delay(250);
      ticketA = await getTerminal(a, roomCode);
      if (ticketA.sessionId !== originalSession) throw new Error('Refresh created a second sandbox instead of reconnecting.');
      termA = await openTerminal(a, ticketA);
      sockets.push(termA.terminal);
      if (!termA.ready.reconnected) throw new Error('Reconnect did not report the existing session.');
    }

    await solveRound(termA.terminal, slugA);
    if (round < 3) {
      await controlB.waitFor((_message, client) => client.state?.players?.find((player) => player.userId === controlA.state.me.userId)?.completedRounds >= round);
      const bStill = controlB.state.players.find((player) => player.userId === controlB.state.me.userId);
      if (bStill.completedRounds !== round - 1) throw new Error('Players were forced into lockstep.');
    }

    if (round === 3) break;
    await solveRound(termB.terminal, slugB);
    await Promise.all([
      controlA.waitFor((_message, client) => client.state?.players?.every((player) => player.completedRounds >= round)),
      controlB.waitFor((_message, client) => client.state?.players?.every((player) => player.completedRounds >= round)),
    ]);
    ticketA = await getTerminal(a, roomCode);
    ticketB = await getTerminal(b, roomCode);
    termA = await openTerminal(a, ticketA);
    termB = await openTerminal(b, ticketB);
    sockets.push(termA.terminal, termB.terminal);
  }

  await controlA.waitFor((_message, client) => client.state?.status === 'finished', 20_000);
  await controlB.waitFor((_message, client) => client.state?.status === 'finished', 20_000);
  const state = controlA.state;
  if (state.winnerUserId !== state.me.userId) throw new Error('Backend selected the wrong winner.');
  if (!state.results?.length || state.results.length !== 2) throw new Error('Persistent battle results are missing.');

  await delay(1_500);
  const cleanupA = await a.request('/api/sandbox/sessions', { method: 'POST', body: JSON.stringify({}) });
  const cleanupB = await b.request('/api/sandbox/sessions', { method: 'POST', body: JSON.stringify({}) });
  if (cleanupA.response.status !== 201 || cleanupB.response.status !== 201) {
    throw new Error(`Battle sandbox cleanup did not release both users: ${cleanupA.response.status}/${cleanupB.response.status}`);
  }

  console.log(JSON.stringify({
    ok: true,
    entry,
    ...(entry === 'matchmaking' ? { exactlyOnePairing: true } : {}),
    roomCode,
    rounds,
    twoIndependentSandboxes: true,
    sharedCountdownAt: state.countdownStartAt,
    winner: state.players.find((player) => player.userId === state.winnerUserId)?.username,
    reconnectReusedSession: true,
    cleanupReleasedBothSessions: true,
    results: state.results.map((result) => ({ username: result.username, completedRounds: result.completedRounds, result: result.result })),
  }, null, 2));
} finally {
  for (const socket of sockets) socket.close();
  await Promise.allSettled([a.delete(), b.delete()]);
}

async function waitForMatch(user) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const { response, body } = await user.request('/api/matchmaking/status');
    if (!response.ok) throw new Error(`matchmaking status: ${response.status} ${body.message ?? ''}`);
    if (body.status === 'matched') return body;
    await delay(250);
  }
  throw new Error(`Matchmaking timed out for ${user.username}.`);
}
