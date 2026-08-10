import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { CheckCircle2, Lightbulb, LoaderCircle, Play, ShieldCheck, SkipForward, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

type TerminalStatus = 'idle' | 'connecting' | 'ready' | 'closed' | 'error';
type CheckStatus = 'idle' | 'checking' | 'passed' | 'failed';

interface SessionTicket {
  sessionId: string;
  token: string;
  websocketPath: string;
}

export function GameShellTerminal({ gameSessionId, hint, onCompleted, onSkip }: {
  gameSessionId: string;
  hint?: string;
  onCompleted: (scoreAwarded: number) => void;
  onSkip: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const passedRef = useRef(false);
  const scoreRef = useRef(0);
  const [status, setStatus] = useState<TerminalStatus>('idle');
  const [checkStatus, setCheckStatus] = useState<CheckStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const sendResize = useCallback(() => {
    const terminal = terminalRef.current;
    const socket = socketRef.current;
    if (terminal && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
    }
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      convertEol: true,
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 14,
      lineHeight: 1.35,
      scrollback: 2_000,
      theme: {
        background: '#06090c', foreground: '#d8e0ea', cursor: '#b6f04a', cursorAccent: '#10150a',
        selectionBackground: '#33415588', black: '#111827', red: '#fb7185', green: '#b6f04a',
        yellow: '#facc15', blue: '#60a5fa', magenta: '#c084fc', cyan: '#52d3f7', white: '#e2e8f0',
        brightBlack: '#64748b', brightRed: '#fda4af', brightGreen: '#d1ff79', brightYellow: '#fde047',
        brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#a5f3fc', brightWhite: '#ffffff',
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();
    terminal.writeln('\x1b[38;2;182;240;74mCLIRace game shell\x1b[0m');
    terminal.writeln('Запустите одноразовую песочницу для этого задания.\r\n');
    const input = terminal.onData((data) => {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: 'input', data }));
      }
    });
    const resize = new ResizeObserver(() => {
      try { fit.fit(); sendResize(); } catch { /* terminal is being disposed */ }
    });
    resize.observe(host);
    terminalRef.current = terminal;
    fitRef.current = fit;
    return () => {
      resize.disconnect();
      input.dispose();
      socketRef.current?.close(1000, 'page_unmounted');
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [sendResize]);

  const start = useCallback(async () => {
    if (status === 'connecting' || status === 'ready') return;
    setStatus('connecting');
    setCheckStatus('idle');
    setError(null);
    passedRef.current = false;
    scoreRef.current = 0;
    terminalRef.current?.clear();
    terminalRef.current?.writeln('\x1b[38;2;82;211;247mСоздаём изолированный контейнер…\x1b[0m');
    try {
      const response = await fetch('/api/sandbox/sessions', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gameSessionId }),
      });
      const payload = await response.json().catch(() => null) as (SessionTicket & { message?: string }) | null;
      if (!response.ok || !payload?.token) throw new Error(payload?.message ?? 'Не удалось создать shell-сессию.');
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${window.location.host}${payload.websocketPath}`);
      socket.binaryType = 'arraybuffer';
      socketRef.current = socket;
      socket.onopen = () => {
        const terminal = terminalRef.current;
        socket.send(JSON.stringify({ type: 'auth', token: payload.token, cols: terminal?.cols ?? 100, rows: terminal?.rows ?? 28 }));
      };
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') {
          terminalRef.current?.write(new Uint8Array(event.data as ArrayBuffer));
          return;
        }
        const message = JSON.parse(event.data) as { type: string; passed?: boolean; message?: string; scoreAwarded?: number; reason?: string };
        if (message.type === 'ready') {
          setStatus('ready');
          fitRef.current?.fit();
          sendResize();
        }
        if (message.type === 'check_result') {
          const passed = message.passed === true;
          passedRef.current = passed;
          scoreRef.current = message.scoreAwarded ?? 0;
          setCheckStatus(passed ? 'passed' : 'failed');
          terminalRef.current?.writeln(`\r\n\x1b[${passed ? '38;2;182;240;74' : '33'}m${passed ? '✓' : '○'} ${message.message ?? 'Проверка завершена.'}${message.scoreAwarded ? `  +${message.scoreAwarded}` : ''}\x1b[0m`);
        }
        if (message.type === 'closed' && !passedRef.current && message.reason !== 'challenge_completed') {
          terminalRef.current?.writeln(`\r\n\x1b[33mСессия завершена: ${message.reason ?? 'закрыта'}\x1b[0m`);
        }
      };
      socket.onerror = () => {
        setStatus('error');
        setError('Не удалось подключиться к игровому shell.');
      };
      socket.onclose = () => {
        socketRef.current = null;
        setStatus((current) => current === 'error' ? current : 'closed');
        if (passedRef.current) onCompleted(scoreRef.current);
      };
    } catch (startError) {
      setStatus('error');
      const message = startError instanceof Error ? startError.message : 'Ошибка запуска shell.';
      setError(message);
      terminalRef.current?.writeln(`\r\n\x1b[31m${message}\x1b[0m`);
    }
  }, [gameSessionId, onCompleted, sendResize, status]);

  const check = () => {
    if (socketRef.current?.readyState !== WebSocket.OPEN || checkStatus === 'checking') return;
    setCheckStatus('checking');
    socketRef.current.send(JSON.stringify({ type: 'check' }));
  };
  const stop = () => socketRef.current?.close(1000, 'user_stopped');
  const active = status === 'connecting' || status === 'ready';

  return (
    <div className="game-shell mt-8">
      {hint && <details className="challenge-hint px-4 pt-4 sm:px-5"><summary><Lightbulb size={13} /> Подсказка</summary><p>{hint}</p></details>}
      <div className="game-shell-host" ref={hostRef} />
      {error && <p className="play-error mx-4 mb-3 sm:mx-5" role="alert">{error}</p>}
      <div className="game-shell-actions">
        <span className="flex items-center gap-2 text-slate-500"><ShieldCheck size={14} className="text-acid" /> rootless · без сети · без доступа к хосту</span>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="secondary-button min-h-9 px-3 text-xs" onClick={onSkip} disabled={active}><SkipForward size={13} /> Пропустить</button>
          {status === 'ready' && <button type="button" className="terminal-action" onClick={check} disabled={checkStatus === 'checking' || checkStatus === 'passed'}>
            {checkStatus === 'checking' ? <LoaderCircle size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
            {checkStatus === 'checking' ? 'Проверяем…' : checkStatus === 'passed' ? 'Выполнено' : 'Проверить'}
          </button>}
          {active ? <button type="button" className="terminal-action terminal-action-stop" onClick={stop}><Square size={13} /> Завершить</button>
            : <button type="button" className="terminal-action" onClick={() => void start()}><Play size={13} /> {status === 'idle' ? 'Запустить shell' : 'Запустить снова'}</button>}
        </div>
      </div>
    </div>
  );
}
