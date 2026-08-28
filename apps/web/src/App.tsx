import { lazy, Suspense, useEffect, useState } from 'react';
import { Activity, ArrowRight, BookOpen, Check, Command, Swords, Terminal, Trophy } from 'lucide-react';
import { QuickStartSection } from './QuickStartSection';
import { CommunityHeader } from './CommunityHeader';
import { routeMetadata, secondaryNavigation } from './product-ux';
import { legacyPvpOnlineHref } from './flow-intents';
import { currentUser } from './auth-client';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { AppPage, PageLoader } from './Ui';

const BattleCreatePage = lazy(() => import('./BattlePages').then((module) => ({
  default: module.BattleCreatePage,
})));
const BattleRoomPage = lazy(() => import('./BattlePages').then((module) => ({
  default: module.BattleRoomPage,
})));
const LearningPathsPage = lazy(() => import('./LearningPathsPage').then((module) => ({ default: module.LearningPathsPage })));
const LeaderboardPage = lazy(() => import('./LeaderboardPage').then((module) => ({ default: module.LeaderboardPage })));
const DailyPage = lazy(() => import('./DailyPage').then((module) => ({ default: module.DailyPage })));
const PlayPage = lazy(() => import('./PlayPage').then((module) => ({ default: module.PlayPage })));
const OnlinePage = lazy(() => import('./OnlinePage').then((module) => ({ default: module.OnlinePage })));
const ProfilePage = lazy(() => import('./ProfilePage').then((module) => ({ default: module.ProfilePage })));
const InterviewPage = lazy(() => import('./InterviewPage').then((module) => ({ default: module.InterviewPage })));
const AdminConsole = lazy(() => import('./AdminConsole').then((module) => ({ default: module.AdminConsole })));
const LearnPage = lazy(() => import('./LearnPage').then((module) => ({ default: module.LearnPage })));
const TerminalReplayPage = lazy(() => import('./TerminalReplayPage').then((module) => ({ default: module.TerminalReplayPage })));

function BattlePageFallback() {
  return <AppPage><PageLoader label="Загружаем раздел" /></AppPage>;
}

type Health = {
  status: 'ready' | 'not_ready';
  checks: { postgres: 'up' | 'down'; redis: 'up' | 'down' };
};

const modes = [
  { key: '01', name: 'НАБОР', detail: 'Развивайте мышечную память команд.', time: '5–20 с' },
  { key: '02', name: 'ВСПОМНИ', detail: 'Превращайте задачу в точный синтаксис.', time: '10–30 с' },
  { key: '03', name: 'БЫСТРО', detail: 'Решайте короткие практические задачи.', time: '15–60 с' },
  { key: '04', name: 'ТЕРМИНАЛ', detail: 'Работайте в настоящей Linux-песочнице.', time: '30–60 с' },
];

const stats = [
  ['01', 'задача'],
  ['120', 'очки'],
  ['04', 'серия'],
  ['00:18', 'прошло'],
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

function LearningPathResume() {
  const [course, setCourse] = useState<{ slug: string; title: string; enrollment: { status: string; progress: number } } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    currentUser().then(({ user }) => user ? fetch('/api/learn/paths', { signal: controller.signal }) : null)
      .then(async (response) => response?.ok ? response.json() as Promise<{ courses: Array<{ slug: string; title: string; enrollment: { status: string; progress: number } | null }> }> : null)
      .then((payload) => setCourse(payload?.courses.find((candidate) => candidate.enrollment?.status === 'active') as typeof course ?? null))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  if (!course?.enrollment) return null;
  return <section className="page-width pb-16"><Link className="home-course-resume" to={`/learn/paths/${course.slug}`}><div><small>Продолжить обучение</small><strong>{course.title}</strong></div><span>{course.enrollment.progress}%</span><ArrowRight size={16} /></Link></section>;
}

function RouteFallback() {
  return <AppPage><PageLoader label="Загружаем раздел" /></AppPage>;
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
        <span>практика/linux/средняя</span>
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
                Практикуйте Linux и DevOps <span className="text-acid">в настоящем терминале.</span>
              </h1>
              <p className="mt-6 max-w-2xl text-base leading-7 text-slate-400 lg:text-lg">
                Решайте короткие задачи, разбирайте ошибки и соревнуйтесь с другими — без настройки окружения.
              </p>
              <div className="mt-7 flex flex-wrap items-center gap-4">
                <Link className="primary-button" to="/play">Начать практику <ArrowRight size={16} /></Link>
                <Link className="secondary-button" to="/online?match=quick"><Swords size={15} /> Найти соперника</Link>
              </div>
              <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.14em] text-acid">ONLINE PvP · реальный соперник · Quick без MMR</p>
              <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[10px] uppercase tracking-[0.12em] text-slate-600">
                <SystemStatus /><span>Задачи по 30–180 секунд</span><span>Без настройки окружения</span>
              </div>
            </div>
            <TerminalDemo />
          </div>
        </section>

        <section className="page-width pb-16" aria-labelledby="product-paths-title">
          <p className="eyebrow">Выберите направление</p>
          <h2 id="product-paths-title" className="mt-3 text-2xl font-semibold text-white sm:text-3xl">Начните с одного понятного шага.</h2>
          <div className="product-paths mt-6">
            <Link to="/play#practice"><Terminal size={19} /><div><strong>Практика</strong><span>Короткие задачи в настоящем Linux shell.</span></div><ArrowRight size={15} /></Link>
            <Link to="/learn"><BookOpen size={19} /><div><strong>Обучение</strong><span>Вопросы с разбором каждого ответа.</span></div><ArrowRight size={15} /></Link>
            <Link to="/online"><Trophy size={19} /><div><strong>Онлайн</strong><span>Quick без MMR, Ranked с MMR или матч с другом.</span></div><ArrowRight size={15} /></Link>
          </div>
        </section>

        <LearningPathResume />

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
                [BookOpen, 'Получите задачу', 'короткое условие и понятная цель'],
                [Terminal, 'Решите в Linux shell', 'настоящие команды без доступа к хосту'],
                [Trophy, 'Получите результат', 'очки, время, серия и прогресс'],
              ].map(([Icon, label, detail], index) => {
                const FlowIcon = Icon as typeof BookOpen;
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
            <nav className="footer-links" aria-label="Дополнительные разделы">{secondaryNavigation.map((item) => <Link to={item.href} key={item.href}>{item.label}</Link>)}</nav>
          </div>
        </section>
      </main>
    </div>
  );
}

export function App() {
  const { pathname: path, search, hash } = useLocation();
  useEffect(() => {
    const metadata = routeMetadata(path);
    document.title = metadata.title;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'description'; document.head.append(meta); }
    meta.content = metadata.description;
    let canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonical) { canonical = document.createElement('link'); canonical.rel = 'canonical'; document.head.append(canonical); }
    canonical.href = metadata.canonical;
    setMeta('property', 'og:title', metadata.title);
    setMeta('property', 'og:description', metadata.description);
    setMeta('property', 'og:url', metadata.canonical);
    setMeta('name', 'robots', metadata.indexable ? 'index, follow' : 'noindex, nofollow');
  }, [path]);
  if (path === '/' || path === '/login' || path === '/register') return <HomePage />;
  if (path === '/admin' || path.startsWith('/admin/')) return <Suspense fallback={<RouteFallback />}><AdminConsole /></Suspense>;
  if (path === '/play') {
    const onlineHref = legacyPvpOnlineHref(search, hash);
    if (onlineHref) return <Navigate to={onlineHref} replace />;
    return <Suspense fallback={<RouteFallback />}><PlayPage /></Suspense>;
  }
  if (path === '/online') return <Suspense fallback={<RouteFallback />}><OnlinePage /></Suspense>;
  if (/^\/practice\/replay\/[0-9a-f-]{36}$/i.test(path)) return <Suspense fallback={<RouteFallback />}><TerminalReplayPage /></Suspense>;
  if (path === '/learn') return <Suspense fallback={<RouteFallback />}><LearnPage catalogOnly /></Suspense>;
  if (path === '/learn/paths' || path.startsWith('/learn/paths/')) return <Suspense fallback={<BattlePageFallback />}><LearningPathsPage /></Suspense>;
  if (path === '/learn/linux-core') return <Suspense fallback={<RouteFallback />}><LearnPage /></Suspense>;
  if (path === '/daily') return <Suspense fallback={<RouteFallback />}><DailyPage /></Suspense>;
  if (path === '/interview') return <Suspense fallback={<RouteFallback />}><InterviewPage /></Suspense>;
  if (path === '/battle') return <Suspense fallback={<BattlePageFallback />}><BattleCreatePage /></Suspense>;
  if (/^\/battle\/[A-HJ-NP-Z2-9]{5}$/i.test(path)) return <Suspense fallback={<BattlePageFallback />}><BattleRoomPage /></Suspense>;
  if (path === '/leaderboard' || path === '/rating') return <Suspense fallback={<RouteFallback />}><LeaderboardPage /></Suspense>;
  if (path === '/profile' || path.startsWith('/profile/')) return <Suspense fallback={<RouteFallback />}><ProfilePage /></Suspense>;
  return <NotFoundPage />;
}

function setMeta(attribute: 'name' | 'property', key: string, content: string) {
  let element = document.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
  if (!element) { element = document.createElement('meta'); element.setAttribute(attribute, key); document.head.append(element); }
  element.content = content;
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
          <Link className="primary-button mt-8" to="/">Вернуться в CLIRace <ArrowRight size={15} /></Link>
        </section>
      </main>
    </div>
  );
}
