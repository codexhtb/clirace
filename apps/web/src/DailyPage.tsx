import { ArrowRight, CalendarCheck, CheckCircle2, Clock3, Flame, LoaderCircle, Send, Sparkles, Target, Trophy, Users } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { CommunityHeader } from './CommunityHeader';
import { ErrorState, PageLoader } from './Ui';
import { Link } from 'react-router-dom';
import { humanizeError } from './errors';
import { difficultyLabel } from './product-language';

interface DailyPayload {
  authenticated: boolean;
  daily: {
    date: string;
    nextResetAt: string;
    bonusMultiplier: number;
    challenge: {
      slug: string; title: string; description: string; difficulty: string; type: string;
      category: { slug: string; name: string };
    };
  };
  community: { participants: number; completions: number };
  progress: null | {
    gameSessionId: string; status: string; completed: boolean;
    score: number; ratingDelta: number; practiceScoreDelta?: number; startedAt?: string;
  };
  streak: { current: number; best: number; lastDate: string | null };
}

export function DailyPage() {
  const [payload, setPayload] = useState<DailyPayload | null>(null);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ correct: boolean; text: string; score?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState('—');

  const loadDaily = useCallback(async () => {
    const response = await fetch('/api/daily');
    const data = await response.json() as DailyPayload & { message?: string };
    if (!response.ok) throw new Error(data.message ?? 'Испытание дня недоступно.');
    setPayload(data);
    setRemaining(formatRemaining(data.daily.nextResetAt));
  }, []);

  useEffect(() => {
    void loadDaily().catch((loadError) => setError(humanizeError(loadError, 'Не удалось загрузить испытание дня.')));
    return undefined;
  }, [loadDaily]);

  useEffect(() => {
    const nextResetAt = payload?.daily.nextResetAt;
    if (!nextResetAt) return;
    const timer = window.setInterval(() => setRemaining(formatRemaining(nextResetAt)), 1_000);
    return () => window.clearInterval(timer);
  }, [payload?.daily.nextResetAt]);

  const start = async () => {
    setBusy(true); setError(null);
    try {
      const response = await fetch('/api/daily/start', { method: 'POST' });
      const result = await response.json() as { gameSessionId?: string; status?: string; message?: string };
      if (!response.ok || !result.gameSessionId) throw new Error(result.message ?? 'Не удалось начать испытание.');
      setPayload((current) => current ? {
        ...current,
        progress: { gameSessionId: result.gameSessionId!, status: result.status ?? 'active', completed: false, score: 0, ratingDelta: 0 },
      } : current);
    } catch (startError) {
      setError(humanizeError(startError, 'Не удалось начать испытание. Попробуйте ещё раз.'));
    } finally { setBusy(false); }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!payload?.progress?.gameSessionId || !answer.trim() || busy) return;
    setBusy(true); setFeedback(null); setError(null);
    try {
      const response = await fetch(`/api/game/sessions/${payload.progress.gameSessionId}/submit`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer }),
      });
      const result = await response.json() as { correct?: boolean; feedback?: string; scoreAwarded?: number; message?: string };
      if (!response.ok) throw new Error(result.message ?? 'Не удалось проверить команду.');
      setFeedback({
        correct: result.correct === true,
        text: result.feedback ?? 'Проверка завершена.',
        ...(typeof result.scoreAwarded === 'number' ? { score: result.scoreAwarded } : {}),
      });
      if (result.correct) {
        setAnswer('');
        await loadDaily();
      }
    } catch (submitError) {
      setError(humanizeError(submitError, 'Не удалось проверить команду. Попробуйте ещё раз.'));
    } finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen bg-ink text-slate-200">
      <div className="grid-noise fixed inset-0 pointer-events-none" />
      <CommunityHeader />
      <main className="page-width relative z-10 py-10 sm:py-16">
        {!payload && !error && <PageLoader label="Выбираем испытание дня" />}
        {error && !payload && <ErrorState title="Задача дня временно недоступна" message={error} />}
        {payload && <DailyContent payload={payload} answer={answer} setAnswer={setAnswer} busy={busy} feedback={feedback} error={error} remaining={remaining} start={() => void start()} submit={submit} />}
      </main>
    </div>
  );
}

function DailyContent({ payload, answer, setAnswer, busy, feedback, error, remaining, start, submit }: {
  payload: DailyPayload; answer: string; setAnswer: (value: string) => void; busy: boolean;
  feedback: { correct: boolean; text: string; score?: number } | null; error: string | null;
  remaining: string; start: () => void; submit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const completed = payload.progress?.completed === true;
  const active = payload.progress?.status === 'active';
  return (
    <>
      <section className="daily-heading">
        <div>
          <p className="eyebrow">Ежедневное испытание · {formatDate(payload.daily.date)}</p>
          <h1 className="mt-4 text-4xl font-semibold tracking-[-0.05em] text-white sm:text-6xl">Одна задача.<br /><span className="text-acid">Каждый день.</span></h1>
          <p className="mt-5 max-w-xl text-sm leading-7 text-slate-400">Одинаковая задача для всех. Решите её сегодня и сохраните дневную серию.</p>
        </div>
        <div className="daily-countdown"><Clock3 size={17} /><div><span>Новое задание через</span><strong>{remaining}</strong></div></div>
      </section>

      <section className="mt-10 grid overflow-hidden rounded-lg border border-line bg-panel sm:grid-cols-4">
        <DailyMetric icon={Flame} value={String(payload.streak.current)} label="текущая серия" />
        <DailyMetric icon={Trophy} value={String(payload.streak.best)} label="лучшая серия" />
        <DailyMetric icon={Users} value={String(payload.community.participants)} label="участников" />
        <DailyMetric icon={CheckCircle2} value={String(payload.community.completions)} label="справились" />
      </section>

      <section className="daily-challenge mt-8">
        <div className="daily-challenge-top">
          <div className="flex flex-wrap items-center gap-2">
            <span className="challenge-category">{payload.daily.challenge.category.name}</span>
            <span className="difficulty">{difficultyLabel(payload.daily.challenge.difficulty, true)}</span>
          </div>
          <span className="flex items-center gap-1.5 font-mono text-[10px] font-semibold text-acid"><Sparkles size={13} /> ×{payload.daily.bonusMultiplier.toFixed(2)} ОЧКОВ</span>
        </div>
        <div className="p-5 sm:p-8">
          <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-slate-600">Задача дня</p>
          <h2 className="mt-3 text-2xl font-semibold text-white sm:text-3xl">{payload.daily.challenge.title}</h2>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-400">{payload.daily.challenge.description}</p>

          {completed ? (
            <><div className="daily-completed mt-8"><CalendarCheck size={25} /><div><strong>Сегодня выполнено</strong><span>{payload.progress?.score} очков · оценка практики {formatDelta(payload.progress?.practiceScoreDelta ?? payload.progress?.ratingDelta ?? 0)}</span></div></div><Link className="secondary-button mt-4" to="/play#practice">Продолжить практику <ArrowRight size={14} /></Link></>
          ) : active ? (
            <form className="game-terminal mt-8" onSubmit={submit}>
              <div className="game-terminal-bar"><span>daily@clirace:~</span><span>проверка готова</span></div>
              <label className="game-command-line"><span className="select-none text-acid">$</span><input autoFocus value={answer} onChange={(event) => setAnswer(event.target.value)} autoComplete="off" spellCheck={false} placeholder="введите команду…" disabled={busy} aria-label="Ответ на испытание дня" /></label>
              <div className="flex justify-end border-t border-line p-3"><button className="terminal-action" type="submit" disabled={busy || !answer.trim()}>{busy ? <LoaderCircle size={13} className="animate-spin" /> : <Send size={13} />} Проверить</button></div>
            </form>
          ) : payload.authenticated ? (
            <button className="primary-button mt-8" type="button" onClick={start} disabled={busy}>{busy ? <LoaderCircle size={15} className="animate-spin" /> : <Target size={15} />} Начать испытание</button>
          ) : (
            <Link className="primary-button mt-8" to="/?auth=1&returnTo=%2Fdaily">Войти и участвовать</Link>
          )}
          {feedback && !completed && <div className={`game-feedback ${feedback.correct ? 'game-feedback-correct' : 'game-feedback-wrong'}`}><span>{feedback.text}</span>{feedback.score ? <strong>+{feedback.score}</strong> : null}</div>}
          {error && <p className="play-error mt-4">{error}</p>}
        </div>
      </section>
    </>
  );
}

function DailyMetric({ icon: Icon, value, label }: { icon: typeof Flame; value: string; label: string }) {
  return <div className="daily-metric"><Icon size={15} /><strong>{value}</strong><span>{label}</span></div>;
}

function formatRemaining(nextResetAt: string) {
  const next = new Date(nextResetAt);
  const seconds = Math.max(0, Math.floor((next.getTime() - Date.now()) / 1000));
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
function formatDate(value: string) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T12:00:00`)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return 'сегодня';
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(date);
}
function formatDelta(value: number) { return `${value >= 0 ? '+' : ''}${value}`; }
