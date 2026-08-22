import assert from 'node:assert/strict';

const base = (process.env.CLIRACE_URL ?? '').replace(/\/$/, '');
assert.ok(base.startsWith('https://'), 'Set CLIRACE_URL=https://your-domain.example');
const origin = new URL(base).origin;
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const username = `learn_${suffix}`.slice(0, 24);
const password = 'Learn-Production-2026!';
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
function noLeak(payload) {
  const json = JSON.stringify(payload);
  check(!Object.hasOwn(payload, 'feedback'), 'pre-answer payload has no feedback');
  check(!json.includes('correctAnswerIds'), 'pre-answer payload has no correct IDs');
  check(!json.includes('answerExplanations'), 'pre-answer payload has no hidden explanations');
}

try {
  const learnPage = await request('/learn/linux-core');
  equal(learnPage.status, 200, 'Learn page is public');
  const sitemap = await request('/sitemap.xml');
  check((await sitemap.text()).includes('/learn/linux-core'), 'sitemap contains stable Learn route');
  const catalogResponse = await request('/api/learn/linux-core');
  equal(catalogResponse.status, 200, 'catalog response');
  const catalog = await catalogResponse.json();
  equal(catalog.totalQuestions, 25, 'fixture count');
  equal(catalog.modes.find((mode) => mode.id === 'quick').available, true, 'Quick available');
  equal(catalog.modes.find((mode) => mode.id === 'standard').available, true, 'Standard available');
  equal(catalog.modes.find((mode) => mode.id === 'full').available, false, 'Full hidden until enough unique content');

  const registration = await request('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, email: `${username}@e2e.invalid`, password }) });
  equal(registration.status, 201, 'temporary account registration');
  cookie = (registration.headers.get('set-cookie') ?? '').split(';')[0];
  check(Boolean(cookie), 'secure auth cookie issued');

  const createdResponse = await request('/api/learn/sessions', { method: 'POST', body: JSON.stringify({ mode: 'quick' }) });
  equal(createdResponse.status, 201, 'Quick Check created');
  let session = await createdResponse.json();
  const slugs = new Set();
  let idempotenceChecked = false;
  let resumeChecked = false;
  let shellLinkChecked = false;
  while (session.status === 'active') {
    noLeak(session);
    check(!slugs.has(session.question.slug), 'question not duplicated');
    slugs.add(session.question.slug);
    if (!resumeChecked) {
      const resumed = await request('/api/learn/sessions/current');
      equal((await resumed.json()).question.slug, session.question.slug, 'session resumes at same question');
      resumeChecked = true;
    }
    const selected = [session.question.answers[0].id];
    const answerResponse = await request(`/api/learn/sessions/${session.id}/answers`, { method: 'POST', body: JSON.stringify({ questionSlug: session.question.slug, answerIds: selected }) });
    equal(answerResponse.status, 200, 'answer accepted');
    const answered = await answerResponse.json();
    check(typeof answered.feedback.isCorrect === 'boolean', 'server returns correctness after submit');
    check(Boolean(answered.feedback.explanation), 'main explanation returned');
    if (!answered.feedback.isCorrect) check(Boolean(answered.feedback.selectedAnswerExplanation), 'wrong-answer explanation returned');
    if (!idempotenceChecked) {
      const repeat = await request(`/api/learn/sessions/${session.id}/answers`, { method: 'POST', body: JSON.stringify({ questionSlug: session.question.slug, answerIds: selected }) });
      equal(JSON.stringify((await repeat.json()).feedback), JSON.stringify(answered.feedback), 'repeat submit is idempotent');
      idempotenceChecked = true;
    }
    if (answered.feedback.shellPracticeChallengeSlug) {
      const challenge = await request(`/api/challenges/${encodeURIComponent(answered.feedback.shellPracticeChallengeSlug)}`);
      equal(challenge.status, 200, 'shell practice points to existing challenge');
      shellLinkChecked = true;
    }
    const next = await request(`/api/learn/sessions/${session.id}/next`, { method: 'POST' });
    equal(next.status, 200, 'next question');
    session = await next.json();
  }
  equal(slugs.size, 10, 'Quick Check has ten unique questions');
  check(session.result.total === 10 && session.result.percent >= 0 && session.result.percent <= 100, 'result score is valid');
  check(Object.keys(session.result.categories).length > 0, 'category analytics returned');
  check(Object.keys(session.result.concepts).length > 0, 'concept analytics returned');
  const noCurrent = await request('/api/learn/sessions/current');
  equal(await noCurrent.json(), null, 'completed session is not resumed as active');

  console.log(JSON.stringify({ ok: true, url: base, checks, questions: slugs.size, shellPracticeObserved: shellLinkChecked }, null, 2));
} finally {
  if (cookie) await request('/api/auth/account', { method: 'DELETE', body: JSON.stringify({ password }) }).catch(() => undefined);
}
