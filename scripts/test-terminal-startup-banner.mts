import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const bashrc = await readFile(new URL('../infra/sandbox/bashrc', import.meta.url), 'utf8');
const terminalSource = await readFile(new URL('../apps/web/src/GameShellTerminal.tsx', import.meta.url), 'utf8');
const managerSource = await readFile(new URL('../apps/api/src/sandbox-manager.ts', import.meta.url), 'utf8');

const banner = 'CLIRace sandbox';
assert.equal(bashrc.split(banner).length - 1, 1, 'sandbox image must define exactly one startup banner');
assert.match(bashrc, /if \[\[ \$- == \*i\* \]\]; then[\s\S]*CLIRace sandbox[\s\S]*fi/, 'banner must be restricted to the final interactive shell');
assert.ok(!terminalSource.includes('CLIRace game shell'), 'Practice frontend must not synthesize a shell banner inside xterm');
assert.ok(!terminalSource.includes("terminalRef.current?.writeln('\\x1b[38;2;82;211;247mГотовим терминал"), 'loading status must stay outside xterm');
assert.ok(terminalSource.includes("status === 'connecting' ? 'Готовим терминал…'"), 'loading status remains visible outside xterm');
assert.ok(managerSource.includes("exec /bin/bash -l"), 'authoritative interactive login shell remains the terminal source');
assert.ok(!managerSource.includes("includes('CLIRace sandbox')") && !managerSource.includes("replace('CLIRace sandbox'"), 'PTY output is not suppressed by banner string matching');

console.log(JSON.stringify({
  ok: true,
  bannerDefinitions: 1,
  interactiveOnly: true,
  frontendSyntheticBanner: false,
  frontendLoadingInsideXterm: false,
  authoritativePtyFiltering: false,
}, null, 2));
