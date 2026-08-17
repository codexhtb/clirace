import { lazy, Suspense, useEffect, useState } from 'react';
import { Activity, ArrowRight, Check, Command, Gauge, Network, Server, Swords } from 'lucide-react';
import { AuthControl } from './AuthControl';
import { LeaderboardPage } from './LeaderboardPage';
import { DailyPage } from './DailyPage';
import { PlayPage } from './PlayPage';
import { ProfilePage } from './ProfilePage';
import { QuickStartSection } from './QuickStartSection';
import { InterviewPage } from './InterviewPage';

const ShellTerminal = lazy(() => import('./ShellTerminal').then((module) => ({
  default: module.ShellTerminal,
})));
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
  ['07', 'задача'],
  ['1 840', 'очки'],
  ['12', 'серия'],
  ['98,4%', 'точность'],
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

      <header className="relative z-10 border-b border-line/80">
        <div className="page-width flex h-16 items-center justify-between">
          <a href="/" className="flex items-center gap-2.5" aria-label="Главная CLIRace">
            <span className="logo-mark"><span>&gt;_</span></span>
            <span className="font-mono text-sm font-bold tracking-[0.12em] text-white">CLIRACE</span>
          </a>
          <nav className="hidden items-center gap-7 text-xs font-medium text-slate-400 md:flex" aria-label="Основная навигация">
            <a className="nav-link" href="#quick-start">Быстрый старт</a>
            <a className="nav-link" href="#modes">Режимы</a>
            <a className="nav-link" href="/daily">Daily</a>
            <a className="nav-link" href="/interview">Interview 100</a>
            <a className="nav-link" href="/battle">Battle</a>
            <a className="nav-link" href="/leaderboard">Рейтинг</a>
          </nav>
          <div className="flex items-center gap-3 sm:gap-5">
            <div className="hidden lg:block"><SystemStatus /></div>
            <AuthControl />
          </div>
        </div>
      </header>

      <main className="relative z-10">
        <section className="page-width pb-20 pt-16 lg:pb-28 lg:pt-24">
          <div className="mb-12 grid items-end gap-10 lg:grid-cols-[1.1fr_0.9fr]">
            <div>
              <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-line bg-white/[0.025] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-slate-400">
                <Activity size={12} className="text-acid" /> Измеримая мышечная память Linux
              </div>
              <h1 className="max-w-4xl text-5xl font-semibold leading-[0.96] tracking-[-0.055em] text-white sm:text-6xl lg:text-[78px]">
                Тренируйтесь в ритме <span className="text-acid">терминала.</span>
              </h1>
            </div>
            <div className="lg:pb-1">
              <p className="max-w-xl text-base leading-7 text-slate-400 lg:text-lg">
                Короткие соревновательные задачи по Linux и DevOps. Вводите настоящие команды, набирайте серии и развивайте навыки уверенной работы в терминале.
              </p>
              <div className="mt-7 flex flex-wrap items-center gap-4">
                <a className="primary-button" href="/play">Начать забег <ArrowRight size={16} /></a>
                <a className="secondary-button" href="/battle"><Swords size={15} /> Private Battle</a>
                <span className="font-mono text-xs text-slate-500">Без настройки · задачи по 5–60 секунд</span>
              </div>
            </div>
          </div>

          <div id="demo">
            <Suspense fallback={<div className="terminal-shell h-[520px] animate-pulse bg-[#0b1016]" aria-label="Загрузка терминала" />}>
              <ShellTerminal />
            </Suspense>
          </div>
        </section>

        <QuickStartSection />

        <section id="modes" className="border-y border-line bg-[#0a0e13]/90">
          <div className="page-width py-20">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Четыре режима тренировки</p>
                <h2>Быстрые повторы. Настоящие CLI-навыки.</h2>
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

        <section id="architecture" className="page-width py-20 lg:py-28">
          <div className="grid gap-12 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20">
            <div>
              <p className="eyebrow">Готово к настоящей практике</p>
              <h2 className="mt-4 text-3xl font-semibold tracking-[-0.035em] text-white sm:text-4xl">Безопасный путь к реальному bash.</h2>
              <p className="mt-5 max-w-md leading-7 text-slate-400">
                Архитектура разделяет публичную точку входа, аккаунты, закрытый слой данных и одноразовые rootless-песочницы, не открывая shell хост-системы.
              </p>
            </div>
            <div className="architecture-flow">
              {[
                [Network, 'Входной Nginx', 'единая публичная точка'],
                [Gauge, 'Fastify API', 'состояние и готовность'],
                [Server, 'Слой данных', 'Postgres · Redis'],
              ].map(([Icon, label, detail], index) => {
                const FlowIcon = Icon as typeof Network;
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

        <section id="roadmap" className="border-t border-line">
          <div className="page-width flex flex-col gap-5 py-8 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
            <span className="font-mono uppercase tracking-[0.16em]">ЭТАП 5 · РЕЙТИНГИ И ПРОФИЛИ</span>
            <span>История забегов · рейтинг категорий · глобальная таблица</span>
          </div>
        </section>
      </main>
    </div>
  );
}

export function App() {
  const path = window.location.pathname;
  if (path === '/play') return <PlayPage />;
  if (path === '/daily') return <DailyPage />;
  if (path === '/interview') return <InterviewPage />;
  if (path === '/battle') return <Suspense fallback={<BattlePageFallback />}><BattleCreatePage /></Suspense>;
  if (/^\/battle\/[A-HJ-NP-Z2-9]{5}$/i.test(path)) return <Suspense fallback={<BattlePageFallback />}><BattleRoomPage /></Suspense>;
  if (path === '/leaderboard') return <LeaderboardPage />;
  if (path.startsWith('/profile/')) return <ProfilePage />;
  return <HomePage />;
}
