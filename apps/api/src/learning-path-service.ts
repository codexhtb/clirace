import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { LearningService } from './learning-service.js';

type ItemType = 'theory' | 'knowledge_check' | 'practice' | 'shell_lab' | 'checkpoint';
type CourseRow = {
  id: string; slug: string; title: string; description: string; version: number; sort_order: number;
  estimated_minutes: number; level: string;
};
type ModuleRow = {
  id: string; course_id: string; slug: string; title: string; description: string; sort_order: number;
  prerequisite_slugs: string[]; estimated_minutes: number;
};
type ItemRow = {
  id: string; module_id: string; stable_id: string; slug: string; title: string; item_type: ItemType;
  sort_order: number; category_slug: string; concept_slug: string; reference_config: ReferenceConfig;
  theory_content: TheoryBlock[] | null; completion_config: CompletionConfig; version: number;
};
type ReferenceConfig = { questionSlugs?: string[]; challengeSlugs?: string[] };
type CompletionConfig = { passThreshold?: number; requireAll?: boolean; explicitContinue?: boolean };
type TheoryBlock =
  | { type: 'heading'; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'bullets'; items: string[] }
  | { type: 'code'; language: 'bash'; code: string }
  | { type: 'note'; tone: 'note' | 'warning'; text: string };
type EnrollmentRow = {
  id: string; user_id: string; course_id: string; course_version_started: number; status: 'active' | 'completed';
  current_module_id: string | null; current_item_id: string | null; progress_percent: number; final_score: number | null;
  started_at: Date; completed_at: Date | null; last_activity_at: Date;
};
type ProgressRow = {
  enrollment_id: string; item_id: string; status: 'started' | 'failed' | 'completed'; score_percent: number | null;
  attempt_count: number; evidence: Record<string, unknown>; completed_at: Date | null;
};
type ModuleResultRow = {
  module_id: string; knowledge_score: number | null; practice_score: number | null; lab_score: number | null;
  checkpoint_score: number | null; mastery_score: number | null; recommendations: string[]; completed_at: Date;
};

export const MASTERY_WEIGHTS = Object.freeze({ knowledge: 35, practice: 25, lab: 20, checkpoint: 20 });
export const MASTERY_MINIMUM_EVIDENCE = 3;

export class LearningPathError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) { super(message); }
}

export class LearningPathService {
  private readonly learning: LearningService;

  constructor(private readonly database: Pool) { this.learning = new LearningService(database); }

  async catalog(userId?: string): Promise<unknown> {
    const courses = await this.database.query<CourseRow>(`
      SELECT id, slug, title, description, version, sort_order, estimated_minutes, level
      FROM learning_courses WHERE enabled ORDER BY sort_order, id
    `);
    const enrollment = userId ? await this.database.query<EnrollmentRow>(`
      SELECT e.* FROM learning_enrollments e JOIN learning_courses c ON c.id=e.course_id
      WHERE e.user_id=$1 ORDER BY e.last_activity_at DESC
    `, [userId]) : null;
    const byCourse = new Map(enrollment?.rows.map((row) => [row.course_id, row]) ?? []);
    return {
      courses: courses.rows.map((course) => ({
        slug: course.slug, title: course.title, description: course.description, version: course.version,
        estimatedMinutes: course.estimated_minutes, level: course.level,
        enrollment: byCourse.get(course.id) ? publicEnrollment(byCourse.get(course.id)!) : null,
      })),
    };
  }

  async course(courseSlug: string, userId?: string): Promise<unknown> {
    if (!userId) return this.publicCourse(await this.loadStructure(this.database, courseSlug));
    const existing = await this.findEnrollment(userId, courseSlug);
    if (!existing) return this.publicCourse(await this.loadStructure(this.database, courseSlug));
    return this.sync(userId, courseSlug);
  }

  async enroll(userId: string, courseSlug: string): Promise<unknown> {
    const structure = await this.loadStructure(this.database, courseSlug);
    const firstModule = structure.modules[0];
    const firstItem = firstModule?.items[0];
    if (!firstModule || !firstItem) throw new LearningPathError(409, 'course_empty', 'Курс пока не содержит учебных модулей.');
    await this.database.query(`
      INSERT INTO learning_enrollments (
        id, user_id, course_id, course_version_started, current_module_id, current_item_id
      ) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (user_id, course_id) DO UPDATE SET last_activity_at=learning_enrollments.last_activity_at
    `, [randomUUID(), userId, structure.course.id, structure.course.version, firstModule.id, firstItem.id]);
    return this.sync(userId, courseSlug);
  }

  async item(userId: string, courseSlug: string, moduleSlug: string, itemSlug: string): Promise<unknown> {
    const state = await this.syncState(userId, courseSlug);
    const module = state.structure.modules.find((candidate) => candidate.slug === moduleSlug);
    const item = module?.items.find((candidate) => candidate.slug === itemSlug);
    if (!module || !item) throw new LearningPathError(404, 'item_not_found', 'Учебный шаг не найден.');
    const moduleState = state.moduleStates.get(module.id)!;
    const itemState = state.itemStates.get(item.id)!;
    if (moduleState.status === 'locked' || itemState.status === 'locked') throw new LearningPathError(409, 'item_locked', 'Сначала завершите предыдущий учебный шаг.');

    const challenges = item.reference_config.challengeSlugs?.length
      ? await this.database.query<{ slug: string; title: string; description: string; difficulty: string; type: string; completed: boolean }>(`
          SELECT c.slug,c.title,c.description,c.difficulty,c.type,EXISTS (
            SELECT 1 FROM results r JOIN session_tasks st ON st.id=r.session_task_id
            WHERE r.user_id=$2 AND r.correct AND st.challenge_id=c.id
          ) AS completed
          FROM challenges c WHERE c.enabled AND c.slug = ANY($1::varchar[])
          ORDER BY array_position($1::varchar[], c.slug)
        `, [item.reference_config.challengeSlugs, userId])
      : null;
    return {
      course: courseSummary(state.structure.course),
      module: moduleSummary(module, moduleState),
      item: {
        stableId: item.stable_id, slug: item.slug, title: item.title, type: item.item_type,
        category: item.category_slug, concept: item.concept_slug, version: item.version,
        status: itemState.status, score: itemState.score,
        recommendations: itemState.status === 'failed' ? [
          `Повторите теорию модуля «${module.title}».`,
          `Вернитесь к практике по теме «${item.category_slug}».`,
        ] : [],
        theory: item.item_type === 'theory' ? item.theory_content : undefined,
        questionCount: item.reference_config.questionSlugs?.length,
        passThreshold: item.completion_config.passThreshold,
        challenges: challenges?.rows ?? undefined,
      },
      resume: state.resume,
    };
  }

  async completeTheory(userId: string, courseSlug: string, stableItemId: string): Promise<unknown> {
    const state = await this.syncState(userId, courseSlug);
    const access = ensureCurrentItem(state, stableItemId, 'theory');
    await this.database.query(`
      INSERT INTO learning_item_progress (enrollment_id, item_id, status, score_percent, attempt_count, evidence, completed_at)
      VALUES ($1,$2,'completed',100,1,'{"explicitContinue":true}'::jsonb,now())
      ON CONFLICT (enrollment_id,item_id) DO UPDATE SET status='completed', score_percent=100,
        attempt_count=GREATEST(learning_item_progress.attempt_count,1), evidence=EXCLUDED.evidence,
        completed_at=coalesce(learning_item_progress.completed_at,now()), updated_at=now()
    `, [state.enrollment.id, access.item.id]);
    return this.sync(userId, courseSlug);
  }

  async startAssessment(userId: string, courseSlug: string, stableItemId: string): Promise<unknown> {
    const state = await this.syncState(userId, courseSlug);
    const access = ensureCurrentItem(state, stableItemId, ['knowledge_check', 'checkpoint']);
    const questionSlugs = access.item.reference_config.questionSlugs ?? [];
    if (!questionSlugs.length) throw new LearningPathError(409, 'assessment_empty', 'Для проверки не настроены вопросы.');
    return this.learning.createPathSession(userId, state.enrollment.id, access.item.id, questionSlugs);
  }

  async sync(userId: string, courseSlug: string): Promise<unknown> {
    const state = await this.syncState(userId, courseSlug);
    return this.statePayload(state);
  }

  async profile(userId: string): Promise<unknown[]> {
    const enrollments = await this.database.query<{
      slug: string; title: string; status: string; progress_percent: number; final_score: number | null;
      started_at: Date; completed_at: Date | null; current_module: string | null;
    }>(`
      SELECT c.slug,c.title,e.status,e.progress_percent,e.final_score,e.started_at,e.completed_at,m.title AS current_module
      FROM learning_enrollments e JOIN learning_courses c ON c.id=e.course_id
      LEFT JOIN learning_modules m ON m.id=e.current_module_id
      WHERE e.user_id=$1 ORDER BY e.last_activity_at DESC
    `, [userId]);
    const mastery = await this.database.query<{ category_slug: string; score: number | null; sufficient_data: boolean }>(`
      SELECT category_slug,score,sufficient_data FROM learning_mastery
      WHERE user_id=$1 ORDER BY score DESC NULLS LAST,category_slug
    `, [userId]);
    return enrollments.rows.map((row) => ({
      slug: row.slug, title: row.title, status: row.status, progress: row.progress_percent,
      finalScore: row.final_score, currentModule: row.current_module,
      startedAt: row.started_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null,
      mastery: mastery.rows.filter((entry) => entry.sufficient_data).slice(0, 4).map((entry) => ({ category: entry.category_slug, score: entry.score })),
    }));
  }

  private async syncState(userId: string, courseSlug: string): Promise<SyncedState> {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const structure = await this.loadStructure(client, courseSlug);
      const enrollmentResult = await client.query<EnrollmentRow>(`
        SELECT * FROM learning_enrollments WHERE user_id=$1 AND course_id=$2 FOR UPDATE
      `, [userId, structure.course.id]);
      const enrollment = enrollmentResult.rows[0];
      if (!enrollment) throw new LearningPathError(409, 'not_enrolled', 'Сначала начните курс.');
      const state = await this.reconcileLocked(client, userId, structure, enrollment);
      await client.query('COMMIT');
      return state;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  private async reconcileLocked(client: PoolClient, userId: string, structure: CourseStructure, enrollment: EnrollmentRow): Promise<SyncedState> {
    const items = structure.modules.flatMap((module) => module.items);
    const assessmentSessions = await client.query<{
      learning_path_item_id: string; id: string; score_percent: number; total_questions: number;
    }>(`
      SELECT DISTINCT ON (learning_path_item_id) learning_path_item_id,id,score_percent,total_questions
      FROM learning_sessions
      WHERE user_id=$1 AND learning_enrollment_id=$2 AND learning_path_item_id IS NOT NULL AND status='completed'
      ORDER BY learning_path_item_id,completed_at DESC,id DESC
    `, [userId, enrollment.id]);
    const latestAssessment = new Map(assessmentSessions.rows.map((row) => [row.learning_path_item_id, row]));
    const challengeSlugs = [...new Set(items.flatMap((item) => item.reference_config.challengeSlugs ?? []))];
    const completedChallenges = challengeSlugs.length ? await client.query<{ slug: string }>(`
      SELECT DISTINCT c.slug FROM results r JOIN session_tasks st ON st.id=r.session_task_id
      JOIN challenges c ON c.id=st.challenge_id WHERE r.user_id=$1 AND r.correct AND c.slug=ANY($2::varchar[])
    `, [userId, challengeSlugs]) : { rows: [] as Array<{ slug: string }> };
    const completedChallengeSet = new Set(completedChallenges.rows.map((row) => row.slug));
    const existingProgress = await client.query<ProgressRow>('SELECT * FROM learning_item_progress WHERE enrollment_id=$1 FOR UPDATE', [enrollment.id]);
    const progress = new Map(existingProgress.rows.map((row) => [row.item_id, row]));

    for (const item of items) {
      if (progress.get(item.id)?.status === 'completed') continue;
      if (item.item_type === 'knowledge_check' || item.item_type === 'checkpoint') {
        const session = latestAssessment.get(item.id);
        if (!session || progress.get(item.id)?.evidence.sessionId === session.id) continue;
        const threshold = item.completion_config.passThreshold ?? 70;
        const passed = session.score_percent >= threshold;
        const row = await upsertProgress(client, enrollment.id, item.id, passed ? 'completed' : 'failed', session.score_percent,
          { sessionId: session.id, questions: session.total_questions, threshold }, passed);
        progress.set(item.id, row);
      } else if (item.item_type === 'practice' || item.item_type === 'shell_lab') {
        const required = item.reference_config.challengeSlugs ?? [];
        if (required.length && required.every((slug) => completedChallengeSet.has(slug))) {
          const row = await upsertProgress(client, enrollment.id, item.id, 'completed', 100,
            { challengeSlugs: required, policy: 'stable-slug-compatible-completion' }, true);
          progress.set(item.id, row);
        }
      }
    }

    const moduleIds = structure.modules.map((module) => module.id);
    const moduleResultQuery = await client.query<ModuleResultRow>(`
      SELECT * FROM learning_module_results WHERE enrollment_id=$1 AND module_id=ANY($2::bigint[])
    `, [enrollment.id, moduleIds]);
    const moduleResults = new Map(moduleResultQuery.rows.map((row) => [row.module_id, row]));
    for (const module of structure.modules) {
      if (moduleResults.has(module.id) || !module.items.every((item) => progress.get(item.id)?.status === 'completed')) continue;
      const scores = moduleScores(module, progress);
      const mastery = calculateMastery(scores);
      const checkpointItem = module.items.find((item) => item.item_type === 'checkpoint');
      const recommendations = deterministicRecommendations(module, scores);
      const saved = await client.query<ModuleResultRow>(`
        INSERT INTO learning_module_results (enrollment_id,module_id,knowledge_score,practice_score,lab_score,checkpoint_score,mastery_score,recommendations)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
        ON CONFLICT (enrollment_id,module_id) DO UPDATE SET knowledge_score=EXCLUDED.knowledge_score,
          practice_score=EXCLUDED.practice_score,lab_score=EXCLUDED.lab_score,
          checkpoint_score=EXCLUDED.checkpoint_score,mastery_score=EXCLUDED.mastery_score,
          recommendations=EXCLUDED.recommendations
        RETURNING *
      `, [enrollment.id, module.id, scores.knowledge, scores.practice, scores.lab, scores.checkpoint, mastery, JSON.stringify(recommendations)]);
      moduleResults.set(module.id, saved.rows[0]!);
      const evidenceCount = module.items.reduce((sum, item) => sum + (item.reference_config.questionSlugs?.length ?? item.reference_config.challengeSlugs?.length ?? 0), 0);
      const category = checkpointItem?.category_slug ?? module.items[0]!.category_slug;
      const concept = checkpointItem?.concept_slug ?? module.items[0]!.concept_slug;
      await client.query(`
        INSERT INTO learning_mastery (user_id,category_slug,concept_slug,evidence_count,score,sufficient_data)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (user_id,category_slug,concept_slug) DO UPDATE SET
          evidence_count=GREATEST(learning_mastery.evidence_count,EXCLUDED.evidence_count),
          score=EXCLUDED.score,sufficient_data=EXCLUDED.sufficient_data,updated_at=now()
      `, [userId, category, concept, evidenceCount, mastery, evidenceCount >= MASTERY_MINIMUM_EVIDENCE]);
    }

    const completedItems = items.filter((item) => progress.get(item.id)?.status === 'completed').length;
    const progressPercent = Math.round((completedItems / items.length) * 100);
    const moduleStates = buildModuleStates(structure.modules, moduleResults);
    const itemStates = buildItemStates(structure.modules, moduleStates, progress);
    const currentModule = structure.modules.find((module) => moduleStates.get(module.id)?.status === 'current' || moduleStates.get(module.id)?.status === 'available') ?? null;
    const currentItem = currentModule?.items.find((item) => itemStates.get(item.id)?.status === 'current') ?? null;
    const allModulesComplete = moduleResults.size === structure.modules.length;
    const courseCompleted = enrollment.status === 'completed' || allModulesComplete;
    let finalScore = enrollment.final_score;
    if (allModulesComplete && enrollment.status !== 'completed') {
      const courseScores = aggregateCourseScores([...moduleResults.values()]);
      finalScore = calculateMastery(courseScores);
      const masteryRows = await client.query<{ category_slug: string; score: number | null; sufficient_data: boolean }>(`
        SELECT category_slug,score,sufficient_data FROM learning_mastery WHERE user_id=$1
      `, [userId]);
      const strong = masteryRows.rows.filter((row) => row.sufficient_data && (row.score ?? 0) >= 80).map((row) => row.category_slug);
      const weak = masteryRows.rows.filter((row) => row.sufficient_data && (row.score ?? 100) < 65).map((row) => row.category_slug);
      await client.query(`
        INSERT INTO learning_course_results (enrollment_id,knowledge_score,practice_score,lab_score,checkpoint_score,overall_score,strong_areas,weak_areas)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) ON CONFLICT (enrollment_id) DO NOTHING
      `, [enrollment.id, courseScores.knowledge, courseScores.practice, courseScores.lab, courseScores.checkpoint,
        finalScore, JSON.stringify(strong), JSON.stringify(weak)]);
    }
    const updated = await client.query<EnrollmentRow>(`
      UPDATE learning_enrollments SET status=$2::varchar,current_module_id=$3,current_item_id=$4,
        progress_percent=$5,final_score=$6,completed_at=CASE WHEN $2::varchar='completed' THEN coalesce(completed_at,now()) ELSE completed_at END,
        last_activity_at=now() WHERE id=$1 RETURNING *
    `, [enrollment.id, courseCompleted ? 'completed' : 'active', courseCompleted ? null : currentModule?.id ?? null,
      courseCompleted ? null : currentItem?.id ?? null, enrollment.status === 'completed' ? 100 : progressPercent, finalScore]);
    return {
      structure, enrollment: updated.rows[0]!, progress, moduleResults, moduleStates, itemStates,
      resume: currentModule && currentItem ? { module: currentModule.slug, item: currentItem.slug, title: currentItem.title } : null,
    };
  }

  private statePayload(state: SyncedState): unknown {
    return {
      course: courseSummary(state.structure.course),
      enrollment: publicEnrollment(state.enrollment),
      modules: state.structure.modules.map((module) => ({
        ...moduleSummary(module, state.moduleStates.get(module.id)!),
        items: module.items.map((item) => {
          const itemState = state.itemStates.get(item.id)!;
          return { stableId: item.stable_id, slug: item.slug, title: item.title, type: item.item_type, status: itemState.status, score: itemState.score };
        }),
        result: state.moduleResults.get(module.id) ? publicModuleResult(state.moduleResults.get(module.id)!) : null,
      })),
      resume: state.resume,
    };
  }

  private publicCourse(structure: CourseStructure): unknown {
    return {
      course: courseSummary(structure.course),
      enrollment: null,
      modules: structure.modules.map((module) => ({
        slug: module.slug, title: module.title, description: module.description, order: module.sort_order,
        estimatedMinutes: module.estimated_minutes, prerequisites: module.prerequisite_slugs,
        itemCount: module.items.length,
      })),
    };
  }

  private async findEnrollment(userId: string, courseSlug: string): Promise<EnrollmentRow | null> {
    const result = await this.database.query<EnrollmentRow>(`
      SELECT e.* FROM learning_enrollments e JOIN learning_courses c ON c.id=e.course_id
      WHERE e.user_id=$1 AND c.slug=$2
    `, [userId, courseSlug]);
    return result.rows[0] ?? null;
  }

  private async loadStructure(database: Pool | PoolClient, courseSlug: string): Promise<CourseStructure> {
    const courseResult = await database.query<CourseRow>(`
      SELECT id,slug,title,description,version,sort_order,estimated_minutes,level
      FROM learning_courses WHERE slug=$1 AND enabled
    `, [courseSlug]);
    const course = courseResult.rows[0];
    if (!course) throw new LearningPathError(404, 'course_not_found', 'Учебный путь не найден.');
    const modules = await database.query<ModuleRow>(`
      SELECT id,course_id,slug,title,description,sort_order,prerequisite_slugs,estimated_minutes
      FROM learning_modules WHERE course_id=$1 AND enabled ORDER BY sort_order,id
    `, [course.id]);
    const items = await database.query<ItemRow>(`
      SELECT i.id,i.module_id,i.stable_id,i.slug,i.title,i.item_type,i.sort_order,i.category_slug,i.concept_slug,
        i.reference_config,i.theory_content,i.completion_config,i.version
      FROM learning_items i JOIN learning_modules m ON m.id=i.module_id
      WHERE m.course_id=$1 AND i.enabled ORDER BY m.sort_order,i.sort_order,i.id
    `, [course.id]);
    return { course, modules: modules.rows.map((module) => ({ ...module, items: items.rows.filter((item) => item.module_id === module.id) })) };
  }
}

type CourseModule = ModuleRow & { items: ItemRow[] };
type CourseStructure = { course: CourseRow; modules: CourseModule[] };
type ModuleState = { status: 'completed' | 'current' | 'available' | 'locked'; completedItems: number; totalItems: number };
type ItemState = { status: 'completed' | 'failed' | 'current' | 'available' | 'locked'; score: number | null };
type SyncedState = {
  structure: CourseStructure; enrollment: EnrollmentRow; progress: Map<string, ProgressRow>;
  moduleResults: Map<string, ModuleResultRow>; moduleStates: Map<string, ModuleState>;
  itemStates: Map<string, ItemState>; resume: { module: string; item: string; title: string } | null;
};

async function upsertProgress(client: PoolClient, enrollmentId: string, itemId: string, status: ProgressRow['status'], score: number,
  evidence: Record<string, unknown>, completed: boolean): Promise<ProgressRow> {
  const result = await client.query<ProgressRow>(`
    INSERT INTO learning_item_progress (enrollment_id,item_id,status,score_percent,attempt_count,evidence,completed_at)
    VALUES ($1,$2,$3,$4,1,$5::jsonb,CASE WHEN $6 THEN now() ELSE NULL END)
    ON CONFLICT (enrollment_id,item_id) DO UPDATE SET status=EXCLUDED.status,score_percent=EXCLUDED.score_percent,
      attempt_count=learning_item_progress.attempt_count+1,evidence=EXCLUDED.evidence,
      completed_at=CASE WHEN $6 THEN coalesce(learning_item_progress.completed_at,now()) ELSE NULL END,updated_at=now()
    RETURNING *
  `, [enrollmentId, itemId, status, score, JSON.stringify(evidence), completed]);
  return result.rows[0]!;
}

function buildModuleStates(modules: CourseModule[], results: Map<string, ModuleResultRow>): Map<string, ModuleState> {
  const completedSlugs = new Set(modules.filter((module) => results.has(module.id)).map((module) => module.slug));
  const states = new Map<string, ModuleState>();
  let currentAssigned = false;
  for (const module of modules) {
    const completed = results.has(module.id);
    const unlocked = module.prerequisite_slugs.every((slug) => completedSlugs.has(slug));
    const status: ModuleState['status'] = completed ? 'completed' : !unlocked ? 'locked' : !currentAssigned ? 'current' : 'available';
    if (status === 'current') currentAssigned = true;
    states.set(module.id, { status, completedItems: 0, totalItems: module.items.length });
  }
  return states;
}

function buildItemStates(modules: CourseModule[], moduleStates: Map<string, ModuleState>, progress: Map<string, ProgressRow>): Map<string, ItemState> {
  const states = new Map<string, ItemState>();
  for (const module of modules) {
    const moduleState = moduleStates.get(module.id)!;
    let previousComplete = true;
    let currentAssigned = false;
    let completedItems = 0;
    for (const item of module.items) {
      const saved = progress.get(item.id);
      const completed = saved?.status === 'completed';
      if (completed) completedItems += 1;
      const status: ItemState['status'] = completed ? 'completed'
        : moduleState.status === 'locked' || !previousComplete ? 'locked'
          : !currentAssigned ? (saved?.status === 'failed' ? 'failed' : 'current') : 'available';
      if (status === 'current' || status === 'failed') currentAssigned = true;
      states.set(item.id, { status, score: saved?.score_percent ?? null });
      previousComplete = completed;
    }
    moduleState.completedItems = completedItems;
  }
  return states;
}

function ensureCurrentItem(state: SyncedState, stableId: string, expected: ItemType | ItemType[]): { module: CourseModule; item: ItemRow } {
  for (const module of state.structure.modules) {
    const item = module.items.find((candidate) => candidate.stable_id === stableId);
    if (!item) continue;
    const allowed = Array.isArray(expected) ? expected.includes(item.item_type) : item.item_type === expected;
    if (!allowed) throw new LearningPathError(400, 'wrong_item_type', 'Этот учебный шаг нельзя завершить таким способом.');
    const status = state.itemStates.get(item.id)?.status;
    if (status === 'locked' || status === 'available') throw new LearningPathError(409, 'item_locked', 'Сначала завершите предыдущий учебный шаг.');
    return { module, item };
  }
  throw new LearningPathError(404, 'item_not_found', 'Учебный шаг не найден.');
}

function moduleScores(module: CourseModule, progress: Map<string, ProgressRow>) {
  return {
    knowledge: average(module.items.filter((item) => item.item_type === 'knowledge_check').map((item) => progress.get(item.id)?.score_percent ?? 0), 100),
    practice: average(module.items.filter((item) => item.item_type === 'practice').map((item) => progress.get(item.id)?.score_percent ?? 0), 100),
    lab: average(module.items.filter((item) => item.item_type === 'shell_lab').map((item) => progress.get(item.id)?.score_percent ?? 0), 100),
    checkpoint: average(module.items.filter((item) => item.item_type === 'checkpoint').map((item) => progress.get(item.id)?.score_percent ?? 0), 100),
  };
}

export function calculateMastery(scores: { knowledge: number; practice: number; lab: number; checkpoint: number }): number {
  return Math.round((scores.knowledge * MASTERY_WEIGHTS.knowledge + scores.practice * MASTERY_WEIGHTS.practice
    + scores.lab * MASTERY_WEIGHTS.lab + scores.checkpoint * MASTERY_WEIGHTS.checkpoint) / 100);
}

export function masteryPresentation(score: number, evidenceCount: number): { sufficientData: boolean; score: number | null } {
  return evidenceCount >= MASTERY_MINIMUM_EVIDENCE ? { sufficientData: true, score: Math.round(score) } : { sufficientData: false, score: null };
}

function aggregateCourseScores(results: ModuleResultRow[]) {
  return {
    knowledge: average(results.map((row) => row.knowledge_score ?? 0), 0),
    practice: average(results.map((row) => row.practice_score ?? 0), 0),
    lab: average(results.map((row) => row.lab_score ?? 0), 0),
    checkpoint: average(results.map((row) => row.checkpoint_score ?? 0), 0),
  };
}

function deterministicRecommendations(module: CourseModule, scores: ReturnType<typeof moduleScores>): string[] {
  const recommendations: string[] = [];
  if (scores.knowledge < 80) recommendations.push(`Повторите теорию модуля «${module.title}».`);
  if (scores.checkpoint < 80) recommendations.push(`Повторите checkpoint по теме «${module.title}».`);
  return recommendations;
}

function courseSummary(course: CourseRow) {
  return { slug: course.slug, title: course.title, description: course.description, version: course.version,
    estimatedMinutes: course.estimated_minutes, level: course.level };
}
function moduleSummary(module: CourseModule, state: ModuleState) {
  return { slug: module.slug, title: module.title, description: module.description, order: module.sort_order,
    estimatedMinutes: module.estimated_minutes, prerequisites: module.prerequisite_slugs,
    status: state.status, completedItems: state.completedItems, totalItems: state.totalItems };
}
function publicEnrollment(row: EnrollmentRow) {
  return { status: row.status, progress: row.progress_percent, finalScore: row.final_score,
    startedAt: row.started_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null,
    lastActivityAt: row.last_activity_at.toISOString() };
}
function publicModuleResult(row: ModuleResultRow) {
  return { knowledge: row.knowledge_score, practice: row.practice_score, lab: row.lab_score,
    checkpoint: row.checkpoint_score, mastery: row.mastery_score, recommendations: row.recommendations,
    completedAt: row.completed_at.toISOString() };
}
function average(values: number[], fallback: number): number { return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : fallback; }
