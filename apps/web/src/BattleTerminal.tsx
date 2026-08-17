import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { CheckCircle2, LoaderCircle, ShieldCheck, Wifi, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { humanizeError } from './errors';

interface SessionTicket {
  sessionId: string;
  token: string;
  websocketPath: string;
}

type TerminalStatus = 'connecting' | 'ready' | 'reconnecting' | 'error' | 'closed';

export function BattleTerminal({ roomCode, round, locked }: {
  roomCode: string;
  round: number;
  locked: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const lockedRef = useRef(locked);
  const mountedRef = useRef(true);
  const [status, setStatus] = useState<TerminalStatus>('connecting');
  const [checking, setChecking] = useState(false);
  const [passed, setPassed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { lockedRef.current = locked; }, [locked]);

  const sendResize = useCallback(() => {
    const terminal = terminalRef.current;
    const socket = socketRef.current;
    if (terminal && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
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
        background: '#05080b', foreground: '#d8e0ea', cursor: '#b6f04a', cursorAccent: '#10150a',
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
    terminal.writeln(`\x1b[38;2;182;240;74mCLIRace Battle · round ${round}\x1b[0m`);
    terminal.writeln('\x1b[90mПодготавливаем ваш отдельный rootless sandbox…\x1b[0m\r\n');
    terminalRef.current = terminal;
    fitRef.current = fit;

    const input = terminal.onData((data) => {
      if (!lockedRef.current && socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: 'input', data }));
      }
    });
    const observer = new ResizeObserver(() => {
      try { fit.fit(); sendResize(); } catch { /* terminal is being disposed */ }
    });
    observer.observe(host);
    void connectTerminal(roomCode, terminal, fit, socketRef, lockedRef, mountedRef, {
      setStatus, setChecking, setPassed, setError, sendResize,
    });

    return () => {
      mountedRef.current = false;
      observer.disconnect();
      input.dispose();
      socketRef.current?.close(1000, 'page_unmounted');
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [roomCode, round, sendResize]);

  const check = () => {
    if (checking || passed || lockedRef.current || socketRef.current?.readyState !== WebSocket.OPEN) return;
    setChecking(true);
    socketRef.current.send(JSON.stringify({ type: 'check' }));
  };

  return (
    <div className="battle-terminal-frame">
      <div className="battle-terminal-status">
        <span className="flex items-center gap-2">
          {status === 'ready' ? <Wifi size={13} className="text-acid" /> : status === 'error' ? <WifiOff size={13} className="text-rose-300" /> : <LoaderCircle size={13} className="animate-spin text-cyan" />}
          {terminalStatusLabel(status)}
        </span>
        <span>round/{round}</span>
      </div>
      <div className="battle-terminal-host" ref={hostRef} />
      {locked && status === 'ready' && (
      <div className="battle-terminal-lock"><strong>ТЕРМИНАЛ ЗАБЛОКИРОВАН</strong><span>Ждём общий серверный старт</span></div>
      )}
      <div className="battle-terminal-actions">
        <span><ShieldCheck size={13} className="text-acid" /> отдельный sandbox · ввод сопернику не виден</span>
        <button className="terminal-action" type="button" onClick={check} disabled={checking || passed || locked || status !== 'ready'}>
          {checking ? <LoaderCircle size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
          {passed ? 'Раунд выполнен' : checking ? 'Проверяем…' : 'Проверить'}
        </button>
      </div>
      {error && <p className="play-error m-3" role="alert">{error}</p>}
    </div>
  );
}

async function connectTerminal(
  roomCode: string,
  terminal: Terminal,
  fit: FitAddon,
  socketRef: React.MutableRefObject<WebSocket | null>,
  lockedRef: React.MutableRefObject<boolean>,
  mountedRef: React.MutableRefObject<boolean>,
  actions: {
    setStatus: (value: TerminalStatus) => void;
    setChecking: (value: boolean) => void;
    setPassed: (value: boolean) => void;
    setError: (value: string | null) => void;
    sendResize: () => void;
  },
) {
  actions.setStatus('connecting');
  actions.setError(null);
  let ticket: SessionTicket | undefined;
  for (let attempt = 0; attempt < 16 && mountedRef.current; attempt += 1) {
    const response = await fetch(`/api/battles/${roomCode}/terminal`, { method: 'POST' });
    const payload = await response.json().catch(() => null) as (SessionTicket & { message?: string }) | null;
    if (response.ok && payload?.token) { ticket = payload; break; }
    if (response.status === 409 && attempt < 15) {
      actions.setStatus('reconnecting');
      await new Promise((resolve) => window.setTimeout(resolve, 350));
      continue;
    }
    actions.setStatus('error');
    actions.setError(humanizeError(payload?.message, 'Shell временно недоступен. Попробуйте снова через несколько секунд.'));
    return;
  }
  if (!ticket || !mountedRef.current) return;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${window.location.host}${ticket.websocketPath}`);
  socket.binaryType = 'arraybuffer';
  socketRef.current = socket;
  socket.onopen = () => {
    socket.send(JSON.stringify({ type: 'auth', token: ticket.token, cols: terminal.cols, rows: terminal.rows }));
  };
  socket.onmessage = (event) => {
    if (typeof event.data !== 'string') {
      terminal.write(new Uint8Array(event.data as ArrayBuffer));
      return;
    }
    const message = JSON.parse(event.data) as {
      type: string; inputLocked?: boolean; reconnected?: boolean;
      passed?: boolean; message?: string; reason?: string;
    };
    if (message.type === 'ready') {
      lockedRef.current = message.inputLocked === true;
      actions.setStatus('ready');
      terminal.writeln(message.reconnected ? '\x1b[36mСессия восстановлена.\x1b[0m\r\n' : '\x1b[36mОкружение готово.\x1b[0m\r\n');
      fit.fit();
      actions.sendResize();
    } else if (message.type === 'battle_unlocked') {
      lockedRef.current = false;
      terminal.writeln('\r\n\x1b[38;2;182;240;74mGO — терминал разблокирован.\x1b[0m');
      terminal.focus();
    } else if (message.type === 'check_result') {
      actions.setChecking(false);
      actions.setPassed(message.passed === true);
      const feedback = message.passed ? (message.message ?? 'Раунд выполнен.') : 'Пока не выполнено. Состояние песочницы ещё не соответствует условию.';
      terminal.writeln(`\r\n\x1b[${message.passed ? '38;2;182;240;74' : '33'}m${message.passed ? '✓' : '○'} ${feedback}\x1b[0m`);
    } else if (message.type === 'closed' && message.reason !== 'challenge_completed') {
      terminal.writeln(`\r\n\x1b[33mСессия закрыта: ${message.reason ?? 'завершена'}\x1b[0m`);
    }
  };
  socket.onerror = () => {
    if (!mountedRef.current) return;
    actions.setStatus('error');
    actions.setError('Соединение с Battle terminal потеряно. Обновите страницу — текущий sandbox сохранён 60 секунд.');
  };
  socket.onclose = () => {
    if (!mountedRef.current) return;
    socketRef.current = null;
    actions.setStatus('closed');
  };
}

function terminalStatusLabel(status: TerminalStatus) {
  return ({
    connecting: 'создаём окружение',
    ready: 'терминал подключён',
    reconnecting: 'ждём предыдущий раунд',
    error: 'shell недоступен',
    closed: 'сессия завершена',
  } as const)[status];
}
