import { AlertTriangle, ArrowRight, LoaderCircle, Terminal } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CommunityHeader } from './CommunityHeader';
import { secondaryNavigation } from './product-ux';

export function AppPage({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`min-h-screen bg-ink text-slate-200 ${className}`}>
      <div className="grid-noise pointer-events-none fixed inset-0" />
      <CommunityHeader />
      <main className="page-width relative z-10 py-10 sm:py-14 lg:py-16">{children}</main>
      <footer className="relative z-10 border-t border-line">
        <div className="page-width flex flex-col gap-2 py-6 text-xs text-slate-600 sm:flex-row sm:items-center sm:justify-between">
          <span className="font-mono font-semibold tracking-[0.12em] text-slate-400">CLIRACE</span>
          <nav className="footer-links" aria-label="Дополнительные разделы">{secondaryNavigation.map((item) => <Link to={item.href} key={item.href}>{item.label}</Link>)}</nav>
        </div>
      </footer>
    </div>
  );
}

export function PageLoader({ label }: { label: string }) {
  return (
    <div className="flex min-h-48 items-center justify-center py-16" role="status" aria-live="polite">
      <div className="flex items-center gap-3 font-mono text-xs text-slate-500">
        <LoaderCircle className="animate-spin text-acid" size={17} /> {label}
      </div>
    </div>
  );
}

export function ErrorState({ title = 'Что-то пошло не так', message, retryHref }: {
  title?: string; message?: string; retryHref?: string;
}) {
  return (
    <section className="state-panel" role="alert">
      <AlertTriangle size={24} className="text-amber-300" />
      <div>
        <h1>{title}</h1>
        <p>{message ?? 'Попробуйте ещё раз через несколько секунд.'}</p>
      </div>
      <Link className="secondary-button" to={retryHref ?? window.location.pathname}>Повторить <ArrowRight size={14} /></Link>
    </section>
  );
}

export function EmptyState({ title, text, action }: {
  title: string; text: string; action?: { href: string; label: string };
}) {
  return (
    <section className="state-panel state-panel-compact">
      <Terminal size={22} className="text-acid" />
      <div><h2>{title}</h2><p>{text}</p></div>
      {action && <Link className="secondary-button" to={action.href}>{action.label} <ArrowRight size={14} /></Link>}
    </section>
  );
}
