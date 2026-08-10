import { LogOut, UserRound, X } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

interface AuthUser {
  id: string;
  username: string;
  email: string;
  createdAt: string;
}

type AuthMode = 'login' | 'register';

export function AuthControl() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(() => new URLSearchParams(window.location.search).get('auth') === '1');
  const [mode, setMode] = useState<AuthMode>('login');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/auth/me', { signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('auth unavailable')))
      .then((payload: { user: AuthUser | null }) => setUser(payload.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
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
      setOpen(false);
      const returnTo = new URLSearchParams(window.location.search).get('returnTo');
      if (returnTo?.startsWith('/') && !returnTo.startsWith('//')) window.location.assign(returnTo);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Ошибка авторизации.');
    } finally {
      setSubmitting(false);
    }
  };

  const logout = async () => {
    const response = await fetch('/api/auth/logout', { method: 'POST' });
    if (response.ok) setUser(null);
  };

  if (loading) return <div className="h-8 w-24 animate-pulse rounded border border-line bg-white/[0.03]" />;

  return (
    <>
      {user ? (
        <div className="flex items-center gap-2">
          <a className="hidden font-mono text-[11px] text-slate-300 transition-colors hover:text-acid sm:inline" href={`/profile/${encodeURIComponent(user.username)}`}>@{user.username}</a>
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
          <section className="auth-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-title">
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

            <div className="mt-6 grid grid-cols-2 border-b border-line">
              {(['login', 'register'] as const).map((value) => (
                <button
                  type="button"
                  key={value}
                  className={`auth-tab ${mode === value ? 'auth-tab-active' : ''}`}
                  onClick={() => { setMode(value); setError(null); }}
                >
                  {value === 'login' ? 'Вход' : 'Регистрация'}
                </button>
              ))}
            </div>

            <form className="mt-6 space-y-4" onSubmit={(event) => void submit(event)}>
              {mode === 'register' && (
                <label className="auth-field">
                  <span>Имя пользователя</span>
                  <input name="username" autoComplete="username" required minLength={3} maxLength={24} pattern="[A-Za-z0-9][A-Za-z0-9_-]*" placeholder="terminal_runner" />
                </label>
              )}
              <label className="auth-field">
                <span>{mode === 'login' ? 'Имя или email' : 'Email'}</span>
                <input
                  name={mode === 'login' ? 'identifier' : 'email'}
                  type={mode === 'login' ? 'text' : 'email'}
                  autoComplete={mode === 'login' ? 'username' : 'email'}
                  required
                  placeholder={mode === 'login' ? 'terminal_runner' : 'you@example.com'}
                />
              </label>
              <label className="auth-field">
                <span>Пароль</span>
                <input name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={mode === 'register' ? 10 : 1} maxLength={128} placeholder="••••••••••" />
              </label>
              {error && <p className="auth-error" role="alert">{error}</p>}
              <button type="submit" className="primary-button w-full justify-center" disabled={submitting}>
                {submitting ? 'Проверяем…' : mode === 'login' ? 'Войти' : 'Создать аккаунт'}
              </button>
            </form>
            <p className="mt-4 text-center text-[11px] leading-5 text-slate-600">
              Сессия хранится в защищённой HttpOnly cookie. Пароль никогда не сохраняется в открытом виде.
            </p>
          </section>
        </div>
      ), document.body)}
    </>
  );
}
