import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import WebSocket from 'ws';

const base = (process.env.CLIRACE_URL ?? '').replace(/\/$/, '');
assert.ok(base.startsWith('https://'), 'Set CLIRACE_URL=https://your-domain.example');
const origin = new URL(base).origin;
const wsBase = origin.replace(/^http/, 'ws');
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const username = `zto_${suffix}`.slice(0, 24);
const password = 'Zero-To-Operator-2026!';
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
  let session = await json(await request(`/api/learn/paths/linux-zero-to-operator/items/${stableItemId}/start-assessment`, { method: 'POST' }), 201, `start ${stableItemId}`);
  const seen = new Set();
  while (session.status === 'active') {
    const serialized = JSON.stringify(session);
    check(!serialized.includes('correctAnswerIds') && !serialized.includes('answerExplanations'), 'answers stay server-side before submit');
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
  const slug = 'packages-audit-bash-runtime';
  const game = await json(await request('/api/game/sessions', {
    method: 'POST', body: JSON.stringify({ category: 'all', difficulty: 'all', mode: 'real_shell', taskCount: 5, challengeSlug: slug }),
  }), 201, 'create canonical Practice game');
  equal(game.task.slug, slug, 'required V2 challenge selected exactly');
  const ticket = await json(await request('/api/sandbox/sessions', {
    method: 'POST', body: JSON.stringify({ gameSessionId: game.session.id }),
  }), 201, 'create rootless shell');
  const result = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`${wsBase}${ticket.websocketPath}`, { headers: { Origin: origin, Cookie: cookie } });
    const timer = setTimeout(() => reject(new Error('required shell checkpoint timed out')), 45_000);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'auth', token: ticket.token, cols: 100, rows: 28 })));
    socket.on('message', (data, binary) => {
      if (binary) return;
      const message = JSON.parse(data.toString());
      if (message.type === 'ready') {
        socket.send(JSON.stringify({ type: 'input', data: "dpkg-query -W bash >/dev/null && printf 'bash=installed\\n' > /workspace/package-status.txt\r" }));
        setTimeout(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'check' })); }, 800);
      }
      if (message.type === 'check_result') {
        clearTimeout(timer); socket.close(1000, 'zero_to_operator_e2e_done'); resolve(message);
      }
    });
    socket.on('error', reject);
  });
  check(result.passed === true, 'real rootless checker accepts required solution');
  await new Promise((resolve) => setTimeout(resolve, 1_800));
}

try {
  equal((await request('/learn/paths/linux-zero-to-operator')).status, 200, 'course deep link is public');
  const catalog = await json(await request('/api/learn/paths'), 200, 'public course catalog');
  equal(catalog.courses[0].slug, 'linux-zero-to-operator', 'beginner course is primary');
  const outline = await json(await request('/api/learn/paths/linux-zero-to-operator'), 200, 'public course outline');
  equal(outline.modules.length, 17, 'outline has 17 modules');
  check(outline.modules.every((module) => module.itemCount === 11), 'each module exposes 11 focused steps');

  const registration = await request('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, email: `${username}@e2e.invalid`, password }) });
  equal(registration.status, 201, 'temporary beginner account registered');
  cookie = (registration.headers.get('set-cookie') ?? '').split(';')[0];
  check(Boolean(cookie), 'auth cookie issued');
  let state = await json(await request('/api/learn/paths/linux-zero-to-operator/enroll', { method: 'POST' }), 201, 'enroll beginner course');
  equal(state.resume.item, 'linux-shell', 'resume starts at first lesson');

  const lessons = ['linux-shell', 'prompt-command', 'help-manuals', 'exit-status'];
  for (const lesson of lessons) {
    const detail = await json(await request(`/api/learn/paths/linux-zero-to-operator/modules/terminal-basics/items/${lesson}`), 200, `open ${lesson}`);
    check(detail.item.theory.some((block) => block.type === 'code'), `${lesson} contains static terminal example`);
    state = await json(await request(`/api/learn/paths/linux-zero-to-operator/items/zto-terminal-basics-${lesson}-lesson/complete-theory`, { method: 'POST' }), 200, `complete ${lesson}`);
    equal(state.resume.item, `${lesson}-quiz`, `${lesson} advances to its quiz`);
    await completeAssessment(`zto-terminal-basics-${lesson}-quiz`);
  }

  state = await json(await request('/api/learn/paths/linux-zero-to-operator/sync', { method: 'POST' }), 200, 'sync lesson progress');
  const firstItems = state.modules[0].items;
  const optional = firstItems.find((item) => item.stableId === 'zto-terminal-basics-optional-practice');
  const required = firstItems.find((item) => item.stableId === 'zto-terminal-basics-required-lab');
  check(optional.optional === true && optional.status === 'available', 'optional practice is available but non-blocking');
  equal(required.status, 'current', 'required lab is current');
  await completeRequiredShell();
  state = await json(await request('/api/learn/paths/linux-zero-to-operator/sync', { method: 'POST' }), 200, 'sync canonical Practice result');
  equal(state.modules[0].items.find((item) => item.stableId === 'zto-terminal-basics-checkpoint').status, 'current', 'shell success unlocks checkpoint');
  await completeAssessment('zto-terminal-basics-checkpoint');
  state = await json(await request('/api/learn/paths/linux-zero-to-operator/sync', { method: 'POST' }), 200, 'finish first beginner module');
  check(state.modules[0].status === 'completed' && state.modules[1].status === 'current', 'next module unlocked');
  equal(state.enrollment.progress, 6, 'optional practice excluded from required progress');
  equal(state.resume.module, 'filesystem-navigation', 'resume points at Filesystem module');

  equal((await request('/api/auth/logout', { method: 'POST' })).status, 204, 'logout succeeds');
  cookie = '';
  const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ identifier: username, password }) });
  equal(login.status, 200, 'login succeeds');
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  const restored = await json(await request('/api/learn/paths/linux-zero-to-operator'), 200, 'restore course after login');
  equal(restored.enrollment.progress, state.enrollment.progress, 'server-side progress survives logout/login');
  equal(restored.resume.module, 'filesystem-navigation', 'resume survives logout/login');
  const profile = await json(await request(`/api/profiles/${username}`), 200, 'profile exposes learning path');
  check(profile.profile.learningPaths.some((entry) => entry.slug === 'linux-zero-to-operator' && entry.progress === 6), 'profile progress is consistent');

  console.log(JSON.stringify({ ok: true, url: base, checks, progress: restored.enrollment.progress, resume: restored.resume }, null, 2));
} finally {
  if (cookie) await request('/api/auth/account', { method: 'DELETE', body: JSON.stringify({ password }) }).catch(() => undefined);
}
