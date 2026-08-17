export function humanizeError(value: unknown, fallback = 'Что-то пошло не так. Попробуйте ещё раз.'): string {
  const raw = value instanceof Error ? value.message : typeof value === 'string' ? value : '';
  const message = raw.toLowerCase();
  if (!raw) return fallback;
  if (message.includes('invalid_credentials') || message.includes('invalid credentials')) return 'Неверное имя пользователя или пароль.';
  if (message.includes('already') && (message.includes('user') || message.includes('email'))) return 'Такое имя или email уже используются.';
  if (message.includes('rate') || message.includes('too many')) return 'Слишком много попыток. Подождите немного и попробуйте снова.';
  if (message.includes('unauthorized') || message.includes('authentication')) return 'Сессия завершилась. Войдите снова.';
  if (message.includes('sandbox') || message.includes('docker') || message.includes('socket') || message.includes('econn')) return 'Shell временно недоступен. Попробуйте снова через несколько секунд.';
  if (message.includes('fetch') || message.includes('network') || /^5\d\d/.test(message)) return 'Не удалось связаться с сервером. Проверьте соединение и повторите попытку.';
  if (/^[a-z0-9_.:-]+$/i.test(raw)) return fallback;
  return raw;
}
