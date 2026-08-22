const difficultyLabels: Record<string, string> = {
  easy: 'Лёгкая',
  medium: 'Средняя',
  hard: 'Сложная',
  expert: 'Экспертная',
};

const modeLabels: Record<string, string> = {
  typing: 'Набор',
  recall: 'Вспомни',
  quick: 'Быстро',
  real_shell: 'Терминал',
  mixed: 'Смешанный',
};

export function difficultyLabel(value: string | null | undefined, uppercase = false): string {
  const label = difficultyLabels[String(value ?? '').toLowerCase()] ?? String(value ?? '—');
  return uppercase ? label.toLocaleUpperCase('ru-RU') : label;
}

export function modeLabel(value: string | null | undefined): string {
  return modeLabels[String(value ?? '').toLowerCase()] ?? String(value ?? '—');
}

export function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
