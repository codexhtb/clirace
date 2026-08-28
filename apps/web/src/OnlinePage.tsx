import { ArrowRight, LoaderCircle, Radar, ShieldCheck, Swords, Trophy, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { currentUser } from './auth-client';
import { CommunityHeader } from './CommunityHeader';
import { consumeQuickMatchIntent, hasQuickMatchIntent, onlineModeFromSearch, type OnlineMode } from './flow-intents';
import { QuickMatchPanel } from './QuickMatchPanel';
import { RankedMatchPanel } from './RankedMatchPanel';

export function OnlinePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const quickIntent = hasQuickMatchIntent(location.search);
  const explicitMode = new URLSearchParams(location.search).has('mode') || quickIntent;
  const [auth, setAuth] = useState<'loading' | 'guest' | 'ready'>('loading');
  const [mode, setMode] = useState<OnlineMode>(() => onlineModeFromSearch(location.search));
  const [modeReady, setModeReady] = useState(explicitMode);

  useEffect(() => {
    setMode(onlineModeFromSearch(location.search));
    if (explicitMode) setModeReady(true);
  }, [explicitMode, location.search]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    currentUser().then(async ({ user }) => {
      if (!active) return;
      if (!user) {
        setAuth('guest');
        setModeReady(true);
        return;
      }
      setAuth('ready');
      if (explicitMode) return;
      try {
        const response = await fetch('/api/matchmaking/status?mode=quick', { cache: 'no-store', signal: controller.signal });
        const payload = response.ok ? await response.json() as { pool?: OnlineMode } : null;
        if (active && payload?.pool === 'ranked') setMode('ranked');
      } catch (reason) {
        if (reason instanceof DOMException && reason.name === 'AbortError') return;
      } finally {
        if (active) setModeReady(true);
      }
    }).catch((reason: unknown) => {
      if (!active || (reason instanceof DOMException && reason.name === 'AbortError')) return;
      setAuth('guest');
      setModeReady(true);
    });
    return () => { active = false; controller.abort(); };
  }, [explicitMode]);

  const selectMode = (next: OnlineMode) => {
    setMode(next);
    navigate(next === 'ranked' ? '/online?mode=ranked' : '/online');
  };

  return (
    <div className="online-page min-h-screen bg-ink text-slate-200">
      <div className="grid-noise fixed inset-0 pointer-events-none" />
      <CommunityHeader />
      <main className="page-width relative z-10 py-10 sm:py-16">
        <section className="online-hero">
          <div>
            <p className="eyebrow">ONLINE PvP</p>
            <h1>Сетевые матчи CLIRace.</h1>
            <p>Играйте против живых соперников: быстрый матч без MMR, рейтинговая очередь или приватная комната для друга.</p>
          </div>
          <div className="online-hero-mark" aria-hidden="true"><Swords size={30} /><span>VS</span></div>
        </section>

        {auth === 'loading' || !modeReady ? (
          <section className="matchmaking-panel matchmaking-loading mt-9"><LoaderCircle className="animate-spin" size={18} /> Проверяем состояние матчей…</section>
        ) : auth === 'guest' ? (
          <GuestOnline />
        ) : (
          <>
            <nav className="online-mode-nav mt-9" aria-label="Режим онлайн-матча">
              <button className={mode === 'quick' ? 'online-mode-active' : ''} type="button" aria-pressed={mode === 'quick'} onClick={() => selectMode('quick')}>
                <Radar size={19} /><span><strong>Quick Match</strong><small>быстрый матч · без MMR</small></span>
              </button>
              <button className={mode === 'ranked' ? 'online-mode-active' : ''} type="button" aria-pressed={mode === 'ranked'} onClick={() => selectMode('ranked')}>
                <Trophy size={19} /><span><strong>Ranked</strong><small>влияет на MMR и дивизион</small></span>
              </button>
              <Link to="/battle"><Users size={19} /><span><strong>Игра с другом</strong><small>создать матч или ввести код</small></span><ArrowRight size={15} /></Link>
            </nav>

            <div className="mt-4">
              {mode === 'quick' ? (
                <QuickMatchPanel
                  autoEnqueue={quickIntent}
                  onIntentConsumed={() => navigate({ pathname: '/online', search: consumeQuickMatchIntent(location.search) }, { replace: true })}
                />
              ) : <RankedMatchPanel />}
            </div>

            <section className="online-private mt-5">
              <div><ShieldCheck size={18} /><span><strong>Private Battle</strong><small>Создайте приватный матч или присоединитесь по коду приглашения.</small></span></div>
              <Link className="secondary-button" to="/battle">Создать матч или ввести код <ArrowRight size={15} /></Link>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function GuestOnline() {
  const quickReturn = encodeURIComponent('/online?match=quick');
  const rankedReturn = encodeURIComponent('/online?mode=ranked');
  return (
    <section className="online-guest mt-9">
      <div className="matchmaking-radar"><Swords size={28} /></div>
      <div>
        <p className="eyebrow">Quick Match</p>
        <h2>Найдите соперника сразу после входа.</h2>
        <p>Авторизуйтесь — явный Quick Match intent сохранится, и поиск начнётся автоматически без второго нажатия.</p>
      </div>
      <Link className="primary-button" to={`/?auth=1&returnTo=${quickReturn}`}><Radar size={16} /> Найти соперника</Link>
      <div className="online-guest-secondary">
        <Link to={`/?auth=1&returnTo=${rankedReturn}`}><Trophy size={15} /> Ranked после входа</Link>
        <Link to="/battle"><Users size={15} /> Игра с другом</Link>
      </div>
    </section>
  );
}
