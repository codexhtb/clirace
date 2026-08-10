import { Crown, LoaderCircle, Medal, Trophy, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CommunityHeader } from './CommunityHeader';

interface Category { slug: string; name: string; challenge_count: number }
interface AuthUser { username: string }
interface LeaderboardEntry {
  rank: number;
  username: string;
  rating: number;
  gamesPlayed: number;
  totalScore: number;
  bestStreak: number;
  accuracy: number;
}
interface Leaderboard {
  board: { slug: string; name: string };
  total: number;
  entries: LeaderboardEntry[];
}

export function LeaderboardPage() {
  const initialCategory = new URLSearchParams(window.location.search).get('category') ?? 'overall';
  const [selected, setSelected] = useState(initialCategory);
  const [categories, setCategories] = useState<Category[]>([]);
  const [viewer, setViewer] = useState<string | null>(null);
  const [board, setBoard] = useState<Leaderboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetch('/api/categories', { signal: controller.signal }).then((response) => response.json() as Promise<{ categories: Category[] }>),
      fetch('/api/auth/me', { signal: controller.signal }).then((response) => response.json() as Promise<{ user: AuthUser | null }>),
    ]).then(([catalog, auth]) => {
      setCategories(catalog.categories ?? []);
      setViewer(auth.user?.username ?? null);
    }).catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setBoard(null);
    setError(null);
    fetch(`/api/leaderboard?category=${encodeURIComponent(selected)}&limit=50`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as Leaderboard & { message?: string };
        if (!response.ok) throw new Error(payload.message ?? 'Не удалось загрузить рейтинг.');
        return payload;
      })
      .then(setBoard)
      .catch((requestError) => {
        if (requestError instanceof DOMException && requestError.name === 'AbortError') return;
        setError(requestError instanceof Error ? requestError.message : 'Не удалось загрузить рейтинг.');
      });
    return () => controller.abort();
  }, [selected]);

  const selectCategory = (slug: string) => {
    setSelected(slug);
    const url = slug === 'overall' ? '/leaderboard' : `/leaderboard?category=${encodeURIComponent(slug)}`;
    window.history.replaceState(null, '', url);
  };

  return (
    <div className="min-h-screen bg-ink text-slate-200">
      <div className="grid-noise fixed inset-0 pointer-events-none" />
      <CommunityHeader />
      <main className="page-width relative z-10 py-10 sm:py-16">
        <section className="flex flex-col justify-between gap-7 lg:flex-row lg:items-end">
          <div>
            <p className="eyebrow">CLIRace leaderboard</p>
            <h1 className="mt-4 text-4xl font-semibold tracking-[-0.045em] text-white sm:text-6xl">Таблица сильнейших.</h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-400">Рейтинг меняется после каждого завершённого забега. Точность важнее количества бессмысленных попыток.</p>
          </div>
          <a className="primary-button self-start lg:self-auto" href="/play"><Trophy size={15} /> Улучшить рейтинг</a>
        </section>

        <div className="mt-10 flex gap-2 overflow-x-auto pb-2" role="tablist" aria-label="Категория рейтинга">
          <button className={`leaderboard-filter ${selected === 'overall' ? 'leaderboard-filter-active' : ''}`} onClick={() => selectCategory('overall')} type="button">Общий</button>
          {categories.map((category) => <button className={`leaderboard-filter ${selected === category.slug ? 'leaderboard-filter-active' : ''}`} onClick={() => selectCategory(category.slug)} type="button" key={category.slug}>{category.name}</button>)}
        </div>

        {!board && !error && <div className="flex min-h-[360px] items-center justify-center gap-3 font-mono text-xs uppercase tracking-[0.14em] text-slate-500"><LoaderCircle size={17} className="animate-spin text-acid" /> Считаем позиции</div>}
        {error && <p className="play-error mt-8">{error}</p>}
        {board && <LeaderboardTable board={board} viewer={viewer} />}
      </main>
    </div>
  );
}

function LeaderboardTable({ board, viewer }: { board: Leaderboard; viewer: string | null }) {
  return (
    <section className="mt-6 overflow-hidden rounded-lg border border-[#2a3542] bg-panel shadow-2xl">
      <div className="flex items-center justify-between border-b border-line px-5 py-4">
        <div><span className="font-mono text-[9px] uppercase tracking-[0.14em] text-slate-600">Таблица</span><h2 className="mt-1 font-semibold text-white">{board.board.name}</h2></div>
        <span className="flex items-center gap-2 font-mono text-[10px] text-slate-500"><Users size={13} /> {board.total} участников</span>
      </div>
      {board.entries.length ? (
        <div className="leaderboard-table">
          <div className="leaderboard-head"><span>Место</span><span>Пользователь</span><span>Рейтинг</span><span>Точность</span><span>Забеги</span><span>Очки</span></div>
          {board.entries.map((entry) => <LeaderboardRow entry={entry} active={viewer?.toLowerCase() === entry.username.toLowerCase()} key={entry.username} />)}
        </div>
      ) : (
        <div className="p-12 text-center"><Medal className="mx-auto text-slate-700" size={28} /><h3 className="mt-4 font-semibold text-white">Здесь пока свободно</h3><p className="mt-2 text-sm text-slate-500">Завершите забег в этой категории и займёте первую строчку.</p></div>
      )}
    </section>
  );
}

function LeaderboardRow({ entry, active }: { entry: LeaderboardEntry; active: boolean }) {
  return (
    <a className={`leaderboard-row ${active ? 'leaderboard-row-active' : ''}`} href={`/profile/${encodeURIComponent(entry.username)}`}>
      <span className="rank-cell">{entry.rank === 1 ? <Crown size={16} /> : entry.rank <= 3 ? <Medal size={16} /> : `#${entry.rank}`}</span>
      <span className="min-w-0"><strong className="truncate">@{entry.username}</strong>{active && <small>это вы</small>}</span>
      <span><strong>{entry.rating}</strong><small>CLI</small></span>
      <span><strong>{entry.accuracy}%</strong><small>верно</small></span>
      <span><strong>{entry.gamesPlayed}</strong><small>забегов</small></span>
      <span><strong>{formatNumber(entry.totalScore)}</strong><small>очков</small></span>
    </a>
  );
}

function formatNumber(value: number) { return new Intl.NumberFormat('ru-RU').format(value); }
