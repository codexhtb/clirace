import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { CheckCircle2, Lightbulb, Play, RotateCcw, ShieldCheck, Square, Target } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

type TerminalStatus = 'idle' | 'connecting' | 'ready' | 'closed' | 'error';
type CheckStatus = 'idle' | 'checking' | 'passed' | 'failed';

interface SandboxChallenge {
  id: string;
  title: string;
  description: string;
  category: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  hint: string;
}

interface SessionTicket {
  sessionId: string;
  token: string;
  websocketPath: string;
  challenge: SandboxChallenge;
}

const statusLabels: Record<TerminalStatus, string> = {
  idle: 'готов к запуску',
  connecting: 'создаём песочницу',
  ready: 'shell подключён',
  closed: 'сессия завершена',
  error: 'ошибка подключения',
};

export function ShellTerminal() {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const startShellRef = useRef<() => Promise<void>>(async () => undefined);
  const completedRef = useRef(false);
  const lastChallengeIdRef = useRef<string | null>(null);
  const nextTaskTimerRef = useRef<number | null>(null);
  const [status, setStatus] = useState<TerminalStatus>('idle');
  const [checkStatus, setCheckStatus] = useState<CheckStatus>('idle');
  const [challenge, setChallenge] = useState<SandboxChallenge | null>(null);
  const [taskNumber, setTaskNumber] = useState(0);
  const [streak, setStreak] = useState(0);

  const sendResize = useCallback(() => {
    const terminal = terminalRef.current;
    const socket = socketRef.current;
    if (!terminal || !socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
  }, []);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;

    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      convertEol: true,
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
      fontSize: 14,
      lineHeight: 1.35,
      scrollback: 2_000,
      allowProposedApi: false,
      theme: {
        background: '#070a0e',
        foreground: '#d8e0ea',
        cursor: '#b6f04a',
        cursorAccent: '#10150a',
        selectionBackground: '#33415588',
        black: '#111827',
        red: '#fb7185',
        green: '#b6f04a',
        yellow: '#facc15',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#52d3f7',
        white: '#e2e8f0',
        brightBlack: '#64748b',
        brightRed: '#fda4af',
        brightGreen: '#d1ff79',
        brightYellow: '#fde047',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#a5f3fc',
        brightWhite: '#ffffff',
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    fitAddon.fit();
    terminal.writeln('\x1b[38;2;182;240;74mCLIRace local shell\x1b[0m');
    terminal.writeln('Одноразовая Linux-песочница без доступа к сети и хост-системе.');
    terminal.writeln('Нажмите «Запустить shell», чтобы начать.\r\n');

    const inputDisposable = terminal.onData((data) => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'input', data }));
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit();
        sendResize();
      } catch {
        // The terminal may already be disposing during navigation.
      }
    });
    resizeObserver.observe(host);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    return () => {
      resizeObserver.disconnect();
      inputDisposable.dispose();
      if (nextTaskTimerRef.current !== null) window.clearTimeout(nextTaskTimerRef.current);
      socketRef.current?.close(1000, 'page_unmounted');
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sendResize]);

  const startShell = useCallback(async () => {
    if (status === 'connecting' || status === 'ready') return;
    const terminal = terminalRef.current;
    if (!terminal) return;

    setStatus('connecting');
    setCheckStatus('idle');
    setChallenge(null);
    completedRef.current = false;
    terminal.clear();
    terminal.writeln('\x1b[38;2;82;211;247mГотовим следующее задание…\x1b[0m');

    try {
      const response = await fetch('/api/sandbox/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(lastChallengeIdRef.current
          ? { excludeChallengeId: lastChallengeIdRef.current }
          : {}),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { message?: string } | null;
        throw new Error(payload?.message ?? 'Не удалось создать sandbox-сессию.');
      }

      const ticket = await response.json() as SessionTicket;
      lastChallengeIdRef.current = ticket.challenge.id;
      setChallenge(ticket.challenge);
      setTaskNumber((current) => current + 1);
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${window.location.host}${ticket.websocketPath}`);
      socket.binaryType = 'arraybuffer';
      socketRef.current = socket;

      socket.onopen = () => {
        const currentTerminal = terminalRef.current;
        socket.send(JSON.stringify({
          type: 'auth',
          token: ticket.token,
          cols: currentTerminal?.cols ?? 100,
          rows: currentTerminal?.rows ?? 28,
        }));
      };

      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') {
          terminalRef.current?.write(new Uint8Array(event.data as ArrayBuffer));
          return;
        }

        const message = JSON.parse(event.data) as {
          type: string;
          reason?: string;
          passed?: boolean;
          message?: string;
        };
        if (message.type === 'ready') {
          setStatus('ready');
          fitAddonRef.current?.fit();
          sendResize();
        }
        if (message.type === 'closed') {
          if (message.reason !== 'challenge_completed') {
            terminalRef.current?.writeln(`\r\n\x1b[33mСессия завершена: ${message.reason ?? 'завершено'}\x1b[0m`);
          }
        }
        if (message.type === 'check_result') {
          const passed = message.passed === true;
          if (passed && !completedRef.current) {
            completedRef.current = true;
            setStreak((current) => current + 1);
          }
          setCheckStatus(passed ? 'passed' : 'failed');
          terminalRef.current?.writeln(
            `\r\n\x1b[${passed ? '38;2;182;240;74' : '33'}m${passed ? '✓' : '○'} ${message.message ?? 'Проверка завершена.'}\x1b[0m`,
          );
        }
      };

      socket.onerror = () => {
        completedRef.current = false;
        setStreak(0);
        setStatus('error');
        terminalRef.current?.writeln('\r\n\x1b[31mНе удалось подключиться к локальному shell.\x1b[0m');
      };

      socket.onclose = () => {
        const continueRun = completedRef.current;
        socketRef.current = null;
        setStatus((current) => current === 'error' ? 'error' : 'closed');
        if (continueRun) {
          terminalRef.current?.writeln('\r\n\x1b[36mСледующее задание через секунду…\x1b[0m');
          nextTaskTimerRef.current = window.setTimeout(() => {
            nextTaskTimerRef.current = null;
            void startShellRef.current();
          }, 900);
        }
      };
    } catch (error) {
      setStatus('error');
      terminal.writeln(`\r\n\x1b[31m${error instanceof Error ? error.message : 'Ошибка запуска терминала.'}\x1b[0m`);
    }
  }, [sendResize, status]);

  useEffect(() => {
    startShellRef.current = startShell;
  }, [startShell]);

  const stopShell = useCallback(() => {
    completedRef.current = false;
    setStreak(0);
    socketRef.current?.close(1000, 'user_stopped');
  }, []);

  const checkChallenge = useCallback(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || checkStatus === 'checking') return;
    setCheckStatus('checking');
    socket.send(JSON.stringify({ type: 'check' }));
  }, [checkStatus]);

  const active = status === 'ready' || status === 'connecting';

  return (
    <div className="terminal-shell shadow-glow" aria-label="Настоящий локальный Linux shell">
      <div className="terminal-topbar">
        <div className="flex gap-1.5" aria-hidden="true">
          <span className="terminal-dot bg-[#ff6b66]" />
          <span className="terminal-dot bg-[#e9c55b]" />
          <span className="terminal-dot bg-[#68d391]" />
        </div>
        <span>local/rootless/sandbox</span>
        <span className={status === 'ready' ? 'text-acid' : 'text-slate-500'}>{statusLabels[status]}</span>
      </div>

      <div className="grid border-b border-line sm:grid-cols-4">
        {[
          ['256 МБ', 'память'],
          ['0,25 CPU', 'процессор'],
          ['64', 'лимит PID'],
          ['15 мин', 'максимум'],
        ].map(([value, label]) => (
          <div key={label} className="border-b border-line px-4 py-3 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
            <div className="font-mono text-sm font-semibold text-slate-100">{value}</div>
            <div className="mt-0.5 text-[10px] uppercase tracking-[0.16em] text-slate-500">{label}</div>
          </div>
        ))}
      </div>

      {challenge && (
        <section className="challenge-brief" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2">
            <span className="challenge-category">{challenge.category}</span>
            <span className="difficulty">{challenge.difficulty}</span>
            <span className="run-counter">задание {taskNumber}</span>
            <span className="run-counter text-acid">серия {streak}</span>
            <span className="font-mono text-[10px] text-slate-600">{challenge.id}</span>
          </div>
          <div className="mt-3 flex items-start gap-3">
            <Target size={18} className="mt-0.5 shrink-0 text-acid" />
            <div>
              <h3 className="text-sm font-semibold text-slate-100">{challenge.title}</h3>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-400">{challenge.description}</p>
            </div>
          </div>
          <details className="challenge-hint">
            <summary><Lightbulb size={13} /> Подсказка</summary>
            <p>{challenge.hint}</p>
          </details>
        </section>
      )}

      <div className="relative bg-[#070a0e] p-3 sm:p-5">
        <div ref={containerRef} className="xterm-host" />
      </div>

      <div className="flex flex-col justify-between gap-3 border-t border-line bg-[#0b1016] px-4 py-3 text-xs sm:flex-row sm:items-center">
        <span className="flex items-center gap-2 text-slate-500">
          <ShieldCheck size={14} className="text-acid" /> rootless · без сети · одноразовая сессия
        </span>
        {active ? (
          <div className="flex flex-wrap gap-2">
            {status === 'ready' && (
              <button
                type="button"
                className="terminal-action"
                onClick={checkChallenge}
                disabled={checkStatus === 'checking' || checkStatus === 'passed'}
              >
                <CheckCircle2 size={13} />
                {checkStatus === 'checking' ? 'Проверяем…' : checkStatus === 'passed' ? 'Выполнено' : 'Проверить'}
              </button>
            )}
            <button type="button" className="terminal-action terminal-action-stop" onClick={stopShell}>
              <Square size={13} /> Завершить
            </button>
          </div>
        ) : (
          <button type="button" className="terminal-action" onClick={() => void startShell()}>
            {status === 'idle' ? <Play size={13} /> : <RotateCcw size={13} />}
            {status === 'idle' ? 'Начать RUN' : 'Продолжить RUN'}
          </button>
        )}
      </div>
    </div>
  );
}
