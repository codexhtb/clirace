import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  INITIAL_RANKED_MMR,
  PLACEMENT_MATCHES,
  calculateRankedRating,
  visibleDivision,
  type RankedDivision,
} from './ranked-config.js';
import type { Dependencies } from './services.js';

interface RankedStatsRow {
  user_id: string;
  mmr: number;
  games_played: number;
  wins: number;
  losses: number;
  placement_games_completed: number;
}

interface RankedBattleRow {
  id: string;
  mode: 'private' | 'quick' | 'ranked';
  status: 'waiting' | 'countdown' | 'running' | 'finished' | 'cancelled';
  winner_user_id: string | null;
}

export interface PublicRankedStats {
  mmr: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
  placementGamesCompleted: number;
  placementGamesRequired: number;
  division: RankedDivision;
  provisional: boolean;
}

export interface RankedApplication {
  status: 'applied' | 'already_applied' | 'not_ranked' | 'not_eligible';
  battleId: string;
  result?: RankedBattleResult;
}

export interface RankedBattleResult {
  battleId: string;
  outcome: 'player_a_win' | 'player_b_win' | 'no_contest';
  noContestReason: string | null;
  winnerId: string | null;
  players: Array<{
    userId: string;
    mmrBefore: number;
    mmrAfter: number;
    delta: number;
    divisionBefore: RankedDivision;
    divisionAfter: RankedDivision;
  }>;
  createdAt: string;
}

export class RankedService {
  constructor(private readonly dependencies: Dependencies) {}

  async stats(userId: string): Promise<PublicRankedStats> {
    await this.dependencies.postgres.query(`
      INSERT INTO user_ranked_stats (user_id) VALUES ($1)
      ON CONFLICT (user_id) DO NOTHING
    `, [userId]);
    const row = await this.dependencies.postgres.query<RankedStatsRow>(
      'SELECT * FROM user_ranked_stats WHERE user_id = $1', [userId],
    ).then((result) => result.rows[0]);
    return publicStats(row);
  }

  async getBattleResult(battleId: string): Promise<RankedBattleResult | null> {
    const result = await this.dependencies.postgres.query('SELECT * FROM ranked_match_results WHERE battle_id = $1', [battleId]);
    return result.rows[0] ? publicBattleResult(result.rows[0]) : null;
  }

  async applyFinishedBattle(client: PoolClient, battleId: string): Promise<RankedApplication> {
    const battle = await client.query<RankedBattleRow>(
      'SELECT id, mode, status, winner_user_id FROM battles WHERE id = $1 FOR UPDATE', [battleId],
    ).then((result) => result.rows[0]);
    if (!battle || battle.mode !== 'ranked') return { status: 'not_ranked', battleId };
    const existing = await this.loadResult(client, battleId);
    if (existing) return { status: 'already_applied', battleId, result: existing };
    if (battle.status !== 'finished' || !battle.winner_user_id) return { status: 'not_eligible', battleId };

    const players = await client.query<{ user_id: string }>(`
      SELECT user_id FROM battle_players WHERE battle_id = $1 ORDER BY user_id FOR UPDATE
    `, [battleId]);
    if (players.rows.length !== 2 || !players.rows.some((row) => row.user_id === battle.winner_user_id)) {
      return { status: 'not_eligible', battleId };
    }
    const ids = players.rows.map((row) => row.user_id).sort(compareIds);
    await this.ensureStats(client, ids);
    const stats = await this.lockStats(client, ids);
    const first = stats.find((row) => row.user_id === ids[0])!;
    const second = stats.find((row) => row.user_id === ids[1])!;
    const firstWon = first.user_id === battle.winner_user_id;
    const firstChange = calculateRankedRating(
      { mmr: first.mmr, gamesPlayed: first.games_played },
      { mmr: second.mmr, gamesPlayed: second.games_played },
      firstWon ? 1 : 0,
    );
    const secondChange = calculateRankedRating(
      { mmr: second.mmr, gamesPlayed: second.games_played },
      { mmr: first.mmr, gamesPlayed: first.games_played },
      firstWon ? 0 : 1,
    );
    const firstGamesAfter = first.games_played + 1;
    const secondGamesAfter = second.games_played + 1;
    const firstDivisionBefore = visibleDivision(first.mmr, first.games_played);
    const secondDivisionBefore = visibleDivision(second.mmr, second.games_played);
    const firstDivisionAfter = visibleDivision(firstChange.after, firstGamesAfter);
    const secondDivisionAfter = visibleDivision(secondChange.after, secondGamesAfter);

    await this.updateStats(client, first, firstChange.after, firstWon);
    await this.updateStats(client, second, secondChange.after, !firstWon);
    const outcome = firstWon ? 'player_a_win' : 'player_b_win';
    await client.query(`
      INSERT INTO ranked_match_results (
        id, battle_id, player_a_id, player_b_id, winner_id, outcome,
        player_a_mmr_before, player_a_mmr_after, player_b_mmr_before, player_b_mmr_after,
        player_a_division_before, player_a_division_after,
        player_b_division_before, player_b_division_after
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    `, [
      randomUUID(), battleId, first.user_id, second.user_id, battle.winner_user_id, outcome,
      first.mmr, firstChange.after, second.mmr, secondChange.after,
      firstDivisionBefore, firstDivisionAfter, secondDivisionBefore, secondDivisionAfter,
    ]);
    const applied = await this.loadResult(client, battleId);
    return { status: 'applied', battleId, ...(applied ? { result: applied } : {}) };
  }

  async applyFinishedBattleById(battleId: string): Promise<RankedApplication> {
    return this.transaction((client) => this.applyFinishedBattle(client, battleId));
  }

  async recordNoContest(battleId: string, reason: string): Promise<RankedApplication> {
    return this.transaction(async (client) => {
      const battle = await client.query<RankedBattleRow>(
        'SELECT id, mode, status, winner_user_id FROM battles WHERE id = $1 FOR UPDATE', [battleId],
      ).then((result) => result.rows[0]);
      if (!battle || battle.mode !== 'ranked') return { status: 'not_ranked', battleId };
      const existing = await this.loadResult(client, battleId);
      if (existing) return { status: 'already_applied', battleId, result: existing };
      const players = await client.query<{ user_id: string }>(
        'SELECT user_id FROM battle_players WHERE battle_id = $1 ORDER BY user_id FOR UPDATE', [battleId],
      );
      if (players.rows.length !== 2) return { status: 'not_eligible', battleId };
      const ids = players.rows.map((row) => row.user_id).sort(compareIds);
      await this.ensureStats(client, ids);
      const stats = await this.lockStats(client, ids);
      const first = stats.find((row) => row.user_id === ids[0])!;
      const second = stats.find((row) => row.user_id === ids[1])!;
      const firstDivision = visibleDivision(first.mmr, first.games_played);
      const secondDivision = visibleDivision(second.mmr, second.games_played);
      await client.query(`
        INSERT INTO ranked_match_results (
          id, battle_id, player_a_id, player_b_id, winner_id, outcome, no_contest_reason,
          player_a_mmr_before, player_a_mmr_after, player_b_mmr_before, player_b_mmr_after,
          player_a_division_before, player_a_division_after,
          player_b_division_before, player_b_division_after
        ) VALUES ($1,$2,$3,$4,NULL,'no_contest',$5,$6,$6,$7,$7,$8,$8,$9,$9)
      `, [randomUUID(), battleId, first.user_id, second.user_id, cleanReason(reason), first.mmr, second.mmr, firstDivision, secondDivision]);
      const recorded = await this.loadResult(client, battleId);
      return { status: 'applied', battleId, ...(recorded ? { result: recorded } : {}) };
    });
  }

  async recover(): Promise<{ applied: number; noContest: number }> {
    const rows = await this.dependencies.postgres.query<{ id: string; status: 'finished' | 'cancelled' }>(`
      SELECT b.id, b.status FROM battles b
      WHERE b.mode = 'ranked' AND b.status IN ('finished', 'cancelled')
        AND NOT EXISTS (SELECT 1 FROM ranked_match_results result WHERE result.battle_id = b.id)
      ORDER BY b.finished_at, b.id LIMIT 500
    `);
    let applied = 0;
    let noContest = 0;
    for (const battle of rows.rows) {
      const result = battle.status === 'finished'
        ? await this.applyFinishedBattleById(battle.id)
        : await this.recordNoContest(battle.id, 'recovered_cancelled');
      if (result.status === 'applied') {
        if (result.result?.outcome === 'no_contest') noContest += 1;
        else applied += 1;
      }
    }
    return { applied, noContest };
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.dependencies.postgres.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async ensureStats(client: PoolClient, userIds: string[]): Promise<void> {
    await client.query(`
      INSERT INTO user_ranked_stats (user_id)
      SELECT unnest($1::bigint[])
      ON CONFLICT (user_id) DO NOTHING
    `, [userIds]);
  }

  private async lockStats(client: PoolClient, userIds: string[]): Promise<RankedStatsRow[]> {
    return client.query<RankedStatsRow>(`
      SELECT * FROM user_ranked_stats WHERE user_id = ANY($1::bigint[]) ORDER BY user_id FOR UPDATE
    `, [userIds]).then((result) => result.rows);
  }

  private async updateStats(client: PoolClient, stats: RankedStatsRow, mmr: number, won: boolean): Promise<void> {
    await client.query(`
      UPDATE user_ranked_stats
      SET mmr = $2,
          games_played = games_played + 1,
          wins = wins + $3,
          losses = losses + $4,
          placement_games_completed = LEAST(5, games_played + 1),
          updated_at = now()
      WHERE user_id = $1
    `, [stats.user_id, mmr, won ? 1 : 0, won ? 0 : 1]);
  }

  private async loadResult(client: PoolClient, battleId: string): Promise<RankedBattleResult | null> {
    const result = await client.query('SELECT * FROM ranked_match_results WHERE battle_id = $1', [battleId]);
    return result.rows[0] ? publicBattleResult(result.rows[0]) : null;
  }
}

function publicStats(row: RankedStatsRow | undefined): PublicRankedStats {
  const value = row ?? {
    user_id: '', mmr: INITIAL_RANKED_MMR, games_played: 0, wins: 0, losses: 0, placement_games_completed: 0,
  };
  return {
    mmr: value.mmr,
    gamesPlayed: value.games_played,
    wins: value.wins,
    losses: value.losses,
    placementGamesCompleted: value.placement_games_completed,
    placementGamesRequired: PLACEMENT_MATCHES,
    division: visibleDivision(value.mmr, value.games_played),
    provisional: value.games_played < PLACEMENT_MATCHES,
  };
}

function publicBattleResult(row: Record<string, unknown>): RankedBattleResult {
  const firstId = String(row.player_a_id);
  const secondId = String(row.player_b_id);
  return {
    battleId: String(row.battle_id),
    outcome: row.outcome as RankedBattleResult['outcome'],
    noContestReason: row.no_contest_reason ? String(row.no_contest_reason) : null,
    winnerId: row.winner_id ? String(row.winner_id) : null,
    players: [
      {
        userId: firstId,
        mmrBefore: Number(row.player_a_mmr_before),
        mmrAfter: Number(row.player_a_mmr_after),
        delta: Number(row.player_a_mmr_after) - Number(row.player_a_mmr_before),
        divisionBefore: row.player_a_division_before as RankedDivision,
        divisionAfter: row.player_a_division_after as RankedDivision,
      },
      {
        userId: secondId,
        mmrBefore: Number(row.player_b_mmr_before),
        mmrAfter: Number(row.player_b_mmr_after),
        delta: Number(row.player_b_mmr_after) - Number(row.player_b_mmr_before),
        divisionBefore: row.player_b_division_before as RankedDivision,
        divisionAfter: row.player_b_division_after as RankedDivision,
      },
    ],
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

function compareIds(left: string, right: string): number {
  return BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0;
}

function cleanReason(reason: string): string {
  const value = reason.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 64);
  return value || 'internal_failure';
}
