import assert from 'node:assert/strict';
import {
  SANDBOX_LIFECYCLE_STATES,
  assertSandboxTransition,
  canTransitionSandbox,
  evaluateSandboxCapacity,
} from '../apps/api/src/sandbox-platform.js';

assert.equal(SANDBOX_LIFECYCLE_STATES.length, 9);
assert.equal(canTransitionSandbox('requested', 'starting'), true);
assert.equal(canTransitionSandbox('starting', 'attached'), false);
assert.equal(canTransitionSandbox('idle', 'attached'), true);
assert.equal(canTransitionSandbox('terminated', 'starting'), false);
assert.throws(() => assertSandboxTransition('failed', 'ready'), /Invalid sandbox lifecycle transition/);

assert.deepEqual(evaluateSandboxCapacity({ maxCapacity: 25, perUserCapacity: 1, globalLive: 24, userLive: 0 }), { allowed: true });
assert.deepEqual(evaluateSandboxCapacity({ maxCapacity: 25, perUserCapacity: 1, globalLive: 25, userLive: 0 }), { allowed: false, code: 'capacity_full' });
assert.deepEqual(evaluateSandboxCapacity({ maxCapacity: 25, perUserCapacity: 1, globalLive: 1, userLive: 1 }), { allowed: false, code: 'user_capacity_full' });

console.log(JSON.stringify({ ok: true, lifecycleStates: SANDBOX_LIFECYCLE_STATES.length, capacityBoundary: 25 }, null, 2));
