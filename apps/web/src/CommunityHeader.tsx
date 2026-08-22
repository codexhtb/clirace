import { AuthControl } from './AuthControl';
import { primaryNavigation } from './product-ux';
import { Link, NavLink, useLocation } from 'react-router-dom';

export function CommunityHeader() {
  const { pathname: path, search } = useLocation();
  return (
    <header className="product-header relative z-20 border-b border-line/80">
      <div className="page-width flex min-h-16 items-center justify-between gap-4">
        <Link to="/" className="flex items-center gap-2.5" aria-label="Главная CLIRace">
          <span className="logo-mark"><span>&gt;_</span></span>
          <span className="font-mono text-sm font-bold tracking-[0.12em] text-white">CLIRACE</span>
        </Link>
        <nav className="product-nav" aria-label="Основная навигация">
          {primaryNavigation.map(({ href, label, matches }) => {
            const active = matches(path, search);
            return <NavLink className={`nav-link ${active ? 'nav-link-active' : ''}`} to={href} key={href} aria-current={active ? 'page' : undefined}>{label}</NavLink>;
          })}
        </nav>
        <AuthControl />
      </div>
      <nav className="mobile-nav page-width" aria-label="Мобильная навигация">
        {primaryNavigation.map(({ href, label, matches }) => {
          const active = matches(path, search);
          return <NavLink className={`nav-link ${active ? 'nav-link-active' : ''}`} to={href} key={href} aria-current={active ? 'page' : undefined}>{label}</NavLink>;
        })}
      </nav>
    </header>
  );
}
