import type { PoolClient } from 'pg';

interface CompletedSessionStats {
  score: number;
  total: number;
  correct: number;
  best_streak: number;
  mode: string;
  rating_applied: boolean;
  daily_challenge_id: string | null;
}

export async function finalizeCompletedSession(
  client: PoolClient,
  sessionId: string,
  userId: string,
): Promise<number> {
  const sessionStats = await client.query<CompletedSessionStats>(`
    SELECT gs.score, gs.best_streak, gs.mode, gs.rating_applied, gs.daily_challenge_id,
           count(st.id)::int AS total,
           count(*) FILTER (WHERE st.status = 'correct')::int AS correct
    FROM game_sessions gs
    JOIN session_tasks st ON st.game_session_id = gs.id
    WHERE gs.id = $1 AND gs.user_id = $2 AND gs.status = 'completed'
    GROUP BY gs.id
  `, [sessionId, userId]);
  const stats = sessionStats.rows[0];
  if (!stats || stats.rating_applied) return 0;

  const overallDelta = calculateRatingDelta(stats.total, stats.correct, stats.score);
  await upsertRating(client, userId, null, overallDelta);

  const categoryStats = await client.query<{
    category_id: number; total: number; correct: number; score: number;
  }>(`
    SELECT c.category_id,
           count(st.id)::int AS total,
           count(*) FILTER (WHERE st.status = 'correct')::int AS correct,
           coalesce(sum(st.score_awarded), 0)::int AS score
    FROM session_tasks st
    JOIN challenges c ON c.id = st.challenge_id
    WHERE st.game_session_id = $1
    GROUP BY c.category_id
  `, [sessionId]);
  for (const category of categoryStats.rows) {
    await upsertRating(
      client,
      userId,
      category.category_id,
      calculateRatingDelta(category.total, category.correct, category.score),
    );
  }

  let dailyStreak = 0;
  const dailyCompleted = Boolean(stats.daily_challenge_id) && stats.total > 0 && stats.correct === stats.total;
  if (dailyCompleted) dailyStreak = await updateDailyStreak(client, userId);

  await unlockAchievement(client, userId, 'first-run');
  if (stats.total >= 5 && stats.correct === stats.total) await unlockAchievement(client, userId, 'perfect-five');
  if (stats.best_streak >= 5) await unlockAchievement(client, userId, 'streak-five');
  if (stats.mode === 'real_shell' && stats.correct > 0) await unlockAchievement(client, userId, 'shell-rookie');
  if (dailyCompleted) await unlockAchievement(client, userId, 'daily-one');
  if (dailyStreak >= 3) await unlockAchievement(client, userId, 'daily-three');

  const solved = await client.query<{ total: number }>(`
    SELECT count(*)::int AS total FROM results WHERE user_id = $1 AND correct
  `, [userId]);
  if ((solved.rows[0]?.total ?? 0) >= 100) await unlockAchievement(client, userId, 'hundred-tasks');

  await client.query(`
    UPDATE game_sessions SET rating_delta = $2, rating_applied = true WHERE id = $1
  `, [sessionId, overallDelta]);
  return overallDelta;
}

async function upsertRating(
  client: PoolClient,
  userId: string,
  categoryId: number | null,
  delta: number,
): Promise<void> {
  await client.query(`
    INSERT INTO user_ratings (user_id, category_id, rating, games_played)
    VALUES ($1, $2, GREATEST(0, 1000 + $3), 1)
    ON CONFLICT (user_id, category_id) DO UPDATE
    SET rating = GREATEST(0, user_ratings.rating + $3),
        games_played = user_ratings.games_played + 1,
        updated_at = now()
  `, [userId, categoryId, delta]);
}

async function updateDailyStreak(client: PoolClient, userId: string): Promise<number> {
  const result = await client.query<{ current_daily_streak: number }>(`
    INSERT INTO user_progress (user_id, current_daily_streak, best_daily_streak, last_daily_date)
    VALUES ($1, 1, 1, CURRENT_DATE)
    ON CONFLICT (user_id) DO UPDATE SET
      current_daily_streak = CASE
        WHEN user_progress.last_daily_date = CURRENT_DATE THEN user_progress.current_daily_streak
        WHEN user_progress.last_daily_date = CURRENT_DATE - 1 THEN user_progress.current_daily_streak + 1
        ELSE 1
      END,
      best_daily_streak = GREATEST(
        user_progress.best_daily_streak,
        CASE
          WHEN user_progress.last_daily_date = CURRENT_DATE THEN user_progress.current_daily_streak
          WHEN user_progress.last_daily_date = CURRENT_DATE - 1 THEN user_progress.current_daily_streak + 1
          ELSE 1
        END
      ),
      last_daily_date = CURRENT_DATE,
      updated_at = now()
    RETURNING current_daily_streak
  `, [userId]);
  return result.rows[0]?.current_daily_streak ?? 1;
}

async function unlockAchievement(client: PoolClient, userId: string, slug: string): Promise<void> {
  await client.query(`
    INSERT INTO user_achievements (user_id, achievement_id)
    SELECT $1, id FROM achievements WHERE slug = $2
    ON CONFLICT DO NOTHING
  `, [userId, slug]);
}

function calculateRatingDelta(total: number, correct: number, score: number): number {
  if (total <= 0) return 0;
  const accuracy = correct / total;
  const scoreBonus = Math.min(10, score / Math.max(1, total * 50));
  return Math.max(-24, Math.min(36, Math.round((accuracy - 0.5) * 48 + scoreBonus)));
}
