import type { Pool, PoolClient } from 'pg';
import { filesystemPermissionsPack } from './packs/filesystem-permissions.js';
import { networkingPack } from './packs/networking.js';
import { packagesTroubleshootingPack } from './packs/packages-troubleshooting.js';
import { textShellPack } from './packs/text-shell.js';
import { usersProcessesPack } from './packs/users-processes.js';
import {
  CHALLENGE_CATEGORIES,
  CHALLENGE_TIERS,
  challengeDefinitionHash,
  evaluateBattleEligibility,
  type ChallengeAvailabilityMode,
  type ChallengeCategory,
  type ChallengeTier,
  type ChallengeV2,
} from './model.js';

const CATEGORY_METADATA: Readonly<Record<ChallengeCategory, { name: string; description: string; order: number }>> = {
  filesystem: { name: 'Файлы и каталоги', description: 'Навигация, структуры каталогов, ссылки и управление файлами.', order: 20 },
  permissions: { name: 'Права и владение', description: 'Безопасные режимы файлов, каталогов и эксплуатационных артефактов.', order: 21 },
  'users-groups': { name: 'Пользователи и группы', description: 'Локальные identities, роли и групповая модель доступа.', order: 22 },
  processes: { name: 'Процессы и сигналы', description: 'Фоновые процессы, PID-файлы, сигналы и runtime-state.', order: 23 },
  networking: { name: 'Сеть и порты', description: 'Локальные TCP/UDP sockets, bind-адреса и диагностика портов.', order: 24 },
  'text-processing': { name: 'Поиск и обработка текста', description: 'grep, find, awk, sed и отчёты по локальным данным.', order: 25 },
  shell: { name: 'Shell и pipeline', description: 'Потоки, перенаправления, pipelines и shell-композиция.', order: 26 },
  packages: { name: 'Пакеты', description: 'Offline-проверка гарантированных пакетов окружения.', order: 27 },
  troubleshooting: { name: 'Диагностика', description: 'Небольшие воспроизводимые составные Linux-инциденты.', order: 28 },
};

const EXPECTED_CATEGORY_COUNTS: Readonly<Record<ChallengeCategory, number>> = {
  filesystem: 18,
  permissions: 18,
  'users-groups': 16,
  processes: 16,
  networking: 22,
  'text-processing': 18,
  shell: 16,
  packages: 10,
  troubleshooting: 16,
};

const catalog: readonly ChallengeV2[] = Object.freeze([
  ...filesystemPermissionsPack,
  ...usersProcessesPack,
  ...networkingPack,
  ...textShellPack,
  ...packagesTroubleshootingPack,
]);

export interface ChallengeLibraryV2Report {
  total: number;
  startupValidationMs: number;
  categories: Record<ChallengeCategory, number>;
  tiers: Record<ChallengeTier, number>;
  difficulties: Record<'Easy' | 'Medium' | 'Hard', number>;
  availability: Record<ChallengeAvailabilityMode, number>;
  onlineEligible: Record<'quick' | 'ranked' | 'private', number>;
  warnings: string[];
}

const validationStartedAt = performance.now();
const validationReport = validateChallengeLibraryV2(catalog);
validationReport.startupValidationMs = Math.round((performance.now() - validationStartedAt) * 100) / 100;

export function listChallengeLibraryV2(): readonly ChallengeV2[] {
  return catalog;
}

export function getChallengeV2(id: string, version?: number): ChallengeV2 | undefined {
  return catalog.find((challenge) => challenge.id === id && (version === undefined || challenge.version === version));
}

export function challengeLibraryV2Report(): ChallengeLibraryV2Report {
  return structuredClone(validationReport);
}

export function listBattleEligibleChallenges(mode: 'quick' | 'ranked' | 'private'): readonly ChallengeV2[] {
  return catalog.filter((challenge) => evaluateBattleEligibility(challenge, mode).eligible);
}

export function validateChallengeLibraryV2(challenges: readonly ChallengeV2[]): ChallengeLibraryV2Report {
  const ids = new Set<string>();
  const titles = new Set<string>();
  const descriptions = new Set<string>();
  const objectives = new Set<string>();
  const gameplayShapes = new Map<string, string>();
  const warnings: string[] = [];
  const categories = Object.fromEntries(CHALLENGE_CATEGORIES.map((category) => [category, 0])) as Record<ChallengeCategory, number>;
  const tiers = Object.fromEntries(CHALLENGE_TIERS.map((tier) => [tier, 0])) as Record<ChallengeTier, number>;
  const difficulties = { Easy: 0, Medium: 0, Hard: 0 };
  const availability = { practice: 0, quick: 0, ranked: 0, private: 0 };
  const onlineEligible = { quick: 0, ranked: 0, private: 0 };

  for (const challenge of challenges) {
    if (ids.has(challenge.id)) throw new Error(`Library V2 duplicate challenge id: ${challenge.id}`);
    ids.add(challenge.id);
    if (titles.has(challenge.title)) throw new Error(`Library V2 duplicate title: ${challenge.title}`);
    titles.add(challenge.title);
    if (descriptions.has(challenge.description)) throw new Error(`Library V2 duplicate description: ${challenge.id}`);
    descriptions.add(challenge.description);
    if (objectives.has(challenge.learningObjective)) throw new Error(`Library V2 duplicate learning objective: ${challenge.id}`);
    objectives.add(challenge.learningObjective);
    assertNoForbiddenDefinitionKeys(challenge, challenge.id);
    const hash = challengeDefinitionHash(challenge);
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`${challenge.id}: invalid definition hash`);
    const shape = JSON.stringify({ setup: challenge.setup, checks: challenge.checks });
    const shapeOwner = gameplayShapes.get(shape);
    if (shapeOwner) warnings.push(`${challenge.id}: exact setup/check shape also used by ${shapeOwner}`);
    else gameplayShapes.set(shape, challenge.id);
    categories[challenge.category] += 1;
    tiers[challenge.tier] += 1;
    difficulties[challenge.difficulty] += 1;
    (Object.keys(availability) as ChallengeAvailabilityMode[]).forEach((mode) => {
      if (challenge.availability[mode]) availability[mode] += 1;
    });
    (Object.keys(onlineEligible) as Array<'quick' | 'ranked' | 'private'>).forEach((mode) => {
      const eligibility = evaluateBattleEligibility(challenge, mode);
      if (eligibility.eligible) onlineEligible[mode] += 1;
      else if (challenge.availability[mode]) {
        throw new Error(`${challenge.id}: ONLINE_INELIGIBLE:${eligibility.reasons.join(',')}`);
      }
    });
  }
  if (challenges.length !== 150) throw new Error(`Library V2 expected 150 challenges, received ${challenges.length}`);
  for (const category of CHALLENGE_CATEGORIES) {
    if (categories[category] !== EXPECTED_CATEGORY_COUNTS[category]) {
      throw new Error(`Library V2 ${category} expected ${EXPECTED_CATEGORY_COUNTS[category]}, received ${categories[category]}`);
    }
  }
  return { total: challenges.length, startupValidationMs: 0, categories, tiers, difficulties, availability, onlineEligible, warnings };
}

export async function importChallengeLibraryV2(database: Pool | PoolClient): Promise<ChallengeLibraryV2Report> {
  for (const category of CHALLENGE_CATEGORIES) {
    const metadata = CATEGORY_METADATA[category];
    await database.query(`
      INSERT INTO categories (slug, name, description, enabled, sort_order)
      VALUES ($1, $2, $3, true, $4)
      ON CONFLICT (slug) DO UPDATE SET
        name=EXCLUDED.name, description=EXCLUDED.description, enabled=true, sort_order=EXCLUDED.sort_order
    `, [category, metadata.name, metadata.description, metadata.order]);
  }
  for (const challenge of catalog) {
    const definitionHash = challengeDefinitionHash(challenge);
    const validationConfig = {
      kind: 'sandbox_state',
      sandboxChallengeId: challenge.id,
      libraryVersion: 2,
      challengeVersion: challenge.version,
      definitionHash,
      tier: challenge.tier,
      concepts: challenge.concepts,
      availability: challenge.availability,
      estimatedDurationSeconds: challenge.estimatedDurationSeconds,
      battleEligible: {
        quick: evaluateBattleEligibility(challenge, 'quick').eligible,
        ranked: evaluateBattleEligibility(challenge, 'ranked').eligible,
        private: evaluateBattleEligibility(challenge, 'private').eligible,
      },
    };
    const base = challenge.difficulty === 'Easy' ? 120 : challenge.difficulty === 'Medium' ? 180 : 260;
    await database.query(`
      INSERT INTO challenges (slug, title, description, category_id, difficulty, type, enabled, scoring_config, validation_config)
      SELECT $1, $2, $3, categories.id, $5, 'real_shell', true, $6::jsonb, $7::jsonb
      FROM categories WHERE categories.slug=$4
      ON CONFLICT (slug) DO UPDATE SET
        title=EXCLUDED.title, description=EXCLUDED.description, category_id=EXCLUDED.category_id,
        difficulty=EXCLUDED.difficulty, type='real_shell', enabled=true,
        scoring_config=EXCLUDED.scoring_config, validation_config=EXCLUDED.validation_config, updated_at=now()
    `, [
      challenge.id,
      challenge.title,
      challenge.description,
      challenge.category,
      challenge.difficulty,
      JSON.stringify({ base, timeTargetMs: challenge.estimatedDurationSeconds * 1_000 }),
      JSON.stringify(validationConfig),
    ]);
  }
  return challengeLibraryV2Report();
}

function assertNoForbiddenDefinitionKeys(value: unknown, challengeId: string, path = ''): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenDefinitionKeys(entry, challengeId, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (['setupScript', 'checkScript', 'command', 'bash', 'eval', 'javascript', 'shell'].includes(key)) {
      throw new Error(`${challengeId}: forbidden definition key ${path ? `${path}.` : ''}${key}`);
    }
    assertNoForbiddenDefinitionKeys(child, challengeId, path ? `${path}.${key}` : key);
  }
}
