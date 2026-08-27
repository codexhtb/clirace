import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTINUE_SHELL_RETRY_DELAYS_MS,
  consumeQuickMatchIntent,
  hasQuickMatchIntent,
  sandboxStartErrorMessage,
  shouldAutoStartNextShell,
} from '../apps/web/src/flow-intents.ts';

let checks = 0;
const check = (condition: unknown, message: string) => { checks += 1; assert.ok(condition, message); };
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const webRoot = join(repoRoot, 'apps', 'web', 'src');
const source = async (name: string) => readFile(join(webRoot, name), 'utf8');
const [app, play, quick, shell, battle] = await Promise.all([
  source('App.tsx'), source('PlayPage.tsx'), source('QuickMatchPanel.tsx'),
  source('GameShellTerminal.tsx'), source('BattlePages.tsx'),
]);

check(app.includes('to="/play?match=quick#competition"'), 'homepage opponent CTA carries a direct Quick Match intent');
check(hasQuickMatchIntent('?match=quick') && !hasQuickMatchIntent('?compete=quick'), 'only the explicit action marker auto-enqueues');
check(quick.includes('autoEnqueue') && quick.includes("requestMatchmaking('/api/matchmaking/queue'"), 'auto flow reuses the existing Quick Match enqueue');
check(quick.includes('enqueueInFlightRef') && quick.includes('autoIntentHandledRef'), 'auto enqueue is guarded against repeat clicks and effects');
check(consumeQuickMatchIntent('?match=quick&compete=quick') === '?compete=quick', 'consuming the intent preserves unrelated query state');
check(play.includes('{ replace: true }') && play.includes('consumeQuickMatchIntent'), 'successful enqueue consumes history state with replace');
check(play.includes('location.pathname}${location.search}${location.hash}'), 'authentication return preserves the Quick Match intent');
check(quick.includes("method: 'DELETE'") && quick.includes('Отменить поиск'), 'existing cancel flow remains available');
check(quick.includes('waitingCapacity') && quick.includes('Место в очереди сохранено'), 'capacity waiting remains readable');
check(battle.includes('/play?match=quick#competition'), 'Quick Match result action starts a fresh search');
check(shouldAutoStartNextShell(true, 'real_shell'), 'explicit Continue auto-starts a following real-shell task');
check(!shouldAutoStartNextShell(false, 'real_shell') && !shouldAutoStartNextShell(true, 'quick'), 'direct opens and non-shell tasks never auto-start');
check(play.includes('autoStartShellTaskSlug') && shell.includes("start('continue-auto')"), 'Continue passes a local one-shot auto-start signal');
check(shell.includes("fetch('/api/sandbox/sessions'") && shell.includes("start('manual')"), 'automatic and retry actions reuse the existing sandbox endpoint');
check(CONTINUE_SHELL_RETRY_DELAYS_MS.length === 2 && CONTINUE_SHELL_RETRY_DELAYS_MS.every((delay) => delay <= 1_400), 'terminating-shell retries are short and bounded');
check(sandboxStartErrorMessage('capacity_full').includes('заняты') && sandboxStartErrorMessage('user_capacity_full').includes('завершает работу'), 'capacity and cleanup failures have readable copy');

console.log(JSON.stringify({ ok: true, checks }, null, 2));
