import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isNewPlayer, learningDifficulty, learningQuestionType, practiceHrefForWeakArea,
  primaryNavigation, routeMetadata,
} from '../apps/web/src/product-ux.ts';

let checks = 0;
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const check = (condition: unknown, message: string) => { checks += 1; assert.ok(condition, message); };

check(primaryNavigation.length === 4, 'primary navigation stays focused');
check(primaryNavigation.every((item) => item.href.startsWith('/')), 'primary navigation uses crawlable internal links');
check(new Set(primaryNavigation.map((item) => item.label)).size === 4, 'primary navigation labels are distinct');

const publicRoutes = ['/', '/play', '/learn', '/learn/linux-core', '/interview', '/daily', '/rating'];
const metadata = publicRoutes.map(routeMetadata);
check(metadata.every((item) => item.indexable), 'public routes remain indexable');
check(new Set(metadata.map((item) => item.title)).size === publicRoutes.length, 'public route titles are unique');
check(new Set(metadata.map((item) => item.description)).size === publicRoutes.length, 'public route descriptions are unique');
check(routeMetadata('/admin').indexable === false, 'admin is noindex');
check(routeMetadata('/battle/ABCDE').indexable === false, 'private battle is noindex');

check(practiceHrefForWeakArea('networking').includes('category=networking'), 'Networking maps to Networking practice');
check(practiceHrefForWeakArea('pipes_redirection').includes('category=bash'), 'Pipes map to Bash practice');
check(practiceHrefForWeakArea('unknown').includes('category=linux'), 'unknown weak areas have a safe deterministic fallback');
check(learningQuestionType('multiple_choice') === 'несколько ответов', 'Learn question types are humanized');
check(learningDifficulty('hard') === 'сложно', 'Learn difficulty is humanized');
check(isNewPlayer({ stats: { runs: 0 }, ranked: { gamesPlayed: 0 }, learning: { answered: 0 } }), 'empty profile gets onboarding');
check(!isNewPlayer({ stats: { runs: 1 }, ranked: { gamesPlayed: 0 }, learning: { answered: 0 } }), 'returning practice user skips onboarding');
check(!isNewPlayer({ stats: { runs: 0 }, ranked: { gamesPlayed: 0 }, learning: { answered: 1 } }), 'returning Learn user skips onboarding');

const webRoot = join(repoRoot, 'apps', 'web', 'src');
const sourceFiles = (await readdir(webRoot)).filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'));
const sources = await Promise.all(sourceFiles.map(async (name) => [name, await readFile(join(webRoot, name), 'utf8')] as const));
const directAuthCalls = sources.flatMap(([name, source]) => source.includes("fetch('/api/auth/me") ? [name] : []);
check(directAuthCalls.length === 1 && directAuthCalls[0] === 'auth-client.ts', 'auth request is deduplicated through auth-client');

const play = await readFile(join(webRoot, 'PlayPage.tsx'), 'utf8');
const learn = await readFile(join(webRoot, 'LearnPage.tsx'), 'utf8');
const battle = await readFile(join(webRoot, 'BattlePages.tsx'), 'utf8');
check(play.includes('Начните здесь') && play.includes('без рейтинга') && play.includes('влияет на MMR'), 'new-user and mode guidance are present');
check(learn.includes('practiceHrefForWeakArea') && learn.includes('Разберём ответ'), 'Learn explanation and next practice action are present');
check(battle.includes('Матч не повлиял на рейтинг') && battle.includes('Снова Ranked'), 'Ranked no-contest and replay actions are present');

const sitemap = await readFile(join(repoRoot, 'apps', 'web', 'public', 'sitemap.xml'), 'utf8');
check(publicRoutes.every((path) => sitemap.includes(`<loc>https://clirace.fun${path}</loc>`)), 'all public routes are in sitemap');
check(!sitemap.includes('/admin') && !sitemap.includes('/battle'), 'private routes stay out of sitemap');

console.log(JSON.stringify({ ok: true, checks, publicRoutes: publicRoutes.length, primaryNavigation: primaryNavigation.length }, null, 2));
