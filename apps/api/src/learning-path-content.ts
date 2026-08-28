import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { loadAndValidateLinuxCoreContent } from './learning-content.js';
import { listSandboxChallenges, sandboxChallengeCatalogSlug } from './sandbox-challenges.js';

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120);
const theoryBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heading'), text: z.string().trim().min(2).max(120) }).strict(),
  z.object({ type: z.literal('paragraph'), text: z.string().trim().min(10).max(1_000) }).strict(),
  z.object({ type: z.literal('bullets'), items: z.array(z.string().trim().min(3).max(400)).min(2).max(8) }).strict(),
  z.object({ type: z.literal('code'), language: z.literal('bash'), code: z.string().trim().min(2).max(1_000) }).strict(),
  z.object({ type: z.literal('note'), tone: z.enum(['note', 'warning']), text: z.string().trim().min(10).max(600) }).strict(),
]);

const itemBase = z.object({
  id: slug,
  slug,
  title: z.string().trim().min(3).max(160),
  order: z.number().int().positive(),
  category: z.string().regex(/^[a-z][a-z0-9_]{1,59}$/),
  concept: z.string().regex(/^[a-z][a-z0-9_]{1,79}$/),
  version: z.number().int().positive(),
});

const theoryItem = itemBase.extend({
  type: z.literal('theory'),
  content: z.array(theoryBlockSchema).min(3).max(16),
  completion: z.object({ explicitContinue: z.literal(true) }).strict(),
}).strict();
const assessmentItem = itemBase.extend({
  type: z.enum(['knowledge_check', 'checkpoint']),
  questionSlugs: z.array(slug).min(1).max(20),
  completion: z.object({ passThreshold: z.number().int().min(0).max(100) }).strict(),
}).strict();
const challengeItem = itemBase.extend({
  type: z.enum(['practice', 'shell_lab']),
  challengeSlugs: z.array(slug).min(1).max(5),
  completion: z.object({ requireAll: z.literal(true) }).strict(),
}).strict();

export const learningPathItemSchema = z.union([theoryItem, assessmentItem, challengeItem]);
export const learningPathModuleSchema = z.object({
  slug,
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().min(20).max(800),
  order: z.number().int().positive(),
  prerequisites: z.array(slug).max(4),
  estimatedMinutes: z.number().int().min(5).max(600),
  version: z.number().int().positive(),
  completion: z.object({ allItemsRequired: z.literal(true) }).strict(),
  items: z.array(learningPathItemSchema).min(3).max(12),
}).strict();
const courseFileSchema = z.object({
  slug,
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().min(30).max(1_000),
  version: z.number().int().positive(),
  enabled: z.boolean(),
  order: z.number().int().nonnegative(),
  estimatedMinutes: z.number().int().min(30),
  level: z.enum(['beginner', 'intermediate', 'advanced']),
  prerequisites: z.array(slug).max(8),
  modules: z.array(z.string().regex(/^\d{2}-[a-z0-9-]+\.json$/)).min(1).max(20),
}).strict();

export type LearningPathItemContent = z.infer<typeof learningPathItemSchema>;
export type LearningPathModuleContent = z.infer<typeof learningPathModuleSchema>;
export type LearningPathCourseContent = Omit<z.infer<typeof courseFileSchema>, 'modules'> & { modules: LearningPathModuleContent[] };

export interface LearningPathDatasetReport {
  courses: number;
  modules: number;
  items: number;
  byType: Record<string, number>;
  invalidReferences: number;
  warnings: string[];
}

export async function loadAndValidateLearningPathsContent(): Promise<{ courses: LearningPathCourseContent[]; report: LearningPathDatasetReport }> {
  const root = new URL('../../../content/learning-paths/', import.meta.url);
  const courseDirectories = ['linux-foundations'];
  const linuxCore = await loadAndValidateLinuxCoreContent();
  const questionSlugs = new Set(linuxCore.questions.filter((question) => question.enabled).map((question) => question.slug));
  const challengeSlugs = new Set(listSandboxChallenges().map(sandboxChallengeCatalogSlug));
  const courses: LearningPathCourseContent[] = [];
  const allCourseSlugs = new Set<string>();
  const allItemIds = new Set<string>();
  const warnings: string[] = [];

  for (const directory of courseDirectories) {
    const base = new URL(`${directory}/`, root);
    const parsedCourse = courseFileSchema.safeParse(JSON.parse(await readFile(new URL('course.json', base), 'utf8')) as unknown);
    if (!parsedCourse.success) throw validationError(`${directory}/course.json`, parsedCourse.error);
    if (allCourseSlugs.has(parsedCourse.data.slug)) throw new Error(`Duplicate course slug: ${parsedCourse.data.slug}`);
    allCourseSlugs.add(parsedCourse.data.slug);
    const modules: LearningPathModuleContent[] = [];
    for (const filename of parsedCourse.data.modules) {
      const parsedModule = learningPathModuleSchema.safeParse(JSON.parse(await readFile(new URL(`modules/${filename}`, base), 'utf8')) as unknown);
      if (!parsedModule.success) throw validationError(`${directory}/modules/${filename}`, parsedModule.error);
      modules.push(parsedModule.data);
    }
    validateModuleGraph(parsedCourse.data.slug, modules);
    for (const module of modules) for (const item of module.items) {
      if (allItemIds.has(item.id)) throw new Error(`Duplicate learning item ID: ${item.id}`);
      allItemIds.add(item.id);
    }
    validateLearningPathReferences(modules.flatMap((module) => module.items), questionSlugs, challengeSlugs);
    const { modules: _filenames, ...course } = parsedCourse.data;
    courses.push({ ...course, modules });
  }

  const items = courses.flatMap((course) => course.modules.flatMap((module) => module.items));
  return {
    courses,
    report: {
      courses: courses.length,
      modules: courses.reduce((sum, course) => sum + course.modules.length, 0),
      items: items.length,
      byType: countBy(items, (item) => item.type),
      invalidReferences: 0,
      warnings,
    },
  };
}

export async function importLearningPaths(database: Pool | PoolClient): Promise<LearningPathDatasetReport> {
  const loaded = await loadAndValidateLearningPathsContent();
  const questionReferences = [...new Set(loaded.courses.flatMap((course) => course.modules.flatMap((module) => module.items.flatMap((item) => 'questionSlugs' in item ? item.questionSlugs : []))))];
  const challengeReferences = [...new Set(loaded.courses.flatMap((course) => course.modules.flatMap((module) => module.items.flatMap((item) => 'challengeSlugs' in item ? item.challengeSlugs : []))))];
  const databaseQuestions = await database.query<{ slug: string }>(`SELECT slug FROM learning_questions WHERE course_slug = 'linux-core' AND enabled AND slug = ANY($1::varchar[])`, [questionReferences]);
  const databaseChallenges = await database.query<{ slug: string }>(`SELECT slug FROM challenges WHERE enabled AND type = 'real_shell' AND slug = ANY($1::varchar[])`, [challengeReferences]);
  ensureSameReferences('question', questionReferences, databaseQuestions.rows.map((row) => row.slug));
  ensureSameReferences('challenge', challengeReferences, databaseChallenges.rows.map((row) => row.slug));

  for (const course of loaded.courses) {
    const courseHash = hash(course);
    const courseResult = await database.query<{ id: string }>(`
      INSERT INTO learning_courses (slug, title, description, version, enabled, sort_order, estimated_minutes, level, prerequisites, source_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
      ON CONFLICT (slug) DO UPDATE SET title=EXCLUDED.title, description=EXCLUDED.description,
        version=EXCLUDED.version, enabled=EXCLUDED.enabled, sort_order=EXCLUDED.sort_order,
        estimated_minutes=EXCLUDED.estimated_minutes, level=EXCLUDED.level,
        prerequisites=EXCLUDED.prerequisites, source_hash=EXCLUDED.source_hash, updated_at=now()
      RETURNING id
    `, [course.slug, course.title, course.description, course.version, course.enabled, course.order,
      course.estimatedMinutes, course.level, JSON.stringify(course.prerequisites), courseHash]);
    const courseId = courseResult.rows[0]!.id;
    const importedModuleSlugs: string[] = [];
    const importedItemIds: string[] = [];
    for (const module of course.modules) {
      importedModuleSlugs.push(module.slug);
      const moduleResult = await database.query<{ id: string }>(`
        INSERT INTO learning_modules (course_id, slug, title, description, sort_order, prerequisite_slugs, estimated_minutes, completion_config, version, source_hash)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,$10)
        ON CONFLICT (course_id, slug) DO UPDATE SET title=EXCLUDED.title, description=EXCLUDED.description,
          sort_order=EXCLUDED.sort_order, prerequisite_slugs=EXCLUDED.prerequisite_slugs,
          estimated_minutes=EXCLUDED.estimated_minutes, completion_config=EXCLUDED.completion_config,
          version=EXCLUDED.version, enabled=true, source_hash=EXCLUDED.source_hash, updated_at=now()
        RETURNING id
      `, [courseId, module.slug, module.title, module.description, module.order, JSON.stringify(module.prerequisites),
        module.estimatedMinutes, JSON.stringify(module.completion), module.version, hash(module)]);
      const moduleId = moduleResult.rows[0]!.id;
      for (const item of module.items) {
        importedItemIds.push(item.id);
        const reference = 'questionSlugs' in item ? { questionSlugs: item.questionSlugs }
          : 'challengeSlugs' in item ? { challengeSlugs: item.challengeSlugs } : {};
        const theory = 'content' in item ? item.content : null;
        await database.query(`
          INSERT INTO learning_items (module_id, stable_id, slug, title, item_type, sort_order, category_slug, concept_slug,
            reference_config, theory_content, completion_config, version, source_hash)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13)
          ON CONFLICT (stable_id) DO UPDATE SET module_id=EXCLUDED.module_id, slug=EXCLUDED.slug,
            title=EXCLUDED.title, item_type=EXCLUDED.item_type, sort_order=EXCLUDED.sort_order,
            category_slug=EXCLUDED.category_slug, concept_slug=EXCLUDED.concept_slug,
            reference_config=EXCLUDED.reference_config, theory_content=EXCLUDED.theory_content,
            completion_config=EXCLUDED.completion_config, version=EXCLUDED.version,
            enabled=true, source_hash=EXCLUDED.source_hash, updated_at=now()
        `, [moduleId, item.id, item.slug, item.title, item.type, item.order, item.category, item.concept,
          JSON.stringify(reference), theory ? JSON.stringify(theory) : null, JSON.stringify(item.completion), item.version, hash(item)]);
      }
    }
    await database.query(`
      UPDATE learning_items SET enabled=false,updated_at=now()
      WHERE module_id IN (SELECT id FROM learning_modules WHERE course_id=$1)
        AND NOT (stable_id=ANY($2::varchar[])) AND enabled
    `, [courseId, importedItemIds]);
    await database.query(`
      UPDATE learning_modules SET enabled=false,updated_at=now()
      WHERE course_id=$1 AND NOT (slug=ANY($2::varchar[])) AND enabled
    `, [courseId, importedModuleSlugs]);
  }
  return loaded.report;
}

export function validateModuleGraph(course: string, modules: LearningPathModuleContent[]): void {
  const slugs = new Set<string>();
  const orders = new Set<number>();
  for (const module of modules) {
    if (slugs.has(module.slug)) throw new Error(`${course}: duplicate module slug ${module.slug}`);
    if (orders.has(module.order)) throw new Error(`${course}: duplicate module order ${module.order}`);
    slugs.add(module.slug); orders.add(module.order);
    const itemOrders = new Set<number>(); const itemSlugs = new Set<string>();
    for (const item of module.items) {
      if (itemOrders.has(item.order)) throw new Error(`${module.slug}: duplicate item order ${item.order}`);
      if (itemSlugs.has(item.slug)) throw new Error(`${module.slug}: duplicate item slug ${item.slug}`);
      itemOrders.add(item.order); itemSlugs.add(item.slug);
    }
  }
  for (const module of modules) for (const prerequisite of module.prerequisites) if (!slugs.has(prerequisite)) throw new Error(`${module.slug}: unknown prerequisite ${prerequisite}`);
  const bySlug = new Map(modules.map((module) => [module.slug, module]));
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (moduleSlug: string): void => {
    if (visiting.has(moduleSlug)) throw new Error(`${course}: circular module prerequisite at ${moduleSlug}`);
    if (visited.has(moduleSlug)) return;
    visiting.add(moduleSlug);
    for (const prerequisite of bySlug.get(moduleSlug)?.prerequisites ?? []) visit(prerequisite);
    visiting.delete(moduleSlug); visited.add(moduleSlug);
  };
  for (const module of modules) visit(module.slug);
}

export function validateLearningPathReferences(items: LearningPathItemContent[], questionSlugs: Set<string>, challengeSlugs: Set<string>): void {
  for (const item of items) {
    if ('questionSlugs' in item) for (const reference of item.questionSlugs) if (!questionSlugs.has(reference)) throw new Error(`${item.id}: unknown Linux Core question ${reference}`);
    if ('challengeSlugs' in item) for (const reference of item.challengeSlugs) if (!challengeSlugs.has(reference)) throw new Error(`${item.id}: unknown approved challenge ${reference}`);
  }
}

function ensureSameReferences(kind: string, expected: string[], actual: string[]): void {
  const found = new Set(actual);
  const missing = expected.filter((value) => !found.has(value));
  if (missing.length) throw new Error(`Missing enabled ${kind} references: ${missing.join(', ')}`);
}

function validationError(file: string, error: z.ZodError): Error {
  return new Error(`${file}: ${error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
}

function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((result, item) => { const value = key(item); result[value] = (result[value] ?? 0) + 1; return result; }, {});
}
