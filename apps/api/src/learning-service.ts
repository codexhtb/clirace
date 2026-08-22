import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

type LearningMode = 'quick' | 'standard' | 'full' | 'topic';
type Answer = { id: string; text: string };
type Snapshot = {
  slug: string;
  category: string;
  concept: string;
  difficulty: 'easy' | 'medium' | 'hard';
  type: 'single_choice' | 'multiple_choice' | 'scenario' | 'command_output';
  question: string;
  answers: Answer[];
  correctAnswerIds: string[];
  explanation: string;
  answerExplanations: Record<string, string>;
  shellPracticeChallengeSlug?: string;
  version: number;
};

type SessionRow = {
  id: string;
  user_id: string;
  course_slug: string;
  mode: LearningMode;
  category_filter: string | null;
  requested_count: number;
  total_questions: number;
  current_position: number;
  correct_count: number;
  score_percent: number | null;
  status: 'active' | 'completed' | 'abandoned';
  category_stats: Record<string, LearningStat>;
  concept_stats: Record<string, LearningStat>;
  started_at: Date;
  completed_at: Date | null;
};

type SessionQuestionRow = {
  position: number;
  option_order: string[];
  content_snapshot: Snapshot;
  selected_answer_ids: string[] | null;
  is_correct: boolean | null;
  answered_at: Date | null;
};

export interface LearningStat {
  answered: number;
  correct: number;
  accuracy: number;
  sufficientData: boolean;
}

export class LearningError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
  }
}

export class LearningService {
  constructor(private readonly database: Pool) {}

  async catalog(userId?: string): Promise<unknown> {
    const counts = await this.database.query<{ category_slug: string; count: number }>(`
      SELECT category_slug, count(*)::int AS count
      FROM learning_questions WHERE course_slug = 'linux-core' AND enabled
      GROUP BY category_slug ORDER BY category_slug
    `);
    const total = counts.rows.reduce((sum, row) => sum + row.count, 0);
    const progress = userId ? await this.progress(userId) : null;
    return {
      course: { slug: 'linux-core', title: 'Linux Core', description: 'Понимайте Linux, а не угадывайте команды.' },
      totalQuestions: total,
      categories: counts.rows.map((row) => ({ slug: row.category_slug, count: row.count })),
      modes: [
        { id: 'quick', title: 'Quick Check', questions: 10, available: total >= 10 },
        { id: 'standard', title: 'Standard', questions: 25, available: total >= 25 },
        { id: 'full', title: 'Full Assessment', questions: 50, available: total >= 50 },
        { id: 'topic', title: 'Topic Practice', questions: null, available: counts.rows.some((row) => row.count > 0) },
      ],
      progress,
    };
  }

  async current(userId: string): Promise<unknown | null> {
    const result = await this.database.query<{ id: string }>(`
      SELECT id FROM learning_sessions
      WHERE user_id = $1 AND course_slug = 'linux-core' AND status = 'active'
      ORDER BY started_at DESC LIMIT 1
    `, [userId]);
    return result.rows[0] ? this.getSession(userId, result.rows[0].id) : null;
  }

  async createSession(userId: string, mode: LearningMode, category?: string): Promise<unknown> {
    const existing = await this.current(userId);
    if (existing) return existing;
    if (mode === 'topic' && !category) throw new LearningError(400, 'category_required', 'Выберите тему для Topic Practice.');
    if (mode !== 'topic' && category) throw new LearningError(400, 'category_not_allowed', 'Фильтр темы доступен только в Topic Practice.');

    const requested = mode === 'quick' ? 10 : mode === 'standard' ? 25 : mode === 'full' ? 50 : 10;
    const available = await this.database.query<QuestionRow>(`
      SELECT id, slug, category_slug, concept_slug, difficulty, question_type, question_text,
             answer_options, correct_answer_ids, explanation, answer_explanations,
             shell_practice_challenge_slug, content_version
      FROM learning_questions
      WHERE course_slug = 'linux-core' AND enabled AND ($1::text IS NULL OR category_slug = $1)
    `, [mode === 'topic' ? category : null]);
    if (available.rows.length === 0) throw new LearningError(409, 'content_unavailable', 'Для выбранной темы пока нет вопросов.');
    if (mode !== 'topic' && available.rows.length < requested) {
      throw new LearningError(409, 'mode_unavailable', `Для режима нужно ${requested} уникальных вопросов; сейчас доступно ${available.rows.length}.`);
    }
    const count = mode === 'topic' ? Math.min(requested, available.rows.length) : requested;
    const sessionId = randomUUID();
    const selected = selectBalanced(available.rows, count, sessionId);
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        INSERT INTO learning_sessions (id, user_id, course_slug, mode, category_filter, requested_count, total_questions)
        VALUES ($1, $2, 'linux-core', $3, $4, $5, $6)
      `, [sessionId, userId, mode, mode === 'topic' ? category : null, requested, count]);
      for (let index = 0; index < selected.length; index += 1) {
        const question = selected[index]!;
        const snapshot = toSnapshot(question);
        const order = deterministicOrder(snapshot.answers.map((answer) => answer.id), `${sessionId}:${question.slug}`);
        await client.query(`
          INSERT INTO learning_session_questions (session_id, question_id, position, option_order, content_snapshot)
          VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
        `, [sessionId, question.id, index + 1, JSON.stringify(order), JSON.stringify(snapshot)]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if (isUniqueViolation(error)) {
        const active = await this.current(userId);
        if (active) return active;
      }
      throw error;
    } finally {
      client.release();
    }
    return this.getSession(userId, sessionId);
  }

  async getSession(userId: string, sessionId: string): Promise<unknown> {
    const sessionResult = await this.database.query<SessionRow>(`
      SELECT * FROM learning_sessions WHERE id = $1 AND user_id = $2
    `, [sessionId, userId]);
    const session = sessionResult.rows[0];
    if (!session) throw new LearningError(404, 'session_not_found', 'Учебная сессия не найдена.');
    if (session.status === 'completed') return this.completedPayload(session);

    const questionResult = await this.database.query<SessionQuestionRow>(`
      SELECT position, option_order, content_snapshot, selected_answer_ids, is_correct, answered_at
      FROM learning_session_questions WHERE session_id = $1 AND position = $2
    `, [session.id, session.current_position]);
    const row = questionResult.rows[0];
    if (!row) throw new LearningError(409, 'question_not_found', 'Текущий вопрос сессии недоступен.');
    return this.activePayload(session, row);
  }

  async submitAnswer(userId: string, sessionId: string, questionSlug: string, answerIds: string[]): Promise<unknown> {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const sessionResult = await client.query<SessionRow>(`
        SELECT * FROM learning_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE
      `, [sessionId, userId]);
      const session = sessionResult.rows[0];
      if (!session) throw new LearningError(404, 'session_not_found', 'Учебная сессия не найдена.');
      if (session.status !== 'active') throw new LearningError(409, 'session_finished', 'Эта сессия уже завершена.');
      const questionResult = await client.query<SessionQuestionRow>(`
        SELECT position, option_order, content_snapshot, selected_answer_ids, is_correct, answered_at
        FROM learning_session_questions WHERE session_id = $1 AND position = $2 FOR UPDATE
      `, [session.id, session.current_position]);
      const row = questionResult.rows[0];
      if (!row || row.content_snapshot.slug !== questionSlug) throw new LearningError(409, 'not_current_question', 'Ответ относится не к текущему вопросу.');
      if (row.answered_at) {
        await client.query('COMMIT');
        return this.activePayload(session, row);
      }
      validateSelectedAnswers(row.content_snapshot, answerIds);
      const correct = sameSet(answerIds, row.content_snapshot.correctAnswerIds);
      const saved = await client.query<SessionQuestionRow>(`
        UPDATE learning_session_questions
        SET selected_answer_ids = $3::jsonb, is_correct = $4, answered_at = now()
        WHERE session_id = $1 AND position = $2 AND answered_at IS NULL
        RETURNING position, option_order, content_snapshot, selected_answer_ids, is_correct, answered_at
      `, [session.id, session.current_position, JSON.stringify(answerIds), correct]);
      if (saved.rowCount === 1) {
        await client.query(`
          UPDATE learning_sessions SET correct_count = correct_count + $2::int, updated_at = now() WHERE id = $1
        `, [session.id, correct ? 1 : 0]);
        session.correct_count += correct ? 1 : 0;
      }
      await client.query('COMMIT');
      return this.activePayload(session, saved.rows[0] ?? row);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async next(userId: string, sessionId: string): Promise<unknown> {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<SessionRow>('SELECT * FROM learning_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE', [sessionId, userId]);
      const session = result.rows[0];
      if (!session) throw new LearningError(404, 'session_not_found', 'Учебная сессия не найдена.');
      if (session.status === 'completed') {
        await client.query('COMMIT');
        return this.completedPayload(session);
      }
      const current = await client.query<{ answered_at: Date | null }>(`
        SELECT answered_at FROM learning_session_questions WHERE session_id = $1 AND position = $2 FOR UPDATE
      `, [session.id, session.current_position]);
      if (!current.rows[0]?.answered_at) throw new LearningError(409, 'answer_required', 'Сначала зафиксируйте ответ.');
      if (session.current_position < session.total_questions) {
        await client.query('UPDATE learning_sessions SET current_position = current_position + 1, updated_at = now() WHERE id = $1', [session.id]);
        await client.query('COMMIT');
        return this.getSession(userId, session.id);
      }

      const answers = await client.query<{ content_snapshot: Snapshot; is_correct: boolean }>(`
        SELECT content_snapshot, is_correct FROM learning_session_questions
        WHERE session_id = $1 AND answered_at IS NOT NULL ORDER BY position
      `, [session.id]);
      const categoryStats = calculateStats(answers.rows, (row) => row.content_snapshot.category);
      const conceptStats = calculateStats(answers.rows, (row) => row.content_snapshot.concept);
      const score = Math.round((session.correct_count / session.total_questions) * 100);
      const completed = await client.query<SessionRow>(`
        UPDATE learning_sessions SET status = 'completed', score_percent = $2,
          category_stats = $3::jsonb, concept_stats = $4::jsonb, completed_at = now(), updated_at = now()
        WHERE id = $1 RETURNING *
      `, [session.id, score, JSON.stringify(categoryStats), JSON.stringify(conceptStats)]);
      await client.query('COMMIT');
      return this.completedPayload(completed.rows[0]!);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private activePayload(session: SessionRow, row: SessionQuestionRow): unknown {
    const snapshot = row.content_snapshot;
    const byId = new Map(snapshot.answers.map((answer) => [answer.id, answer]));
    const payload: Record<string, unknown> = {
      id: session.id,
      course: session.course_slug,
      mode: session.mode,
      category: session.category_filter,
      status: session.status,
      progress: { current: session.current_position, total: session.total_questions, answered: Boolean(row.answered_at) },
      question: {
        slug: snapshot.slug,
        category: snapshot.category,
        concept: snapshot.concept,
        difficulty: snapshot.difficulty,
        type: snapshot.type,
        text: snapshot.question,
        answers: row.option_order.map((id) => byId.get(id)).filter(Boolean),
      },
    };
    if (row.answered_at && row.selected_answer_ids && row.is_correct !== null) {
      const selectedWrongId = row.is_correct ? undefined : row.selected_answer_ids.find((id) => !snapshot.correctAnswerIds.includes(id));
      payload.feedback = {
        isCorrect: row.is_correct,
        selectedAnswerIds: row.selected_answer_ids,
        correctAnswerIds: snapshot.correctAnswerIds,
        explanation: snapshot.explanation,
        selectedAnswerExplanation: selectedWrongId ? snapshot.answerExplanations[selectedWrongId] : null,
        shellPracticeChallengeSlug: snapshot.shellPracticeChallengeSlug ?? null,
      };
    }
    return payload;
  }

  private completedPayload(session: SessionRow): unknown {
    const strong = Object.entries(session.category_stats).filter(([, stat]) => stat.sufficientData && stat.accuracy >= 80).map(([slug]) => slug);
    const weak = Object.entries(session.category_stats).filter(([, stat]) => stat.sufficientData && stat.accuracy < 60).map(([slug]) => slug);
    return {
      id: session.id,
      course: session.course_slug,
      mode: session.mode,
      status: 'completed',
      result: {
        correct: session.correct_count,
        total: session.total_questions,
        percent: session.score_percent ?? Math.round((session.correct_count / session.total_questions) * 100),
        categories: session.category_stats,
        concepts: session.concept_stats,
        strongAreas: strong,
        weakAreas: weak,
      },
      startedAt: session.started_at.toISOString(),
      completedAt: session.completed_at?.toISOString() ?? null,
    };
  }

  private async progress(userId: string): Promise<unknown> {
    const result = await this.database.query<{ content_snapshot: Snapshot; is_correct: boolean }>(`
      SELECT q.content_snapshot, q.is_correct
      FROM learning_session_questions q JOIN learning_sessions s ON s.id = q.session_id
      WHERE s.user_id = $1 AND s.course_slug = 'linux-core' AND q.answered_at IS NOT NULL
    `, [userId]);
    return {
      answered: result.rows.length,
      correct: result.rows.filter((row) => row.is_correct).length,
      categories: calculateStats(result.rows, (row) => row.content_snapshot.category),
      concepts: calculateStats(result.rows, (row) => row.content_snapshot.concept),
    };
  }
}

type QuestionRow = {
  id: string;
  slug: string;
  category_slug: string;
  concept_slug: string;
  difficulty: Snapshot['difficulty'];
  question_type: Snapshot['type'];
  question_text: string;
  answer_options: Answer[];
  correct_answer_ids: string[];
  explanation: string;
  answer_explanations: Record<string, string>;
  shell_practice_challenge_slug: string | null;
  content_version: number;
};

function toSnapshot(row: QuestionRow): Snapshot {
  return {
    slug: row.slug, category: row.category_slug, concept: row.concept_slug,
    difficulty: row.difficulty, type: row.question_type, question: row.question_text,
    answers: row.answer_options, correctAnswerIds: row.correct_answer_ids,
    explanation: row.explanation, answerExplanations: row.answer_explanations,
    ...(row.shell_practice_challenge_slug ? { shellPracticeChallengeSlug: row.shell_practice_challenge_slug } : {}),
    version: row.content_version,
  };
}

function selectBalanced(rows: QuestionRow[], count: number, seed: string): QuestionRow[] {
  const buckets = new Map<string, QuestionRow[]>();
  for (const row of rows) {
    const bucket = buckets.get(row.category_slug) ?? [];
    bucket.push(row);
    buckets.set(row.category_slug, bucket);
  }
  for (const bucket of buckets.values()) bucket.sort((a, b) => hash(`${seed}:${a.slug}`).localeCompare(hash(`${seed}:${b.slug}`)));
  const keys = [...buckets.keys()].sort((a, b) => hash(`${seed}:${a}`).localeCompare(hash(`${seed}:${b}`)));
  const selected: QuestionRow[] = [];
  while (selected.length < count) {
    let progressed = false;
    for (const key of keys) {
      const next = buckets.get(key)?.shift();
      if (next) { selected.push(next); progressed = true; }
      if (selected.length === count) break;
    }
    if (!progressed) break;
  }
  return selected;
}

function deterministicOrder(ids: string[], seed: string): string[] {
  return [...ids].sort((a, b) => hash(`${seed}:${a}`).localeCompare(hash(`${seed}:${b}`)));
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sameSet(left: string[], right: string[]): boolean {
  return left.length === right.length && [...new Set(left)].every((id) => right.includes(id));
}

function validateSelectedAnswers(snapshot: Snapshot, answerIds: string[]): void {
  if (answerIds.length === 0 || answerIds.length > snapshot.answers.length || new Set(answerIds).size !== answerIds.length) {
    throw new LearningError(400, 'invalid_answers', 'Выберите допустимый вариант ответа.');
  }
  const available = new Set(snapshot.answers.map((answer) => answer.id));
  if (answerIds.some((id) => !available.has(id))) throw new LearningError(400, 'invalid_answers', 'Выбран неизвестный вариант ответа.');
  if (snapshot.type !== 'multiple_choice' && answerIds.length !== 1) throw new LearningError(400, 'single_answer_required', 'Для этого вопроса нужен один ответ.');
}

function calculateStats<T extends { is_correct: boolean }>(rows: T[], key: (row: T) => string): Record<string, LearningStat> {
  const counts: Record<string, { answered: number; correct: number }> = {};
  for (const row of rows) {
    const slug = key(row);
    const stat = counts[slug] ?? { answered: 0, correct: 0 };
    stat.answered += 1;
    stat.correct += row.is_correct ? 1 : 0;
    counts[slug] = stat;
  }
  return Object.fromEntries(Object.entries(counts).map(([slug, stat]) => [slug, {
    ...stat,
    accuracy: Math.round((stat.correct / stat.answered) * 100),
    sufficientData: stat.answered >= 2,
  }]));
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
