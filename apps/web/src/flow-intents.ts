export const QUICK_MATCH_INTENT = 'quick';

export function hasQuickMatchIntent(search: string): boolean {
  return new URLSearchParams(search).get('match') === QUICK_MATCH_INTENT;
}

export function consumeQuickMatchIntent(search: string): string {
  const query = new URLSearchParams(search);
  query.delete('match');
  const next = query.toString();
  return next ? `?${next}` : '';
}

export type OnlineMode = 'quick' | 'ranked';

export function onlineModeFromSearch(search: string): OnlineMode {
  return new URLSearchParams(search).get('mode') === 'ranked' ? 'ranked' : 'quick';
}

export function legacyPvpOnlineHref(search: string, hash: string): string | null {
  const query = new URLSearchParams(search);
  const competition = query.get('compete');
  const quickIntent = hasQuickMatchIntent(search);
  if (!quickIntent && !competition && hash !== '#competition') return null;

  query.delete('compete');
  if (quickIntent) query.delete('mode');
  else if (competition === 'ranked') query.set('mode', 'ranked');
  else query.delete('mode');
  const next = query.toString();
  return `/online${next ? `?${next}` : ''}`;
}

export function shouldAutoStartNextShell(explicitContinue: boolean, nextTaskType?: string): boolean {
  return explicitContinue && nextTaskType === 'real_shell';
}

export const CONTINUE_SHELL_RETRY_DELAYS_MS = [700, 1_400] as const;

export function sandboxStartErrorMessage(code?: string): string {
  if (code === 'capacity_full') {
    return 'Все игровые среды сейчас заняты. Попробуйте ещё раз через несколько секунд.';
  }
  if (code === 'user_capacity_full') {
    return 'Предыдущий терминал ещё завершает работу. Повторите через несколько секунд.';
  }
  if (code === 'sandbox_unavailable' || code === 'temporarily_unavailable') {
    return 'Терминал временно недоступен. Попробуйте ещё раз через несколько секунд.';
  }
  return 'Не удалось подготовить терминал. Попробуйте ещё раз.';
}
