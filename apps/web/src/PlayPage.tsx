import { ArrowLeft, BookOpenCheck, CalendarDays, CheckCircle2, ChevronRight, Clock3, Flame, LoaderCircle, RotateCcw, Send, SkipForward, Swords, Terminal, Trophy } from 'lucide-react';
import { lazy, Suspense, type FormEvent, useEffect, useRef, useState } from 'react';
import { CommunityHeader } from './CommunityHeader';
import { humanizeError } from './errors';

const GameShellTerminal = lazy(() => import('./GameShellTerminal').then((module) => ({ default: module.GameShellTerminal })));

interface Category { slug: string; name: string; description: string; challenge_count: number; }
interface GameSession {
  id: string;
  status: 'active' | 'completed';
  score: number;
  streak: number;
  bestStreak: number;
  ratingDelta: number;
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
  { value: 'real_shell', label: 'Shell', detail: 'Настоящая Linux-песочница' },
] as const;

export function PlayPage() {
  const [auth, setAuth] = useState<'loading' | 'guest' | 'ready'>('loading');
  const [categories, setCategories] = useState<Category[]>([]);
  const [shellEnabled, setShellEnabled] = useState(false);
  const [game, setGame] = useState<GameState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'correct' | 'wrong' | 'skip'; text: string; score?: number } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetch('/api/auth/me', { signal: controller.signal }).then((response) => response.json() as Promise<{ user: { id: string } | null }>),
      fetch('/api/categories', { signal: controller.signal }).then((response) => response.json() as Promise<{ categories: Category[] }>),
      fetch('/api/sandbox/status', { signal: controller.signal }).then((response) => response.json() as Promise<{ enabled: boolean; healthy?: boolean }>),
    ]).then(([authPayload, categoryPayload, sandboxPayload]) => {
      setAuth(authPayload.user ? 'ready' : 'guest');
      setCategories(categoryPayload.categories ?? []);
      setShellEnabled(sandboxPayload.enabled === true && sandboxPayload.healthy !== false);
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
        {auth === 'loading' && <LoadingState label="Проверяем аккаунт" />}
        {auth === 'guest' && <GuestState />}
        {auth === 'ready' && !game && (
          <SetupScreen categories={categories} shellEnabled={shellEnabled} busy={busy} error={error} onSubmit={createGame} />
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

function SetupScreen({ categories, shellEnabled, busy, error, onSubmit }: {
  categories: Category[]; shellEnabled: boolean; busy: boolean; error: string | null; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const requestedDefaults = getPlayDefaults();
  const defaults = requestedDefaults.mode === 'real_shell' && !shellEnabled
    ? { ...requestedDefaults, mode: 'mixed' as const }
    : requestedDefaults;
  return (
    <section className="mx-auto max-w-4xl">
      <div className="mb-10">
        <p className="eyebrow">Играть</p>
        <h1 className="mt-4 text-4xl font-semibold tracking-[-0.045em] text-white sm:text-6xl">Выберите формат.</h1>
        <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-400">Быстрая практика, собеседование, задача дня или соревнование с другом — каждый режим использует реальные серверные результаты.</p>
      </div>

      <div className="mb-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <a className="mode-card border-acid/40 bg-acid/[0.045]" href="#practice"><span className="mode-card-icon"><Terminal size={17} /></span><strong>Практика</strong><p>Короткий одиночный забег с выбранной сложностью.</p><span>2–5 минут · Shell по выбору</span></a>
        <a className="mode-card" href="/interview"><span className="mode-card-icon"><BookOpenCheck size={17} /></span><strong>Interview 100</strong><p>Подготовка к Linux и DevOps собеседованию.</p><span>10 / 25 / 50 задач</span></a>
        <a className="mode-card" href="/daily"><span className="mode-card-icon"><CalendarDays size={17} /></span><strong>Daily</strong><p>Одна общая задача дня и серия прохождений.</p><span>1 задача · бонусные очки</span></a>
        <a className="mode-card" href="/battle"><span className="mode-card-icon"><Swords size={17} /></span><strong>Private Battle</strong><p>Одинаковые Shell-задачи для двух игроков.</p><span>3 / 5 / 10 раундов</span></a>
      </div>

      <form id="practice" className="play-panel scroll-mt-28 p-5 sm:p-8" onSubmit={onSubmit}>
        <div className="mb-7 border-b border-line pb-6"><p className="eyebrow">Настройка практики</p><h2 className="mt-2 text-2xl font-semibold text-white">Соберите свой забег</h2></div>
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
          <legend className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Длина забега</legend>
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
            {busy ? 'Создаём забег…' : 'Начать забег'}
          </button>
        </div>
      </form>
    </section>
  );
}

function getPlayDefaults() {
  const query = new URLSearchParams(window.location.search);
  const category = query.get('category');
  const difficulty = query.get('difficulty');
  const mode = query.get('mode');
  const count = Number(query.get('count'));
  return {
    category: category && /^[a-z0-9-]{1,40}$/.test(category) ? category : 'all',
    difficulty: (['all', 'Easy', 'Medium', 'Hard', 'Expert'] as const).find((value) => value === difficulty) ?? 'Easy',
    mode: modeOptions.find((option) => option.value === mode)?.value ?? 'mixed',
    count: count === 10 ? 10 : 5,
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
        <a href="/" className="inline-flex items-center gap-2 text-xs text-slate-500 transition-colors hover:text-white"><ArrowLeft size={14} /> Выйти</a>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-600">Задание {game.task?.position ?? 0} из {game.task?.total ?? 0}</span>
      </div>
      <div className="play-panel overflow-hidden">
        <div className="grid border-b border-line sm:grid-cols-4">
          <RunMetric icon={Trophy} value={String(game.session.score)} label="очки" />
          <RunMetric icon={Flame} value={String(game.session.streak)} label="серия" />
          <RunMetric icon={Terminal} value={`${task.position} / ${task.total}`} label="задание" />
          <RunMetric icon={Clock3} value={formatTimer(elapsed)} label="время" />
        </div>
        <div className="h-0.5 bg-[#111820]"><div className="h-full bg-acid transition-all" style={{ width: `${progress}%` }} /></div>

        <div className="p-5 sm:p-8 lg:p-10">
          <div className="flex flex-wrap items-center gap-2">
            <span className="challenge-category">{task.category.name}</span>
            <span className="difficulty">{difficultyLabel(task.difficulty)}</span>
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
  return (
    <section className="mx-auto max-w-3xl text-center">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-acid/30 bg-acid/10 text-acid"><Trophy size={28} /></div>
      <p className="eyebrow mt-7">Забег завершён</p>
      <h1 className="mt-3 text-4xl font-semibold tracking-[-0.045em] text-white sm:text-6xl">{game.session.score} очков</h1>
      <p className="mt-4 text-slate-400">Результат сохранён · рейтинг <span className={game.session.ratingDelta >= 0 ? 'text-acid' : 'text-rose-300'}>{game.session.ratingDelta >= 0 ? '+' : ''}{game.session.ratingDelta}</span></p>
      <div className="play-panel mt-9 grid grid-cols-2 overflow-hidden sm:grid-cols-4">
        <SummaryMetric value={`${summary.correct}/${summary.total}`} label="верно" />
        <SummaryMetric value={`${accuracy}%`} label="точность" />
        <SummaryMetric value={String(game.session.bestStreak)} label="лучшая серия" />
        <SummaryMetric value={formatDuration(summary.duration_ms)} label="время" />
      </div>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <a className="secondary-button" href="/"><ArrowLeft size={14} /> На главную</a>
        <button className="primary-button" type="button" onClick={onReset}><RotateCcw size={15} /> Новый забег</button>
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
      <a className="primary-button mt-8" href={`/?auth=1&returnTo=${returnTo}`}>Войти или зарегистрироваться <ChevronRight size={16} /></a>
    </section>
  );
}

function LoadingState({ label }: { label: string }) {
  return <div className="flex min-h-[55vh] items-center justify-center gap-3 font-mono text-xs uppercase tracking-[0.14em] text-slate-500"><LoaderCircle className="animate-spin text-acid" size={18} /> {label}</div>;
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

function difficultyLabel(value: GameTask['difficulty']): string {
  return ({ Easy: 'ЛЕГКО', Medium: 'СРЕДНЕ', Hard: 'СЛОЖНО', Expert: 'ЭКСПЕРТ' } as const)[value];
}
