import { Activity, ArrowRight, Award, BookOpen, CalendarDays, Flame, Gauge, Medal, Target, Terminal, Trophy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CommunityHeader } from './CommunityHeader';
import { currentUser } from './auth-client';
import { ErrorState, PageLoader } from './Ui';
import { humanizeError } from './errors';
import { RankBadge } from './RankBadge';
import { modeLabel } from './product-language';
import { Link, useLocation, useNavigate } from 'react-router-dom';

interface RunHistory {
  id: string;
  mode: string;
  difficulty: string | null;
  score: number;
  bestStreak: number;
  ratingDelta: number;
  practiceScoreDelta?: number;
  startedAt: string;
  completedAt: string;
  category: { slug: string; name: string | null } | null;
  total: number;
  correct: number;
  skipped: number;
  durationMs: number;
}

interface Profile {
  username: string;
  memberSince: string;
  overall: { rating: number; practiceScore?: number; gamesPlayed: number; rank: number | null };
  stats: {
    runs: number; totalScore: number; bestStreak: number; tasks: number;
    correct: number; accuracy: number; durationMs: number;
  };
  ratings: Array<{ slug: string; name: string; rating: number; practiceScore?: number; gamesPlayed: number; updatedAt: string }>;
  dailyStreak: { current: number; best: number; lastDate: string | null };
  learning: { assessments: number; answered: number; correct: number; accuracy: number; active: boolean };
  learningPaths?: Array<{ slug: string; title: string; status: 'active' | 'completed'; progress: number; finalScore: number | null; currentModule: string | null; completedAt: string | null; mastery: Array<{ category: string; score: number }> }>;
  achievements: Array<{ slug: string; title: string; description: string; icon: string; unlockedAt: string }>;
  recentRuns: RunHistory[];
  ranked: {
    mmr: number; gamesPlayed: number; wins: number; losses: number;
    placementGamesCompleted: number; placementGamesRequired: number; division: string; provisional: boolean;
    recentMatches: Array<{ battleId: string; roomCode: string; opponent: string; result: 'win' | 'loss' | 'no_contest'; mmrBefore: number; mmrAfter: number; delta: number; divisionBefore: string; divisionAfter: string; playedAt: string }>;
  };
}

export function ProfilePage() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const username = decodeURIComponent(pathname.slice('/profile/'.length));
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guest, setGuest] = useState(false);

  useEffect(() => {
    if (!username) {
      let active = true;
      currentUser().then(({ user }) => {
        if (!active) return;
        if (user) navigate(`/profile/${encodeURIComponent(user.username)}`, { replace: true });
        else setGuest(true);
      }).catch(() => { if (active) setGuest(true); });
      return () => { active = false; };
    }
    const controller = new AbortController();
    fetch(`/api/profiles/${encodeURIComponent(username)}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { profile?: Profile; message?: string };
        if (!response.ok || !payload.profile) throw new Error(payload.message ?? 'Профиль не найден.');
        return payload.profile;
      })
      .then(setProfile)
      .catch((requestError) => {
        if (requestError instanceof DOMException && requestError.name === 'AbortError') return;
        setError(humanizeError(requestError, 'Не удалось загрузить профиль.'));
      });
    return () => controller.abort();
  }, [username]);

  return (
    <div className="min-h-screen bg-ink text-slate-200">
      <div className="grid-noise fixed inset-0 pointer-events-none" />
      <CommunityHeader />
      <main className="page-width relative z-10 py-10 sm:py-16">
        {!profile && !error && !guest && <PageLoader label="Загружаем профиль" />}
        {guest && <section className="state-panel"><BookOpen size={24} className="text-acid" /><div><h1>Войдите, чтобы открыть профиль</h1><p>В профиле хранятся результаты практики, обучение и Ranked-статистика.</p></div><Link className="primary-button" to="/?auth=1&returnTo=%2Fprofile">Войти <ArrowRight size={14} /></Link></section>}
        {error && <ErrorState title="Профиль не найден" message={error} retryHref="/rating" />}
        {profile && <ProfileContent profile={profile} />}
      </main>
    </div>
  );
}

function ProfileContent({ profile }: { profile: Profile }) {
  const initial = profile.username.slice(0, 1).toUpperCase();
  return (
    <>
      <section className="profile-hero">
        <div className="profile-avatar" aria-hidden="true">{initial}</div>
        <div className="min-w-0 flex-1">
          <p className="eyebrow">Публичный профиль</p>
          <h1 className="mt-2 truncate text-3xl font-semibold tracking-[-0.04em] text-white sm:text-5xl">@{profile.username}</h1>
          <p className="mt-3 flex items-center gap-2 text-sm text-slate-500"><CalendarDays size={14} /> В CLIRace с {formatDate(profile.memberSince)}</p>
        </div>
        <RankBadge division={profile.ranked.division} mmr={profile.ranked.mmr} provisional={profile.ranked.provisional} placementGamesCompleted={profile.ranked.placementGamesCompleted} placementGamesRequired={profile.ranked.placementGamesRequired} />
      </section>

      {profile.stats.runs === 0 && profile.ranked.gamesPlayed === 0 ? <section className="state-panel mt-6">
        <Terminal size={22} className="text-acid" /><div><h2>Профиль готов к первой тренировке</h2><p>Решите короткую задачу или начните квалификацию — здесь появится ваш прогресс.</p></div><Link className="primary-button" to="/play#practice">Начать практику <ArrowRight size={14} /></Link>
      </section> : <section className="mt-6 grid grid-cols-2 overflow-hidden rounded-lg border border-line bg-panel sm:grid-cols-3 lg:grid-cols-6">
        <Stat icon={Activity} value={String(profile.stats.runs)} label="забегов" />
        <Stat icon={Target} value={`${profile.stats.accuracy}%`} label="точность" />
        <Stat icon={Trophy} value={formatNumber(profile.stats.totalScore)} label="очков" />
        <Stat icon={Flame} value={String(profile.stats.bestStreak)} label="лучшая серия" />
        <Stat icon={Terminal} value={String(profile.stats.correct)} label="решено" />
        <Stat icon={Gauge} value={formatPracticeTime(profile.stats.durationMs)} label="в терминале" />
      </section>}

      <section className="ranked-profile-card mt-6">
        <div><p className="eyebrow">Ranked</p><h2>Соревновательная статистика</h2><span>MMR меняется только после Ranked-матчей</span></div>
        <div className="ranked-profile-stats"><span><strong>{profile.ranked.gamesPlayed}</strong> игр</span><span><strong>{profile.ranked.wins}</strong> побед</span><span><strong>{profile.ranked.losses}</strong> поражений</span></div>
      </section>

      <section className="learning-profile-card mt-4">
        <div><p className="eyebrow">Обучение</p><h2>Linux Core</h2><span>{profile.learning.answered ? `${profile.learning.accuracy}% точность · ${profile.learning.answered} ответов` : 'Обучение ещё не начато'}</span></div>
        <div className="flex flex-wrap items-center gap-3"><span className="font-mono text-xs text-slate-500">{profile.learning.assessments} завершено</span><Link className="secondary-button" to="/learn/linux-core">{profile.learning.active ? 'Продолжить' : 'Начать'} <ArrowRight size={14} /></Link></div>
      </section>

      {(profile.learningPaths?.length ?? 0) > 0 && <section className="mt-10">
        <div><p className="eyebrow">Учебные маршруты</p><h2 className="mt-3 text-2xl font-semibold text-white">Последовательное обучение</h2></div>
        <div className="profile-paths mt-5">{profile.learningPaths?.map((course) => <Link to={`/learn/paths/${course.slug}`} key={course.slug}><div><strong>{course.title}</strong><span>{course.status === 'completed' ? `Завершён · ${course.finalScore}%` : `${course.progress}% · ${course.currentModule ?? 'Первый модуль'}`}</span></div><div>{course.mastery.map((entry) => <small key={entry.category}>{masteryLabel(entry.category)} {entry.score}%</small>)}</div><ArrowRight size={15} /></Link>)}</div>
      </section>}

      <section className="mt-10">
        <div className="flex items-end justify-between gap-4">
          <div><p className="eyebrow">Прогресс</p><h2 className="mt-3 text-2xl font-semibold text-white">Достижения</h2></div>
          <Link className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.1em] text-slate-500 transition-colors hover:text-acid" to="/daily"><Flame size={14} /> Задача дня: {profile.dailyStreak.current} дней</Link>
        </div>
        {profile.achievements.length ? (
          <div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {profile.achievements.map((achievement) => (
              <div className="achievement-card" key={achievement.slug} title={achievement.description}>
                <span><Award size={17} /></span>
                <div><strong>{achievement.title}</strong><small>{achievement.description}</small></div>
              </div>
            ))}
          </div>
        ) : <div className="mt-5 rounded-lg border border-line bg-panel p-6 text-sm text-slate-500">Первое достижение откроется после завершённой практики. <Link className="ml-1 text-acid hover:underline" to="/play#practice">Начать первую задачу</Link></div>}
      </section>

      <div className="mt-10 grid gap-10 lg:grid-cols-[0.72fr_1.28fr]">
        <section>
          <div className="flex items-end justify-between gap-4">
            <div><p className="eyebrow">Навыки</p><h2 className="mt-3 text-2xl font-semibold text-white">Оценка практики по темам</h2></div>
            <Medal size={19} className="text-acid" />
          </div>
          <div className="mt-5 space-y-2">
            {profile.ratings.length ? profile.ratings.map((rating) => (
              <Link className="rating-row" to={`/rating?category=${encodeURIComponent(rating.slug)}`} key={rating.slug}>
                <div><strong>{rating.name}</strong><span>{rating.gamesPlayed} {pluralRuns(rating.gamesPlayed)}</span></div>
                <b>{rating.practiceScore ?? rating.rating}</b>
              </Link>
            )) : <EmptyPanel text="Оценка по темам появится после первой завершённой практики." action={{ href: '/play#practice', label: 'Начать практику' }} />}
          </div>
        </section>

        <section>
          <div className="flex items-end justify-between gap-4">
            <div><p className="eyebrow">История</p><h2 className="mt-3 text-2xl font-semibold text-white">Последние тренировки</h2></div>
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-slate-600">{profile.recentRuns.length} показано</span>
          </div>
          <div className="mt-5 overflow-hidden rounded-lg border border-line bg-panel">
            {profile.recentRuns.length ? profile.recentRuns.map((run) => <RunRow run={run} key={run.id} />)
              : <EmptyPanel text="Здесь появятся результаты завершённых тренировок." action={{ href: '/play#practice', label: 'Первая задача' }} />}
          </div>
        </section>
      </div>
      <section className="mt-10">
        <div><p className="eyebrow">История Ranked</p><h2 className="mt-3 text-2xl font-semibold text-white">Последние рейтинговые матчи</h2></div>
        <div className="mt-5 overflow-hidden rounded-lg border border-line bg-panel">
          {profile.ranked.recentMatches.length ? profile.ranked.recentMatches.map((match) => (
            <Link className="ranked-history-row" to={`/battle/${match.roomCode}`} key={match.battleId}>
              <div><strong>@{match.opponent}</strong><span>{formatDateTime(match.playedAt)}</span></div>
              <b className={match.result === 'win' ? 'text-acid' : match.result === 'loss' ? 'text-rose-300' : 'text-slate-400'}>{match.result === 'win' ? 'ПОБЕДА' : match.result === 'loss' ? 'ПОРАЖЕНИЕ' : 'БЕЗ РЕЗУЛЬТАТА'}</b>
              <div><strong>{match.mmrBefore} → {match.mmrAfter}</strong><span>{match.delta >= 0 ? '+' : ''}{match.delta} MMR</span></div>
            </Link>
          )) : <EmptyPanel text="Здесь появятся завершённые рейтинговые матчи." action={{ href: '/play?compete=ranked#competition', label: 'Играть Ranked' }} />}
        </div>
      </section>
    </>
  );
}

function Stat({ icon: Icon, value, label }: { icon: typeof Activity; value: string; label: string }) {
  return <div className="profile-stat"><Icon size={14} /><strong>{value}</strong><span>{label}</span></div>;
}

function RunRow({ run }: { run: RunHistory }) {
  const accuracy = run.total ? Math.round((run.correct / run.total) * 100) : 0;
  return (
    <div className="history-row">
      <div className="min-w-0">
        <strong>{run.category?.name ?? 'Все категории'} · {modeLabel(run.mode)}</strong>
        <span>{formatDateTime(run.completedAt)} · {formatDuration(run.durationMs)}</span>
      </div>
      <div><b>{run.correct}/{run.total}</b><span>{accuracy}%</span></div>
      <div><b>{run.score}</b><span>очки</span></div>
      <div className={(run.practiceScoreDelta ?? run.ratingDelta) >= 0 ? 'text-acid' : 'text-rose-300'}><b>{(run.practiceScoreDelta ?? run.ratingDelta) >= 0 ? '+' : ''}{run.practiceScoreDelta ?? run.ratingDelta}</b><span>оценка</span></div>
    </div>
  );
}

function EmptyPanel({ text, action }: { text: string; action?: { href: string; label: string } }) {
  return <div className="p-6 text-sm leading-6 text-slate-500">{text}{action && <Link className="mt-3 flex w-fit items-center gap-1 text-acid hover:underline" to={action.href}>{action.label} <ArrowRight size={13} /></Link>}</div>;
}

function masteryLabel(category: string): string {
  return ({ knowledge: 'Знания', practice: 'Практика', lab: 'Shell', checkpoint: 'Проверки' } as Record<string, string>)[category] ?? category;
}


function formatNumber(value: number) { return new Intl.NumberFormat('ru-RU').format(value); }
function formatDate(value: string) { return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(value)); }
function formatDateTime(value: string) { return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
function formatDuration(ms: number) { const seconds = Math.round(ms / 1000); return seconds >= 60 ? `${Math.floor(seconds / 60)}м ${seconds % 60}с` : `${seconds}с`; }
function formatPracticeTime(ms: number) { const minutes = Math.round(ms / 60000); return minutes >= 60 ? `${Math.floor(minutes / 60)}ч ${minutes % 60}м` : `${Math.max(0, minutes)}м`; }
function pluralRuns(value: number) { return value === 1 ? 'забег' : value >= 2 && value <= 4 ? 'забега' : 'забегов'; }
