import { LogOut, ShieldCheck, UserRound, X } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { currentUser, rememberCurrentUser, type CurrentUser } from './auth-client';
import { humanizeError } from './errors';
import { Link, useLocation, useNavigate } from 'react-router-dom';

type AuthUser = CurrentUser;

type AuthMode = 'login' | 'register';

export function AuthControl() {
  const location = useLocation();
  const navigate = useNavigate();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(() => new URLSearchParams(location.search).get('auth') === '1' || ['/login', '/register'].includes(location.pathname));
  const [mode, setMode] = useState<AuthMode>(() => location.pathname === '/register' ? 'register' : 'login');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let active = true;
    currentUser().then((payload) => { if (active) setUser(payload.user); }).catch(() => { if (active) setUser(null); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (new URLSearchParams(location.search).get('auth') === '1' || ['/login', '/register'].includes(location.pathname)) {
      setMode(location.pathname === '/register' ? 'register' : 'login');
      setOpen(true);
    }
  }, [location.pathname, location.search]);

  useEffect(() => {
    if (!open) return;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href], select:not([disabled])'));
      const first = focusable[0]; const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      returnFocus?.focus();
    };
  }, [open]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    const body = mode === 'login'
      ? { identifier: data.get('identifier'), password: data.get('password') }
      : { username: data.get('username'), email: data.get('email'), password: data.get('password') };

    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null) as { user?: AuthUser; message?: string } | null;
      if (!response.ok || !payload?.user) throw new Error(payload?.message ?? 'Не удалось выполнить вход.');
      setUser(payload.user);
      rememberCurrentUser(payload.user);
      setOpen(false);
      const returnTo = new URLSearchParams(location.search).get('returnTo');
      if (returnTo?.startsWith('/') && !returnTo.startsWith('//')) navigate(returnTo);
    } catch (submitError) {
      setError(humanizeError(submitError, 'Не удалось выполнить вход. Попробуйте ещё раз.'));
    } finally {
      setSubmitting(false);
    }
  };

  const logout = async () => {
    const response = await fetch('/api/auth/logout', { method: 'POST' });
    if (response.ok) { setUser(null); rememberCurrentUser(null); }
  };

  if (loading) return <div className="h-8 w-24 animate-pulse rounded border border-line bg-white/[0.03]" />;

  return (
    <>
      {user ? (
        <div className="flex items-center gap-2">
          {user.role === 'admin' && <Link className="header-action" to="/admin"><ShieldCheck size={14} /><span className="hidden lg:inline">Admin</span></Link>}
          <Link className="hidden font-mono text-[11px] text-slate-300 transition-colors hover:text-acid sm:inline" to={`/profile/${encodeURIComponent(user.username)}`}>@{user.username}</Link>
          <button type="button" className="header-action" onClick={() => void logout()} aria-label="Выйти">
            <LogOut size={14} /> <span className="hidden sm:inline">Выйти</span>
          </button>
        </div>
      ) : (
        <button type="button" className="header-action" onClick={() => setOpen(true)}>
          <UserRound size={14} /> Войти
        </button>
      )}

      {open && createPortal((
        <div className="auth-overlay" role="presentation" onMouseDown={(event) => {
          if (event.currentTarget === event.target) setOpen(false);
        }}>
          <section ref={dialogRef} className="auth-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-title" aria-describedby="auth-description">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="eyebrow">Аккаунт CLIRace</p>
                <h2 id="auth-title" className="mt-2 text-2xl font-semibold text-white">
                  {mode === 'login' ? 'Продолжить тренировку' : 'Создать профиль'}
                </h2>
              </div>
              <button type="button" className="icon-button" onClick={() => setOpen(false)} aria-label="Закрыть">
                <X size={17} />
              </button>
            </div>

            <div className="mt-6 grid grid-cols-2 border-b border-line" role="tablist" aria-label="Режим авторизации">
              {(['login', 'register'] as const).map((value) => (
                <button
                  type="button"
                  key={value}
                  role="tab"
                  aria-selected={mode === value}
                  className={`auth-tab ${mode === value ? 'auth-tab-active' : ''}`}
                  onClick={() => { setMode(value); setError(null); }}
                >
                  {value === 'login' ? 'Вход' : 'Регистрация'}
                </button>
              ))}
            </div>

            <form className="mt-6 space-y-4" onSubmit={(event) => void submit(event)} aria-busy={submitting}>
              {mode === 'register' && (
                <label className="auth-field">
                  <span>Имя пользователя</span>
                  <input name="username" autoComplete="username" autoFocus required minLength={3} maxLength={24} pattern="[A-Za-z0-9][A-Za-z0-9_-]*" placeholder="terminal_runner" />
                </label>
              )}
              <label className="auth-field">
                <span>{mode === 'login' ? 'Имя или email' : 'Email'}</span>
                <input
                  name={mode === 'login' ? 'identifier' : 'email'}
                  type={mode === 'login' ? 'text' : 'email'}
                  autoComplete={mode === 'login' ? 'username' : 'email'}
                  required
                  autoFocus={mode === 'login'}
                  placeholder={mode === 'login' ? 'terminal_runner' : 'you@example.com'}
                />
              </label>
              <label className="auth-field">
                <span>Пароль</span>
                <input name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={mode === 'register' ? 10 : 1} maxLength={128} placeholder="••••••••••" />
              </label>
              {mode === 'register' && <p className="-mt-2 text-[11px] leading-5 text-slate-600">Минимум 10 символов. Используйте уникальный пароль.</p>}
              {error && <p className="auth-error" role="alert">{error}</p>}
              <button type="submit" className="primary-button w-full justify-center" disabled={submitting}>
                {submitting ? 'Проверяем…' : mode === 'login' ? 'Войти' : 'Создать аккаунт'}
              </button>
            </form>
            <p id="auth-description" className="mt-4 text-center text-[11px] leading-5 text-slate-600">
              Сессия хранится в защищённой HttpOnly cookie. Пароль никогда не сохраняется в открытом виде.
            </p>
          </section>
        </div>
      ), document.body)}
    </>
  );
}
