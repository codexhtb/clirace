import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hasQuickMatchIntent,
  legacyPvpOnlineHref,
  onlineModeFromSearch,
} from '../apps/web/src/flow-intents.ts';
import { primaryNavigation, routeMetadata } from '../apps/web/src/product-ux.ts';

let checks = 0;
const check = (condition: unknown, message: string) => { checks += 1; assert.ok(condition, message); };
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const webRoot = join(repoRoot, 'apps', 'web', 'src');
const source = (name: string) => readFile(join(webRoot, name), 'utf8');
const [app, header, play, online, quick, ranked, battle, rating, auth] = await Promise.all([
  source('App.tsx'), source('CommunityHeader.tsx'), source('PlayPage.tsx'), source('OnlinePage.tsx'),
  source('QuickMatchPanel.tsx'), source('RankedMatchPanel.tsx'), source('BattlePages.tsx'),
  source('LeaderboardPage.tsx'), source('AuthControl.tsx'),
]);

check(primaryNavigation.map(({ label }) => label).join('|') === 'Обучение|Практика|Онлайн|Рейтинг', 'navbar exposes the new product hierarchy');
check(!primaryNavigation.some(({ label }) => label === 'Соревнования'), 'top-level Competition tab is removed');
check(primaryNavigation.find(({ label }) => label === 'Онлайн')?.matches('/online', '?match=quick') === true, 'Online nav stays active for intents');
check(header.match(/primaryNavigation\.map/g)?.length === 2, 'desktop and mobile navigation share the same Online item');
check(app.includes("path === '/online'") && app.includes('<OnlinePage />'), 'Online owns a dedicated lazy SPA route');
check(routeMetadata('/online').canonical.endsWith('/online') && routeMetadata('/online').indexable, 'Online has public canonical metadata');

check(!play.includes("from './QuickMatchPanel'") && !play.includes("from './RankedMatchPanel'"), 'Practice no longer owns matchmaking components');
check(!play.includes('id="competition"') && play.includes('Solo Practice'), 'Practice hierarchy is solo-only');
check(play.includes('to="/online"') && play.includes('Хотите играть против других?'), 'Practice keeps only a small secondary Online link');

check(!hasQuickMatchIntent('') && onlineModeFromSearch('') === 'quick', 'direct /online selects Quick without enqueue intent');
check(online.includes('autoEnqueue={quickIntent}') && quick.includes("requestMatchmaking('/api/matchmaking/queue'"), 'Online explicit intent reuses the existing Quick enqueue');
check(quick.includes('onClick={() => void startSearch()}') && quick.includes("'Найти соперника'"), 'primary Quick CTA enqueues on its first click');
check(quick.includes('enqueueInFlightRef.current') && quick.includes('autoIntentHandledRef.current'), 'double click and repeated effects have one effective enqueue');
check(quick.includes("status.status !== 'idle'") && quick.includes('onIntentConsumed?.()'), 'refresh restores server queue state without duplicate enqueue');
check(quick.includes("method: 'DELETE'") && quick.includes('Отменить поиск'), 'Quick cancel is preserved');
check(quick.includes('waitingCapacity') && quick.includes("status.status === 'matched'"), 'capacity, matched and reconnect states are preserved');

check(online.includes('<RankedMatchPanel />') && ranked.includes("body: JSON.stringify({ mode: 'ranked' })"), 'Ranked CTA reuses the existing ranked flow');
check(online.includes('to="/battle"') && online.includes('Создать матч или ввести код'), 'Private Battle reuses the existing route');
check(online.includes("encodeURIComponent('/online?match=quick')") && auth.includes('navigate(returnTo)'), 'guest auth resumes the Quick intent');
check(app.includes('to="/online?match=quick"') && rating.includes('to="/online?mode=ranked"'), 'homepage and Rating CTAs use Online flows');
check(battle.includes("'/online?match=quick'") && battle.includes("'/online?mode=ranked'"), 'result next actions return to Online');

check(legacyPvpOnlineHref('?match=quick', '#competition') === '/online?match=quick', 'legacy Quick bookmark preserves auto intent');
check(legacyPvpOnlineHref('?compete=ranked', '#competition') === '/online?mode=ranked', 'legacy Ranked bookmark maps to Online');
check(legacyPvpOnlineHref('?compete=quick', '#competition') === '/online', 'legacy Competition tab maps without accidental enqueue');
check(legacyPvpOnlineHref('?match=quick&compete=ranked', '#competition') === '/online?match=quick', 'explicit Quick intent wins over stale Competition state');
check(legacyPvpOnlineHref('?category=linux', '') === null, 'normal Practice links stay on Practice');
check(app.includes('<Navigate to={onlineHref} replace />'), 'legacy compatibility uses SPA navigation');

const sources = await Promise.all((await readdir(webRoot)).filter((name) => /\.tsx?$/.test(name)).map(async (name) => [name, await source(name)] as const));
const hardNavigation = sources.flatMap(([name, value]) => /(?:window\.)?location\.(?:assign|replace|reload)|window\.location\.href\s*=/.test(value) ? [name] : []);
check(hardNavigation.length === 0, `no hard navigation primitives: ${hardNavigation.join(', ')}`);

console.log(JSON.stringify({ ok: true, checks, navigation: primaryNavigation.map(({ label }) => label) }, null, 2));
