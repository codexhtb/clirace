export function humanizeError(value: unknown, fallback = 'Что-то пошло не так. Попробуйте ещё раз.'): string {
  const raw = value instanceof Error ? value.message : typeof value === 'string' ? value : '';
  const message = raw.toLowerCase();
  if (!raw) return fallback;
  if (message.includes('invalid_credentials') || message.includes('invalid credentials')) return 'Неверное имя пользователя или пароль.';
  if (message.includes('already') && (message.includes('user') || message.includes('email'))) return 'Такое имя или email уже используются.';
  if (message.includes('rate') || message.includes('too many')) return 'Слишком много попыток. Подождите немного и попробуйте снова.';
  if (message.includes('capacity_full') || message.includes('capacity reached')) return 'Сейчас все терминалы заняты. Подождите несколько секунд и попробуйте снова.';
  if (message.includes('user_capacity_full')) return 'У вас уже запущен терминал. Завершите его перед созданием нового.';
  if (message.includes('image_missing')) return 'Окружение терминала обновляется. Попробуйте немного позже.';
  if (message.includes('permission_denied') || message.includes('socket_unavailable')) return 'Сервис терминалов временно восстанавливается. Попробуйте немного позже.';
  if (message.includes('unauthorized') || message.includes('authentication')) return 'Сессия завершилась. Войдите снова.';
  if (message.includes('sandbox') || message.includes('docker') || message.includes('socket') || message.includes('econn')) return 'Shell временно недоступен. Попробуйте снова через несколько секунд.';
  if (message.includes('fetch') || message.includes('network') || /^5\d\d/.test(message)) return 'Не удалось связаться с сервером. Проверьте соединение и повторите попытку.';
  if (message.includes('unexpected end') || message.includes('json') || message.includes('timeout') || message.includes('aborted')) return fallback;
  if (/^[a-z0-9_.:-]+$/i.test(raw)) return fallback;
  return raw;
}
