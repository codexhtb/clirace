import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import WebSocket from 'ws';

const base = (process.env.CLIRACE_URL ?? '').replace(/\/$/, '');
assert.ok(base.startsWith('https://'), 'Set CLIRACE_URL=https://your-domain.example');
const origin = new URL(base).origin;
const wsBase = origin.replace(/^http/, 'ws');
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const username = `operator_${suffix}`.slice(0, 24);
const password = 'Linux-Operator-V1-2026!';
let cookie = '';
let checks = 0;

const files = (await readdir(new URL('../content/linux-core/', import.meta.url))).filter((name) => name.endsWith('.json'));
const authoredQuestions = (await Promise.all(files.map(async (name) => JSON.parse(await readFile(new URL(`../content/linux-core/${name}`, import.meta.url), 'utf8'))))).flat();
const correctAnswers = new Map(authoredQuestions.map((question) => [question.slug, question.correctAnswerIds]));

async function request(path, options = {}) {
  return fetch(`${base}${path}`, {
    ...options,
    headers: { origin, ...(cookie ? { cookie } : {}), ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers ?? {}) },
  });
}
function check(value, message) { checks += 1; assert.ok(value, message); }
function equal(actual, expected, message) { checks += 1; assert.equal(actual, expected, message); }
async function json(response, expected, message) {
  const payload = await response.json().catch(() => ({}));
  equal(response.status, expected, `${message}: ${payload.message ?? response.status}`);
  return payload;
}

async function completeAssessment(stableItemId) {
  let session = await json(await request(`/api/learn/paths/linux-operator/items/${stableItemId}/start-assessment`, { method: 'POST' }), 201, `start ${stableItemId}`);
  const seen = new Set();
  while (session.status === 'active') {
    check(!JSON.stringify(session).includes('correctAnswerIds'), 'correct answers remain server-side before submit');
    check(!seen.has(session.question.slug), `${session.question.slug} appears once`);
    seen.add(session.question.slug);
    const answerIds = correctAnswers.get(session.question.slug);
    check(Array.isArray(answerIds), `${session.question.slug} resolves to authored fixture`);
    const answered = await json(await request(`/api/learn/sessions/${session.id}/answers`, {
      method: 'POST', body: JSON.stringify({ questionSlug: session.question.slug, answerIds }),
    }), 200, `answer ${session.question.slug}`);
    check(answered.feedback.isCorrect === true && Boolean(answered.feedback.explanation), `${session.question.slug} returns explanation`);
    session = await json(await request(`/api/learn/sessions/${session.id}/next`, { method: 'POST' }), 200, 'advance assessment');
  }
  equal(session.result.percent, 100, `${stableItemId} completed at 100%`);
}

async function completeRequiredShell() {
  const slug = 'packages-verify-procps-process-tools';
  const game = await json(await request('/api/game/sessions', {
    method: 'POST', body: JSON.stringify({ category: 'all', difficulty: 'all', mode: 'real_shell', taskCount: 5, challengeSlug: slug }),
  }), 201, 'create exact canonical Practice game');
  equal(game.task.slug, slug, 'required Operator task selected exactly');
  const ticket = await json(await request('/api/sandbox/sessions', {
    method: 'POST', body: JSON.stringify({ gameSessionId: game.session.id }),
  }), 201, 'create rootless Operator shell');
  const result = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`${wsBase}${ticket.websocketPath}`, { headers: { Origin: origin, Cookie: cookie } });
    const timer = setTimeout(() => reject(new Error('Operator shell checkpoint timed out')), 45_000);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'auth', token: ticket.token, cols: 100, rows: 28 })));
    socket.on('message', (data, binary) => {
      if (binary) return;
      const message = JSON.parse(data.toString());
      if (message.type === 'ready') {
        socket.send(JSON.stringify({ type: 'input', data: "command -v tar find du stat ps pgrep bash curl getent ip ss >/dev/null || exit 9; jobs >/dev/null || exit 10; dpkg-query -W procps >/dev/null && printf 'procps=ready\\n' > /workspace/process-tools.txt\r" }));
        setTimeout(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'check' })); }, 900);
      }
      if (message.type === 'check_result') {
        clearTimeout(timer); socket.close(1000, 'operator_v1_e2e_done'); resolve(message);
      }
    });
    socket.on('error', reject);
  });
  check(result.passed === true, 'real rootless checker accepts required Operator solution');
  await new Promise((resolve) => setTimeout(resolve, 1_800));
}

try {
  equal((await request('/learn/paths/linux-operator')).status, 200, 'Operator deep link is public');
  const sitemap = await request('/sitemap.xml');
  check((await sitemap.text()).includes('/learn/paths/linux-operator'), 'Operator route is in sitemap');
  const catalog = await json(await request('/api/learn/paths'), 200, 'public course catalog');
  const operatorCard = catalog.courses.find((course) => course.slug === 'linux-operator');
  check(operatorCard?.prerequisites?.[0] === 'linux-zero-to-operator', 'recommended prerequisite is exposed');
  const outline = await json(await request('/api/learn/paths/linux-operator'), 200, 'public Operator outline');
  equal(outline.modules.length, 14, 'outline has 14 modules');
  check(outline.modules.every((module) => module.itemCount === 11), 'each module exposes 11 focused steps');
  check(!JSON.stringify(outline).includes('correctAnswerIds'), 'public outline contains no answer secrets');

  const registration = await request('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, email: `${username}@e2e.invalid`, password }) });
  equal(registration.status, 201, 'temporary Operator account registered');
  cookie = (registration.headers.get('set-cookie') ?? '').split(';')[0];
  check(Boolean(cookie), 'auth cookie issued');
  const beginner = await json(await request('/api/learn/paths/linux-zero-to-operator/enroll', { method: 'POST' }), 201, 'create unfinished beginner enrollment');
  equal(beginner.enrollment.progress, 0, 'recommended prerequisite is unfinished');
  let state = await json(await request('/api/learn/paths/linux-operator/enroll', { method: 'POST' }), 201, 'experienced user bypasses recommendation');
  equal(state.resume.item, 'identity', 'Operator starts at first lesson');

  const lessons = ['identity', 'uptime-load', 'cpu-memory', 'proc-overview'];
  for (const lesson of lessons) {
    const detail = await json(await request(`/api/learn/paths/linux-operator/modules/system-inspection/items/${lesson}`), 200, `open ${lesson}`);
    check(detail.item.theory.some((block) => block.type === 'code'), `${lesson} has a command example`);
    state = await json(await request(`/api/learn/paths/linux-operator/items/operator-system-inspection-${lesson}-lesson/complete-theory`, { method: 'POST' }), 200, `complete ${lesson}`);
    equal(state.resume.item, `${lesson}-quiz`, `${lesson} advances to quiz`);
    await completeAssessment(`operator-system-inspection-${lesson}-quiz`);
  }

  state = await json(await request('/api/learn/paths/linux-operator/sync', { method: 'POST' }), 200, 'sync Operator lessons');
  const firstItems = state.modules[0].items;
  check(firstItems.find((item) => item.stableId === 'operator-system-inspection-optional-practice').optional === true, 'optional practice is marked optional');
  equal(firstItems.find((item) => item.stableId === 'operator-system-inspection-required-lab').status, 'current', 'required shell lab is current');
  await completeRequiredShell();
  state = await json(await request('/api/learn/paths/linux-operator/sync', { method: 'POST' }), 200, 'sync real shell completion');
  equal(firstItems.length, 11, 'module step count remains stable');
  equal(state.modules[0].items.find((item) => item.stableId === 'operator-system-inspection-checkpoint').status, 'current', 'shell success unlocks checkpoint');
  await completeAssessment('operator-system-inspection-checkpoint');
  state = await json(await request('/api/learn/paths/linux-operator/sync', { method: 'POST' }), 200, 'finish first Operator module');
  check(state.modules[0].status === 'completed' && state.modules[1].status === 'current', 'next module unlocked');
  equal(state.enrollment.progress, 7, 'optional practice excluded from required progress');
  equal(state.resume.module, 'storage-disk-usage', 'resume points at second module');

  equal((await request('/api/auth/logout', { method: 'POST' })).status, 204, 'logout succeeds');
  cookie = '';
  const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ identifier: username, password }) });
  equal(login.status, 200, 'login succeeds');
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  const restored = await json(await request('/api/learn/paths/linux-operator'), 200, 'restore Operator after login');
  equal(restored.enrollment.progress, state.enrollment.progress, 'server-side progress survives logout/login');
  equal(restored.resume.module, 'storage-disk-usage', 'resume survives logout/login');
  const beginnerRestored = await json(await request('/api/learn/paths/linux-zero-to-operator'), 200, 'restore independent beginner course');
  equal(beginnerRestored.enrollment.progress, 0, 'Operator progress does not alter beginner course');
  const profile = await json(await request(`/api/profiles/${username}`), 200, 'profile exposes both courses');
  check(profile.profile.learningPaths.some((entry) => entry.slug === 'linux-operator' && entry.progress === 7), 'profile contains Operator progress');
  check(profile.profile.learningPaths.some((entry) => entry.slug === 'linux-zero-to-operator' && entry.progress === 0), 'profile contains independent beginner progress');

  console.log(JSON.stringify({ ok: true, url: base, checks, progress: restored.enrollment.progress, resume: restored.resume }, null, 2));
} finally {
  if (cookie) await request('/api/auth/account', { method: 'DELETE', body: JSON.stringify({ password }) }).catch(() => undefined);
}
