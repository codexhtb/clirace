import { ArrowLeft, Check, Clipboard, Clock3, Copy, Crown, Flame, LoaderCircle, Radio, RefreshCw, ShieldCheck, Swords, Terminal, Trophy, UserPlus, Users, Wifi, WifiOff, Zap } from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { BattleTerminal } from './BattleTerminal';
import { CommunityHeader } from './CommunityHeader';
import { currentUser } from './auth-client';
import { humanizeError } from './errors';
import { Link, useNavigate } from 'react-router-dom';

interface AuthUser { id: string; username: string; email: string; }
interface BattleOptions { categories: Array<{ slug: string; name: string; challengeCount: number }> }
interface BattlePlayer {
  id: string; userId: string; username: string; isHost: boolean; connected: boolean; ready: boolean;
  sandboxReady: boolean; currentRound: number; completedRounds: number; finishedAt: string | null;
  result: 'win' | 'loss' | 'dnf' | null;
}
interface BattleChallenge {
  slug: string; title: string; description: string; difficulty: string;
  category: { slug: string; name: string };
}
interface BattleResult {
  userId: string; username: string; result: 'win' | 'loss' | 'dnf' | null; completedRounds: number;
  rounds: Array<{ round: number; durationMs: number | null; success: boolean }>;
}
interface RankedBattleResult {
  outcome: 'player_a_win' | 'player_b_win' | 'no_contest';
  noContestReason: string | null;
  winnerId: string | null;
  players: Array<{ userId: string; mmrBefore: number; mmrAfter: number; delta: number; divisionBefore: string; divisionAfter: string }>;
}
interface BattleState {
  id: string; roomCode: string; status: 'waiting' | 'countdown' | 'running' | 'finished' | 'cancelled';
  roundCount: number; category: { slug: string; name: string }; hostUserId: string; winnerUserId: string | null;
  countdownStartAt: string | null; startedAt: string | null; finishedAt: string | null;
  createdAt: string; expiresAt: string; preparing: boolean; participant: boolean;
  me: { playerId: string; userId: string } | null; players: BattlePlayer[]; challenge: BattleChallenge | null;
  results?: BattleResult[];
  mode: 'private' | 'quick' | 'ranked';
  rankedResult?: RankedBattleResult;
  rankedStats?: { mmr: number; placementGamesCompleted: number; placementGamesRequired: number; division: string; provisional: boolean };
}

export function BattleCreatePage() {
  const navigate = useNavigate();
  const [auth, setAuth] = useState<'loading' | 'guest' | 'ready'>('loading');
  const [options, setOptions] = useState<BattleOptions>({ categories: [] });
  const [sandboxEnabled, setSandboxEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      currentUser() as Promise<{ user: AuthUser | null }>,
      fetch('/api/battles/options', { signal: controller.signal }).then((response) => response.json() as Promise<BattleOptions>),
      fetch('/api/sandbox/status', { signal: controller.signal }).then((response) => response.json() as Promise<{ enabled: boolean; healthy?: boolean }>),
    ]).then(([me, battleOptions, sandbox]) => {
      setAuth(me.user ? 'ready' : 'guest');
      setOptions(battleOptions);
      setSandboxEnabled(sandbox.enabled === true && sandbox.healthy !== false);
    }).catch(() => setAuth('guest'));
    return () => controller.abort();
  }, []);

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true); setError(null);
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch('/api/battles', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rounds: Number(data.get('rounds')), category: data.get('category') }),
      });
      const payload = await response.json() as { battle?: BattleState; message?: string };
      if (!response.ok || !payload.battle) throw new Error(payload.message ?? 'Не удалось создать Battle.');
      navigate(`/battle/${payload.battle.roomCode}`);
    } catch (createError) {
      setError(humanizeError(createError, 'Не удалось создать Battle. Попробуйте ещё раз.'));
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-ink text-slate-200">
      <div className="grid-noise fixed inset-0 pointer-events-none" />
      <CommunityHeader />
      <main className="page-width relative z-10 py-12 sm:py-16">
        {auth === 'loading' && <Loading label="Проверяем Battle systems" />}
        {auth === 'guest' && (
          <section className="mx-auto max-w-2xl py-16 text-center">
            <div className="battle-icon mx-auto"><Swords size={27} /></div>
            <p className="eyebrow mt-7">Private Battle</p>
            <h1 className="mt-4 text-4xl font-semibold tracking-[-0.05em] text-white sm:text-6xl">Нужны два аккаунта.<br /><span className="text-acid">И один терминал на каждого.</span></h1>
            <p className="mx-auto mt-5 max-w-lg text-sm leading-7 text-slate-400">Войдите, создайте комнату и отправьте другу короткую ссылку.</p>
            <Link className="primary-button mt-8" to="/?auth=1&returnTo=%2Fbattle">Войти и создать Battle</Link>
          </section>
        )}
        {auth === 'ready' && (
          <section className="mx-auto max-w-5xl">
            <Link className="mb-8 inline-flex items-center gap-2 text-xs text-slate-500 hover:text-white" to="/"><ArrowLeft size={14} /> На главную</Link>
            <div className="grid gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:items-end">
              <div>
                <p className="eyebrow">Real-time · Private Battle</p>
                <h1 className="mt-4 text-5xl font-semibold leading-[0.96] tracking-[-0.055em] text-white sm:text-7xl">Два игрока.<br /><span className="text-acid">Одинаковые задачи.</span></h1>
              </div>
              <p className="max-w-xl text-sm leading-7 text-slate-400">Отдельный rootless Docker sandbox для каждого. Серверный countdown, независимый темп и прогресс соперника без его команд и вывода.</p>
            </div>

            <form className="battle-create-panel mt-12" onSubmit={create}>
              <div className="grid gap-7 md:grid-cols-2">
                <fieldset>
                  <legend>Раунды</legend>
                  <div className="grid grid-cols-3 gap-2">
                    {[3, 5, 10].map((rounds) => <label className="battle-choice" key={rounds}><input name="rounds" type="radio" value={rounds} defaultChecked={rounds === 3} /><span><strong>{rounds}</strong><small>раунда</small></span></label>)}
                  </div>
                </fieldset>
                <label className="play-field">
                  <span>Категория Shell</span>
                  <select name="category" defaultValue="all">
                    <option value="all">Все категории</option>
                    {options.categories.map((category) => <option key={category.slug} value={category.slug}>{category.name} · {category.challengeCount}</option>)}
                  </select>
                </label>
              </div>
              <div className="mt-8 grid gap-3 border-t border-line pt-6 sm:grid-cols-3">
                <BattleFact icon={Terminal} title="Real shell" detail="настоящие Linux-команды" />
                <BattleFact icon={ShieldCheck} title="2 sandboxes" detail="строгая изоляция игроков" />
                <BattleFact icon={Radio} title="Realtime" detail="готовность и прогресс" />
              </div>
              {!sandboxEnabled && <p className="play-error mt-6">Battle временно недоступен: sandbox server выключен.</p>}
              {error && <p className="play-error mt-6">{error}</p>}
              <div className="mt-7 flex justify-end">
                <button className="primary-button" disabled={busy || !sandboxEnabled} type="submit">{busy ? <LoaderCircle size={15} className="animate-spin" /> : <Swords size={15} />} {busy ? 'Создаём комнату…' : 'Создать Battle'}</button>
              </div>
            </form>
          </section>
        )}
      </main>
    </div>
  );
}

export function BattleRoomPage() {
  const roomCode = window.location.pathname.split('/')[2]?.toUpperCase() ?? '';
  const [battle, setBattle] = useState<BattleState | null>(null);
  const battleRef = useRef<BattleState | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [loading, setLoading] = useState(true);
  const [guest, setGuest] = useState(false);
  const [realtime, setRealtime] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { battleRef.current = battle; }, [battle]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch(`/api/battles/${roomCode}`);
        if (response.status === 401) { setGuest(true); return; }
        const payload = await response.json() as { battle?: BattleState; message?: string };
        if (!response.ok || !payload.battle) throw new Error(payload.message ?? 'Battle не найден.');
        let current = payload.battle;
        if (!current.participant && current.status === 'waiting') {
          const joinResponse = await fetch(`/api/battles/${roomCode}/join`, { method: 'POST' });
          const joined = await joinResponse.json() as { battle?: BattleState; message?: string };
          if (!joinResponse.ok || !joined.battle) throw new Error(joined.message ?? 'Не удалось войти в комнату.');
          current = joined.battle;
        }
        if (active) setBattle(current);
      } catch (loadError) {
        if (active) setError(humanizeError(loadError, 'Не удалось загрузить Battle.'));
      } finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [roomCode]);

  useEffect(() => {
    if (!battle?.participant) return;
    let active = true;
    let retryTimer: number | undefined;
    let attempts = 0;
    const connect = () => {
      if (!active || battleRef.current?.status === 'cancelled') return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws/battle/${roomCode}`);
      socketRef.current = socket;
      socket.onopen = () => { attempts = 0; setRealtime(true); setError(null); socket.send(JSON.stringify({ type: 'battle:state' })); };
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as { type: string; state?: BattleState; message?: string };
        if (message.state) setBattle(message.state);
        if (message.type === 'battle:error') setError(humanizeError(message.message, 'Действие не выполнено. Попробуйте ещё раз.'));
      };
      socket.onerror = () => setRealtime(false);
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        setRealtime(false);
        if (active && battleRef.current?.status !== 'finished' && battleRef.current?.status !== 'cancelled') {
          attempts += 1;
          retryTimer = window.setTimeout(connect, Math.min(5_000, 500 * 2 ** Math.min(attempts, 4)));
        }
      };
    };
    connect();
    return () => { active = false; if (retryTimer) window.clearTimeout(retryTimer); socketRef.current?.close(1000, 'page_unmounted'); };
  }, [battle?.participant, roomCode]);

  const toggleReady = async () => {
    const me = battle?.players.find((player) => player.userId === battle.me?.userId);
    if (!battle || !me) return;
    setError(null);
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'player:ready', ready: !me.ready }));
      return;
    }
    try {
      const response = await fetch(`/api/battles/${roomCode}/ready`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ready: !me.ready }),
      });
      const payload = await response.json() as { battle?: BattleState; message?: string };
      if (!response.ok || !payload.battle) throw new Error(payload.message ?? 'Не удалось изменить Ready.');
      setBattle(payload.battle);
    } catch (readyError) { setError(humanizeError(readyError, 'Не удалось изменить готовность.')); }
  };

  return (
    <div className="battle-page min-h-screen bg-ink text-slate-200">
      <div className="grid-noise fixed inset-0 pointer-events-none" />
      {loading && <Loading label="Подключаемся к Battle" />}
      {guest && <BattleGuest roomCode={roomCode} />}
      {!loading && !guest && error && !battle && <BattleError message={error} />}
      {battle && (
        <>
          <BattleTopbar battle={battle} realtime={realtime} />
          {battle.status === 'finished' ? <BattleResults battle={battle} />
            : battle.status === 'cancelled' && battle.rankedResult?.outcome === 'no_contest' ? <RankedNoContest reason={battle.rankedResult.noContestReason} />
              : battle.status === 'cancelled' ? <BattleError message="Комната закрыта по таймауту." />
              : battle.preparing || battle.status === 'countdown' || battle.status === 'running'
                ? <BattleArena battle={battle} realtime={realtime} error={error} />
                : <BattleLobby battle={battle} realtime={realtime} error={error} onReady={() => void toggleReady()} />}
        </>
      )}
    </div>
  );
}

function BattleTopbar({ battle, realtime }: { battle: BattleState; realtime: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 100); return () => window.clearInterval(timer); }, []);
  const elapsed = battle.startedAt ? formatRaceTime(Math.max(0, (battle.finishedAt ? new Date(battle.finishedAt).getTime() : now) - new Date(battle.startedAt).getTime())) : '00:00.0';
  return (
    <header className="battle-topbar">
      <Link to="/" className="flex items-center gap-2.5"><span className="logo-mark"><span>&gt;_</span></span><span className="font-mono text-sm font-bold tracking-[0.12em] text-white">CLIRACE</span></Link>
      <div className="battle-topbar-center"><span>BATTLE {battle.roomCode}</span><strong>{elapsed}</strong><span>{battle.status === 'waiting' ? 'ЛОББИ' : `РАУНД ${Math.min(...battle.players.map((player) => player.currentRound))}/${battle.roundCount}`}</span></div>
      <div className={`battle-live ${realtime ? 'is-online' : ''}`}>{realtime ? <Wifi size={13} /> : <WifiOff size={13} />} {realtime ? 'СИНХРОНИЗИРОВАНО' : 'ПЕРЕПОДКЛЮЧЕНИЕ'}</div>
    </header>
  );
}

function BattleLobby({ battle, realtime, error, onReady }: { battle: BattleState; realtime: boolean; error: string | null; onReady: () => void }) {
  const me = battle.players.find((player) => player.userId === battle.me?.userId)!;
  const invite = `${window.location.origin}/battle/${battle.roomCode}`;
  const [copied, setCopied] = useState(false);
  const copy = async () => { await navigator.clipboard.writeText(invite); setCopied(true); window.setTimeout(() => setCopied(false), 1_500); };
  return (
    <main className="page-width relative z-10 py-10 sm:py-14">
      <section className="battle-lobby">
        <div className="battle-lobby-heading">
          <div><p className="eyebrow">Приватное лобби</p><h1>BATTLE <span>{battle.roomCode}</span></h1><p>{battle.roundCount} раунда · {battle.category.name} · отдельный sandbox для каждого</p></div>
          <div className="battle-invite"><span>Код и ссылка для друга</span><code>{battle.roomCode}</code><button type="button" onClick={() => void copy()} aria-label="Скопировать ссылку-приглашение">{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Скопировано' : 'Копировать ссылку'}</button></div>
        </div>
        <div className="battle-player-grid">
          {[0, 1].map((index) => {
            const player = battle.players[index];
            return player ? <LobbyPlayer key={player.id} player={player} isMe={player.userId === battle.me?.userId} /> : <div className="lobby-player lobby-player-empty" key="empty"><UserPlus size={24} /><strong>Ждём второго игрока</strong><span>Отправьте ему ссылку-приглашение</span></div>;
          })}
        </div>
        {error && <p className="play-error mt-5">{error}</p>}
        <div className="battle-ready-row"><span><Radio size={14} className={realtime ? 'text-acid' : 'text-amber-300'} /> {realtime ? 'Соединение установлено' : 'Восстанавливаем соединение'}</span><button className={`battle-ready-button ${me.ready ? 'is-ready' : ''}`} type="button" onClick={onReady} disabled={!realtime || battle.players.length !== 2}>{me.ready ? <Check size={16} /> : <Zap size={16} />}{me.ready ? 'ГОТОВ' : 'Я ГОТОВ'}</button></div>
      </section>
    </main>
  );
}

function BattleArena({ battle, realtime, error }: { battle: BattleState; realtime: boolean; error: string | null }) {
  const me = battle.players.find((player) => player.userId === battle.me?.userId)!;
  const opponent = battle.players.find((player) => player.userId !== battle.me?.userId)!;
  const countdown = useCountdown(battle.countdownStartAt, battle.status);
  return (
    <main className="battle-arena relative z-10">
      {battle.status === 'countdown' && <div className="battle-countdown" key={countdown}><span>{countdown}</span><small>серверный отсчёт</small></div>}
      <div className="battle-workspace">
        <section className="battle-terminal-column">
          <div className="battle-pane-label"><span>ВАШ ТЕРМИНАЛ</span><span>{me.sandboxReady ? 'ОКРУЖЕНИЕ ГОТОВО' : 'СОЗДАЁМ ОКРУЖЕНИЕ'}</span></div>
          <BattleTerminal key={`${battle.id}-${me.currentRound}-${me.completedRounds}`} roomCode={battle.roomCode} round={me.currentRound} locked={battle.status !== 'running'} />
        </section>
        <aside className="battle-sidebar">
          <section className="battle-challenge-card">
            <div className="flex items-center justify-between gap-3"><span className="challenge-category">{battle.challenge?.category.name ?? 'Shell'}</span><span className="difficulty">{battle.challenge?.difficulty ?? 'READY'}</span></div>
            <p>РАУНД {me.currentRound} / {battle.roundCount}</p>
            <h1>{battle.challenge?.title ?? 'Готовим задание'}</h1>
            <div>{battle.challenge?.description ?? 'Одинаковое окружение создаётся для обоих игроков.'}</div>
          </section>
          <section className="battle-progress-panel">
            <ProgressPlayer player={me} total={battle.roundCount} label="ВЫ" />
            <ProgressPlayer player={opponent} total={battle.roundCount} label={opponent.username.toUpperCase()} />
          </section>
          <div className="battle-privacy"><ShieldCheck size={14} /><span>Прогресс синхронизируется. Команды, stdout и решение соперника скрыты.</span></div>
          {!realtime && <p className="play-error">Связь с Battle восстанавливается. Ваш терминал продолжает работать.</p>}
          {error && <p className="play-error">{error}</p>}
        </aside>
      </div>
    </main>
  );
}

function BattleResults({ battle }: { battle: BattleState }) {
  const winner = battle.players.find((player) => player.userId === battle.winnerUserId);
  const victory = battle.me?.userId === battle.winnerUserId;
  const rows = Array.from({ length: battle.roundCount }, (_, index) => index + 1);
  return (
    <main className="page-width relative z-10 py-12 sm:py-16">
      <section className="battle-results">
        <div className="battle-winner"><div className="battle-icon"><Crown size={28} /></div><p className="eyebrow">Battle завершён</p><h1>{victory ? 'ПОБЕДА' : 'ПОРАЖЕНИЕ'}<br /><span>{winner?.username ?? '—'}</span></h1><p>{battle.startedAt && battle.finishedAt ? formatCompactDuration(new Date(battle.finishedAt).getTime() - new Date(battle.startedAt).getTime()) : '—'}</p></div>
        <div className="battle-result-table">
          <div className="battle-result-row battle-result-head"><span>РАУНД</span>{battle.results?.map((result) => <strong key={result.userId}>{result.username}</strong>)}</div>
          {rows.map((round) => <div className="battle-result-row" key={round}><span>{String(round).padStart(2, '0')}</span>{battle.results?.map((result) => { const item = result.rounds.find((entry) => entry.round === round); return <strong className={item?.success ? 'text-white' : 'text-slate-600'} key={result.userId}>{item?.success && item.durationMs !== null ? formatCompactDuration(item.durationMs) : 'DNF'}</strong>; })}</div>)}
        </div>
        {battle.mode === 'ranked' && battle.rankedResult && <RankedResultBlock battle={battle} result={battle.rankedResult} victory={victory} />}
        <div className="mt-8 flex flex-wrap justify-center gap-3"><Link className="secondary-button" to="/"><ArrowLeft size={14} /> На главную</Link>{battle.mode === 'ranked' && <Link className="secondary-button" to="/rating?category=ranked"><Trophy size={14} /> Рейтинг</Link>}<Link className="primary-button" to={battle.mode === 'ranked' ? '/online?mode=ranked' : battle.mode === 'quick' ? '/online?match=quick' : '/battle'}><RefreshCw size={14} /> {battle.mode === 'ranked' ? 'Снова Ranked' : battle.mode === 'quick' ? 'Снова Quick Match' : 'Новая игра с другом'}</Link></div>
      </section>
    </main>
  );
}

function RankedResultBlock({ battle, result, victory }: { battle: BattleState; result: RankedBattleResult; victory: boolean }) {
  const mine = result.players.find((player) => player.userId === battle.me?.userId);
  if (!mine) return null;
  const changedDivision = mine.divisionBefore !== mine.divisionAfter;
  const provisional = battle.rankedStats?.provisional === true;
  const placementComplete = !provisional && battle.rankedStats?.placementGamesCompleted === battle.rankedStats?.placementGamesRequired;
  return (
    <section className="ranked-result-block">
      <div><span>Результат Ranked</span><strong>{victory ? 'Победа' : 'Поражение'}</strong></div>
      <div><span>MMR</span><strong>{provisional ? 'Пока скрыт' : `${mine.mmrBefore} → ${mine.mmrAfter}`}</strong><b className={mine.delta >= 0 ? 'text-acid' : 'text-rose-300'}>{provisional ? 'Откроется после квалификации' : `${mine.delta >= 0 ? '+' : ''}${mine.delta} MMR`}</b></div>
      <div><span>Дивизион</span><strong>{provisional ? `Квалификация ${battle.rankedStats?.placementGamesCompleted}/${battle.rankedStats?.placementGamesRequired}` : changedDivision ? `${mine.divisionBefore} → ${mine.divisionAfter}` : mine.divisionAfter}</strong>{placementComplete ? <b>Квалификация 5/5 · дивизион открыт</b> : !provisional && changedDivision && <b>{mine.delta > 0 ? 'Повышение' : 'Понижение'}</b>}</div>
    </section>
  );
}

function RankedNoContest({ reason }: { reason: string | null }) {
  return <main className="page-width relative z-10 py-24 text-center"><div className="battle-icon mx-auto"><ShieldCheck size={25} /></div><p className="eyebrow mt-7">Рейтинговый матч отменён</p><h1 className="mt-4 text-4xl font-semibold text-white">Матч не повлиял на MMR.</h1><p className="mx-auto mt-4 max-w-lg text-slate-400">{noContestMessage(reason)} Ни один игрок не получил поражение.</p><Link className="primary-button mt-8" to="/online?mode=ranked">Вернуться к Ranked</Link></main>;
}

function noContestMessage(reason: string | null): string {
  return ({
    admin_terminated: 'Матч завершён системой.',
    both_players_disconnected: 'Оба игрока отключились до завершения.',
    battle_expired: 'Время матча истекло.',
    internal_failure: 'Игровая среда завершилась с технической ошибкой.',
  } as Record<string, string>)[reason ?? ''] ?? 'Матч завершён из-за проблемы игровой среды.';
}

function LobbyPlayer({ player, isMe }: { player: BattlePlayer; isMe: boolean }) {
  return <div className={`lobby-player ${player.ready ? 'is-ready' : ''}`}><div className="flex items-center justify-between"><span className={`battle-presence ${player.connected ? 'is-online' : ''}`}>{player.connected ? '● В СЕТИ' : '○ НЕ В СЕТИ'}</span>{player.isHost && <span className="battle-host">СОЗДАТЕЛЬ</span>}</div><strong>{player.username}{isMe ? ' · ВЫ' : ''}</strong><span className="lobby-ready-state">{player.ready ? <Check size={16} /> : <Clock3 size={15} />}{player.ready ? 'ГОТОВ' : 'НЕ ГОТОВ'}</span></div>;
}

function ProgressPlayer({ player, total, label }: { player: BattlePlayer; total: number; label: string }) {
  const percent = Math.round((player.completedRounds / total) * 100);
  return <div className="battle-progress-player"><div><strong>{label}</strong><span className={player.connected ? 'is-online' : ''}>{player.connected ? '● В СЕТИ' : '○ НЕ В СЕТИ'}</span></div><div className="battle-progress-track"><i style={{ width: `${percent}%` }} /></div><p><span>{player.completedRounds} / {total}</span><span>{player.finishedAt ? 'ФИНИШ' : `РАУНД ${player.currentRound}`}</span></p></div>;
}

function BattleFact({ icon: Icon, title, detail }: { icon: typeof Terminal; title: string; detail: string }) { return <div className="battle-fact"><Icon size={15} /><div><strong>{title}</strong><span>{detail}</span></div></div>; }
function Loading({ label }: { label: string }) { return <div className="flex min-h-[65vh] items-center justify-center gap-3 font-mono text-xs uppercase tracking-[0.14em] text-slate-500"><LoaderCircle size={18} className="animate-spin text-acid" />{label}</div>; }
function BattleGuest({ roomCode }: { roomCode: string }) { return <main className="page-width relative z-10 py-24 text-center"><div className="battle-icon mx-auto"><Users size={26} /></div><p className="eyebrow mt-7">Invite · {roomCode}</p><h1 className="mt-4 text-4xl font-semibold text-white">Войдите, чтобы присоединиться.</h1><Link className="primary-button mt-8" to={`/?auth=1&returnTo=${encodeURIComponent(`/battle/${roomCode}`)}`}>Войти в Battle</Link></main>; }
function BattleError({ message }: { message: string }) { return <main className="page-width relative z-10 py-24 text-center"><div className="battle-icon mx-auto text-rose-300"><WifiOff size={25} /></div><h1 className="mt-6 text-3xl font-semibold text-white">Battle недоступен</h1><p className="mx-auto mt-4 max-w-lg text-slate-400">{message}</p><Link className="secondary-button mt-8" to="/battle">Создать новую комнату</Link></main>; }

function useCountdown(startAt: string | null, status: BattleState['status']) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (status !== 'countdown') return; const timer = window.setInterval(() => setNow(Date.now()), 50); return () => window.clearInterval(timer); }, [status]);
  return useMemo(() => {
    if (!startAt) return '…';
    const left = new Date(startAt).getTime() - now;
    return left <= 0 ? 'GO' : String(Math.ceil(left / 1_000));
  }, [now, startAt]);
}

function formatRaceTime(ms: number) { const seconds = ms / 1_000; return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toFixed(1).padStart(4, '0')}`; }
function formatCompactDuration(ms: number) { const seconds = Math.max(0, Math.round(ms / 1_000)); return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`; }
