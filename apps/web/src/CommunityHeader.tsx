import { AuthControl } from './AuthControl';

export function CommunityHeader() {
  const path = window.location.pathname;
  const links = [
    ['/play', 'Играть'],
    ['/interview', 'Interview 100'],
    ['/daily', 'Daily'],
    ['/leaderboard', 'Рейтинг'],
    ['/battle', 'Battle'],
  ];
  return (
    <header className="product-header relative z-20 border-b border-line/80">
      <div className="page-width flex min-h-16 items-center justify-between gap-4">
        <a href="/" className="flex items-center gap-2.5" aria-label="Главная CLIRace">
          <span className="logo-mark"><span>&gt;_</span></span>
          <span className="font-mono text-sm font-bold tracking-[0.12em] text-white">CLIRACE</span>
        </a>
        <nav className="product-nav" aria-label="Основная навигация">
          {links.map(([href, label]) => {
            const active = path === href || (href === '/battle' && path.startsWith('/battle/'));
            return <a className={`nav-link ${active ? 'nav-link-active' : ''}`} href={href} key={href} aria-current={active ? 'page' : undefined}>{label}</a>;
          })}
        </nav>
        <AuthControl />
      </div>
      <nav className="mobile-nav page-width" aria-label="Мобильная навигация">
        {links.map(([href, label]) => {
          const active = path === href || (href === '/battle' && path.startsWith('/battle/'));
          return <a className={`nav-link ${active ? 'nav-link-active' : ''}`} href={href} key={href} aria-current={active ? 'page' : undefined}>{label}</a>;
        })}
      </nav>
    </header>
  );
}
