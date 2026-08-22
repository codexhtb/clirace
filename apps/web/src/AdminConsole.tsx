import {
  Activity, Ban, Boxes, CheckCircle2, ClipboardList, Database, Gauge, ListChecks,
  LoaderCircle, LogOut, RefreshCw, Search, Server, ShieldAlert, ShieldCheck, Swords,
  UserCog, Users, XCircle,
} from 'lucide-react';
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { currentUser } from './auth-client';

interface AdminUser {
  id: string;
  username: string;
  email: string;
  role: 'user' | 'admin';
  accountStatus: 'active' | 'suspended';
}

interface PagePayload {
  items: Array<Record<string, unknown>>;
  page: number;
  limit: number;
  total: number;
  pages: number;
}

interface OverviewPayload {
  dependencies: { api: 'up' | 'down'; postgres: 'up' | 'down'; redis: 'up' | 'down' };
  sandbox: {
    platform: {
      enabled: boolean; healthy: boolean; code: string;
      capacity: { maxCapacity: number; perUserCapacity: number; running: number; starting: number; available: number; failed: number };
      runtime: { socketPath: string; image: string; rootless: boolean };
      warmPool: { configured: number; ready: number; enabled: boolean };
    };
    metrics: { failedTotal: number; cleanupTotal: number; orphanTotal: number; createP50Seconds: number; createP95Seconds: number; createCount: number };
    lifecycleCounts: Record<string, number>;
  };
  product: Record<string, number>;
  matchmaking: {
    queueDepth: number; oldestWaitSeconds: number; enqueuedTotal: number; matchedTotal: number;
    cancelledTotal: number; expiredTotal: number; failedTotal: number;
    waitP50Seconds: number; waitP95Seconds: number;
  };
  ranked: {
    matchmaking: OverviewPayload['matchmaking'];
    matchesToday: number;
    noContestToday: number;
    averageMmr: number;
  };
  integrity: Record<string, unknown> | null;
  generatedAt: string;
}

type Section = 'overview' | 'users' | 'sandboxes' | 'challenges' | 'battles' | 'audit';

const nav: Array<{ key: Section; label: string; icon: typeof Gauge }> = [
  { key: 'overview', label: 'Обзор', icon: Gauge },
  { key: 'users', label: 'Пользователи', icon: Users },
  { key: 'sandboxes', label: 'Песочницы', icon: Boxes },
  { key: 'challenges', label: 'Задания', icon: ListChecks },
  { key: 'battles', label: 'Battles', icon: Swords },
  { key: 'audit', label: 'Audit log', icon: ClipboardList },
];

export function AdminConsole() {
  const [user, setUser] = useState<AdminUser | null | undefined>(undefined);
  const [authStatus, setAuthStatus] = useState(200);
  const section = currentSection();

  useEffect(() => {
    const existing = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const meta = existing ?? document.head.appendChild(document.createElement('meta'));
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    return () => { if (!existing) meta.remove(); };
  }, []);

  useEffect(() => {
    let active = true;
    currentUser().then((payload) => {
      if (!active) return;
      setAuthStatus(200);
      setUser(payload.user as AdminUser | null);
    }).catch(() => { if (active) { setAuthStatus(503); setUser(null); } });
    return () => { active = false; };
  }, []);

  if (user === undefined) return <AdminState icon={<LoaderCircle className="animate-spin" />} title="Проверяем доступ" />;
  if (!user) return <AdminState icon={<ShieldAlert />} title="Нужна авторизация" detail={authStatus === 503 ? 'Сервис авторизации временно недоступен.' : 'Войдите в аккаунт администратора.'} action={<a className="primary-button" href={`/?auth=1&returnTo=${encodeURIComponent(window.location.pathname)}`}>Войти</a>} />;
  if (user.role !== 'admin') return <AdminState icon={<Ban />} title="Доступ запрещён" detail="Operations Console доступна только пользователям с ролью admin." action={<a className="secondary-button" href="/">Вернуться на сайт</a>} />;

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <div className="admin-brand"><span>CR</span><div><strong>OPERATIONS</strong><small>production console</small></div></div>
        <nav className="admin-nav" aria-label="Разделы Operations Console">
          {nav.map(({ key, label, icon: Icon }) => <a key={key} className={section === key ? 'active' : ''} href={key === 'overview' ? '/admin' : `/admin/${key}`}><Icon size={15} />{label}</a>)}
        </nav>
        <div className="admin-identity"><ShieldCheck size={15} /><div><strong>@{user.username}</strong><small>administrator</small></div></div>
      </aside>
      <main className="admin-main">
        <header className="admin-topbar">
          <div><p>CLIRACE / ADMIN</p><h1>{nav.find((item) => item.key === section)?.label}</h1></div>
          <div className="flex items-center gap-2"><span className="admin-live"><i /> LIVE</span><a className="admin-icon-link" href="/" title="Вернуться на сайт"><LogOut size={15} /></a></div>
        </header>
        {section === 'overview' ? <Overview /> : <Collection section={section} />}
      </main>
    </div>
  );
}

function Overview() {
  const { data, error, loading, reload } = useResource<OverviewPayload>('/api/admin/overview');
  if (loading && !data) return <LoadingPanel />;
  if (error || !data) return <ErrorPanel message={error ?? 'Не удалось загрузить обзор.'} retry={reload} />;
  const p = data.product;
  return (
    <div className="admin-content space-y-6">
      <section>
        <AdminHeading title="Состояние платформы" detail={`Снимок ${formatDate(data.generatedAt)}`} />
        <div className="admin-health-grid">
          <HealthTile label="Fastify API" ok={data.dependencies.api === 'up'} detail={data.dependencies.api} icon={<Activity />} />
          <HealthTile label="PostgreSQL" ok={data.dependencies.postgres === 'up'} detail={data.dependencies.postgres} icon={<Database />} />
          <HealthTile label="Redis" ok={data.dependencies.redis === 'up'} detail={data.dependencies.redis} icon={<Database />} />
          <HealthTile label="Sandbox runtime" ok={data.sandbox.platform.healthy} detail={data.sandbox.platform.code} icon={<Server />} />
          <HealthTile label="Rootless" ok={data.sandbox.platform.runtime.rootless} detail={data.sandbox.platform.runtime.image} icon={<ShieldCheck />} />
        </div>
      </section>
      <section>
        <AdminHeading title="Продукт" detail="Реальные агрегаты из production-базы" />
        <div className="admin-stat-grid">
          <Stat label="Пользователей" value={p.users_total} hint={`+${p.users_24h ?? 0} за 24 ч`} />
          <Stat label="Новых за 7 дней" value={p.users_7d} hint={`${p.users_30d ?? 0} за 30 дней`} />
          <Stat label="Входов за 24 ч" value={p.logins_24h} />
          <Stat label="Активных игр" value={p.active_games} />
          <Stat label="Активных shell" value={p.active_sandboxes} />
          <Stat label="Battles сегодня" value={p.battles_today} />
          <Stat label="Решений сегодня" value={p.challenges_today} />
        </div>
      </section>
      <section>
        <AdminHeading title="Matchmaking" detail="Quick Match · Redis queue · без пользовательских labels" />
        <div className="admin-stat-grid">
          <Stat label="В очереди" value={data.matchmaking.queueDepth} hint={`старейший ${data.matchmaking.oldestWaitSeconds.toFixed(0)} с`} />
          <Stat label="Матчей сегодня" value={p.matchmaking_today} />
          <Stat label="P50 ожидания" value={`${data.matchmaking.waitP50Seconds.toFixed(1)} с`} />
          <Stat label="P95 ожидания" value={`${data.matchmaking.waitP95Seconds.toFixed(1)} с`} />
          <Stat label="Истекло" value={data.matchmaking.expiredTotal} />
          <Stat label="Ошибок pairing" value={data.matchmaking.failedTotal} />
        </div>
      </section>
      <section>
        <AdminHeading title="Ranked" detail="Read-only MMR operations snapshot" />
        <div className="admin-stat-grid">
          <Stat label="Ranked в очереди" value={data.ranked.matchmaking.queueDepth} hint={`старейший ${data.ranked.matchmaking.oldestWaitSeconds.toFixed(0)} с`} />
          <Stat label="Ranked сегодня" value={data.ranked.matchesToday} />
          <Stat label="Средний MMR" value={data.ranked.averageMmr} />
          <Stat label="No contest" value={data.ranked.noContestToday} />
        </div>
      </section>
      <section>
        <AdminHeading title="Learning Paths" detail="Read-only progression snapshot" />
        <div className="admin-stat-grid">
          <Stat label="Активных учеников" value={p.learning_active} />
          <Stat label="Стартов курса" value={p.learning_course_starts} />
          <Stat label="Завершений" value={p.learning_course_completions} />
          <Stat label="Средний итог" value={`${p.learning_average_score ?? 0}%`} />
          <Stat label="Модулей завершено" value={`${p.learning_module_completion_rate ?? 0}%`} />
        </div>
      </section>
      <section className="grid gap-5 xl:grid-cols-2">
        <div className="admin-panel">
          <AdminHeading title="Sandbox capacity" detail={`${data.sandbox.platform.capacity.running} запущено · ${data.sandbox.platform.capacity.starting} запускается`} />
          <div className="admin-capacity"><div style={{ width: `${Math.min(100, ((data.sandbox.platform.capacity.running + data.sandbox.platform.capacity.starting) / data.sandbox.platform.capacity.maxCapacity) * 100)}%` }} /></div>
          <div className="mt-4 grid grid-cols-3 gap-3"><Mini label="Доступно" value={data.sandbox.platform.capacity.available} /><Mini label="Лимит" value={data.sandbox.platform.capacity.maxCapacity} /><Mini label="На пользователя" value={data.sandbox.platform.capacity.perUserCapacity} /></div>
          <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5">{['starting', 'ready', 'attached', 'idle', 'terminating'].map((state) => <Mini key={state} label={state} value={data.sandbox.lifecycleCounts[state] ?? 0} />)}</div>
          <dl className="admin-kv mt-5"><div><dt>Socket</dt><dd>{data.sandbox.platform.runtime.socketPath}</dd></div><div><dt>Image</dt><dd>{data.sandbox.platform.runtime.image}</dd></div><div><dt>P95 startup</dt><dd>{data.sandbox.metrics.createP95Seconds.toFixed(2)} s</dd></div></dl>
          <div className="mt-3 grid grid-cols-4 gap-2"><Mini label="Failures" value={data.sandbox.metrics.failedTotal} /><Mini label="Orphans" value={data.sandbox.metrics.orphanTotal} /><Mini label="Cleanup" value={data.sandbox.metrics.cleanupTotal} /><Mini label="Warm ready" value={data.sandbox.platform.warmPool.ready} /></div>
        </div>
        <div className="admin-panel">
          <AdminHeading title="Integrity" detail="Последний полный прогон real shell" />
          {data.integrity ? <>
            <div className={`admin-integrity ${Number(data.integrity.failed) === 0 ? 'ok' : 'bad'}`}>{Number(data.integrity.failed) === 0 ? <CheckCircle2 /> : <XCircle />}<div><strong>{String(data.integrity.passed)} / {String(data.integrity.total)}</strong><span>{Number(data.integrity.failed) === 0 ? 'Все проверки пройдены' : `Ошибок: ${String(data.integrity.failed)}`}</span></div></div>
            <dl className="admin-kv mt-5"><div><dt>Источник</dt><dd>{String(data.integrity.source)}</dd></div><div><dt>Время</dt><dd>{formatDate(data.integrity.created_at)}</dd></div><div><dt>Длительность</dt><dd>{String(data.integrity.duration_ms)} ms</dd></div></dl>
          </> : <p className="admin-empty">Прогон integrity ещё не зарегистрирован.</p>}
        </div>
      </section>
    </div>
  );
}

function Collection({ section }: { section: Exclude<Section, 'overview'> }) {
  const query = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('page')) params.set('page', '1');
    if (!params.has('limit')) params.set('limit', '25');
    return params.toString();
  }, [section]);
  const { data, error, loading, reload } = useResource<PagePayload>(`/api/admin/${section}?${query}`, section === 'sandboxes' ? 4_000 : 0);
  const [pendingAction, setPendingAction] = useState<ActionRequest | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const execute = async () => {
    if (!pendingAction) return;
    setActionError(null);
    try {
      await requestJson(pendingAction.url, { method: 'POST' });
      setPendingAction(null);
      reload();
    } catch (actionFailure) {
      setActionError(actionFailure instanceof Error ? actionFailure.message : 'Операция не выполнена.');
    }
  };

  return (
    <div className="admin-content">
      <CollectionHeader section={section} reload={reload} requestAction={setPendingAction} />
      {section === 'sandboxes' && <SandboxOpsStrip />}
      <Filters section={section} />
      {actionError && <div className="admin-alert">{actionError}</div>}
      {loading && !data ? <LoadingPanel /> : error || !data ? <ErrorPanel message={error ?? 'Не удалось загрузить данные.'} retry={reload} /> : <DataTable section={section} payload={data} requestAction={setPendingAction} />}
      {pendingAction && <ConfirmModal action={pendingAction} onCancel={() => setPendingAction(null)} onConfirm={() => void execute()} />}
    </div>
  );
}

interface ActionRequest { title: string; detail: string; confirm: string; url: string }

function CollectionHeader({ section, reload, requestAction }: { section: Exclude<Section, 'overview'>; reload: () => void; requestAction: (action: ActionRequest) => void }) {
  const details: Record<typeof section, string> = {
    users: 'Аккаунты, роли, статусы и активность.', sandboxes: 'Lifecycle, capacity и безопасные операции.',
    challenges: 'Каталог и состояние публикации.', battles: 'Состояние приватных матчей.', audit: 'Неизменяемая история административных действий.',
  };
  return <div className="admin-section-head"><AdminHeading title={nav.find((item) => item.key === section)?.label ?? section} detail={details[section]} /><div className="flex gap-2">{section === 'sandboxes' && <button className="admin-button warning" onClick={() => requestAction({ title: 'Запустить reconciliation?', detail: 'Будут удалены только orphan-контейнеры с меткой CLIRace и завершены подтверждённо устаревшие записи.', confirm: 'Запустить', url: '/api/admin/sandboxes/reconcile' })}><ShieldCheck size={14} /> Reconcile</button>}<button className="admin-button" onClick={reload}><RefreshCw size={14} /> Обновить</button></div></div>;
}

function SandboxOpsStrip() {
  const { data } = useResource<OverviewPayload>('/api/admin/overview', 5_000);
  if (!data) return null;
  const platform = data.sandbox.platform;
  return <div className="admin-ops-strip">
    <div><span className={platform.healthy ? 'ok' : 'bad'} /><strong>Rootless Docker</strong><small>{platform.code}</small></div>
    <div><strong>{platform.capacity.running + platform.capacity.starting} / {platform.capacity.maxCapacity}</strong><small>active / capacity</small></div>
    <div><strong>{platform.capacity.available}</strong><small>available</small></div>
    <div><strong>{data.sandbox.metrics.failedTotal}</strong><small>failures</small></div>
    <div><strong>{data.sandbox.metrics.orphanTotal}</strong><small>orphans</small></div>
    <div className="min-w-0"><strong className="truncate">{platform.runtime.image}</strong><small className="truncate">{platform.runtime.socketPath}</small></div>
  </div>;
}

function Filters({ section }: { section: Exclude<Section, 'overview'> }) {
  const params = new URLSearchParams(window.location.search);
  return <form className="admin-filters" action={`/admin/${section}`}>
    {section !== 'audit' && <label><Search size={14} /><input name="search" defaultValue={params.get('search') ?? ''} placeholder="Поиск…" /></label>}
    {section === 'users' && <><FilterSelect name="role" value={params.get('role')} options={['all:Все роли', 'user:User', 'admin:Admin']} /><FilterSelect name="status" value={params.get('status')} options={['all:Все статусы', 'active:Active', 'suspended:Suspended']} /><FilterSelect name="recentDays" value={params.get('recentDays')} options={['0:За всё время', '1:За 24 часа', '7:За 7 дней', '30:За 30 дней']} /></>}
    {section === 'sandboxes' && <><FilterSelect name="live" value={params.get('live')} options={['all:Все сессии', 'true:Только live', 'false:Завершённые']} /><input className="admin-filter-input" name="state" defaultValue={params.get('state') ?? 'all'} placeholder="Lifecycle state" /></>}
    {section === 'challenges' && <><FilterSelect name="type" value={params.get('type')} options={['all:Все типы', 'typing:Typing', 'recall:Recall', 'quick:Quick', 'real_shell:Real shell']} /><FilterSelect name="difficulty" value={params.get('difficulty')} options={['all:Все сложности', 'Easy:Easy', 'Medium:Medium', 'Hard:Hard', 'Expert:Expert']} /><FilterSelect name="enabled" value={params.get('enabled')} options={['all:Все состояния', 'true:Enabled', 'false:Disabled']} /><input className="admin-filter-input" name="category" defaultValue={params.get('category') ?? 'all'} placeholder="Category slug" /></>}
    {section === 'battles' && <FilterSelect name="status" value={params.get('status')} options={['all:Все статусы', 'waiting:Waiting', 'countdown:Countdown', 'running:Running', 'finished:Finished', 'cancelled:Cancelled']} />}
    {section === 'audit' && <><input className="admin-filter-input" name="actor" defaultValue={params.get('actor') ?? ''} placeholder="Администратор" /><input className="admin-filter-input" name="action" defaultValue={params.get('action') ?? ''} placeholder="Действие" /><input className="admin-filter-input" name="targetType" defaultValue={params.get('targetType') ?? ''} placeholder="Тип объекта" /><FilterSelect name="days" value={params.get('days')} options={['1:24 часа', '7:7 дней', '30:30 дней', '0:Всё время']} /></>}
    <button className="admin-button" type="submit">Применить</button>
  </form>;
}

function FilterSelect({ name, value, options }: { name: string; value: string | null; options: string[] }) {
  return <select name={name} defaultValue={value ?? options[0]?.split(':')[0]}>{options.map((item) => { const [key, label] = item.split(':'); return <option key={key} value={key}>{label}</option>; })}</select>;
}

function DataTable({ section, payload, requestAction }: { section: Exclude<Section, 'overview'>; payload: PagePayload; requestAction: (action: ActionRequest) => void }) {
  const columns = tableColumns(section, requestAction);
  return <>
    <div className="admin-table-wrap"><table className="admin-table"><thead><tr>{columns.map((column) => <th key={column.label}>{column.label}</th>)}</tr></thead><tbody>{payload.items.length ? payload.items.map((row, index) => <tr key={String(row.id ?? index)}>{columns.map((column) => <td key={column.label}>{column.render(row)}</td>)}</tr>) : <tr><td colSpan={columns.length}><div className="admin-empty">Ничего не найдено.</div></td></tr>}</tbody></table></div>
    <Pagination payload={payload} />
  </>;
}

function tableColumns(section: Exclude<Section, 'overview'>, requestAction: (action: ActionRequest) => void): Array<{ label: string; render: (row: Record<string, unknown>) => ReactNode }> {
  if (section === 'users') return [
    { label: 'Пользователь', render: (r) => <div><strong>@{text(r.username)}</strong><small>{text(r.email)}</small></div> },
    { label: 'Роль / статус', render: (r) => <><Badge value={r.role} /><Badge value={r.account_status} /></> },
    { label: 'Активность', render: (r) => <div><strong>{text(r.ranked_division)} · {text(r.ranked_mmr)} MMR</strong><small>{text(r.ranked_wins)}W/{text(r.ranked_losses)}L · {text(r.ranked_games)} ranked</small></div> },
    { label: 'Даты', render: (r) => <div><strong>{formatDate(r.created_at)}</strong><small>login: {formatDate(r.last_login_at)}</small></div> },
    { label: 'Sandbox', render: (r) => r.active_sandbox ? <Badge value="active" /> : '—' },
    { label: '', render: (r) => <div className="admin-row-actions"><button onClick={() => requestAction({ title: r.account_status === 'suspended' ? 'Возобновить аккаунт?' : 'Приостановить аккаунт?', detail: `@${text(r.username)}. Активные сессии будут отозваны, песочницы завершены.`, confirm: r.account_status === 'suspended' ? 'Возобновить' : 'Приостановить', url: `/api/admin/users/${text(r.id)}/${r.account_status === 'suspended' ? 'unsuspend' : 'suspend'}` })}>{r.account_status === 'suspended' ? 'Unsuspend' : 'Suspend'}</button><button onClick={() => requestAction({ title: 'Отозвать все сессии?', detail: `Пользователь @${text(r.username)} должен будет войти заново.`, confirm: 'Отозвать', url: `/api/admin/users/${text(r.id)}/revoke-sessions` })}>Revoke</button></div> },
  ];
  if (section === 'sandboxes') return [
    { label: 'Сессия', render: (r) => <div><strong>{shortId(r.id)}</strong><small>{text(r.username, 'guest')}</small></div> },
    { label: 'Lifecycle', render: (r) => <><Badge value={r.lifecycle_state} /><small className="block mt-1">{text(r.status)}</small></> },
    { label: 'Контекст', render: (r) => <div><strong>{text(r.challenge_title, text(r.room_code, '—'))}</strong><small>{r.battle_id ? `battle ${text(r.room_code)}` : 'practice'}</small></div> },
    { label: 'Возраст / activity', render: (r) => <div><strong>{relative(r.created_at)}</strong><small>{relative(r.last_activity_at)}</small></div> },
    { label: 'Завершение', render: (r) => <div><strong>{formatDate(r.expires_at)}</strong><small>{text(r.failure_code, text(r.termination_reason, '—'))}</small></div> },
    { label: '', render: (r) => isLive(r.lifecycle_state) ? <button className="admin-danger" onClick={() => requestAction({ title: 'Завершить песочницу?', detail: `Сессия ${shortId(r.id)} будет остановлена через SandboxManager.`, confirm: 'Завершить', url: `/api/admin/sandboxes/${text(r.id)}/terminate` })}>Terminate</button> : null },
  ];
  if (section === 'challenges') return [
    { label: 'Задание', render: (r) => <div><strong>{text(r.title)}</strong><small>{text(r.slug)}</small></div> },
    { label: 'Категория', render: (r) => <div><strong>{text(r.category_name)}</strong><small>{text(r.type)} · {text(r.difficulty)}</small></div> },
    { label: 'Валидация', render: (r) => <div><strong>{text(r.validation_kind)}</strong><small>{text(r.sandbox_challenge_id, 'без sandbox')} {r.integrity_status ? `· integrity ${text(r.integrity_status)}` : ''}</small></div> },
    { label: 'Коллекции', render: (r) => arrayText(r.collections) },
    { label: 'Состояние', render: (r) => <Badge value={r.enabled ? 'enabled' : 'disabled'} /> },
    { label: '', render: (r) => <button className={r.enabled ? 'admin-danger' : 'admin-success'} onClick={() => requestAction({ title: r.enabled ? 'Отключить задание?' : 'Включить задание?', detail: `${text(r.title)} исчезнет из новых забегов или снова станет доступно.`, confirm: r.enabled ? 'Отключить' : 'Включить', url: `/api/admin/challenges/${text(r.id)}/${r.enabled ? 'disable' : 'enable'}` })}>{r.enabled ? 'Disable' : 'Enable'}</button> },
  ];
  if (section === 'battles') return [
    { label: 'Battle', render: (r) => <div><strong>{text(r.room_code)}</strong><small>{shortId(r.id)}</small></div> },
    { label: 'Статус', render: (r) => <><Badge value={r.status} /><Badge value={r.mode} /></> },
    { label: 'Игроки', render: (r) => <div><strong>{text(r.players, '—')}</strong><small>host: @{text(r.host_username)} · winner: {text(r.winner_username)}</small></div> },
    { label: 'Раунды', render: (r) => <div><strong>{text(r.round_count)}</strong><small>{text(r.category_name, 'Все категории')}</small></div> },
    { label: 'Время', render: (r) => <div><strong>{relative(r.created_at)}</strong><small>{formatDate(r.finished_at)}</small></div> },
    { label: '', render: (r) => ['waiting', 'countdown', 'running'].includes(text(r.status)) ? <button className="admin-danger" onClick={() => requestAction({ title: 'Завершить Battle?', detail: `Комната ${text(r.room_code)} будет отменена, её песочницы — остановлены.`, confirm: 'Завершить', url: `/api/admin/battles/${text(r.id)}/terminate` })}>Terminate</button> : null },
  ];
  return [
    { label: 'Время', render: (r) => <div><strong>{formatDate(r.created_at)}</strong><small>#{text(r.id)}</small></div> },
    { label: 'Администратор', render: (r) => text(r.actor_username, 'system / CLI') },
    { label: 'Действие', render: (r) => <Badge value={r.action} /> },
    { label: 'Объект', render: (r) => <div><strong>{text(r.target_type)}</strong><small>{shortId(r.target_id)}</small></div> },
    { label: 'Метаданные', render: (r) => <code className="admin-json">{JSON.stringify(r.metadata ?? {})}</code> },
    { label: 'IP', render: (r) => text(r.client_ip, '—') },
  ];
}

function Pagination({ payload }: { payload: PagePayload }) {
  const href = (page: number) => { const params = new URLSearchParams(window.location.search); params.set('page', String(page)); return `${window.location.pathname}?${params}`; };
  return <div className="admin-pagination"><span>{payload.total} записей · страница {payload.page} из {payload.pages}</span><div>{payload.page > 1 && <a href={href(payload.page - 1)}>← Назад</a>}{payload.page < payload.pages && <a href={href(payload.page + 1)}>Дальше →</a>}</div></div>;
}

function ConfirmModal({ action, onCancel, onConfirm }: { action: ActionRequest; onCancel: () => void; onConfirm: () => void }) {
  return <div className="admin-modal-backdrop"><section className="admin-modal" role="dialog" aria-modal="true"><ShieldAlert size={26} /><h2>{action.title}</h2><p>{action.detail}</p><div><button className="admin-button" onClick={onCancel}>Отмена</button><button className="admin-button warning" onClick={onConfirm}>{action.confirm}</button></div></section></div>;
}

function useResource<T>(url: string, pollMs = 0) {
  const [data, setData] = useState<T | null>(null); const [error, setError] = useState<string | null>(null); const [loading, setLoading] = useState(true); const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let active = true; const load = () => requestJson<T>(url).then((value) => { if (active) { setData(value); setError(null); } }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : 'Ошибка соединения.'); }).finally(() => { if (active) setLoading(false); });
    void load(); const timer = pollMs ? window.setInterval(() => void load(), pollMs) : undefined;
    return () => { active = false; if (timer) window.clearInterval(timer); };
  }, [url, pollMs, revision]);
  return { data, error, loading, reload };
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init); const payload = await response.json().catch(() => null) as { message?: string } | null;
  if (!response.ok) throw new Error(payload?.message ?? `HTTP ${response.status}`); return payload as T;
}

function currentSection(): Section { const value = window.location.pathname.split('/')[2]; return nav.some((item) => item.key === value) ? value as Section : 'overview'; }
function text(value: unknown, fallback = '—') { return value === null || value === undefined || value === '' ? fallback : String(value); }
function shortId(value: unknown) { const raw = text(value); return raw.length > 14 ? `${raw.slice(0, 8)}…${raw.slice(-4)}` : raw; }
function arrayText(value: unknown) { return Array.isArray(value) && value.length ? value.join(', ') : '—'; }
function formatDate(value: unknown) { if (!value) return '—'; const date = new Date(String(value)); return Number.isNaN(date.getTime()) ? text(value) : date.toLocaleString('ru-RU'); }
function relative(value: unknown) { if (!value) return '—'; const ms = Date.now() - new Date(String(value)).getTime(); if (!Number.isFinite(ms)) return '—'; const minutes = Math.max(0, Math.floor(ms / 60_000)); return minutes < 1 ? 'только что' : minutes < 60 ? `${minutes} мин назад` : minutes < 1440 ? `${Math.floor(minutes / 60)} ч назад` : `${Math.floor(minutes / 1440)} дн назад`; }
function isLive(value: unknown) { return ['requested', 'queued', 'starting', 'ready', 'attached', 'idle', 'terminating'].includes(text(value)); }

function Badge({ value }: { value: unknown }) { const label = text(value); return <span className={`admin-badge badge-${label.replace(/[^a-z0-9_-]/gi, '-').toLowerCase()}`}>{label}</span>; }
function AdminHeading({ title, detail }: { title: string; detail?: string }) { return <div className="admin-heading"><h2>{title}</h2>{detail && <p>{detail}</p>}</div>; }
function Stat({ label, value, hint }: { label: string; value: unknown; hint?: string }) { return <div className="admin-stat"><span>{label}</span><strong>{text(value, '0')}</strong>{hint && <small>{hint}</small>}</div>; }
function Mini({ label, value }: { label: string; value: unknown }) { return <div className="admin-mini"><span>{label}</span><strong>{text(value)}</strong></div>; }
function HealthTile({ label, ok, detail, icon }: { label: string; ok: boolean; detail: string; icon: ReactNode }) { return <div className="admin-health"><span className={ok ? 'ok' : 'bad'}>{icon}</span><div><strong>{label}</strong><small>{detail}</small></div><i className={ok ? 'ok' : 'bad'} /></div>; }
function LoadingPanel() { return <div className="admin-loading"><LoaderCircle className="animate-spin" /> Загружаем production-данные…</div>; }
function ErrorPanel({ message, retry }: { message: string; retry: () => void }) { return <div className="admin-error"><XCircle /><div><strong>Данные недоступны</strong><p>{message}</p></div><button className="admin-button" onClick={retry}>Повторить</button></div>; }
function AdminState({ icon, title, detail, action }: { icon: ReactNode; title: string; detail?: string; action?: ReactNode }) { return <main className="admin-state"><div>{icon}</div><p>CLIRACE OPERATIONS</p><h1>{title}</h1>{detail && <span>{detail}</span>}{action}</main>; }
