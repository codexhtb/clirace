import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../apps/api/src/interview-data.ts', import.meta.url), 'utf8');
const rows = [...source.matchAll(/^  \['([^']+)','(Easy|Medium|Hard)','([^']+)','([^']+)'/gm)];
assert.equal(rows.length, 100, 'Interview collection must contain exactly 100 task specifications');
assert.deepEqual(Object.fromEntries(['Easy','Medium','Hard'].map((level) => [level, rows.filter((row) => row[2] === level).length])), {
  Easy: 30, Medium: 50, Hard: 20,
});
const topics = Object.fromEntries([...new Set(rows.map((row) => row[1]))].map((topic) => [topic, rows.filter((row) => row[1] === topic).length]));
assert.deepEqual(topics, {
  'linux-fundamentals': 15, 'files-text': 15, 'processes-performance': 10,
  networking: 15, 'permissions-security': 10, 'systemd-services': 10,
  'storage-filesystems': 10, 'bash-shell': 10, 'git-containers': 5,
});
assert.equal(new Set(rows.map((_, index) => `interview-${String(index + 1).padStart(3, '0')}`)).size, 100);
assert.equal(new Set(rows.map((row) => row[4])).size, 100, 'Interview titles must be unique');
assert.match(source, /checkScript:/, 'State validators must be present');
assert.match(source, /alternatives/, 'Alternative solutions must be present');

const baseUrl = process.env.CLIRACE_BASE_URL;
if (baseUrl) {
  const base = baseUrl.replace(/\/$/, '');
  const origin = new URL(base).origin;
  const response = await fetch(`${base}/api/interview`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.summary.total, 100);
  assert.equal(payload.summary.easy, 30);
  assert.equal(payload.summary.medium, 50);
  assert.equal(payload.summary.hard, 20);
  assert.equal(payload.tasks.length, 100);
  assert.equal(new Set(payload.tasks.map((task) => task.slug)).size, 100);

  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const username = `int_e2e_${suffix}`;
  const password = 'Interview-E2E-2026!';
  let cookie = '';
  const request = (path, options = {}) => fetch(`${base}${path}`, {
    ...options,
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  });
  try {
    const registration = await request('/api/auth/register', {
      method: 'POST', body: JSON.stringify({ username, email: `${username}@example.test`, password }),
    });
    assert.equal(registration.status, 201);
    cookie = registration.headers.get('set-cookie')?.split(';')[0] ?? '';
    assert.ok(cookie, 'Registration must return an auth cookie');
    const runResponse = await request('/api/interview/runs', {
      method: 'POST', body: JSON.stringify({ taskCount: 10 }),
    });
    const run = await runResponse.json();
    assert.equal(runResponse.status, 201, run.message);
    assert.equal(run.session.mode, 'interview');
    assert.equal(run.session.status, 'active');
    assert.equal(run.task.total, 10);
  } finally {
    if (cookie) await request('/api/auth/account', { method: 'DELETE', body: JSON.stringify({ password }) }).catch(() => undefined);
  }
}

console.log(`Interview 100 OK: ${rows.length} tasks; Easy 30 / Medium 50 / Hard 20`);
