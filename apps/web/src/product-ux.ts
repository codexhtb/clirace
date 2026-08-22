export const primaryNavigation = [
  { href: '/play#practice', label: 'Практика', matches: (path: string, search: string) => path === '/play' && !new URLSearchParams(search).has('compete') },
  { href: '/learn', label: 'Обучение', matches: (path: string, _search: string) => path.startsWith('/learn') || path === '/interview' },
  { href: '/play?compete=quick#competition', label: 'Соревнования', matches: (path: string, search: string) => path.startsWith('/battle') || (path === '/play' && new URLSearchParams(search).has('compete')) },
  { href: '/rating', label: 'Рейтинг', matches: (path: string, _search: string) => path === '/rating' || path === '/leaderboard' },
] as const;

export const secondaryNavigation = [
  { href: '/daily', label: 'Задача дня' },
  { href: '/interview', label: 'Interview 100' },
  { href: '/battle', label: 'Игра с другом' },
] as const;

type RouteMeta = { title: string; description: string; canonical: string; indexable: boolean };

export function routeMetadata(path: string): RouteMeta {
  if (path === '/learn/paths') return meta('Учебные пути Linux — CLIRace', 'Последовательные курсы Linux: короткая теория, проверка знаний, CLI-практика и лабораторные в настоящем shell.', '/learn/paths');
  if (path === '/learn/paths/linux-foundations') return meta('Linux Foundations — структурированный курс Linux | CLIRace', 'Пройдите основы Linux от команд и файлов до сетей, systemd и диагностики с практикой в настоящем терминале.', '/learn/paths/linux-foundations');
  if (path.startsWith('/learn/paths/')) return meta('Учебный модуль — CLIRace', 'Персональный прогресс учебного пути CLIRace.', path, false);
  if (path === '/play') return meta('Практика и соревнования — CLIRace', 'Решайте Linux-задачи в настоящем терминале или найдите соперника в Quick Match и Ranked.', '/play');
  if (path === '/learn') return meta('Обучение Linux с разбором ошибок — CLIRace', 'Изучайте Linux Core с объяснениями ответов и переходите от слабых тем к практике в терминале.', '/learn');
  if (path === '/learn/linux-core') return meta('Linux Core — обучение Linux с объяснениями | CLIRace', 'Проверьте знания Linux, разберите каждый ответ и закрепите слабые темы в настоящем терминале.', '/learn/linux-core');
  if (path === '/interview') return meta('Interview 100 — подготовка к Linux-собеседованию | CLIRace', 'Сто практических Linux и DevOps задач для подготовки к техническому собеседованию.', '/interview');
  if (path === '/daily') return meta('Задача дня по Linux — CLIRace', 'Решите общую Linux-задачу дня, сохраните серию и сравните результат с другими игроками.', '/daily');
  if (path === '/rating' || path === '/leaderboard') return meta('Рейтинг игроков CLIRace', 'Таблица результатов практики и Ranked-матчей игроков CLIRace.', '/rating');
  if (path === '/profile') return meta('Профиль игрока — CLIRace', 'Прогресс, результаты практики, обучение и Ranked-статистика игрока CLIRace.', '/profile', false);
  if (path.startsWith('/profile/')) return meta('Профиль игрока — CLIRace', 'Прогресс, результаты практики, обучение и Ranked-статистика игрока CLIRace.', path);
  if (path.startsWith('/admin')) return meta('Панель управления — CLIRace', 'Служебная панель CLIRace.', path, false);
  if (path.startsWith('/battle')) return meta('Матч — CLIRace', 'Приватный Linux-матч в настоящих изолированных терминалах.', path, false);
  if (path === '/' || path === '/login' || path === '/register') return meta('CLIRace — практика Linux и DevOps в терминале', 'Практикуйте Linux в настоящем терминале: решайте задачи, учитесь на ошибках и соревнуйтесь с другими.', '/');
  return meta('Страница не найдена — CLIRace', 'Запрошенная страница CLIRace не найдена.', path, false);
}

function meta(title: string, description: string, canonical: string, indexable = true): RouteMeta {
  return { title, description, canonical: `https://clirace.fun${canonical}`, indexable };
}

const practiceCategory: Record<string, string> = {
  filesystem: 'linux', permissions: 'linux', processes: 'linux', users_groups: 'linux',
  networking: 'networking', storage: 'linux', systemd: 'systemd', logs: 'linux', packages: 'linux',
  bash: 'bash', ssh: 'networking', cron: 'systemd', signals: 'linux', pipes_redirection: 'bash',
  environment: 'bash', troubleshooting: 'linux',
};

export function practiceHrefForWeakArea(area: string): string {
  const category = practiceCategory[area] ?? 'linux';
  return `/play?category=${category}&difficulty=Easy&mode=real_shell&count=5#practice`;
}

export function learningQuestionType(value: string): string {
  return ({ single_choice: 'один ответ', multiple_choice: 'несколько ответов', scenario: 'сценарий', command_output: 'вывод команды' } as Record<string, string>)[value] ?? 'вопрос';
}

export function learningDifficulty(value: string): string {
  return ({ easy: 'легко', medium: 'средне', hard: 'сложно' } as Record<string, string>)[value] ?? value;
}

export function isNewPlayer(profile: { stats?: { runs?: number }; ranked?: { gamesPlayed?: number }; learning?: { answered?: number }; learningPaths?: unknown[] } | null): boolean {
  return Boolean(profile)
    && (profile?.stats?.runs ?? 0) === 0
    && (profile?.ranked?.gamesPlayed ?? 0) === 0
    && (profile?.learning?.answered ?? 0) === 0
    && (profile?.learningPaths?.length ?? 0) === 0;
}
