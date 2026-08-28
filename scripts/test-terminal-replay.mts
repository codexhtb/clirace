import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  REPLAY_MAX_EVENTS,
  REPLAY_MAX_LOGICAL_BYTES,
  terminalReplayV1Schema,
} from '../apps/api/src/terminal-replay-format.ts';
import { TerminalReplayRecorder } from '../apps/api/src/terminal-replay-recorder.ts';
import { parseReplayPayload, playbackPosition, replayMarkerLabel } from '../apps/web/src/replay-player.ts';

let passed = 0;
function check(condition: unknown, name: string) {
  assert.ok(condition, name);
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

const valid = {
  version: 1,
  initialCols: 100,
  initialRows: 28,
  events: [
    { seq: 0, tMs: 0, type: 'output', data: Buffer.from('\u001b[32mпривет\u001b[0m').toString('base64') },
    { seq: 1, tMs: 10, type: 'resize', cols: 120, rows: 32 },
    { seq: 2, tMs: 20, type: 'checker', status: 'failed', passed: 2, total: 3 },
    { seq: 3, tMs: 30, type: 'completed', scoreAwarded: 100, gameCompleted: false },
  ],
};
check(terminalReplayV1Schema.safeParse(valid).success, 'valid Replay Format V1 passes');
check(!terminalReplayV1Schema.safeParse({ ...valid, version: 2 }).success, 'unknown replay version is rejected');
check(!terminalReplayV1Schema.safeParse({ ...valid, events: [{ seq: 0, tMs: 0, type: 'input', data: 'secret' }] }).success, 'input event type is rejected');
check(!terminalReplayV1Schema.safeParse({ ...valid, events: [{ ...valid.events[0], seq: 1 }] }).success, 'non-contiguous first sequence is rejected');
check(!terminalReplayV1Schema.safeParse({ ...valid, events: [{ ...valid.events[0] }, { ...valid.events[1], seq: 0 }] }).success, 'duplicate sequence is rejected');
check(!terminalReplayV1Schema.safeParse({ ...valid, events: [{ ...valid.events[0], tMs: -1 }] }).success, 'negative timestamp is rejected');
check(!terminalReplayV1Schema.safeParse({ ...valid, events: [{ ...valid.events[0], tMs: 2 }, { ...valid.events[1], tMs: 1 }] }).success, 'non-monotonic timestamp is rejected');
check(!terminalReplayV1Schema.safeParse({ ...valid, initialCols: 2 }).success, 'invalid initial terminal dimensions are rejected');
check(!terminalReplayV1Schema.safeParse({ ...valid, events: [{ seq: 0, tMs: 0, type: 'resize', cols: 999, rows: 1 }] }).success, 'invalid resize is rejected');
check(!terminalReplayV1Schema.safeParse({ ...valid, events: [{ seq: 0, tMs: 0, type: 'output', data: 'not-base64!' }] }).success, 'corrupt output encoding is rejected');
check(!terminalReplayV1Schema.safeParse({ version: 1, events: [] }).success, 'missing required metadata is rejected');
check(!terminalReplayV1Schema.safeParse({ ...valid, events: [{ seq: 0, tMs: 0, type: 'output', data: Buffer.alloc(REPLAY_MAX_LOGICAL_BYTES + 1).toString('base64') }] }).success, 'oversized stored output is rejected');

const recorder = new TerminalReplayRecorder(100, 28);
recorder.recordOutput(Buffer.from('A'));
recorder.recordResize(120, 30);
recorder.recordOutput(Buffer.from('B'));
recorder.recordChecker({ status: 'failed', checks: [{ id: 'one', status: 'failed' }] });
const completed = recorder.finalize(120, false);
check(completed.payload.events.map((event) => event.type).join(',') === 'output,resize,output,checker,completed', 'recorder preserves authoritative event order');
check(completed.payload.events.every((event, index) => event.seq === index), 'recorder sequence is monotonic');
check(completed.payload.events.every((event, index, events) => index === 0 || event.tMs >= events[index - 1]!.tMs), 'recorder timestamps are monotonic');
check(completed.payload.events.some((event) => event.type === 'resize' && event.cols === 120), 'resize is recorded');
check(completed.payload.events.some((event) => event.type === 'checker' && event.status === 'failed'), 'checker marker is recorded');
check(completed.payload.events.at(-1)?.type === 'completed', 'completion marker is recorded');
check(recorder.finalize(999, true) === completed, 'finalization is idempotent');

const reconnectRecorder = new TerminalReplayRecorder(100, 28);
reconnectRecorder.recordOutput(Buffer.from('COMMAND_A_ONCE'));
reconnectRecorder.recordOutput(Buffer.from('COMMAND_B_ONCE'));
const reconnectReplay = reconnectRecorder.finalize(1, false);
const replayText = reconnectReplay.payload.events.filter((event) => event.type === 'output').map((event) => Buffer.from(event.data, 'base64').toString()).join('');
check(replayText.match(/COMMAND_A_ONCE/g)?.length === 1 && replayText.match(/COMMAND_B_ONCE/g)?.length === 1, 'one recorder spans reconnect without duplicating output');

const bounded = new TerminalReplayRecorder(100, 28, 1_024, 32);
for (let index = 0; index < 100; index += 1) bounded.recordOutput(Buffer.alloc(128, index));
bounded.recordChecker({ status: 'passed', checks: [{ id: 'bounded-check', status: 'passed' }] });
const truncated = bounded.finalize(5, true);
check(truncated.truncated, 'recorder marks oversized sessions as truncated');
check(truncated.sizeBytes <= 1_024 && truncated.eventCount <= 32, 'recorder enforces byte and event limits');
check(truncated.payload.events.some((event) => event.type === 'checker'), 'semantic checker marker survives output truncation');
check(truncated.payload.events.some((event) => event.type === 'completed'), 'completion marker survives output truncation');
check(REPLAY_MAX_LOGICAL_BYTES === 512 * 1024 && REPLAY_MAX_EVENTS === 4_096, 'production replay bounds are explicit');

const checkerFlood = new TerminalReplayRecorder(100, 28, 1_024, 20);
for (let index = 0; index < 100; index += 1) {
  checkerFlood.recordChecker({ status: 'failed', checks: [{ id: 'repeated-check', status: 'failed' }] });
}
const checkerFloodReplay = checkerFlood.finalize(5, true);
check(checkerFloodReplay.truncated, 'repeated checker events respect the replay event bound');
check(checkerFloodReplay.eventCount <= 20 && checkerFloodReplay.payload.events.at(-1)?.type === 'completed', 'completion keeps its reserved final event after checker flood');

check(parseReplayPayload(valid)?.events.length === 4, 'frontend accepts valid V1 payload');
check(parseReplayPayload({ ...valid, version: 99 }) === undefined, 'frontend safely rejects unknown version');
check(parseReplayPayload({ ...valid, events: [{ seq: 0, tMs: 0, type: 'output', data: '<script>' }] }) === undefined, 'frontend rejects malformed output rather than treating it as HTML');
check(playbackPosition(1_000, 5_000, 5_500, 2, 9_000) === 2_000, '2x playback uses elapsed clock');
check(playbackPosition(1_000, 5_000, 5_500, 4, 9_000) === 3_000, '4x playback uses elapsed clock');
check(playbackPosition(8_900, 5_000, 6_000, 4, 9_000) === 9_000, 'playback clock clamps at duration');
check(replayMarkerLabel({ seq: 0, tMs: 0, type: 'checker', status: 'passed', passed: 3, total: 3 }) === 'Проверка: 3/3', 'checker marker has safe public label');
check(replayMarkerLabel({ seq: 0, tMs: 0, type: 'completed', scoreAwarded: 1, gameCompleted: true }) === 'Задача выполнена', 'completion marker has public label');

const managerSource = await readFile(new URL('../apps/api/src/sandbox-manager.ts', import.meta.url), 'utf8');
const routesSource = await readFile(new URL('../apps/api/src/terminal-replay-routes.ts', import.meta.url), 'utf8');
const serviceSource = await readFile(new URL('../apps/api/src/terminal-replay-service.ts', import.meta.url), 'utf8');
const playerSource = await readFile(new URL('../apps/web/src/TerminalReplayPage.tsx', import.meta.url), 'utf8');
const migrationSource = await readFile(new URL('../apps/api/migrations/017_terminal_replay_v1.sql', import.meta.url), 'utf8');
check(!managerSource.includes('recordInput') && !managerSource.includes("type: 'input', data: message.data"), 'raw client input has no recorder path');
check(managerSource.includes('session.stream.write(message.data)') && managerSource.includes('session.replayRecorder?.recordOutput(chunk)'), 'input goes only to PTY while authoritative output goes to recorder');
check(managerSource.indexOf('session.replayRecorder?.recordOutput(chunk)') < managerSource.indexOf('socket.send(chunk, { binary: true })'), 'recording occurs before WebSocket delivery');
check(managerSource.includes('if (!session.battle && !session.replayRecorder)') && managerSource.includes("destroySession(sessionId, reason)"), 'reconnect grace is limited to Battle and recorded Practice sessions');
check(managerSource.includes('terminal_replay_persist_failed') && managerSource.includes('.catch((error: unknown)'), 'replay persistence failure is isolated from completion');
check(serviceSource.includes('tr.user_id = $2') && routesSource.includes('deleteOwned(parsed.data.id, user.id)'), 'GET and DELETE are owner-scoped');
check(routesSource.includes("reply.code(404)"), 'unauthorized replay enumeration uses not-found semantics');
check(migrationSource.includes('ON DELETE CASCADE') && migrationSource.includes('UNIQUE (session_task_id)'), 'database enforces user cleanup and one replay per task');
check(migrationSource.includes('expires_at') && serviceSource.includes('expires_at > now()'), 'expired replay is unavailable before janitor deletion');
check(!playerSource.includes('dangerouslySetInnerHTML') && playerSource.includes('terminal.write(decodeReplayOutput'), 'ANSI output is rendered by xterm without HTML injection');
check(playerSource.includes('type="range"') && playerSource.includes('aria-label="Позиция повтора"'), 'seek is an accessible range control');
check(playerSource.includes("([1, 2, 4] as const)") && playerSource.includes('requestAnimationFrame'), 'player implements 1x/2x/4x with elapsed playback clock');
check(playerSource.includes('terminal.reset()') && playerSource.includes('eventIndexRef.current = 0'), 'seek reconstructs terminal from the beginning');
check(playerSource.includes("window.confirm('Удалить этот повтор?"), 'manual delete requires confirmation');
check(!JSON.stringify(completed.payload).includes('cookie') && !JSON.stringify(completed.payload).includes('token'), 'replay payload contains no auth cookie or terminal ticket fields');

const representativeChunks = Array.from({ length: 1_000 }, () => Buffer.alloc(256, 65));
let baselineBytes = 0;
const baselineStarted = performance.now();
for (const chunk of representativeChunks) baselineBytes += chunk.length;
const baselineMs = performance.now() - baselineStarted;
const benchmarkRecorder = new TerminalReplayRecorder(100, 28);
const recordingStarted = performance.now();
for (const chunk of representativeChunks) benchmarkRecorder.recordOutput(chunk);
const recordingMs = performance.now() - recordingStarted;
check(baselineBytes === 256_000 && benchmarkRecorder.finalize(1, false).eventCount === 1_001, 'representative recorder append remains bounded and complete');

console.log(JSON.stringify({ checks: passed, benchmark: { chunks: representativeChunks.length, bytes: baselineBytes, baselineMs: Number(baselineMs.toFixed(3)), recordingMs: Number(recordingMs.toFixed(3)) } }, null, 2));
console.log(`terminal-replay: ${passed}/${passed} checks passed`);
