import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

export const LINUX_CORE_CATEGORIES = [
  'filesystem', 'permissions', 'processes', 'users_groups', 'networking', 'storage',
  'systemd', 'logs', 'packages', 'bash', 'ssh', 'cron', 'signals',
  'pipes_redirection', 'environment', 'troubleshooting',
] as const;

const answerSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  text: z.string().trim().min(2).max(500),
}).strict();

export const learningQuestionSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120),
  category: z.enum(LINUX_CORE_CATEGORIES),
  concept: z.string().regex(/^[a-z][a-z0-9_]{1,79}$/),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  type: z.enum(['single_choice', 'multiple_choice', 'scenario', 'command_output']),
  question: z.string().trim().min(12).max(1_500),
  answers: z.array(answerSchema).min(4).max(8),
  correctAnswerIds: z.array(z.string()).min(1).max(4),
  explanation: z.string().trim().min(30).max(2_000),
  answerExplanations: z.record(z.string(), z.string().trim().min(15).max(1_000)),
  shellPracticeChallengeSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100).optional(),
  enabled: z.boolean().default(true),
  version: z.number().int().positive(),
}).strict();

export type LearningQuestionContent = z.infer<typeof learningQuestionSchema>;

export interface LearningDatasetReport {
  total: number;
  enabled: number;
  files: number;
  byCategory: Record<string, number>;
  byDifficulty: Record<string, number>;
  byType: Record<string, number>;
  warnings: string[];
}

export interface LoadedLearningContent {
  questions: LearningQuestionContent[];
  report: LearningDatasetReport;
}

export async function loadAndValidateLinuxCoreContent(): Promise<LoadedLearningContent> {
  const directory = new URL('../../../content/linux-core/', import.meta.url);
  const files = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  if (files.length === 0) throw new Error('Linux Core content folder contains no JSON files.');

  const questions: LearningQuestionContent[] = [];
  const warnings: string[] = [];
  for (const file of files) {
    const raw = JSON.parse(await readFile(new URL(file, directory), 'utf8')) as unknown;
    const parsed = z.array(learningQuestionSchema).safeParse(raw);
    if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
    for (const question of parsed.data) {
      questions.push(question);
    }
  }

  warnings.push(...validateLearningQuestionSet(questions));

  return {
    questions,
    report: {
      total: questions.length,
      enabled: questions.filter((question) => question.enabled).length,
      files: files.length,
      byCategory: countBy(questions, (question) => question.category),
      byDifficulty: countBy(questions, (question) => question.difficulty),
      byType: countBy(questions, (question) => question.type),
      warnings,
    },
  };
}

export function validateLearningQuestionSet(questions: LearningQuestionContent[]): string[] {
  const warnings: string[] = [];
  const slugs = new Set<string>();
  const normalizedTexts = new Set<string>();
  for (const question of questions) {
    if (slugs.has(question.slug)) throw new Error(`Duplicate question slug: ${question.slug}`);
    slugs.add(question.slug);
    const normalized = normalize(question.question);
    if (normalizedTexts.has(normalized)) throw new Error(`Duplicate question text: ${question.slug}`);
    normalizedTexts.add(normalized);
    validateQuestionQuality(question, question.slug, warnings);
  }
  return warnings;
}

function validateQuestionQuality(question: LearningQuestionContent, label: string, warnings: string[]): void {
  const answerIds = new Set(question.answers.map((answer) => answer.id));
  if (answerIds.size !== question.answers.length) throw new Error(`${label}: duplicate answer IDs`);
  const answerTexts = question.answers.map((answer) => normalize(answer.text));
  if (new Set(answerTexts).size !== answerTexts.length) throw new Error(`${label}: duplicate answer texts`);
  if (question.correctAnswerIds.some((id) => !answerIds.has(id))) throw new Error(`${label}: correct answer does not exist`);
  if (new Set(question.correctAnswerIds).size !== question.correctAnswerIds.length) throw new Error(`${label}: duplicate correct answer IDs`);
  if (question.type === 'multiple_choice' && question.correctAnswerIds.length < 2) throw new Error(`${label}: multiple_choice needs at least two correct answers`);
  if (question.type !== 'multiple_choice' && question.correctAnswerIds.length !== 1) throw new Error(`${label}: this question type needs exactly one correct answer`);
  for (const id of answerIds) {
    if (!question.answerExplanations[id]) throw new Error(`${label}: explanation is missing for answer ${id}`);
  }
  const forbidden = /(?:вс[её]\s+вышеперечислен|ни\s+один\s+из\s+вариант)/iu;
  if (forbidden.test(question.question) || question.answers.some((answer) => forbidden.test(answer.text))) throw new Error(`${label}: forbidden giveaway answer wording`);
  const unsafeHtml = /<\/?[a-z][^>]*>/iu;
  const authoredText = [question.question, question.explanation, ...question.answers.map((answer) => answer.text), ...Object.values(question.answerExplanations)];
  if (authoredText.some((value) => unsafeHtml.test(value))) throw new Error(`${label}: raw HTML is not allowed in learning content`);

  const lengths = question.answers.map((answer) => answer.text.length).sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)] ?? 1;
  const longest = lengths.at(-1) ?? 1;
  if (longest > median * 3.5 && longest - median > 45) warnings.push(`${label}: one answer is unusually long`);
  const words = question.answers.map((answer) => answer.text.trim().split(/\s+/u).length);
  if (Math.min(...words) === 1 && Math.max(...lengths) > 60) warnings.push(`${label}: one-word distractor next to a detailed answer`);
}

export async function importLinuxCoreQuestions(database: Pool | PoolClient): Promise<LearningDatasetReport> {
  const loaded = await loadAndValidateLinuxCoreContent();
  for (const question of loaded.questions) {
    if (question.shellPracticeChallengeSlug) {
      const challenge = await database.query<{ type: string; enabled: boolean }>(
        'SELECT type, enabled FROM challenges WHERE slug = $1', [question.shellPracticeChallengeSlug],
      );
      if (!challenge.rows[0] || challenge.rows[0].type !== 'real_shell' || !challenge.rows[0].enabled) {
        throw new Error(`${question.slug}: shell practice must reference an enabled real_shell challenge`);
      }
    }
    const sourceHash = createHash('sha256').update(JSON.stringify(question)).digest('hex');
    await database.query(`
      INSERT INTO learning_questions (
        course_slug, slug, category_slug, concept_slug, difficulty, question_type,
        question_text, answer_options, correct_answer_ids, explanation, answer_explanations,
        shell_practice_challenge_slug, enabled, content_version, source_hash
      ) VALUES (
        'linux-core', $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10::jsonb, $11, $12, $13, $14
      )
      ON CONFLICT (course_slug, slug) DO UPDATE SET
        category_slug = EXCLUDED.category_slug, concept_slug = EXCLUDED.concept_slug,
        difficulty = EXCLUDED.difficulty, question_type = EXCLUDED.question_type,
        question_text = EXCLUDED.question_text, answer_options = EXCLUDED.answer_options,
        correct_answer_ids = EXCLUDED.correct_answer_ids, explanation = EXCLUDED.explanation,
        answer_explanations = EXCLUDED.answer_explanations,
        shell_practice_challenge_slug = EXCLUDED.shell_practice_challenge_slug,
        enabled = EXCLUDED.enabled, content_version = EXCLUDED.content_version,
        source_hash = EXCLUDED.source_hash, updated_at = now()
    `, [
      question.slug, question.category, question.concept, question.difficulty, question.type,
      question.question, JSON.stringify(question.answers), JSON.stringify(question.correctAnswerIds),
      question.explanation, JSON.stringify(question.answerExplanations),
      question.shellPracticeChallengeSlug ?? null, question.enabled, question.version, sourceHash,
    ]);
  }
  return loaded.report;
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const value = key(item);
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase('ru-RU').replace(/\s+/gu, ' ');
}
