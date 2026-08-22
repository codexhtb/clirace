import { ArrowLeft, BookOpen, BookOpenCheck, CalendarDays, CheckCircle2, ChevronRight, Clock3, Flame, LoaderCircle, Map, RotateCcw, Send, SkipForward, Swords, Terminal, Trophy } from 'lucide-react';
import { lazy, Suspense, type FormEvent, useEffect, useRef, useState } from 'react';
import { CommunityHeader } from './CommunityHeader';
import { currentUser } from './auth-client';
import { humanizeError } from './errors';
import { isNewPlayer } from './product-ux';
import { QuickMatchPanel } from './QuickMatchPanel';
import { RankedMatchPanel } from './RankedMatchPanel';
import { PageLoader } from './Ui';
import { difficultyLabel } from './product-language';
import { Link } from 'react-router-dom';

const GameShellTerminal = lazy(() => import('./GameShellTerminal').then((module) => ({ default: module.GameShellTerminal })));

interface Category { slug: string; name: string; description: string; challenge_count: number; }
interface GameSession {
  id: string;
  status: 'active' | 'completed';
  score: number;
  streak: number;
  bestStreak: number;
  ratingDelta: number;
  practiceScoreDelta?: number;
  mode: string;
  startedAt: string;
  completedAt: string | null;
}
interface GameTask {
  slug: string;
  title: string;
  description: string;
  difficulty: 'Easy' | 'Medium' | 'Hard' | 'Expert';
  type: 'recall' | 'quick' | 'real_shell';
  category: { slug: string; name: string };
  position: number;
  total: number;
  presentedAt: string;
  attempts: number;
  hint?: string;
}
interface GameSummary { total: number; correct: number; skipped: number; answered: number; duration_ms: number; }
interface GameState { session: GameSession; task: GameTask | null; summary?: GameSummary; }

const modeOptions = [
  { value: 'mixed', label: 'Смешанный', detail: 'Вспомни + быстрые задачи' },
  { value: 'recall', label: 'Вспомни', detail: 'Точная команда по описанию' },
  { value: 'quick', label: 'Быстро', detail: 'Короткая практическая задача' },
  { value: 'real_shell', label: 'Терминал', detail: 'Настоящая Linux-песочница' },
] as const;

export function PlayPage() {
  const [auth, setAuth] = useState<'loading' | 'guest' | 'ready'>('loading');
  const [categories, setCategories] = useState<Category[]>([]);
  const [shellEnabled, setShellEnabled] = useState(false);
  const [newPlayer, setNewPlayer] = useState(false);
  const [game, setGame] = useState<GameState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'correct' | 'wrong' | 'skip'; text: string; score?: number } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      currentUser(),
      fetch('/api/categories', { signal: controller.signal }).then((response) => response.json() as Promise<{ categories: Category[] }>),
      fetch('/api/sandbox/status', { signal: controller.signal }).then((response) => response.json() as Promise<{ enabled: boolean; healthy?: boolean }>),
    ]).then(async ([authPayload, categoryPayload, sandboxPayload]) => {
      setAuth(authPayload.user ? 'ready' : 'guest');
      setCategories(categoryPayload.categories ?? []);
      setShellEnabled(sandboxPayload.enabled === true && sandboxPayload.healthy !== false);
      if (authPayload.user) {
        const response = await fetch(`/api/profiles/${encodeURIComponent(authPayload.user.username)}`, { cache: 'no-store', signal: controller.signal });
        if (response.ok) {
          const payload = await response.json() as { profile?: Parameters<typeof isNewPlayer>[0] };
          setNewPlayer(isNewPlayer(payload.profile ?? null));
        }
      }
    }).catch(() => {
      setAuth('guest');
      setCategories([]);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const sessionId = new URLSearchParams(window.location.search).get('session');
    if (auth !== 'ready' || !sessionId || game) return;
    const controller = new AbortController();
    setBusy(true);
    fetch(`/api/game/sessions/${encodeURIComponent(sessionId)}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as GameState & { message?: string };
        if (!response.ok) throw new Error(payload.message ?? 'Забег не найден.');
        setGame(payload);
      })
      .catch((reason) => { if (reason.name !== 'AbortError') setError(humanizeError(reason, 'Не удалось открыть забег.')); })
      .finally(() => setBusy(false));
    return () => controller.abort();
  }, [auth, game]);

  const createGame = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch('/api/game/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          category: data.get('category'),
          difficulty: data.get('difficulty'),
          mode: data.get('mode'),
          taskCount: Number(data.get('taskCount')),
          ...(data.get('challengeSlug') ? { challengeSlug: data.get('challengeSlug') } : {}),
        }),
      });
      const payload = await response.json() as GameState & { message?: string };
      if (!response.ok) throw new Error(payload.message ?? 'Не удалось создать забег.');
      setGame(payload);
      setFeedback(null);
    } catch (createError) {
      setError(humanizeError(createError, 'Не удалось создать забег. Попробуйте ещё раз.'));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setGame(null);
    setFeedback(null);
    setError(null);
  };

  return (
    <div className="play-page min-h-screen bg-ink text-slate-200">
      <div className="grid-noise fixed inset-0 pointer-events-none" />
      <CommunityHeader />

      <main className="page-width relative z-10 py-10 sm:py-16">
        {auth === 'loading' && <PageLoader label="Проверяем аккаунт" />}
        {auth === 'guest' && <GuestState />}
        {auth === 'ready' && !game && (
          <SetupScreen categories={categories} shellEnabled={shellEnabled} busy={busy} error={error} newPlayer={newPlayer} onSubmit={createGame} />
        )}
        {auth === 'ready' && game?.session.status === 'active' && game.task && (
          <RunScreen game={game} busy={busy} feedback={feedback} setBusy={setBusy} setGame={setGame} setFeedback={setFeedback} setError={setError} />
        )}
        {auth === 'ready' && game?.session.status === 'completed' && game.summary && (
          <FinalScreen game={game} onReset={reset} />
        )}
        {error && game && <p className="play-error mt-5" role="alert">{error}</p>}
      </main>
    </div>
  );
}

function SetupScreen({ categories, shellEnabled, busy, error, newPlayer, onSubmit }: {
  categories: Category[]; shellEnabled: boolean; busy: boolean; error: string | null; newPlayer: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const requestedCompetition = new URLSearchParams(window.location.search).get('compete');
  const [matchmakingMode, setMatchmakingMode] = useState<'quick' | 'ranked'>(requestedCompetition === 'ranked' ? 'ranked' : 'quick');
  useEffect(() => {
    if (requestedCompetition === 'quick' || requestedCompetition === 'ranked') return;
    const controller = new AbortController();
    fetch('/api/matchmaking/status?mode=quick', { cache: 'no-store', signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((payload: { pool?: 'quick' | 'ranked' } | null) => {
        if (payload?.pool === 'ranked') setMatchmakingMode('ranked');
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [requestedCompetition]);
  const requestedDefaults = getPlayDefaults();
  const defaults = requestedDefaults.mode === 'real_shell' && !shellEnabled
    ? { ...requestedDefaults, mode: 'mixed' as const }
    : requestedDefaults;
  return (
    <section className="mx-auto max-w-4xl">
      <div className="mb-10">
        <p className="eyebrow">Практика и соревнования</p>
        <h1 className="mt-4 text-4xl font-semibold tracking-[-0.045em] text-white sm:text-6xl">Выберите следующий шаг.</h1>
        <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-400">Тренируйтесь самостоятельно или сыграйте три одинаковых shell-раунда против другого игрока.</p>
      </div>

      {newPlayer && <section className="onboarding-card" aria-labelledby="first-step-title">
        <div><p className="eyebrow">Начните здесь</p><h2 id="first-step-title">Выберите подходящий первый шаг.</h2><p>Новичкам подойдёт последовательный Linux Foundations. Если основы знакомы — проверьте знания или сразу откройте практику.</p></div>
        <div className="onboarding-actions"><Link className="primary-button" to="/learn/paths/linux-foundations"><Map size={15} /> Linux Foundations</Link><Link className="secondary-button" to="/learn/linux-core"><BookOpen size={15} /> Проверить знания</Link><Link className="secondary-button" to="#practice"><Terminal size={15} /> Первая задача</Link></div>
      </section>}

      <form id="practice" className="play-panel scroll-mt-28 p-5 sm:p-8" onSubmit={onSubmit}>
        {defaults.challengeSlug && <input type="hidden" name="challengeSlug" value={defaults.challengeSlug} />}
        <div className="mb-7 border-b border-line pb-6"><p className="eyebrow">{defaults.challengeSlug ? 'Практика из Linux Core' : 'Практика'}</p><h2 className="mt-2 text-2xl font-semibold text-white">{defaults.challengeSlug ? 'Закрепите вопрос в терминале' : 'Настройте тренировку'}</h2></div>
        <div className="grid gap-7 sm:grid-cols-2">
          <label className="play-field">
            <span>Категория</span>
            <select name="category" defaultValue={defaults.category}>
              <option value="all">Все категории</option>
              {categories.map((category) => <option value={category.slug} key={category.slug}>{category.name} · {category.challenge_count}</option>)}
            </select>
          </label>
          <label className="play-field">
            <span>Сложность</span>
            <select name="difficulty" defaultValue={defaults.difficulty}>
              <option value="all">Любая сложность</option>
              <option value="Easy">Легко · для старта</option>
              <option value="Medium">Средне</option>
              <option value="Hard">Сложно</option>
              <option value="Expert">Эксперт</option>
            </select>
          </label>
        </div>

        <fieldset className="mt-8">
          <legend className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Режим</legend>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {modeOptions.map((mode) => (
              <label className="play-choice" key={mode.value}>
                <input type="radio" name="mode" value={mode.value} defaultChecked={mode.value === defaults.mode} disabled={mode.value === 'real_shell' && !shellEnabled} />
                <span><strong>{mode.label}</strong><small>{mode.value === 'real_shell' && !shellEnabled ? 'Доступно на sandbox-сервере' : mode.detail}</small></span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="mt-8">
          <legend className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Длина тренировки</legend>
          <div className="flex gap-3">
            {[5, 10].map((count) => (
              <label className="play-count" key={count}>
                <input type="radio" name="taskCount" value={count} defaultChecked={count === defaults.count} />
                <span>{count} заданий</span>
              </label>
            ))}
          </div>
        </fieldset>

        {error && <p className="play-error mt-6" role="alert">{error}</p>}
        <div className="mt-8 flex flex-col items-start justify-between gap-4 border-t border-line pt-6 sm:flex-row sm:items-center">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-slate-600">Обычно 2–5 минут</span>
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? <LoaderCircle size={16} className="animate-spin" /> : <Terminal size={16} />}
            {busy ? 'Готовим тренировку…' : 'Начать практику'}
          </button>
        </div>
      </form>

      <section id="competition" className="mt-12 scroll-mt-28" aria-labelledby="competition-title">
        <div className="mb-5"><p className="eyebrow">Соревнования</p><h2 id="competition-title" className="mt-2 text-2xl font-semibold text-white">Сыграйте против другого игрока.</h2><p className="mt-2 text-sm text-slate-500">Quick — без MMR. Ranked — с изменением MMR.</p></div>
        <div className="matchmaking-mode-tabs" role="tablist" aria-label="Режим соревнования">
          <button className={matchmakingMode === 'quick' ? 'active' : ''} type="button" role="tab" aria-selected={matchmakingMode === 'quick'} onClick={() => setMatchmakingMode('quick')}>Quick Match <small>без MMR</small></button>
          <button className={matchmakingMode === 'ranked' ? 'active' : ''} type="button" role="tab" aria-selected={matchmakingMode === 'ranked'} onClick={() => setMatchmakingMode('ranked')}>Ranked <small>влияет на MMR</small></button>
        </div>
        {matchmakingMode === 'quick' ? <QuickMatchPanel /> : <RankedMatchPanel />}
        <Link className="mt-4 inline-flex items-center gap-2 text-sm text-slate-500 transition-colors hover:text-white" to="/battle"><Swords size={15} /> Создать приватный матч с другом <ChevronRight size={14} /></Link>
      </section>

      <nav className="context-links mt-10" aria-label="Другие способы практики"><Link to="/daily"><CalendarDays size={14} /> Задача дня</Link><Link to="/interview"><BookOpenCheck size={14} /> Interview 100</Link><Link to="/learn/linux-core"><BookOpen size={14} /> Linux Core с объяснениями</Link></nav>
    </section>
  );
}

function getPlayDefaults() {
  const query = new URLSearchParams(window.location.search);
  const category = query.get('category');
  const difficulty = query.get('difficulty');
  const mode = query.get('mode');
  const count = Number(query.get('count'));
  const challengeSlug = query.get('challenge');
  return {
    category: category && /^[a-z0-9-]{1,40}$/.test(category) ? category : 'all',
    difficulty: (['all', 'Easy', 'Medium', 'Hard', 'Expert'] as const).find((value) => value === difficulty) ?? 'Easy',
    mode: modeOptions.find((option) => option.value === mode)?.value ?? 'mixed',
    count: count === 10 ? 10 : 5,
    challengeSlug: challengeSlug && /^[a-z0-9-]{1,100}$/.test(challengeSlug) ? challengeSlug : '',
  };
}

function RunScreen({ game, busy, feedback, setBusy, setGame, setFeedback, setError }: {
  game: GameState;
  busy: boolean;
  feedback: { kind: 'correct' | 'wrong' | 'skip'; text: string; score?: number } | null;
  setBusy: (value: boolean) => void;
  setGame: (value: GameState) => void;
  setFeedback: (value: { kind: 'correct' | 'wrong' | 'skip'; text: string; score?: number } | null) => void;
  setError: (value: string | null) => void;
}) {
  const task = game.task!;
  const [answer, setAnswer] = useState('');
  const [elapsed, setElapsed] = useState(() => Date.now() - new Date(task.presentedAt).getTime());
  const [pendingGame, setPendingGame] = useState<GameState | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setAnswer('');
    setElapsed(Date.now() - new Date(task.presentedAt).getTime());
    inputRef.current?.focus();
    const timer = window.setInterval(() => setElapsed(Date.now() - new Date(task.presentedAt).getTime()), 100);
    return () => window.clearInterval(timer);
  }, [task.slug, task.presentedAt]);

  const request = async (action: 'submit' | 'skip') => {
    if (busy || pendingGame || (action === 'submit' && task.type !== 'real_shell' && !answer.trim())) return;
    setBusy(true);
    setError(null);
    try {
      const requestOptions: RequestInit = action === 'submit'
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer }) }
        : { method: 'POST' };
      const response = await fetch(`/api/game/sessions/${game.session.id}/${action}`, requestOptions);
      const payload = await response.json() as GameState & { correct?: boolean; skipped?: boolean; feedback?: string; scoreAwarded?: number; message?: string };
      if (!response.ok) throw new Error(payload.message ?? 'Не удалось отправить ответ.');
      if (action === 'skip') setFeedback({ kind: 'skip', text: payload.feedback ?? 'Задание пропущено.' });
      else if (payload.correct) {
        setFeedback({
          kind: 'correct',
          text: payload.feedback ?? 'Задача решена.',
          ...(payload.scoreAwarded === undefined ? {} : { score: payload.scoreAwarded }),
        });
        setPendingGame({ session: payload.session, task: payload.task, ...(payload.summary ? { summary: payload.summary } : {}) });
      }
      else setFeedback({ kind: 'wrong', text: 'Пока не выполнено. Проверьте команду и попробуйте ещё раз.' });
      if (!payload.correct) setGame({ session: payload.session, task: payload.task, ...(payload.summary ? { summary: payload.summary } : {}) });
      if (!payload.correct && !payload.skipped) inputRef.current?.select();
    } catch (requestError) {
      setError(humanizeError(requestError, 'Не удалось проверить ответ. Попробуйте ещё раз.'));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && task.type !== 'real_shell' && !pendingGame) void request('skip');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pendingGame, task.type]);

  const progress = Math.round(((task.position - 1) / task.total) * 100);
  const refreshAfterShell = async (scoreAwarded: number) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/game/sessions/${game.session.id}`);
      const state = await response.json() as GameState & { message?: string };
      if (!response.ok) throw new Error(state.message ?? 'Не удалось продолжить забег.');
      setFeedback({ kind: 'correct', text: 'Состояние песочницы проверено сервером.', score: scoreAwarded });
      setPendingGame(state);
    } catch (refreshError) {
      setError(humanizeError(refreshError, 'Задача решена, но следующий шаг не загрузился. Обновите страницу.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mx-auto max-w-5xl">
      <div className="mb-5 flex items-center justify-between">
        <Link to="/" className="inline-flex items-center gap-2 text-xs text-slate-500 transition-colors hover:text-white"><ArrowLeft size={14} /> Выйти</Link>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-600">Задание {game.task?.position ?? 0} из {game.task?.total ?? 0}</span>
      </div>
      <div className="play-panel overflow-hidden">
        <div className="grid border-b border-line sm:grid-cols-4">
          <RunMetric icon={Trophy} value={String(game.session.score)} label="очки" />
          <RunMetric icon={Flame} value={String(game.session.streak)} label="серия" />
          <RunMetric icon={Terminal} value={`${task.position} / ${task.total}`} label="задание" />
          <RunMetric icon={Clock3} value={formatTimer(elapsed)} label="прошло" />
        </div>
        <div className="h-0.5 bg-[#111820]"><div className="h-full bg-acid transition-all" style={{ width: `${progress}%` }} /></div>

        <div className="p-5 sm:p-8 lg:p-10">
          <div className="flex flex-wrap items-center gap-2">
            <span className="challenge-category">{task.category.name}</span>
            <span className="difficulty">{difficultyLabel(task.difficulty, true)}</span>
            <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-slate-600">{task.type === 'recall' ? 'Вспомни' : task.type === 'quick' ? 'Быстро' : 'Shell'}</span>
          </div>
          <h1 className="mt-6 text-2xl font-semibold tracking-[-0.025em] text-white sm:text-4xl">{task.title}</h1>
          <p className="mt-4 max-w-3xl text-base leading-7 text-slate-400">{task.description}</p>

          {task.type === 'real_shell' ? (
            <div className={pendingGame ? 'pointer-events-none' : ''} aria-disabled={pendingGame !== null}>
              <Suspense fallback={<div className="game-shell mt-8 flex h-[480px] items-center justify-center"><LoaderCircle size={20} className="animate-spin text-acid" /></div>}>
                <GameShellTerminal gameSessionId={game.session.id} {...(task.hint ? { hint: task.hint } : {})} onCompleted={(score) => void refreshAfterShell(score)} onSkip={() => void request('skip')} />
              </Suspense>
            </div>
          ) : (
            <form className="game-terminal mt-9" onSubmit={(event) => { event.preventDefault(); void request('submit'); }}>
              <div className="game-terminal-bar"><span>clirace@runner:~</span><span>semantic-check / ready</span></div>
              <label className="game-command-line">
                <span className="select-none text-acid">$</span>
                <input ref={inputRef} value={answer} onChange={(event) => { setAnswer(event.target.value); setFeedback(null); }} autoComplete="off" spellCheck={false} placeholder="введите команду…" disabled={busy || pendingGame !== null} aria-label="Команда" />
              </label>
            </form>
          )}

          {feedback && (
            <div className={`game-feedback game-feedback-${feedback.kind}`} role="status">
              {feedback.kind === 'correct' ? <CheckCircle2 size={16} /> : feedback.kind === 'skip' ? <SkipForward size={16} /> : <Terminal size={16} />}
              <span>{feedback.text}</span>
              {feedback.score ? <strong>+{feedback.score}</strong> : null}
              {pendingGame && <button type="button" className="terminal-action ml-auto" onClick={() => { setGame(pendingGame); setPendingGame(null); setFeedback(null); }}>Продолжить <ChevronRight size={13} /></button>}
            </div>
          )}

          {task.type !== 'real_shell' && <div className="mt-6 flex flex-col-reverse justify-between gap-4 sm:flex-row sm:items-center">
            <span className="font-mono text-[10px] text-slate-600">Enter — проверить · Esc — пропустить</span>
            <div className="flex gap-3">
              <button type="button" className="secondary-button" disabled={busy || pendingGame !== null} onClick={() => void request('skip')}><SkipForward size={14} /> Пропустить</button>
              <button type="button" className="primary-button" disabled={busy || pendingGame !== null || !answer.trim()} onClick={() => void request('submit')}>
                {busy ? <LoaderCircle size={15} className="animate-spin" /> : <Send size={15} />} Проверить
              </button>
            </div>
          </div>}
        </div>
      </div>
    </section>
  );
}

function FinalScreen({ game, onReset }: { game: GameState; onReset: () => void }) {
  const summary = game.summary!;
  const accuracy = summary.total ? Math.round((summary.correct / summary.total) * 100) : 0;
  const returnTo = courseReturnTo();
  return (
    <section className="mx-auto max-w-3xl text-center">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-acid/30 bg-acid/10 text-acid"><Trophy size={28} /></div>
      <p className="eyebrow mt-7">Тренировка завершена</p>
      <h1 className="mt-3 text-4xl font-semibold tracking-[-0.045em] text-white sm:text-6xl">{game.session.score} очков</h1>
      <p className="mt-4 text-slate-400">Результат сохранён · оценка практики <span className={(game.session.practiceScoreDelta ?? game.session.ratingDelta) >= 0 ? 'text-acid' : 'text-rose-300'}>{(game.session.practiceScoreDelta ?? game.session.ratingDelta) >= 0 ? '+' : ''}{game.session.practiceScoreDelta ?? game.session.ratingDelta}</span></p>
      <div className="play-panel mt-9 grid grid-cols-2 overflow-hidden sm:grid-cols-4">
        <SummaryMetric value={`${summary.correct}/${summary.total}`} label="верно" />
        <SummaryMetric value={`${accuracy}%`} label="точность" />
        <SummaryMetric value={String(game.session.bestStreak)} label="лучшая серия" />
        <SummaryMetric value={formatDuration(summary.duration_ms)} label="время" />
      </div>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Link className="secondary-button" to={returnTo ?? '/'}><ArrowLeft size={14} /> {returnTo ? 'Вернуться в курс' : 'На главную'}</Link>
        <Link className="secondary-button" to="/play?compete=quick#competition"><Swords size={15} /> Quick Match</Link>
        {returnTo ? <Link className="primary-button" to={returnTo}>Засчитать шаг <CheckCircle2 size={15} /></Link> : <button className="primary-button" type="button" onClick={onReset}><RotateCcw size={15} /> Следующая практика</button>}
      </div>
    </section>
  );
}

function GuestState() {
  const returnTo = encodeURIComponent('/play');
  return (
    <section className="mx-auto max-w-2xl py-14 text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-line bg-panel text-acid"><Terminal size={24} /></div>
      <p className="eyebrow mt-7">Нужен аккаунт</p>
      <h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em] text-white">Войдите перед стартом.</h1>
      <p className="mx-auto mt-4 max-w-lg text-sm leading-7 text-slate-400">Так сервер сможет сохранить очки, серию и результаты каждого задания.</p>
      <Link className="primary-button mt-8" to={`/?auth=1&returnTo=${returnTo}`}>Войти или зарегистрироваться <ChevronRight size={16} /></Link>
    </section>
  );
}

function RunMetric({ icon: Icon, value, label }: { icon: typeof Trophy; value: string; label: string }) {
  return <div className="run-metric"><Icon size={14} /><div><strong>{value}</strong><span>{label}</span></div></div>;
}

function SummaryMetric({ value, label }: { value: string; label: string }) {
  return <div className="summary-metric"><strong>{value}</strong><span>{label}</span></div>;
}

function formatTimer(milliseconds: number): string {
  const seconds = Math.max(0, milliseconds) / 1000;
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}м ${seconds % 60}с` : `${seconds}с`;
}

function courseReturnTo(): string | null {
  const value = new URLSearchParams(window.location.search).get('returnTo');
  return value?.startsWith('/learn/paths/') && !value.startsWith('//') ? value : null;
}
