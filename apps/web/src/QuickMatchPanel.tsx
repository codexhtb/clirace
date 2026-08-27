import { ArrowRight, LoaderCircle, Radar, ShieldCheck, Swords, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

type MatchmakingStatus =
  | { status: 'idle'; pool: 'quick' }
  | {
    status: 'searching'; pool: 'quick'; queuedAt: string; leaseExpiresAt: string;
    waitingCapacity: boolean; phase: 'queued' | 'pairing';
  }
  | {
    status: 'matched'; pool: 'quick'; matchId: string | null; battleId: string; roomCode: string;
    opponent: { userId: string; username: string } | null; matchedAt: string | null;
    source: 'quick_match' | 'active_battle';
  };

interface ApiError { code?: string; message?: string; battleId?: string; roomCode?: string }

export function QuickMatchPanel({ autoEnqueue = false, onIntentConsumed }: {
  autoEnqueue?: boolean;
  onIntentConsumed?: () => void;
}) {
  const navigate = useNavigate();
  const [status, setStatus] = useState<MatchmakingStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const enqueueInFlightRef = useRef(false);
  const autoIntentHandledRef = useRef(false);

  const loadStatus = useCallback(async () => {
    const response = await fetch('/api/matchmaking/status', { cache: 'no-store' });
    const payload = await response.json() as MatchmakingStatus & ApiError;
    if (!response.ok) throw new MatchmakingRequestError(payload.code, payload.message);
    setStatus(payload);
    setError(null);
    return payload;
  }, []);

  useEffect(() => {
    let active = true;
    loadStatus().catch((reason) => {
      if (active) setError(readableError(reason));
    });
    return () => { active = false; };
  }, [loadStatus]);

  useEffect(() => {
    if (status?.status !== 'searching') return;
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    const polling = window.setInterval(() => {
      void loadStatus().catch((reason) => setError(readableError(reason)));
    }, 1_500);
    const heartbeat = window.setInterval(() => {
      void requestMatchmaking('/api/matchmaking/heartbeat', { method: 'POST' })
        .then(setStatus)
        .catch((reason) => {
          if (reason instanceof MatchmakingRequestError && reason.code === 'queue_expired') {
            setStatus({ status: 'idle', pool: 'quick' });
          }
          setError(readableError(reason));
        });
    }, 20_000);
    return () => {
      window.clearInterval(clock);
      window.clearInterval(polling);
      window.clearInterval(heartbeat);
    };
  }, [loadStatus, status?.status]);

  useEffect(() => {
    if (status?.status !== 'matched' || status.source !== 'quick_match') return;
    const transition = window.setTimeout(() => {
      navigate(`/battle/${status.roomCode}`);
    }, 1_200);
    return () => window.clearTimeout(transition);
  }, [navigate, status]);

  const enqueue = useCallback(async () => {
    if (enqueueInFlightRef.current) return false;
    enqueueInFlightRef.current = true;
    setBusy(true);
    setError(null);
    try {
      setStatus(await requestMatchmaking('/api/matchmaking/queue', { method: 'POST' }));
      setNow(Date.now());
      return true;
    } catch (reason) {
      if (reason instanceof MatchmakingRequestError && reason.code === 'active_battle' && reason.roomCode) {
        setStatus({
          status: 'matched', pool: 'quick', matchId: null,
          battleId: reason.battleId ?? '', roomCode: reason.roomCode,
          opponent: null, matchedAt: null, source: 'active_battle',
        });
        return true;
      } else {
        setError(readableError(reason));
        return false;
      }
    } finally {
      enqueueInFlightRef.current = false;
      setBusy(false);
    }
  }, []);

  const startSearch = useCallback(async () => {
    const started = await enqueue();
    if (started && autoEnqueue) onIntentConsumed?.();
  }, [autoEnqueue, enqueue, onIntentConsumed]);

  useEffect(() => {
    if (!autoEnqueue || !status || autoIntentHandledRef.current) return;
    autoIntentHandledRef.current = true;
    if (status.status !== 'idle') {
      onIntentConsumed?.();
      return;
    }
    void startSearch();
  }, [autoEnqueue, onIntentConsumed, startSearch, status]);

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await requestMatchmaking('/api/matchmaking/queue', { method: 'DELETE' }));
    } catch (reason) {
      if (reason instanceof MatchmakingRequestError && reason.code === 'match_committing') {
        await loadStatus().catch(() => undefined);
      } else {
        setError(readableError(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return <section id="quick-match" className="matchmaking-panel matchmaking-loading"><LoaderCircle className="animate-spin" size={18} /> Проверяем Quick Match…</section>;
  }

  if (status.status === 'searching') {
    const elapsed = Math.max(0, Math.floor((now - new Date(status.queuedAt).getTime()) / 1_000));
    return (
      <section id="quick-match" className="matchmaking-panel" aria-live="polite">
        <div className="matchmaking-radar"><Radar size={28} /></div>
        <div className="min-w-0 flex-1">
          <p className="eyebrow">Quick Match · поиск</p>
          <h2>{status.phase === 'pairing' ? 'Соперник найден — готовим матч…' : status.waitingCapacity ? 'Ждём два свободных терминала' : 'Ищем соперника'}</h2>
          <p>{status.waitingCapacity ? 'Место в очереди сохранено. Матч начнётся, когда освободятся две игровые среды.' : 'Поиск продолжится после обновления страницы — состояние хранится на сервере.'}</p>
        </div>
        <div className="matchmaking-search-meta"><strong>{formatElapsed(elapsed)}</strong><span>в поиске</span></div>
        <button className="secondary-button" type="button" disabled={busy || status.phase === 'pairing'} onClick={() => void cancel()}>
          {busy ? <LoaderCircle className="animate-spin" size={15} /> : <X size={15} />} Отменить поиск
        </button>
        {error && <p className="matchmaking-error">{error}</p>}
      </section>
    );
  }

  if (status.status === 'matched') {
    const quick = status.source === 'quick_match';
    return (
      <section id="quick-match" className="matchmaking-panel matchmaking-found" aria-live="assertive">
        <div className="matchmaking-radar"><Swords size={28} /></div>
        <div className="min-w-0 flex-1">
          <p className="eyebrow">{quick ? 'Соперник найден' : 'Активный матч'}</p>
          <h2>{status.opponent ? `@${status.opponent.username} готов к гонке` : quick ? 'Матч готов' : 'Вернитесь в матч'}</h2>
          <p>{quick ? 'Открываем матч из трёх одинаковых shell-задач.' : 'Новый поиск не создавался: сервер восстановил ваш текущий матч.'}</p>
        </div>
        <Link className="primary-button" to={`/battle/${status.roomCode}`}>{quick ? 'Открыть Battle' : 'Вернуться'} <ArrowRight size={15} /></Link>
      </section>
    );
  }

  return (
    <section id="quick-match" className="matchmaking-panel">
      <div className="matchmaking-radar"><Swords size={28} /></div>
      <div className="min-w-0 flex-1">
        <p className="eyebrow">Quick Match</p>
        <h2>Найдите соперника автоматически.</h2>
        <p>Быстрый PvP без изменения MMR: три случайных shell-задачи и отдельный терминал для каждого игрока.</p>
        <div className="matchmaking-trust"><span><ShieldCheck size={13} /> один матч на игрока</span><span>без MMR</span><span>результат определяет сервер</span></div>
      </div>
      <button className="primary-button" type="button" disabled={busy} onClick={() => void startSearch()}>
        {busy ? <LoaderCircle className="animate-spin" size={16} /> : <Radar size={16} />}
        {busy ? 'Входим в очередь…' : 'Найти соперника'}
      </button>
      {error && <p className="matchmaking-error">{error}</p>}
    </section>
  );
}

class MatchmakingRequestError extends Error {
  constructor(
    readonly code?: string,
    message = 'Matchmaking request failed.',
    readonly battleId?: string,
    readonly roomCode?: string,
  ) { super(message); }
}

async function requestMatchmaking(url: string, init: RequestInit): Promise<MatchmakingStatus> {
  const response = await fetch(url, init);
  const payload = await response.json() as MatchmakingStatus & ApiError;
  if (!response.ok) throw new MatchmakingRequestError(payload.code, payload.message, payload.battleId, payload.roomCode);
  return payload;
}

function readableError(reason: unknown): string {
  if (!(reason instanceof MatchmakingRequestError)) return 'Не удалось связаться с Matchmaking. Попробуйте ещё раз.';
  const messages: Record<string, string> = {
    active_battle: 'У вас уже есть активный Battle.',
    incompatible_active_session: 'Сначала завершите активную Shell-сессию.',
    capacity_full: 'Все песочницы заняты. Поиск продолжится автоматически.',
    temporarily_unavailable: 'Quick Match временно недоступен. Попробуйте ещё раз.',
    queue_expired: 'Поиск завершился из-за отсутствия связи. Запустите его снова.',
    match_failed: 'Battle не создался. Вы возвращены в очередь.',
    match_committing: 'Соперник уже найден — завершаем создание Battle.',
  };
  const translated = reason.code ? messages[reason.code] : undefined;
  return translated ?? reason.message;
}

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
  return `${minutes}:${(seconds % 60).toString().padStart(2, '0')}`;
}
