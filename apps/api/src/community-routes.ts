import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { visibleDivision } from './ranked-config.js';
import { RankedService } from './ranked-service.js';
import { LearningPathService } from './learning-path-service.js';
import type { Dependencies } from './services.js';

const usernameSchema = z.object({
  username: z.string().min(3).max(24).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
});

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(15),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

const leaderboardQuerySchema = z.object({
  category: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/).default('overall'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

interface PublicUserRow {
  id: string;
  username: string;
  created_at: Date;
}

interface HistoryRow {
  id: string;
  mode: string;
  difficulty: string | null;
  score: number;
  best_streak: number;
  rating_delta: number;
  started_at: Date;
  completed_at: Date;
  category_slug: string | null;
  category_name: string | null;
  total: number;
  correct: number;
  skipped: number;
  duration_ms: number;
}

interface RankedHistoryRow {
  battle_id: string;
  room_code: string;
  opponent_username: string;
  winner_id: string | null;
  outcome: 'player_a_win' | 'player_b_win' | 'no_contest';
  mmr_before: number;
  mmr_after: number;
  division_before: string;
  division_after: string;
  created_at: Date;
}

export async function registerCommunityRoutes(
  app: FastifyInstance,
  dependencies: Dependencies,
  rankedService = new RankedService(dependencies),
): Promise<void> {
  const learningPaths = new LearningPathService(dependencies.postgres);
  app.get('/api/profiles/:username', async (request, reply) => {
    const params = usernameSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply);
    const user = await findPublicUser(dependencies, params.data.username);
    if (!user) return notFound(reply);

    const [overallResult, statsResult, ranked, rankedHistory, ratingsResult, rankResult, historyResult, progressResult, achievementResult, learningResult, pathProgress] = await Promise.all([
      dependencies.postgres.query<{ rating: number; games_played: number }>(`
        SELECT rating, games_played FROM user_ratings
        WHERE user_id = $1 AND category_id IS NULL
      `, [user.id]),
      dependencies.postgres.query<{
        runs: number; total_score: number; best_streak: number;
        tasks: number; correct: number; duration_ms: string;
      }>(`
        SELECT
          count(DISTINCT gs.id)::int AS runs,
          coalesce(max(session_totals.total_score), 0)::int AS total_score,
          coalesce(max(session_totals.best_streak), 0)::int AS best_streak,
          count(r.id) FILTER (WHERE gs.id IS NOT NULL)::int AS tasks,
          count(*) FILTER (WHERE gs.id IS NOT NULL AND r.correct)::int AS correct,
          coalesce(sum(r.duration_ms) FILTER (WHERE gs.id IS NOT NULL), 0)::bigint AS duration_ms
        FROM users u
        LEFT JOIN results r ON r.user_id = u.id
        LEFT JOIN session_tasks st ON st.id = r.session_task_id
        LEFT JOIN game_sessions gs ON gs.id = st.game_session_id AND gs.status = 'completed'
        LEFT JOIN LATERAL (
          SELECT coalesce(sum(score), 0)::int AS total_score,
                 coalesce(max(best_streak), 0)::int AS best_streak
          FROM game_sessions completed
          WHERE completed.user_id = u.id AND completed.status = 'completed'
        ) session_totals ON true
        WHERE u.id = $1
        GROUP BY u.id
      `, [user.id]),
      rankedService.stats(user.id),
      loadRankedHistory(dependencies, user.id, 10),
      dependencies.postgres.query<{
        slug: string; name: string; rating: number; games_played: number; updated_at: Date;
      }>(`
        SELECT c.slug, c.name, ur.rating, ur.games_played, ur.updated_at
        FROM user_ratings ur
        JOIN categories c ON c.id = ur.category_id
        WHERE ur.user_id = $1 AND ur.games_played > 0
        ORDER BY ur.rating DESC, c.sort_order, c.name
      `, [user.id]),
      dependencies.postgres.query<{ rank: string }>(`
        SELECT ranked.rank
        FROM (
          SELECT user_id, row_number() OVER (ORDER BY rating DESC, games_played DESC, user_id)::int AS rank
          FROM user_ratings
          WHERE category_id IS NULL AND games_played > 0
        ) ranked
        WHERE ranked.user_id = $1
      `, [user.id]),
      loadHistory(dependencies, user.id, 10, 0),
      dependencies.postgres.query<{
        current_daily_streak: number; best_daily_streak: number; last_daily_date: string | null;
      }>(`
        SELECT current_daily_streak, best_daily_streak, last_daily_date
        FROM user_progress WHERE user_id = $1
      `, [user.id]),
      dependencies.postgres.query<{
        slug: string; title: string; description: string; icon: string; unlocked_at: Date;
      }>(`
        SELECT a.slug, a.title, a.description, a.icon, ua.unlocked_at
        FROM user_achievements ua
        JOIN achievements a ON a.id = ua.achievement_id
        WHERE ua.user_id = $1
        ORDER BY a.sort_order, ua.unlocked_at
      `, [user.id]),
      dependencies.postgres.query<{
        assessments: number; answered: number; correct: number; active: boolean;
      }>(`
        SELECT
          count(DISTINCT ls.id) FILTER (WHERE ls.status = 'completed')::int AS assessments,
          count(lsq.question_id) FILTER (WHERE lsq.answered_at IS NOT NULL)::int AS answered,
          count(lsq.question_id) FILTER (WHERE lsq.is_correct)::int AS correct,
          coalesce(bool_or(ls.status = 'active'), false) AS active
        FROM users u
        LEFT JOIN learning_sessions ls ON ls.user_id = u.id
        LEFT JOIN learning_session_questions lsq ON lsq.session_id = ls.id
        WHERE u.id = $1
        GROUP BY u.id
      `, [user.id]),
      learningPaths.profile(user.id),
    ]);

    const overall = overallResult.rows[0] ?? { rating: 1000, games_played: 0 };
    const stats = statsResult.rows[0] ?? {
      runs: 0, total_score: 0, best_streak: 0, tasks: 0, correct: 0, duration_ms: '0',
    };
    const progress = progressResult.rows[0];
    const learning = learningResult.rows[0] ?? { assessments: 0, answered: 0, correct: 0, active: false };
    return reply.header('cache-control', 'public, max-age=30').send({
      profile: {
        username: user.username,
        memberSince: user.created_at.toISOString(),
        overall: {
          rating: overall.rating,
          gamesPlayed: overall.games_played,
          rank: rankResult.rows[0] ? Number(rankResult.rows[0].rank) : null,
        },
        stats: {
          runs: stats.runs,
          totalScore: stats.total_score,
          bestStreak: stats.best_streak,
          tasks: stats.tasks,
          correct: stats.correct,
          accuracy: stats.tasks > 0 ? Math.round((stats.correct / stats.tasks) * 100) : 0,
          durationMs: Number(stats.duration_ms),
        },
        ratings: ratingsResult.rows.map((rating) => ({
          slug: rating.slug,
          name: rating.name,
          rating: rating.rating,
          gamesPlayed: rating.games_played,
          updatedAt: rating.updated_at.toISOString(),
        })),
        dailyStreak: {
          current: progress?.current_daily_streak ?? 0,
          best: progress?.best_daily_streak ?? 0,
          lastDate: progress?.last_daily_date ?? null,
        },
        achievements: achievementResult.rows.map((achievement) => ({
          slug: achievement.slug,
          title: achievement.title,
          description: achievement.description,
          icon: achievement.icon,
          unlockedAt: achievement.unlocked_at.toISOString(),
        })),
        recentRuns: historyResult.rows.map(publicHistoryRow),
        ranked: {
          ...ranked,
          recentMatches: rankedHistory.rows.map((match) => ({
            battleId: match.battle_id,
            roomCode: match.room_code,
            opponent: match.opponent_username,
            result: match.outcome === 'no_contest' ? 'no_contest' : match.winner_id === user.id ? 'win' : 'loss',
            mmrBefore: match.mmr_before,
            mmrAfter: match.mmr_after,
            delta: match.mmr_after - match.mmr_before,
            divisionBefore: match.division_before,
            divisionAfter: match.division_after,
            playedAt: match.created_at.toISOString(),
          })),
        },
        learning: {
          assessments: learning.assessments,
          answered: learning.answered,
          correct: learning.correct,
          accuracy: learning.answered > 0 ? Math.round((learning.correct / learning.answered) * 100) : 0,
          active: learning.active,
        },
        learningPaths: pathProgress,
      },
    });
  });

  app.get('/api/profiles/:username/history', async (request, reply) => {
    const params = usernameSchema.safeParse(request.params);
    const query = historyQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return invalidRequest(reply);
    const user = await findPublicUser(dependencies, params.data.username);
    if (!user) return notFound(reply);
    const [history, total] = await Promise.all([
      loadHistory(dependencies, user.id, query.data.limit, query.data.offset),
      dependencies.postgres.query<{ total: number }>(`
        SELECT count(*)::int AS total FROM game_sessions
        WHERE user_id = $1 AND status = 'completed'
      `, [user.id]),
    ]);
    return reply.header('cache-control', 'public, max-age=30').send({
      username: user.username,
      total: total.rows[0]?.total ?? 0,
      runs: history.rows.map(publicHistoryRow),
    });
  });

  app.get('/api/leaderboard', async (request, reply) => {
    const query = leaderboardQuerySchema.safeParse(request.query);
    if (!query.success) return invalidRequest(reply);
    if (query.data.category === 'ranked') {
      return rankedLeaderboard(reply, dependencies, query.data.limit, query.data.offset);
    }
    const category = query.data.category === 'overall'
      ? null
      : await dependencies.postgres.query<{ id: number; slug: string; name: string }>(`
          SELECT id, slug, name FROM categories WHERE slug = $1 AND enabled
        `, [query.data.category]).then((result) => result.rows[0] ?? undefined);
    if (query.data.category !== 'overall' && !category) return notFound(reply, 'Категория не найдена.');

    const categoryId = category?.id ?? null;
    const entries = await dependencies.postgres.query<{
      rank: number; username: string; rating: number; games_played: number;
      total_score: string; best_streak: number; tasks: number; correct: number;
    }>(`
      WITH session_stats AS (
        SELECT user_id,
               coalesce(sum(score), 0)::bigint AS total_score,
               coalesce(max(best_streak), 0)::int AS best_streak
        FROM game_sessions
        WHERE status = 'completed'
        GROUP BY user_id
      ), result_stats AS (
        SELECT r.user_id, count(*)::int AS tasks,
               count(*) FILTER (WHERE r.correct)::int AS correct
        FROM results r
        JOIN session_tasks st ON st.id = r.session_task_id
        JOIN game_sessions gs ON gs.id = st.game_session_id AND gs.status = 'completed'
        GROUP BY r.user_id
      ), ranked AS (
        SELECT ur.user_id, ur.rating, ur.games_played,
               row_number() OVER (ORDER BY ur.rating DESC, ur.games_played DESC, u.username_normalized)::int AS rank
        FROM user_ratings ur
        JOIN users u ON u.id = ur.user_id
        WHERE ur.category_id IS NOT DISTINCT FROM $1 AND ur.games_played > 0
      )
      SELECT ranked.rank, u.username, ranked.rating, ranked.games_played,
             coalesce(ss.total_score, 0)::bigint AS total_score,
             coalesce(ss.best_streak, 0)::int AS best_streak,
             coalesce(rs.tasks, 0)::int AS tasks,
             coalesce(rs.correct, 0)::int AS correct
      FROM ranked
      JOIN users u ON u.id = ranked.user_id
      LEFT JOIN session_stats ss ON ss.user_id = ranked.user_id
      LEFT JOIN result_stats rs ON rs.user_id = ranked.user_id
      ORDER BY ranked.rank
      LIMIT $2 OFFSET $3
    `, [categoryId, query.data.limit, query.data.offset]);
    const total = await dependencies.postgres.query<{ total: number }>(`
      SELECT count(*)::int AS total FROM user_ratings
      WHERE category_id IS NOT DISTINCT FROM $1 AND games_played > 0
    `, [categoryId]);

    return reply.header('cache-control', 'public, max-age=20').send({
      board: category ? { slug: category.slug, name: category.name } : { slug: 'overall', name: 'Общий рейтинг' },
      total: total.rows[0]?.total ?? 0,
      entries: entries.rows.map((entry) => ({
        rank: entry.rank,
        username: entry.username,
        rating: entry.rating,
        gamesPlayed: entry.games_played,
        totalScore: Number(entry.total_score),
        bestStreak: entry.best_streak,
        accuracy: entry.tasks > 0 ? Math.round((entry.correct / entry.tasks) * 100) : 0,
      })),
    });
  });
}

async function findPublicUser(dependencies: Dependencies, username: string): Promise<PublicUserRow | undefined> {
  const result = await dependencies.postgres.query<PublicUserRow>(`
    SELECT id, username, created_at FROM users WHERE username_normalized = $1
  `, [username.toLowerCase()]);
  return result.rows[0];
}

async function rankedLeaderboard(
  reply: FastifyReply,
  dependencies: Dependencies,
  limit: number,
  offset: number,
) {
  const [entries, total] = await Promise.all([
    dependencies.postgres.query<{
      rank: number; username: string; mmr: number; games_played: number;
      wins: number; losses: number; placement_games_completed: number;
    }>(`
      WITH ranked AS (
        SELECT stats.user_id, stats.mmr, stats.games_played, stats.wins, stats.losses,
               stats.placement_games_completed,
               row_number() OVER (
                 ORDER BY stats.mmr DESC, stats.wins DESC, stats.games_played ASC, u.username_normalized
               )::int AS rank
        FROM user_ranked_stats stats
        JOIN users u ON u.id = stats.user_id
        WHERE stats.games_played > 0 AND u.account_status = 'active'
      )
      SELECT ranked.*, u.username FROM ranked
      JOIN users u ON u.id = ranked.user_id
      ORDER BY ranked.rank LIMIT $1 OFFSET $2
    `, [limit, offset]),
    dependencies.postgres.query<{ total: number }>(`
      SELECT count(*)::int AS total FROM user_ranked_stats stats
      JOIN users u ON u.id = stats.user_id
      WHERE stats.games_played > 0 AND u.account_status = 'active'
    `),
  ]);
  return reply.header('cache-control', 'public, max-age=20').send({
    board: { slug: 'ranked', name: 'Ranked' },
    total: total.rows[0]?.total ?? 0,
    entries: entries.rows.map((entry) => ({
      rank: entry.rank,
      username: entry.username,
      rating: entry.mmr,
      mmr: entry.mmr,
      gamesPlayed: entry.games_played,
      wins: entry.wins,
      losses: entry.losses,
      placementGamesCompleted: entry.placement_games_completed,
      division: visibleDivision(entry.mmr, entry.games_played),
      provisional: entry.games_played < 5,
      totalScore: 0,
      bestStreak: 0,
      accuracy: entry.games_played > 0 ? Math.round((entry.wins / entry.games_played) * 100) : 0,
    })),
  });
}

function loadRankedHistory(dependencies: Dependencies, userId: string, limit: number) {
  return dependencies.postgres.query<RankedHistoryRow>(`
    SELECT result.battle_id, battle.room_code, opponent.username AS opponent_username,
           result.winner_id, result.outcome,
           CASE WHEN result.player_a_id = $1 THEN result.player_a_mmr_before ELSE result.player_b_mmr_before END AS mmr_before,
           CASE WHEN result.player_a_id = $1 THEN result.player_a_mmr_after ELSE result.player_b_mmr_after END AS mmr_after,
           CASE WHEN result.player_a_id = $1 THEN result.player_a_division_before ELSE result.player_b_division_before END AS division_before,
           CASE WHEN result.player_a_id = $1 THEN result.player_a_division_after ELSE result.player_b_division_after END AS division_after,
           result.created_at
    FROM ranked_match_results result
    JOIN battles battle ON battle.id = result.battle_id
    JOIN users opponent ON opponent.id = CASE
      WHEN result.player_a_id = $1 THEN result.player_b_id ELSE result.player_a_id END
    WHERE result.player_a_id = $1 OR result.player_b_id = $1
    ORDER BY result.created_at DESC, result.id DESC
    LIMIT $2
  `, [userId, limit]);
}

function loadHistory(dependencies: Dependencies, userId: string, limit: number, offset: number) {
  return dependencies.postgres.query<HistoryRow>(`
    SELECT gs.id, gs.mode, gs.difficulty, gs.score, gs.best_streak, gs.rating_delta,
           gs.started_at, gs.completed_at,
           c.slug AS category_slug, c.name AS category_name,
           count(st.id)::int AS total,
           count(*) FILTER (WHERE st.status = 'correct')::int AS correct,
           count(*) FILTER (WHERE st.status = 'skipped')::int AS skipped,
           coalesce(sum(r.duration_ms), 0)::int AS duration_ms
    FROM game_sessions gs
    LEFT JOIN categories c ON c.id = gs.category_id
    JOIN session_tasks st ON st.game_session_id = gs.id
    LEFT JOIN results r ON r.session_task_id = st.id
    WHERE gs.user_id = $1 AND gs.status = 'completed'
    GROUP BY gs.id, c.slug, c.name
    ORDER BY gs.completed_at DESC
    LIMIT $2 OFFSET $3
  `, [userId, limit, offset]);
}

function publicHistoryRow(row: HistoryRow) {
  return {
    id: row.id,
    mode: row.mode,
    difficulty: row.difficulty,
    score: row.score,
    bestStreak: row.best_streak,
    ratingDelta: row.rating_delta,
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at.toISOString(),
    category: row.category_slug ? { slug: row.category_slug, name: row.category_name } : null,
    total: row.total,
    correct: row.correct,
    skipped: row.skipped,
    durationMs: row.duration_ms,
  };
}

function invalidRequest(reply: FastifyReply) {
  return reply.code(400).send({ error: 'Invalid request', message: 'Некорректные параметры запроса.' });
}

function notFound(reply: FastifyReply, message = 'Профиль не найден.') {
  return reply.code(404).send({ error: 'Not found', message });
}
