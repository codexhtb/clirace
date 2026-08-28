import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { ArrowLeft, Pause, Play, RefreshCcw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { CommunityHeader } from './CommunityHeader';
import { decodeReplayOutput, parseReplayPayload, playbackPosition, replayMarkerLabel, type ReplayEvent, type ReplayPayload } from './replay-player';

interface ReplayResponse {
  replay: {
    id: string;
    challenge: { slug: string; title: string };
    durationMs: number;
    eventCount: number;
    sizeBytes: number;
    truncated: boolean;
    expiresAt: string;
    payload: unknown;
  };
}

export function TerminalReplayPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const replayId = /^\/practice\/replay\/([0-9a-f-]{36})$/i.exec(location.pathname)?.[1];
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const payloadRef = useRef<ReplayPayload | null>(null);
  const eventIndexRef = useRef(0);
  const positionRef = useRef(0);
  const renderChainRef = useRef(Promise.resolve());
  const [replay, setReplay] = useState<ReplayResponse['replay'] | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'invalid'>('loading');
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<1 | 2 | 4>(1);
  const [position, setPosition] = useState(0);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!replayId) { setState('missing'); return; }
    const controller = new AbortController();
    fetch(`/api/practice/replays/${replayId}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (response.status === 404 || response.status === 401) return undefined;
        if (!response.ok) throw new Error('invalid');
        return response.json() as Promise<ReplayResponse>;
      })
      .then((response) => {
        if (!response) { setState('missing'); return; }
        const payload = parseReplayPayload(response.replay.payload);
        if (!payload) { setState('invalid'); return; }
        payloadRef.current = payload;
        setReplay(response.replay);
        setState('ready');
      })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== 'AbortError') setState('invalid');
      });
    return () => controller.abort();
  }, [replayId]);

  useEffect(() => {
    if (state !== 'ready' || !hostRef.current || !payloadRef.current) return;
    const terminal = new Terminal({
      disableStdin: true,
      cursorBlink: false,
      convertEol: false,
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.3,
      scrollback: 2_000,
      theme: { background: '#06090c', foreground: '#d8e0ea', cursor: '#06090c', black: '#111827', red: '#fb7185', green: '#b6f04a', yellow: '#facc15', blue: '#60a5fa', magenta: '#c084fc', cyan: '#52d3f7', white: '#e2e8f0', brightBlack: '#64748b', brightRed: '#fda4af', brightGreen: '#d1ff79', brightYellow: '#fde047', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#a5f3fc', brightWhite: '#ffffff' },
    });
    terminal.open(hostRef.current);
    terminal.resize(payloadRef.current.initialCols, payloadRef.current.initialRows);
    terminalRef.current = terminal;
    return () => { terminal.dispose(); terminalRef.current = null; };
  }, [state]);

  const applyEvent = useCallback(async (event: ReplayEvent) => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (event.type === 'output') {
      await new Promise<void>((resolve) => terminal.write(decodeReplayOutput(event.data), resolve));
    } else if (event.type === 'resize') {
      terminal.resize(event.cols, event.rows);
    }
  }, []);

  const renderThrough = useCallback((target: number) => {
    renderChainRef.current = renderChainRef.current.then(async () => {
      const payload = payloadRef.current;
      if (!payload) return;
      while (eventIndexRef.current < payload.events.length && payload.events[eventIndexRef.current]!.tMs <= target) {
        await applyEvent(payload.events[eventIndexRef.current]!);
        eventIndexRef.current += 1;
      }
      positionRef.current = target;
      setPosition(target);
    });
    return renderChainRef.current;
  }, [applyEvent]);

  const seek = useCallback(async (target: number) => {
    setPlaying(false);
    await renderChainRef.current;
    const terminal = terminalRef.current;
    const payload = payloadRef.current;
    if (!terminal || !payload || !replay) return;
    terminal.reset();
    terminal.resize(payload.initialCols, payload.initialRows);
    eventIndexRef.current = 0;
    positionRef.current = 0;
    await renderThrough(Math.min(replay.durationMs, Math.max(0, target)));
  }, [renderThrough, replay]);

  useEffect(() => {
    if (state === 'ready' && terminalRef.current) void renderThrough(0);
  }, [renderThrough, state]);

  useEffect(() => {
    if (!playing || !replay) return;
    const anchorPosition = positionRef.current;
    const anchorTime = performance.now();
    let animation = 0;
    const tick = (now: number) => {
      const next = playbackPosition(anchorPosition, anchorTime, now, speed, replay.durationMs);
      void renderThrough(next);
      if (next >= replay.durationMs) setPlaying(false);
      else animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [playing, replay, renderThrough, speed]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement) return;
      event.preventDefault();
      setPlaying((current) => !current);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const remove = async () => {
    if (!replayId || !window.confirm('Удалить этот повтор? Восстановить его будет нельзя.')) return;
    setDeleting(true);
    const response = await fetch(`/api/practice/replays/${replayId}`, { method: 'DELETE' }).catch(() => undefined);
    if (response?.ok) navigate('/play');
    else setDeleting(false);
  };

  if (state !== 'ready' || !replay) return <ReplayState state={state === 'ready' ? 'invalid' : state} />;
  const markers = payloadRef.current?.events.filter((event): event is Extract<ReplayEvent, { type: 'checker' | 'completed' }> => event.type === 'checker' || event.type === 'completed') ?? [];
  return (
    <div className="min-h-screen bg-ink text-slate-200">
      <div className="grid-noise pointer-events-none fixed inset-0" />
      <CommunityHeader />
      <main className="page-width relative z-10 py-8 sm:py-12">
        <Link className="inline-flex items-center gap-2 text-xs text-slate-500 hover:text-white" to="/play"><ArrowLeft size={14} /> Вернуться к практике</Link>
        <div className="mt-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div><p className="eyebrow">Terminal Replay</p><h1 className="mt-2 text-3xl font-semibold text-white sm:text-5xl">{replay.challenge.title}</h1><p className="mt-3 text-sm text-slate-500">Задача выполнена · {formatTime(replay.durationMs)} · {replay.truncated ? 'запись сокращена' : 'полная запись'}</p></div>
          <button className="secondary-button text-rose-300" type="button" onClick={() => void remove()} disabled={deleting}><Trash2 size={14} /> {deleting ? 'Удаляем…' : 'Удалить повтор'}</button>
        </div>
        {replay.truncated && <p className="replay-warning" role="status">Повтор был сокращён из-за ограничения размера. Завершение задачи при этом сохранено.</p>}
        <section className="replay-panel" aria-label="Воспроизведение терминала">
          <div className="replay-terminal" ref={hostRef} aria-label="Терминал только для чтения" />
          <div className="replay-controls">
            <button className="terminal-action" type="button" onClick={() => setPlaying((current) => !current)} aria-label={playing ? 'Пауза' : 'Воспроизвести'}>{playing ? <Pause size={14} /> : <Play size={14} />} {playing ? 'Пауза' : 'Старт'}</button>
            <button className="terminal-action" type="button" onClick={() => void seek(0)} aria-label="Начать повтор сначала"><RefreshCcw size={13} /> Сначала</button>
            <div className="replay-speeds" aria-label="Скорость воспроизведения">{([1, 2, 4] as const).map((value) => <button type="button" aria-pressed={speed === value} className={speed === value ? 'active' : ''} onClick={() => setSpeed(value)} key={value}>{value}x</button>)}</div>
            <span>{formatTime(position)} / {formatTime(replay.durationMs)}</span>
          </div>
          <input className="replay-range" type="range" min={0} max={Math.max(1, replay.durationMs)} value={Math.round(position)} onChange={(event) => void seek(Number(event.target.value))} aria-label="Позиция повтора" />
        </section>
        <section className="mt-7" aria-labelledby="replay-events"><h2 id="replay-events" className="text-lg font-semibold text-white">События</h2><div className="replay-markers">{markers.map((marker) => <button type="button" key={marker.seq} onClick={() => void seek(marker.tMs)}><span>{formatTime(marker.tMs)}</span><strong>{replayMarkerLabel(marker)}</strong></button>)}</div></section>
      </main>
    </div>
  );
}

function ReplayState({ state }: { state: 'loading' | 'missing' | 'invalid' }) {
  return <div className="min-h-screen bg-ink text-slate-200"><CommunityHeader /><main className="page-width flex min-h-[65vh] items-center justify-center text-center"><section><p className="eyebrow">Terminal Replay</p><h1 className="mt-3 text-3xl font-semibold text-white">{state === 'loading' ? 'Загружаем повтор…' : state === 'missing' ? 'Повтор недоступен.' : 'Повтор повреждён.'}</h1><p className="mt-3 text-sm text-slate-500">{state === 'missing' ? 'Он мог истечь, быть удалён или принадлежать другому пользователю.' : state === 'invalid' ? 'Формат записи не удалось безопасно прочитать.' : 'Подготавливаем терминал только для чтения.'}</p><Link className="secondary-button mt-7" to="/play">Вернуться к практике</Link></section></main></div>;
}

function formatTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, milliseconds) / 1_000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toFixed(1).padStart(4, '0')}`;
}
