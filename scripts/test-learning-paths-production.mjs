import assert from 'node:assert/strict';
import WebSocket from 'ws';

const base = (process.env.CLIRACE_URL ?? '').replace(/\/$/, '');
assert.ok(base.startsWith('https://'), 'Set CLIRACE_URL=https://your-domain.example');
const origin = new URL(base).origin;
const wsBase = origin.replace(/^http/, 'ws');
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const username = `path_${suffix}`.slice(0, 24);
const password = 'Paths-Production-2026!';
let cookie = '';
let checks = 0;

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

function check(value, message) { checks += 1; assert.ok(value, message); }
function equal(actual, expected, message) { checks += 1; assert.equal(actual, expected, message); }
async function json(response, expected, message) {
  const payload = await response.json().catch(() => ({}));
  equal(response.status, expected, `${message}: ${payload.message ?? response.status}`);
  return payload;
}

async function completeAssessment(stableItemId) {
  let session = await json(await request(`/api/learn/paths/linux-foundations/items/${stableItemId}/start-assessment`, { method: 'POST' }), 201, `start ${stableItemId}`);
  const seen = new Set();
  while (session.status === 'active') {
    check(!JSON.stringify(session).includes('correctAnswerIds'), 'correct answers stay server-side before submit');
    check(!seen.has(session.question.slug), 'assessment question is not duplicated');
    seen.add(session.question.slug);
    const answer = await json(await request(`/api/learn/sessions/${session.id}/answers`, {
      method: 'POST',
      body: JSON.stringify({ questionSlug: session.question.slug, answerIds: ['a1'] }),
    }), 200, `answer ${session.question.slug}`);
    check(answer.feedback.isCorrect === true, `${session.question.slug} accepted correct answer`);
    session = await json(await request(`/api/learn/sessions/${session.id}/next`, { method: 'POST' }), 200, 'advance assessment');
  }
  check(session.result.percent === 100, `${stableItemId} completed at 100%`);
  return session;
}

async function completeShellChallenge(challengeSlug, command) {
  const game = await json(await request('/api/game/sessions', {
    method: 'POST',
    body: JSON.stringify({ category: 'all', difficulty: 'all', mode: 'real_shell', taskCount: 5, challengeSlug }),
  }), 201, `create ${challengeSlug} game`);
  equal(game.task.slug, challengeSlug, `selected ${challengeSlug}`);
  const ticket = await json(await request('/api/sandbox/sessions', {
    method: 'POST', body: JSON.stringify({ gameSessionId: game.session.id }),
  }), 201, `create ${challengeSlug} shell`);

  const result = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`${wsBase}${ticket.websocketPath}`, { headers: { Origin: origin, Cookie: cookie } });
    const timer = setTimeout(() => reject(new Error(`${challengeSlug} shell timed out`)), 40_000);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'auth', token: ticket.token, cols: 100, rows: 28 })));
    socket.on('message', (data, binary) => {
      if (binary) return;
      const message = JSON.parse(data.toString());
      if (message.type === 'ready') {
        socket.send(JSON.stringify({ type: 'input', data: `${command}\r` }));
        setTimeout(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'check' }));
        }, 700);
      }
      if (message.type === 'output') return;
      if (message.type === 'check_result') {
        clearTimeout(timer);
        socket.close(1000, 'learning_path_e2e_done');
        resolve(message);
      }
    });
    socket.on('error', reject);
  });
  check(result.passed === true, `${challengeSlug} state check passed`);
  await new Promise((resolve) => setTimeout(resolve, 1_800));
  const completed = await json(await request(`/api/game/sessions/${game.session.id}`), 200, `reload ${challengeSlug} game`);
  equal(completed.session.status, 'completed', `${challengeSlug} game persisted`);
}

try {
  equal((await request('/learn/paths')).status, 200, 'paths catalog page is public');
  equal((await request('/learn/paths/linux-foundations')).status, 200, 'course page is public');
  const sitemap = await request('/sitemap.xml');
  const sitemapText = await sitemap.text();
  check(sitemapText.includes('/learn/paths') && sitemapText.includes('/learn/paths/linux-foundations'), 'sitemap exposes public path routes');

  const catalog = await json(await request('/api/learn/paths'), 200, 'public paths catalog');
  const publicCourse = catalog.courses.find((course) => course.slug === 'linux-foundations');
  check(publicCourse && publicCourse.enrollment === null, 'public catalog contains Linux Foundations without private progress');
  const outline = await json(await request('/api/learn/paths/linux-foundations'), 200, 'public course outline');
  equal(outline.modules.length, 10, 'course has ten modules');
  check(!JSON.stringify(outline).includes('correctAnswerIds'), 'public outline has no answer secrets');

  const registration = await request('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, email: `${username}@e2e.invalid`, password }) });
  equal(registration.status, 201, 'temporary account registered');
  cookie = (registration.headers.get('set-cookie') ?? '').split(';')[0];
  check(Boolean(cookie), 'auth cookie issued');

  let state = await json(await request('/api/learn/paths/linux-foundations/enroll', { method: 'POST' }), 201, 'course enrollment');
  equal(state.enrollment.progress, 0, 'new enrollment starts at zero');
  equal(state.modules[0].status, 'current', 'first module is current');
  equal(state.modules[1].status, 'locked', 'second module is locked');

  await json(await request('/api/learn/paths/linux-foundations/items/linux-foundations-basics-theory/complete-theory', { method: 'POST' }), 200, 'complete theory');
  await completeAssessment('linux-foundations-basics-knowledge');
  await completeShellChallenge('shell-hello-terminal', "printf 'Привет, терминал!\\n' > /workspace/hello.txt");
  await json(await request('/api/learn/paths/linux-foundations/sync', { method: 'POST' }), 200, 'sync practice evidence');
  await completeShellChallenge('shell-build-castle', 'mkdir -p /workspace/castle/tower');
  await json(await request('/api/learn/paths/linux-foundations/sync', { method: 'POST' }), 200, 'sync lab evidence');
  await completeAssessment('linux-foundations-basics-checkpoint');
  state = await json(await request('/api/learn/paths/linux-foundations/sync', { method: 'POST' }), 200, 'finish first module');

  equal(state.modules[0].status, 'completed', 'first module completed');
  equal(state.modules[1].status, 'current', 'second module unlocked');
  check(state.enrollment.progress > 0 && state.enrollment.progress < 100, 'course progress advanced');
  check(state.modules[0].result.mastery === 100, 'module mastery calculated');

  const restored = await json(await request('/api/learn/paths/linux-foundations'), 200, 'refresh course state');
  equal(restored.enrollment.progress, state.enrollment.progress, 'progress restored after refresh');
  equal(restored.resume.module, state.resume.module, 'resume module persisted');
  const profile = await json(await request(`/api/profiles/${username}`), 200, 'public profile');
  const profilePath = profile.profile.learningPaths.find((course) => course.slug === 'linux-foundations');
  check(profilePath && profilePath.progress === state.enrollment.progress, 'profile exposes path progress');

  console.log(JSON.stringify({ ok: true, url: base, checks, firstModuleMastery: state.modules[0].result.mastery, progress: state.enrollment.progress }, null, 2));
} finally {
  if (cookie) await request('/api/auth/account', { method: 'DELETE', body: JSON.stringify({ password }) }).catch(() => undefined);
}
