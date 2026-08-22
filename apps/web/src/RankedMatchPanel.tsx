import { ArrowRight, LoaderCircle, Radar, ShieldCheck, Trophy, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { humanizeError } from './errors';

interface RankedStats {
  mmr: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
  placementGamesCompleted: number;
  placementGamesRequired: number;
  division: string;
  provisional: boolean;
}

type RankedStatus =
  | { status: 'idle'; pool: 'ranked'; ranked: RankedStats }
  | { status: 'searching'; pool: 'ranked'; queuedAt: string; waitingCapacity: boolean; phase: 'queued' | 'pairing'; ranked: RankedStats }
  | { status: 'matched'; pool: 'ranked'; battleId: string; roomCode: string; opponent: { username: string; ranked?: RankedStats } | null; source: 'ranked_match' | 'active_battle'; ranked?: RankedStats };

export function RankedMatchPanel() {
  const [status, setStatus] = useState<RankedStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    const response = await fetch('/api/matchmaking/status?mode=ranked', { cache: 'no-store' });
    const payload = await response.json() as RankedStatus & { message?: string };
    if (!response.ok) throw new Error(payload.message ?? 'Ranked временно недоступен.');
    if (payload.pool === 'ranked') setStatus(payload);
    return payload;
  }, []);

  useEffect(() => { void load().catch((reason) => setError(message(reason))); }, [load]);
  useEffect(() => {
    if (status?.status !== 'searching') return;
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    const polling = window.setInterval(() => void load().catch((reason) => setError(message(reason))), 1_500);
    const heartbeat = window.setInterval(() => void request('/api/matchmaking/heartbeat', { method: 'POST' }).then(setStatus).catch((reason) => setError(message(reason))), 20_000);
    return () => { window.clearInterval(clock); window.clearInterval(polling); window.clearInterval(heartbeat); };
  }, [load, status?.status]);
  useEffect(() => {
    if (status?.status !== 'matched' || status.source !== 'ranked_match') return;
    const timer = window.setTimeout(() => window.location.assign(`/battle/${status.roomCode}`), 1_200);
    return () => window.clearTimeout(timer);
  }, [status]);

  const enqueue = async () => {
    setBusy(true); setError(null);
    try {
      setStatus(await request('/api/matchmaking/queue', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'ranked' }),
      }));
      setNow(Date.now());
    } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  };
  const cancel = async () => {
    setBusy(true); setError(null);
    try { setStatus(await request('/api/matchmaking/queue', { method: 'DELETE' })); }
    catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  };

  if (!status) return <section className="matchmaking-panel matchmaking-ranked matchmaking-loading"><LoaderCircle className="animate-spin" size={18} /> Проверяем Ranked…</section>;
  return (
    <section id="ranked-match" className={`matchmaking-panel matchmaking-ranked ${status.status === 'matched' ? 'matchmaking-found' : ''}`} aria-live="polite">
      <div className="matchmaking-radar"><Trophy size={28} /></div>
      <div className="min-w-0 flex-1">
        <p className="eyebrow">Ranked · {statusLabel(status.status)}</p>
        {status.status === 'idle' && <><h2>Рейтинговый матч.</h2><p>Победа повышает MMR, поражение снижает. Quick Match и игра с другом на рейтинг не влияют.</p><RankedBadge stats={status.ranked} /><div className="matchmaking-trust"><span><ShieldCheck size={13} /> результат фиксирует сервер</span><span>подбор по MMR</span><span>5 квалификационных игр</span></div></>}
        {status.status === 'searching' && <><h2>{status.phase === 'pairing' ? 'Соперник найден — готовим матч…' : status.waitingCapacity ? 'Ждём два свободных терминала' : 'Ищем близкого соперника'}</h2><p>Диапазон рейтинга постепенно расширяется, чтобы поиск не затянулся.</p><RankedBadge stats={status.ranked} /></>}
        {status.status === 'matched' && <><h2>{status.opponent ? `@${status.opponent.username} готов к гонке` : 'Рейтинговый матч готов'}</h2><p>Открываем матч. Изменение MMR будет показано после результата.</p>{status.opponent?.ranked && <span className="matchmaking-opponent">Соперник: {rankLabel(status.opponent.ranked)}</span>}</>}
      </div>
      {status.status === 'idle' && <button className="primary-button" type="button" disabled={busy} onClick={() => void enqueue()}>{busy ? <LoaderCircle className="animate-spin" size={16} /> : <Radar size={16} />}{busy ? 'Входим в очередь…' : 'Играть Ranked'}</button>}
      {status.status === 'searching' && <><div className="matchmaking-search-meta"><strong>{elapsed(now, status.queuedAt)}</strong><span>в поиске</span></div><button className="secondary-button" type="button" disabled={busy || status.phase === 'pairing'} onClick={() => void cancel()}>{busy ? <LoaderCircle className="animate-spin" size={15} /> : <X size={15} />} Отменить</button></>}
      {status.status === 'matched' && <a className="primary-button" href={`/battle/${status.roomCode}`}>Открыть Battle <ArrowRight size={15} /></a>}
      {error && <p className="matchmaking-error">{error}</p>}
    </section>
  );
}

function RankedBadge({ stats }: { stats: RankedStats }) { return <div className="ranked-badge"><strong>{rankLabel(stats)}</strong>{!stats.provisional && <span>{stats.mmr} MMR</span>}</div>; }
function rankLabel(stats: RankedStats) { return stats.provisional ? `Квалификация ${stats.placementGamesCompleted}/${stats.placementGamesRequired}` : `${stats.division} · ${stats.mmr} MMR`; }
function statusLabel(status: RankedStatus['status']) { return ({ idle: 'готово к поиску', searching: 'поиск', matched: 'соперник найден' } as const)[status]; }
function elapsed(now: number, queuedAt: string) { const seconds = Math.max(0, Math.floor((now - new Date(queuedAt).getTime()) / 1_000)); return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`; }
function message(reason: unknown) { return humanizeError(reason, 'Рейтинговый матч временно недоступен. Попробуйте ещё раз.'); }
async function request(url: string, init: RequestInit): Promise<RankedStatus> { const response = await fetch(url, init); const payload = await response.json() as RankedStatus & { message?: string }; if (!response.ok) throw new Error(payload.message ?? 'Ranked временно недоступен.'); return payload; }
