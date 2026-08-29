import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { loadAndValidateLinuxCoreContent } from './learning-content.js';
import { listSandboxChallenges, sandboxChallengeCatalogSlug } from './sandbox-challenges.js';
import { listChallengeLibraryV2 } from './challenge-library-v2/catalog.js';

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
  completion: z.object({ requireAll: z.literal(true), optional: z.boolean().optional() }).strict(),
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
  canonicalChallengeLibrary: z.literal(2).optional(),
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
  lessons: number;
  questionReferences: number;
  uniqueQuestionReferences: number;
  challengeReferences: number;
  uniqueChallengeReferences: number;
  zeroToOperator: null | {
    modules: number; lessons: number; questions: number; reusedQuestions: number;
    newQuestions: number; requiredPractice: number; optionalPractice: number;
  };
  linuxOperator: null | {
    modules: number; lessons: number; questions: number; reusedQuestions: number;
    newQuestions: number; requiredPractice: number; optionalPractice: number;
    uniqueCanonicalChallenges: number; newChallenges: number;
  };
}

export async function loadAndValidateLearningPathsContent(): Promise<{ courses: LearningPathCourseContent[]; report: LearningPathDatasetReport }> {
  const root = new URL('../../../content/learning-paths/', import.meta.url);
  const courseDirectories = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const linuxCore = await loadAndValidateLinuxCoreContent();
  const questionSlugs = new Set(linuxCore.questions.filter((question) => question.enabled).map((question) => question.slug));
  const challengeSlugs = new Set(listSandboxChallenges().map(sandboxChallengeCatalogSlug));
  const courses: LearningPathCourseContent[] = [];
  const allCourseSlugs = new Set<string>();
  const allItemIds = new Set<string>();
  const warnings: string[] = [];
  let zeroToOperator: LearningPathDatasetReport['zeroToOperator'] = null;
  let linuxOperator: LearningPathDatasetReport['linuxOperator'] = null;

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
    const courseItems = modules.flatMap((module) => module.items);
    validateLearningPathReferences(courseItems, questionSlugs, challengeSlugs);
    validateStructuredText(parsedCourse.data.slug, modules);
    if (parsedCourse.data.canonicalChallengeLibrary === 2) {
      validateCanonicalPracticeReferences(parsedCourse.data.slug, courseItems);
    }
    if (parsedCourse.data.slug === 'linux-zero-to-operator') {
      zeroToOperator = validateZeroToOperatorCourse(modules, linuxCore.questions.map((question) => question.slug));
    }
    if (parsedCourse.data.slug === 'linux-operator') {
      linuxOperator = validateLinuxOperatorCourse(modules, linuxCore.questions.map((question) => question.slug));
    }
    const { modules: _filenames, ...course } = parsedCourse.data;
    courses.push({ ...course, modules });
  }

  const knownCourses = new Set(courses.map((course) => course.slug));
  for (const course of courses) for (const prerequisite of course.prerequisites) {
    if (prerequisite === course.slug || !knownCourses.has(prerequisite)) {
      throw new Error(`${course.slug}: invalid course prerequisite ${prerequisite}`);
    }
  }

  const items = courses.flatMap((course) => course.modules.flatMap((module) => module.items));
  const questionReferences = items.flatMap((item) => 'questionSlugs' in item ? item.questionSlugs : []);
  const challengeReferences = items.flatMap((item) => 'challengeSlugs' in item ? item.challengeSlugs : []);
  return {
    courses,
    report: {
      courses: courses.length,
      modules: courses.reduce((sum, course) => sum + course.modules.length, 0),
      items: items.length,
      byType: countBy(items, (item) => item.type),
      invalidReferences: 0,
      warnings,
      lessons: items.filter((item) => item.type === 'theory').length,
      questionReferences: questionReferences.length,
      uniqueQuestionReferences: new Set(questionReferences).size,
      challengeReferences: challengeReferences.length,
      uniqueChallengeReferences: new Set(challengeReferences).size,
      zeroToOperator,
      linuxOperator,
    },
  };
}

export function validateZeroToOperatorCourse(modules: LearningPathModuleContent[], allQuestionSlugs: string[]): NonNullable<LearningPathDatasetReport['zeroToOperator']> {
  if (modules.length !== 17) throw new Error(`linux-zero-to-operator: expected 17 modules, received ${modules.length}`);
  const lessonTitles = new Set<string>();
  const questionReferences: string[] = [];
  const requiredPractice: string[] = [];
  const optionalPractice: string[] = [];
  for (const [index, module] of modules.entries()) {
    const theory = module.items.filter((item) => item.type === 'theory');
    const knowledge = module.items.filter((item) => item.type === 'knowledge_check');
    const checkpoints = module.items.filter((item) => item.type === 'checkpoint');
    const required = module.items.filter((item) => (item.type === 'practice' || item.type === 'shell_lab') && item.completion.optional !== true);
    const optional = module.items.filter((item) => (item.type === 'practice' || item.type === 'shell_lab') && item.completion.optional === true);
    if (theory.length !== 4 || knowledge.length !== 4 || checkpoints.length !== 1 || required.length !== 1 || optional.length !== 1) {
      throw new Error(`${module.slug}: expected four lesson/quiz pairs, one required lab, one optional practice and one checkpoint`);
    }
    if (index === 0 ? module.prerequisites.length !== 0 : module.prerequisites.length !== 1 || module.prerequisites[0] !== modules[index - 1]?.slug) {
      throw new Error(`${module.slug}: course prerequisite chain is not linear`);
    }
    for (const item of theory) {
      const normalizedTitle = item.title.toLocaleLowerCase('ru-RU').replace(/\s+/gu, ' ').trim();
      if (lessonTitles.has(normalizedTitle)) throw new Error(`${item.id}: duplicate lesson title`);
      lessonTitles.add(normalizedTitle);
      if (item.content.length < 5) throw new Error(`${item.id}: lesson needs theory, example and summary blocks`);
    }
    questionReferences.push(...knowledge.flatMap((item) => 'questionSlugs' in item ? item.questionSlugs : []),
      ...checkpoints.flatMap((item) => 'questionSlugs' in item ? item.questionSlugs : []));
    requiredPractice.push(...required.flatMap((item) => 'challengeSlugs' in item ? item.challengeSlugs : []));
    optionalPractice.push(...optional.flatMap((item) => 'challengeSlugs' in item ? item.challengeSlugs : []));
  }
  if (lessonTitles.size !== 68) throw new Error(`linux-zero-to-operator: expected 68 lessons, received ${lessonTitles.size}`);
  if (questionReferences.length !== 187 || new Set(questionReferences).size !== questionReferences.length) {
    throw new Error('linux-zero-to-operator: expected 187 unique question references');
  }
  if (requiredPractice.length !== 17 || optionalPractice.length !== 34 || new Set([...requiredPractice, ...optionalPractice]).size !== 51) {
    throw new Error('linux-zero-to-operator: practice references must contain 17 required and 34 unique optional challenges');
  }
  const newQuestions = questionReferences.filter((slugValue) => slugValue.startsWith('zto-'));
  const questionSet = new Set(allQuestionSlugs);
  const orphaned = allQuestionSlugs.filter((slugValue) => slugValue.startsWith('zto-') && !questionReferences.includes(slugValue));
  if (newQuestions.length !== 162 || orphaned.length || questionReferences.some((slugValue) => !questionSet.has(slugValue))) {
    throw new Error(`linux-zero-to-operator: invalid question ownership or orphaned content (${orphaned.join(', ')})`);
  }
  return {
    modules: modules.length, lessons: lessonTitles.size, questions: questionReferences.length,
    reusedQuestions: questionReferences.length - newQuestions.length, newQuestions: newQuestions.length,
    requiredPractice: requiredPractice.length, optionalPractice: optionalPractice.length,
  };
}

export function validateLinuxOperatorCourse(modules: LearningPathModuleContent[], allQuestionSlugs: string[]): NonNullable<LearningPathDatasetReport['linuxOperator']> {
  if (modules.length !== 14) throw new Error(`linux-operator: expected 14 modules, received ${modules.length}`);
  const lessonTitles = new Set<string>();
  const questionReferences: string[] = [];
  const requiredPractice: string[] = [];
  const optionalPractice: string[] = [];
  const unsafeLabTerms = /(?:https?:\/\/(?!127\.0\.0\.1|localhost)|\bsudo\b|\bsystemctl\b|\bjournalctl\b|\bmount\b|\bmkfs\b|\bfdisk\b)/iu;
  for (const [index, module] of modules.entries()) {
    const theory = module.items.filter((item) => item.type === 'theory');
    const knowledge = module.items.filter((item) => item.type === 'knowledge_check');
    const checkpoints = module.items.filter((item) => item.type === 'checkpoint');
    const required = module.items.filter((item) => (item.type === 'practice' || item.type === 'shell_lab') && item.completion.optional !== true);
    const optional = module.items.filter((item) => (item.type === 'practice' || item.type === 'shell_lab') && item.completion.optional === true);
    if (theory.length !== 4 || knowledge.length !== 4 || checkpoints.length !== 1 || required.length !== 1 || optional.length !== 1) {
      throw new Error(`${module.slug}: Linux Operator expects four lesson/quiz pairs, one required lab, one optional practice and one checkpoint`);
    }
    if (index === 0 ? module.prerequisites.length !== 0 : module.prerequisites.length !== 1 || module.prerequisites[0] !== modules[index - 1]?.slug) {
      throw new Error(`${module.slug}: Linux Operator prerequisite chain is not linear`);
    }
    for (const item of theory) {
      const normalizedTitle = item.title.toLocaleLowerCase('ru-RU').replace(/\s+/gu, ' ').trim();
      if (lessonTitles.has(normalizedTitle)) throw new Error(`${item.id}: duplicate Operator lesson title`);
      lessonTitles.add(normalizedTitle);
      const commandBlocks = item.content.filter((block) => block.type === 'code');
      if (item.content.length < 5 || commandBlocks.length !== 1) throw new Error(`${item.id}: Operator lesson needs one focused command example`);
      if (commandBlocks.some((block) => block.type === 'code' && unsafeLabTerms.test(block.code))) {
        throw new Error(`${item.id}: Operator example depends on Internet or unsupported privileges`);
      }
    }
    questionReferences.push(...knowledge.flatMap((item) => 'questionSlugs' in item ? item.questionSlugs : []),
      ...checkpoints.flatMap((item) => 'questionSlugs' in item ? item.questionSlugs : []));
    requiredPractice.push(...required.flatMap((item) => 'challengeSlugs' in item ? item.challengeSlugs : []));
    optionalPractice.push(...optional.flatMap((item) => 'challengeSlugs' in item ? item.challengeSlugs : []));
  }
  const allReferences = [...requiredPractice, ...optionalPractice];
  if (lessonTitles.size !== 56) throw new Error(`linux-operator: expected 56 lessons, received ${lessonTitles.size}`);
  if (questionReferences.length !== 154 || new Set(questionReferences).size !== 154) throw new Error('linux-operator: expected 154 unique question references');
  if (requiredPractice.length !== 14 || optionalPractice.length !== 43 || new Set(allReferences).size !== 57) {
    throw new Error('linux-operator: expected 14 required and 43 optional unique canonical challenge references');
  }
  const newQuestions = questionReferences.filter((value) => value.startsWith('operator-'));
  const allQuestions = new Set(allQuestionSlugs);
  const orphaned = allQuestionSlugs.filter((value) => value.startsWith('operator-') && !questionReferences.includes(value));
  if (newQuestions.length !== 137 || orphaned.length || questionReferences.some((value) => !allQuestions.has(value))) {
    throw new Error(`linux-operator: invalid question ownership or orphaned content (${orphaned.join(', ')})`);
  }
  return {
    modules: modules.length, lessons: lessonTitles.size, questions: questionReferences.length,
    reusedQuestions: questionReferences.length - newQuestions.length, newQuestions: newQuestions.length,
    requiredPractice: requiredPractice.length, optionalPractice: optionalPractice.length,
    uniqueCanonicalChallenges: new Set(allReferences).size, newChallenges: 0,
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
  for (const module of modules) for (const prerequisite of module.prerequisites) {
    const dependency = modules.find((candidate) => candidate.slug === prerequisite)!;
    if (dependency.order >= module.order) throw new Error(`${module.slug}: prerequisite ${prerequisite} must come earlier in the course`);
  }
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

export function validateCanonicalPracticeReferences(course: string, items: LearningPathItemContent[]): void {
  const practiceEligible = new Set(listChallengeLibraryV2().filter((challenge) => challenge.availability.practice).map((challenge) => challenge.id));
  for (const item of items) if ('challengeSlugs' in item) for (const reference of item.challengeSlugs) {
    if (!practiceEligible.has(reference)) throw new Error(`${course}/${item.id}: challenge ${reference} is not Practice-eligible Library V2 content`);
  }
}

export function validateStructuredText(course: string, modules: LearningPathModuleContent[]): void {
  const unsafeHtml = /<\/?[a-z][^>]*>/iu;
  for (const module of modules) for (const item of module.items) {
    if (!('content' in item)) continue;
    for (const block of item.content) {
      const values = 'items' in block ? block.items : ['code' in block ? block.code : block.text];
      if (values.some((value) => unsafeHtml.test(value))) throw new Error(`${course}/${item.id}: raw HTML is not allowed in lesson content`);
    }
  }
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
