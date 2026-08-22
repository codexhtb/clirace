import { lazy, Suspense, useEffect, useState } from 'react';
import { Activity, ArrowRight, Check, Command, Library, Swords, Terminal, Trophy } from 'lucide-react';
import { LeaderboardPage } from './LeaderboardPage';
import { DailyPage } from './DailyPage';
import { PlayPage } from './PlayPage';
import { ProfilePage } from './ProfilePage';
import { QuickStartSection } from './QuickStartSection';
import { InterviewPage } from './InterviewPage';
import { CommunityHeader } from './CommunityHeader';
import { AdminConsole } from './AdminConsole';
import { LearnPage } from './LearnPage';

const BattleCreatePage = lazy(() => import('./BattlePages').then((module) => ({
  default: module.BattleCreatePage,
})));
const BattleRoomPage = lazy(() => import('./BattlePages').then((module) => ({
  default: module.BattleRoomPage,
})));

function BattlePageFallback() {
  return <main className="page-width py-24 font-mono text-sm uppercase tracking-[0.15em] text-slate-500">Загружаем Battle…</main>;
}

type Health = {
  status: 'ready' | 'not_ready';
  checks: { postgres: 'up' | 'down'; redis: 'up' | 'down' };
};

const modes = [
  { key: '01', name: 'НАБОР', detail: 'Развивайте мышечную память команд.', time: '5–20 с' },
  { key: '02', name: 'ВСПОМНИ', detail: 'Превращайте задачу в точный синтаксис.', time: '10–30 с' },
  { key: '03', name: 'БЫСТРО', detail: 'Решайте короткие практические задачи.', time: '15–60 с' },
  { key: '04', name: 'SHELL', detail: 'Работайте в настоящей Linux-песочнице.', time: '30–60 с' },
];

const stats = [
  ['REAL', 'Linux shell'],
  ['ROOTLESS', 'изоляция'],
  ['OFF', 'внешняя сеть'],
  ['TTL', 'одноразовая сессия'],
];

function SystemStatus() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('API не готов');
        return response.json() as Promise<Health>;
      })
      .then(setHealth)
      .catch(() => setHealth(null));
    return () => controller.abort();
  }, []);

  const ready = health?.status === 'ready';

  return (
    <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-slate-400">
      <span className={`h-2 w-2 rounded-full ${ready ? 'bg-acid shadow-[0_0_12px_#b6f04a]' : 'bg-amber-400'}`} />
      {ready ? 'Системы готовы' : 'Проверка систем'}
    </div>
  );
}

function TerminalDemo() {
  return (
    <div className="terminal-shell shadow-glow" aria-label="Предпросмотр CLI-задачи">
      <div className="terminal-topbar">
        <div className="flex gap-1.5" aria-hidden="true">
          <span className="terminal-dot bg-[#ff6b66]" />
          <span className="terminal-dot bg-[#e9c55b]" />
          <span className="terminal-dot bg-[#68d391]" />
        </div>
        <span>забег/linux/средняя</span>
        <span className="text-acid">00:18.42</span>
      </div>

      <div className="grid border-b border-line sm:grid-cols-4">
        {stats.map(([value, label]) => (
          <div key={label} className="border-b border-line px-4 py-3 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
            <div className="font-mono text-lg font-semibold text-slate-100">{value}</div>
            <div className="mt-0.5 text-[10px] uppercase tracking-[0.16em] text-slate-500">{label}</div>
          </div>
        ))}
      </div>

      <div className="p-5 sm:p-7">
        <div className="mb-8 flex items-start justify-between gap-5">
          <div>
            <p className="eyebrow">Быстрая задача · Сети</p>
            <h2 className="mt-3 max-w-xl text-xl font-medium leading-snug text-white sm:text-2xl">
              Покажите TCP-сокеты в состоянии прослушивания и связанные с ними процессы.
            </h2>
          </div>
          <span className="difficulty">СРЕДНЯЯ</span>
        </div>

        <div className="command-line">
          <span className="select-none text-acid">clirace@box</span>
          <span className="select-none text-slate-500">:</span>
          <span className="select-none text-cyan">~</span>
          <span className="select-none text-slate-400">$</span>
          <span className="text-slate-100">ss -lntp</span>
          <span className="cursor-block" aria-hidden="true" />
        </div>

        <div className="mt-5 flex flex-col justify-between gap-3 border-t border-line pt-4 text-xs sm:flex-row sm:items-center">
          <span className="flex items-center gap-2 text-slate-500"><Command size={13} /> Enter — отправить · Esc — пропустить</span>
          <span className="flex items-center gap-2 font-mono text-acid"><Check size={14} /> семантическая проверка готова</span>
        </div>
      </div>
    </div>
  );
}

function HomePage() {
  return (
    <div className="min-h-screen overflow-hidden bg-ink text-slate-200">
      <div className="grid-noise fixed inset-0 pointer-events-none" />

      <CommunityHeader />

      <main className="relative z-10">
        <section className="page-width pb-16 pt-12 sm:pt-16 lg:pb-20 lg:pt-20">
          <div className="mb-10 grid items-center gap-9 lg:grid-cols-[1.04fr_0.96fr] lg:gap-14">
            <div>
              <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-line bg-white/[0.025] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-slate-400">
                <Activity size={12} className="text-acid" /> Измеримая мышечная память Linux
              </div>
              <h1 className="max-w-3xl text-4xl font-semibold leading-[1.02] tracking-[-0.05em] text-white sm:text-5xl lg:text-6xl">
                Соревновательная практика Linux и DevOps <span className="text-acid">в настоящем терминале.</span>
              </h1>
              <p className="mt-6 max-w-2xl text-base leading-7 text-slate-400 lg:text-lg">
                Не тест и не теория: получите задачу, откройте одноразовый Linux shell, выполните команду и сразу увидите результат.
              </p>
              <div className="mt-7 flex flex-wrap items-center gap-4">
                <a className="primary-button" href="/play">Начать практику <ArrowRight size={16} /></a>
                <a className="secondary-button" href="/battle"><Swords size={15} /> Сыграть с другом</a>
              </div>
              <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[10px] uppercase tracking-[0.12em] text-slate-600">
                <SystemStatus /><span>Задачи по 30–180 секунд</span><span>Без настройки окружения</span>
              </div>
            </div>
            <TerminalDemo />
          </div>
        </section>

        <section className="page-width pb-16">
          <div className="feature-strip">
            <div className="feature-item"><strong>229</strong><span>практических задач, включая Interview 100</span></div>
            <div className="feature-item"><strong>Real Shell</strong><span>одноразовая rootless Linux-песочница</span></div>
            <div className="feature-item"><strong>Daily</strong><span>общее испытание и серия дней</span></div>
            <div className="feature-item"><strong>Private Battle</strong><span>одинаковые задачи для двух игроков</span></div>
          </div>
        </section>

        <QuickStartSection />

        <section id="modes" className="border-y border-line bg-[#0a0e13]/90">
          <div className="page-width py-20">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Форматы практики</p>
                <h2>Один навык — несколько способов тренироваться.</h2>
              </div>
              <p>Переходите от точного синтаксиса к задачам на состояние Linux, не теряя темп.</p>
            </div>
            <div className="mt-10 divide-y divide-line border-y border-line">
              {modes.map((mode) => (
                <div key={mode.key} className="mode-row group">
                  <span className="font-mono text-xs text-slate-600">{mode.key}</span>
                  <span className="font-mono text-sm font-bold tracking-[0.1em] text-white group-hover:text-acid">{mode.name}</span>
                  <span className="text-sm text-slate-400">{mode.detail}</span>
                  <span className="justify-self-end font-mono text-xs text-slate-600">{mode.time}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="how-it-works" className="page-width py-20">
          <div className="grid gap-10 lg:grid-cols-[0.75fr_1.25fr] lg:gap-16">
            <div>
              <p className="eyebrow">Как это работает</p>
              <h2 className="mt-4 text-3xl font-semibold tracking-[-0.035em] text-white sm:text-4xl">От условия до результата — без настройки.</h2>
              <p className="mt-5 max-w-md leading-7 text-slate-400">
                CLIRace создаёт безопасное окружение только на время задания. Вы работаете с настоящими файлами и командами, а сервер проверяет итоговое состояние.
              </p>
            </div>
            <div className="architecture-flow">
              {[
                [Library, 'Получите задачу', 'короткое условие и понятная цель'],
                [Terminal, 'Решите в Linux shell', 'настоящие команды без доступа к хосту'],
                [Trophy, 'Получите результат', 'очки, время, серия и прогресс'],
              ].map(([Icon, label, detail], index) => {
                const FlowIcon = Icon as typeof Library;
                return (
                  <div className="flow-node" key={String(label)}>
                    <div className="flow-number">0{index + 1}</div>
                    <FlowIcon size={20} className="text-acid" />
                    <div><div className="text-sm font-medium text-white">{String(label)}</div><div className="mt-1 font-mono text-[10px] text-slate-500">{String(detail)}</div></div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <section className="border-t border-line">
          <div className="page-width flex flex-col gap-4 py-8 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
            <span className="font-mono font-semibold tracking-[0.14em] text-slate-300">CLIRACE</span>
            <span>Linux · DevOps · Shell · Interview · Battle</span>
          </div>
        </section>
      </main>
    </div>
  );
}

export function App() {
  const path = window.location.pathname;
  useEffect(() => {
    const title = path === '/learn/linux-core' ? 'Linux Core — обучение Linux с объяснениями | CLIRace'
      : path === '/learn' ? 'CLIRace Learn — обучение Linux и DevOps'
      : path.startsWith('/admin') ? 'Operations Console — CLIRace'
      : path === '/play' ? 'Играть — CLIRace'
      : path === '/interview' ? 'Interview 100 — CLIRace'
        : path === '/daily' ? 'Daily Challenge — CLIRace'
          : path === '/leaderboard' || path === '/rating' ? 'Рейтинг — CLIRace'
            : path.startsWith('/profile/') ? 'Профиль — CLIRace'
              : path.startsWith('/battle') ? 'Private Battle — CLIRace'
                : path === '/' || path === '/login' || path === '/register' ? 'CLIRace — практика Linux и DevOps в терминале'
                  : 'Страница не найдена — CLIRace';
    document.title = title;
    const description = path.startsWith('/learn')
      ? 'Изучайте основы Linux: отвечайте на вопросы, разбирайте ошибки и закрепляйте знания в настоящем терминале CLIRace.'
      : 'CLIRace — практика Linux и DevOps в настоящем терминале.';
    let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'description'; document.head.append(meta); }
    meta.content = description;
    let canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonical) { canonical = document.createElement('link'); canonical.rel = 'canonical'; document.head.append(canonical); }
    canonical.href = `https://clirace.fun${path}`;
  }, [path]);
  if (path === '/' || path === '/login' || path === '/register') return <HomePage />;
  if (path === '/admin' || path.startsWith('/admin/')) return <AdminConsole />;
  if (path === '/play') return <PlayPage />;
  if (path === '/learn') return <LearnPage catalogOnly />;
  if (path === '/learn/linux-core') return <LearnPage />;
  if (path === '/daily') return <DailyPage />;
  if (path === '/interview') return <InterviewPage />;
  if (path === '/battle') return <Suspense fallback={<BattlePageFallback />}><BattleCreatePage /></Suspense>;
  if (/^\/battle\/[A-HJ-NP-Z2-9]{5}$/i.test(path)) return <Suspense fallback={<BattlePageFallback />}><BattleRoomPage /></Suspense>;
  if (path === '/leaderboard' || path === '/rating') return <LeaderboardPage />;
  if (path.startsWith('/profile/')) return <ProfilePage />;
  return <NotFoundPage />;
}

function NotFoundPage() {
  return (
    <div className="min-h-screen bg-ink text-slate-200">
      <div className="grid-noise pointer-events-none fixed inset-0" />
      <CommunityHeader />
      <main className="page-width relative z-10 flex min-h-[70vh] items-center justify-center py-16 text-center">
        <section>
          <p className="eyebrow">Ошибка 404</p>
          <h1 className="mt-4 text-4xl font-semibold tracking-[-0.04em] text-white sm:text-6xl">Страница не найдена.</h1>
          <p className="mx-auto mt-4 max-w-lg text-sm leading-7 text-slate-500">Возможно, ссылка устарела или в адресе есть опечатка.</p>
          <a className="primary-button mt-8" href="/">Вернуться в CLIRace <ArrowRight size={15} /></a>
        </section>
      </main>
    </div>
  );
}
