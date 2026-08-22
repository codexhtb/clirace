import { Crown, Medal, Trophy, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CommunityHeader } from './CommunityHeader';
import { EmptyState, ErrorState, PageLoader } from './Ui';
import { humanizeError } from './errors';

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
  division?: string;
  wins?: number;
  losses?: number;
  provisional?: boolean;
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
        setError(humanizeError(requestError, 'Не удалось загрузить рейтинг.'));
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
          <button className={`leaderboard-filter ${selected === 'ranked' ? 'leaderboard-filter-active' : ''}`} onClick={() => selectCategory('ranked')} type="button">Ranked</button>
          {categories.map((category) => <button className={`leaderboard-filter ${selected === category.slug ? 'leaderboard-filter-active' : ''}`} onClick={() => selectCategory(category.slug)} type="button" key={category.slug}>{category.name}</button>)}
        </div>

        {!board && !error && <PageLoader label="Считаем позиции" />}
        {error && <ErrorState title="Рейтинг временно недоступен" message={error} />}
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
          <div className="leaderboard-head"><span>Место</span><span>Игрок</span><span>Рейтинг</span><span>Результаты</span></div>
          {board.entries.map((entry) => <LeaderboardRow entry={entry} active={viewer?.toLowerCase() === entry.username.toLowerCase()} key={entry.username} />)}
        </div>
      ) : (
        <div className="p-5"><EmptyState title="Здесь пока свободно" text="Завершите забег в этой категории и займёте первую строчку." action={{ href: '/play', label: 'Начать практику' }} /></div>
      )}
    </section>
  );
}

function LeaderboardRow({ entry, active }: { entry: LeaderboardEntry; active: boolean }) {
  return (
    <a className={`leaderboard-row ${active ? 'leaderboard-row-active' : ''}`} href={`/profile/${encodeURIComponent(entry.username)}`}>
      <span className="rank-cell">{entry.rank === 1 ? <Crown size={16} /> : entry.rank <= 3 ? <Medal size={16} /> : `#${entry.rank}`}</span>
      <span className="min-w-0"><strong className="truncate">@{entry.username}</strong>{active && <small>это вы</small>}</span>
      <span><strong>{entry.provisional ? 'Unranked' : entry.division ?? entry.rating}</strong><small>{entry.division ? `${entry.rating} MMR` : 'CLI'}</small></span>
      <span><strong>{entry.division ? `${entry.wins ?? 0}W · ${entry.losses ?? 0}L` : `${entry.gamesPlayed} · ${entry.accuracy}%`}</strong><small>{entry.division ? 'победы · поражения' : 'забегов · точность'}</small></span>
    </a>
  );
}
