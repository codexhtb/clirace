import WebSocket from 'ws';

const base = process.env.CLIRACE_URL ?? 'http://localhost:8080';
const origin = new URL(base).origin;
const wsBase = origin.replace(/^http/, 'ws');
const entry = ['matchmaking', 'ranked'].includes(process.env.CLIRACE_BATTLE_ENTRY)
  ? process.env.CLIRACE_BATTLE_ENTRY
  : 'private';
const publicMatchmaking = entry === 'matchmaking' || entry === 'ranked';
const matchmakingMode = entry === 'ranked' ? 'ranked' : 'quick';
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
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const { response, body } = await user.request(`/api/battles/${roomCode}/terminal`, { method: 'POST' });
    if (response.ok) return body;
    if (response.status === 429) {
      const retryAfterSeconds = Number.parseInt(response.headers.get('retry-after') ?? '1', 10);
      await delay(Math.max(1, Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : 1) * 1_000);
      continue;
    }
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
  'linux-directory-mode': 'mkdir -p /workspace/app && chmod 750 /workspace/app',
  'shell-move-largest-file': 'find /workspace/data -type f -size +5M -exec mv {} /workspace/archive/ \\;',
  'shell-secure-secret': 'chmod 600 /workspace/secret.env',
  'shell-log-investigation': "awk '$5 == 503 { print $1 }' /workspace/access.log > /workspace/answer.txt",
  'shell-release-symlink': 'ln -s /workspace/versions/app-v2.conf /workspace/current.conf',
  'shell-stop-worker': 'kill "$(cat /workspace/worker.pid)" && sleep 0.1',
  'shell-restore-git-file': 'cd /workspace/repo && git restore README.md',
  'shell-local-http': 'curl -fsS http://127.0.0.1:8081/status.txt -o /workspace/response.txt',
  'shell-hello-terminal': "printf 'Привет, терминал!\\n' > /workspace/hello.txt",
  'shell-cat-house': 'mkdir -p /workspace/cat-house && touch /workspace/cat-house/meow.txt',
  'shell-copy-treasure': 'mkdir -p /workspace/backpack && cp /workspace/chest/treasure.txt /workspace/backpack/',
  'shell-rename-duck': 'mv /workspace/duck.tmp /workspace/duck.txt',
  'shell-first-story-line': 'head -n 1 /workspace/story.txt > /workspace/answer.txt',
  'shell-banana-count': "grep -c '^banana$' /workspace/fruits.txt > /workspace/answer.txt",
  'shell-sort-pets': 'sort /workspace/pets.txt > /workspace/sorted.txt',
  'shell-hidden-gem': 'touch /workspace/.gem',
  'shell-delete-junk': 'rm /workspace/junk.txt',
  'shell-rainbow-files': 'cat /workspace/red.txt /workspace/blue.txt > /workspace/rainbow.txt',
  'shell-build-castle': 'mkdir -p /workspace/castle/tower',
  'shell-name-robot': "echo 'BEEP-42' > /workspace/robot.txt",
  'shell-launch-rocket': 'mv /workspace/hangar/rocket.txt /workspace/launchpad/',
  'shell-copy-map': 'mkdir -p /workspace/traveler && cp /workspace/map.txt /workspace/traveler/map.txt',
  'shell-remove-crumbs': 'rm /workspace/crumbs.txt',
  'shell-feed-dragon': "echo 'pizza' >> /workspace/dragon-menu.txt",
  'shell-make-playlist': 'cat /workspace/song-a.txt /workspace/song-b.txt > /workspace/playlist.txt',
  'shell-count-stars': 'wc -l < /workspace/stars.txt > /workspace/answer.txt',
  'shell-find-unicorn': 'grep unicorn /workspace/zoo.txt > /workspace/found.txt',
  'shell-shout-message': "tr 'a-z' 'A-Z' < /workspace/whisper.txt > /workspace/shout.txt",
  'shell-last-cookie': 'tail -n 1 /workspace/cookies.txt > /workspace/last.txt',
  'shell-first-planets': 'head -n 3 /workspace/planets.txt > /workspace/first.txt',
  'shell-csv-names': "cut -d',' -f1 /workspace/players.csv > /workspace/names.txt",
  'shell-unique-colors': 'sort -u /workspace/colors.txt > /workspace/unique.txt',
  'shell-create-planets': 'touch /workspace/earth.txt /workspace/mars.txt /workspace/venus.txt',
  'shell-executable-spell': 'chmod 755 /workspace/spell.sh',
  'shell-readonly-scroll': 'chmod 444 /workspace/scroll.txt',
  'shell-portal-shortcut': 'ln -s /workspace/worlds/mars /workspace/portal',
  'shell-replace-moon': "sed -i 's/moon/mars/' /workspace/sky.txt",
  'shell-backup-note': 'cp /workspace/note.txt /workspace/note.txt.bak',
  'shell-archive-logs': 'cd /workspace && tar -czf logs.tar.gz logs',
  'shell-production-config': "sed -i 's/debug=true/debug=false/' /workspace/app.conf",
  'shell-filter-json': "jq -r '.[] | select(.enabled) | .name' /workspace/services.json > /workspace/enabled.txt",
  'shell-rename-backups': "for f in /workspace/backups/*.conf.bak; do mv \"$f\" \"${f%.bak}\"; done",
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const a = new UserClient(`${entry === 'ranked' ? 'rank_a' : entry === 'matchmaking' ? 'match_a' : 'battle_a'}_${suffix}`.slice(0, 24));
const b = new UserClient(`${entry === 'ranked' ? 'rank_b' : entry === 'matchmaking' ? 'match_b' : 'battle_b'}_${suffix}`.slice(0, 24));
const sockets = [];
let roomCode;

try {
  await Promise.all([a.register(), b.register()]);
  console.log('[battle-e2e] users registered');
  let matchmakingBattleId;
  if (publicMatchmaking) {
    const queueOptions = { method: 'POST', body: JSON.stringify({ mode: matchmakingMode }) };
    const duplicateEnqueue = await Promise.all([
      a.request('/api/matchmaking/queue', queueOptions),
      a.request('/api/matchmaking/queue', queueOptions),
    ]);
    if (duplicateEnqueue.some(({ response }) => !response.ok)) throw new Error('Idempotent matchmaking enqueue failed.');
    const secondEnqueue = await b.request('/api/matchmaking/queue', queueOptions);
    if (!secondEnqueue.response.ok) throw new Error(`second matchmaking enqueue: ${secondEnqueue.response.status} ${secondEnqueue.body.message ?? ''}`);
    const [statusA, statusB] = await Promise.all([waitForMatch(a, matchmakingMode), waitForMatch(b, matchmakingMode)]);
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
    if (stateA.body.battle.mode !== matchmakingMode) throw new Error(`Battle mode is ${stateA.body.battle.mode}, expected ${matchmakingMode}.`);
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
  let rankedSummary;
  if (entry === 'ranked') {
    if (state.mode !== 'ranked' || !state.rankedResult) throw new Error('Ranked result is missing from Battle state.');
    const winnerRating = state.rankedResult.players.find((player) => player.userId === state.winnerUserId);
    const loserRating = state.rankedResult.players.find((player) => player.userId !== state.winnerUserId);
    if (!winnerRating || winnerRating.delta <= 0 || !loserRating || loserRating.delta >= 0) throw new Error('Ranked MMR deltas are invalid.');
    const [profileA, profileB, repeatedState] = await Promise.all([
      fetch(`${base}/api/profiles/${a.username}`).then((response) => response.json()),
      fetch(`${base}/api/profiles/${b.username}`).then((response) => response.json()),
      a.request(`/api/battles/${roomCode}`),
    ]);
    if (profileA.profile?.ranked?.gamesPlayed !== 1 || profileB.profile?.ranked?.gamesPlayed !== 1) throw new Error('Ranked profile stats were not updated.');
    if (repeatedState.body.battle.rankedResult.players.find((player) => player.userId === state.winnerUserId)?.mmrAfter !== winnerRating.mmrAfter) throw new Error('Reconnect returned a different MMR result.');
    rankedSummary = { winnerDelta: winnerRating.delta, loserDelta: loserRating.delta, resultPersisted: true, reconnectStable: true };
  }

  await delay(1_500);
  const cleanupA = await a.request('/api/sandbox/sessions', { method: 'POST', body: JSON.stringify({}) });
  const cleanupB = await b.request('/api/sandbox/sessions', { method: 'POST', body: JSON.stringify({}) });
  if (cleanupA.response.status !== 201 || cleanupB.response.status !== 201) {
    throw new Error(`Battle sandbox cleanup did not release both users: ${cleanupA.response.status}/${cleanupB.response.status}`);
  }

  console.log(JSON.stringify({
    ok: true,
    entry,
    ...(publicMatchmaking ? { exactlyOnePairing: true } : {}),
    ...(rankedSummary ? { ranked: rankedSummary } : {}),
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

async function waitForMatch(user, mode = 'quick') {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const { response, body } = await user.request(`/api/matchmaking/status?mode=${mode}`);
    if (!response.ok) throw new Error(`matchmaking status: ${response.status} ${body.message ?? ''}`);
    if (body.status === 'matched') return body;
    await delay(250);
  }
  throw new Error(`Matchmaking timed out for ${user.username}.`);
}
