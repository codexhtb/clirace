type ValidationConfig = Record<string, unknown>;

export interface ValidationResult {
  correct: boolean;
  feedback: string;
}

export function validateChallengeAnswer(answer: string, config: ValidationConfig): ValidationResult {
  const normalized = normalizeCommand(answer);
  if (!normalized) return invalid('Введите команду перед отправкой.');

  const kind = stringValue(config.kind);
  let correct = false;
  if (kind === 'exact_normalized') {
    correct = normalized === normalizeCommand(stringValue(config.answer));
  } else if (kind === 'command_semantics') {
    correct = validateCommandSemantics(normalized, config);
  } else if (kind === 'pipeline_semantics') {
    correct = validatePipeline(normalized, config);
  }

  return correct
    ? { correct: true, feedback: 'Верно. Команда решает задачу.' }
    : invalid('Команда пока не подходит. Проверьте программу, аргументы и порядок операций.');
}

function validateCommandSemantics(command: string, config: ValidationConfig): boolean {
  const accepted = stringArray(config.accepted);
  if (accepted.length > 0) {
    const candidate = canonicalCommand(command);
    return accepted.some((value) => canonicalCommand(value) === candidate);
  }

  const tokens = tokenize(command);
  const programs = [...stringArray(config.programs), stringValue(config.program)].filter(Boolean);
  if (programs.length > 0 && !programs.some((program) => tokens[0] === program.toLowerCase())) return false;

  const subcommand = stringValue(config.subcommand).toLowerCase();
  if (subcommand && !tokens.slice(1, 3).includes(subcommand)) return false;

  const action = stringValue(config.action).toLowerCase();
  if (action && !tokens.includes(action)) return false;

  const unit = stringValue(config.unit).toLowerCase();
  if (unit && !tokens.includes(unit)) return false;

  const since = stringValue(config.since).toLowerCase();
  if (since && !command.includes(since)) return false;

  for (const required of stringArray(config.requires)) {
    const requirement = normalizeCommand(required);
    if (requirement === '--follow') {
      if (!tokens.includes('--follow') && !tokens.includes('-f')) return false;
    } else if (!command.includes(requirement)) {
      return false;
    }
  }

  const targetPort = numberValue(config.targetPort);
  if (targetPort !== null && !new RegExp(`(^|[^0-9])${targetPort}([^0-9]|$)`).test(command)) return false;

  const limit = numberValue(config.limit);
  if (limit !== null) {
    const hasLimit = tokens.includes(`-${limit}`)
      || tokens.some((token, index) => ['-n', '--max-count'].includes(token) && tokens[index + 1] === String(limit))
      || tokens.includes(`--max-count=${limit}`);
    if (!hasLimit) return false;
  }

  if (config.oneLine === true && !tokens.includes('--oneline')) return false;
  return programs.length > 0;
}

function validatePipeline(command: string, config: ValidationConfig): boolean {
  const stages = stringArray(config.stages);
  if (stages.length === 0) return false;
  const parts = command.split('|').map((part) => part.trim()).filter(Boolean);
  const extractsFirstColumn = parts.some((part) => /\b(awk\s+['\"]?\{?print\s+\$1|cut\s+[^|]*-f\s*1)/.test(part));
  const makesUnique = parts.some((part) => /\bsort\b[^|]*\s-u(\s|$)/.test(part))
    || parts.some((part) => /^uniq(\s|$)/.test(part));
  const counts = parts.some((part) => /^wc\s+(-l|--lines)(\s|$)/.test(part));
  return (!stages.includes('extract_column_1') || extractsFirstColumn)
    && (!stages.includes('unique') || makesUnique)
    && (!stages.includes('count') || counts)
    && command.includes('access.log');
}

function canonicalCommand(value: string): string {
  const tokens = tokenize(normalizeCommand(value));
  return tokens.map((token) => {
    if (/^-[a-z]{2,}$/i.test(token)) return `-${[...token.slice(1)].sort().join('')}`;
    return token;
  }).join(' ');
}

function normalizeCommand(value: string): string {
  return value.trim().toLowerCase().replace(/[“”]/g, '"').replace(/\s+/g, ' ');
}

function tokenize(value: string): string[] {
  return value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) => token.replace(/^(['"])(.*)\1$/, '$2')) ?? [];
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function invalid(feedback: string): ValidationResult {
  return { correct: false, feedback };
}
