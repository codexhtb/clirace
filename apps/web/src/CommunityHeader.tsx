import { AuthControl } from './AuthControl';

export function CommunityHeader() {
  return (
    <header className="relative z-10 border-b border-line/80">
      <div className="page-width flex h-16 items-center justify-between gap-4">
        <a href="/" className="flex items-center gap-2.5" aria-label="Главная CLIRace">
          <span className="logo-mark"><span>&gt;_</span></span>
          <span className="font-mono text-sm font-bold tracking-[0.12em] text-white">CLIRACE</span>
        </a>
        <nav className="hidden items-center gap-6 text-xs font-medium text-slate-400 sm:flex" aria-label="Навигация">
          <a className="nav-link" href="/play">Играть</a>
          <a className="nav-link" href="/daily">Daily</a>
          <a className="nav-link" href="/interview">Interview 100</a>
          <a className="nav-link" href="/battle">Battle</a>
          <a className="nav-link" href="/leaderboard">Рейтинг</a>
        </nav>
        <AuthControl />
      </div>
    </header>
  );
}
