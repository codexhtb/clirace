import { Activity, Award, CalendarDays, Flame, Gauge, Medal, Target, Terminal, Trophy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CommunityHeader } from './CommunityHeader';
import { ErrorState, PageLoader } from './Ui';
import { humanizeError } from './errors';

interface RunHistory {
  id: string;
  mode: string;
  difficulty: string | null;
  score: number;
  bestStreak: number;
  ratingDelta: number;
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
  overall: { rating: number; gamesPlayed: number; rank: number | null };
  stats: {
    runs: number; totalScore: number; bestStreak: number; tasks: number;
    correct: number; accuracy: number; durationMs: number;
  };
  ratings: Array<{ slug: string; name: string; rating: number; gamesPlayed: number; updatedAt: string }>;
  dailyStreak: { current: number; best: number; lastDate: string | null };
  achievements: Array<{ slug: string; title: string; description: string; icon: string; unlockedAt: string }>;
  recentRuns: RunHistory[];
}

export function ProfilePage() {
  const username = decodeURIComponent(window.location.pathname.slice('/profile/'.length));
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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
        {!profile && !error && <PageLoader label="Загружаем профиль" />}
        {error && <ErrorState title="Профиль не найден" message={error} retryHref="/leaderboard" />}
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
        <div className="profile-rating">
          <span>CLI RATING</span>
          <strong>{profile.overall.rating}</strong>
          <small>{profile.overall.rank ? `#${profile.overall.rank} в общем рейтинге` : 'Завершите первый забег'}</small>
        </div>
      </section>

      <section className="mt-6 grid grid-cols-2 overflow-hidden rounded-lg border border-line bg-panel sm:grid-cols-3 lg:grid-cols-6">
        <Stat icon={Activity} value={String(profile.stats.runs)} label="забегов" />
        <Stat icon={Target} value={`${profile.stats.accuracy}%`} label="точность" />
        <Stat icon={Trophy} value={formatNumber(profile.stats.totalScore)} label="очков" />
        <Stat icon={Flame} value={String(profile.stats.bestStreak)} label="лучшая серия" />
        <Stat icon={Terminal} value={String(profile.stats.correct)} label="решено" />
        <Stat icon={Gauge} value={formatPracticeTime(profile.stats.durationMs)} label="в терминале" />
      </section>

      <section className="mt-10">
        <div className="flex items-end justify-between gap-4">
          <div><p className="eyebrow">Прогресс</p><h2 className="mt-3 text-2xl font-semibold text-white">Достижения</h2></div>
          <a className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.1em] text-slate-500 transition-colors hover:text-acid" href="/daily"><Flame size={14} /> Daily: {profile.dailyStreak.current} дней</a>
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
        ) : <div className="mt-5 rounded-lg border border-line bg-panel p-6 text-sm text-slate-500">Первое достижение откроется после завершённого забега.</div>}
      </section>

      <div className="mt-10 grid gap-10 lg:grid-cols-[0.72fr_1.28fr]">
        <section>
          <div className="flex items-end justify-between gap-4">
            <div><p className="eyebrow">Навыки</p><h2 className="mt-3 text-2xl font-semibold text-white">Рейтинг категорий</h2></div>
            <Medal size={19} className="text-acid" />
          </div>
          <div className="mt-5 space-y-2">
            {profile.ratings.length ? profile.ratings.map((rating) => (
              <a className="rating-row" href={`/leaderboard?category=${encodeURIComponent(rating.slug)}`} key={rating.slug}>
                <div><strong>{rating.name}</strong><span>{rating.gamesPlayed} {pluralRuns(rating.gamesPlayed)}</span></div>
                <b>{rating.rating}</b>
              </a>
            )) : <EmptyPanel text="Категорийный рейтинг появится после первого завершённого забега." />}
          </div>
        </section>

        <section>
          <div className="flex items-end justify-between gap-4">
            <div><p className="eyebrow">История</p><h2 className="mt-3 text-2xl font-semibold text-white">Последние забеги</h2></div>
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-slate-600">{profile.recentRuns.length} показано</span>
          </div>
          <div className="mt-5 overflow-hidden rounded-lg border border-line bg-panel">
            {profile.recentRuns.length ? profile.recentRuns.map((run) => <RunRow run={run} key={run.id} />)
              : <EmptyPanel text="Здесь появятся результаты завершённых тренировок." />}
          </div>
        </section>
      </div>
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
      <div className={run.ratingDelta >= 0 ? 'text-acid' : 'text-rose-300'}><b>{run.ratingDelta >= 0 ? '+' : ''}{run.ratingDelta}</b><span>рейтинг</span></div>
    </div>
  );
}

function EmptyPanel({ text }: { text: string }) {
  return <div className="p-6 text-sm leading-6 text-slate-500">{text}</div>;
}


function modeLabel(mode: string) {
  return ({ recall: 'Вспомни', quick: 'Быстро', mixed: 'Смешанный', real_shell: 'Shell', typing: 'Набор' } as Record<string, string>)[mode] ?? mode;
}
function formatNumber(value: number) { return new Intl.NumberFormat('ru-RU').format(value); }
function formatDate(value: string) { return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(value)); }
function formatDateTime(value: string) { return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
function formatDuration(ms: number) { const seconds = Math.round(ms / 1000); return seconds >= 60 ? `${Math.floor(seconds / 60)}м ${seconds % 60}с` : `${seconds}с`; }
function formatPracticeTime(ms: number) { const minutes = Math.round(ms / 60000); return minutes >= 60 ? `${Math.floor(minutes / 60)}ч ${minutes % 60}м` : `${Math.max(0, minutes)}м`; }
function pluralRuns(value: number) { return value === 1 ? 'забег' : value >= 2 && value <= 4 ? 'забега' : 'забегов'; }
