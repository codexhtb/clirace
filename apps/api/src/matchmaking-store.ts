import type { Dependencies } from './services.js';

export const QUICK_MATCH_POOL = 'quick';

export interface SearchingState {
  status: 'searching';
  pool: string;
  userId: string;
  queuedAt: number;
  waitingCapacity: boolean;
}

export interface PairingState {
  status: 'pairing';
  pool: string;
  userId: string;
  queuedAt: number;
  claimedAt: number;
  matchId: string;
  opponentUserId: string;
}

export interface MatchedState {
  status: 'matched';
  pool: string;
  userId: string;
  matchId: string;
  battleId: string;
  roomCode: string;
  opponentUserId: string;
  matchedAt: number;
}

export type MatchmakingRedisState = SearchingState | PairingState | MatchedState;

export interface PairClaim {
  matchId: string;
  pool: string;
  userA: string;
  userB: string;
  queuedAtA: number;
  queuedAtB: number;
  claimedAt: number;
}

export interface MatchmakingMetricsSnapshot {
  queueDepth: number;
  oldestWaitSeconds: number;
  enqueuedTotal: number;
  matchedTotal: number;
  cancelledTotal: number;
  expiredTotal: number;
  failedTotal: number;
  waitP50Seconds: number;
  waitP95Seconds: number;
  waitSumSeconds: number;
  waitCount: number;
}

const ENQUEUE_SCRIPT = String.raw`
local existing = redis.call('GET', KEYS[2])
if existing then
  local state = cjson.decode(existing)
  if state.status == 'searching' then
    redis.call('ZADD', KEYS[1], 'NX', state.queuedAt, ARGV[1])
    redis.call('PEXPIRE', KEYS[2], ARGV[4])
  end
  return existing
end
local state = {
  status = 'searching', pool = ARGV[2], userId = ARGV[1],
  queuedAt = tonumber(ARGV[3]), waitingCapacity = false
}
local encoded = cjson.encode(state)
redis.call('SET', KEYS[2], encoded, 'PX', ARGV[4])
redis.call('ZADD', KEYS[1], 'NX', ARGV[3], ARGV[1])
redis.call('HINCRBY', KEYS[3], 'enqueuedTotal', 1)
return encoded
`;

const HEARTBEAT_SCRIPT = String.raw`
local existing = redis.call('GET', KEYS[1])
if not existing then return '' end
local state = cjson.decode(existing)
if state.status == 'searching' then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return existing
`;

const WAITING_CAPACITY_SCRIPT = String.raw`
local existing = redis.call('GET', KEYS[1])
if not existing then return '' end
local state = cjson.decode(existing)
if state.status ~= 'searching' then return existing end
state.waitingCapacity = ARGV[1] == '1'
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 1 then ttl = tonumber(ARGV[2]) end
local encoded = cjson.encode(state)
redis.call('SET', KEYS[1], encoded, 'PX', ttl)
return encoded
`;

const CLAIM_SCRIPT = String.raw`
local currentRaw = redis.call('GET', KEYS[2])
if not currentRaw then
  redis.call('ZREM', KEYS[1], ARGV[1])
  return ''
end
local current = cjson.decode(currentRaw)
if current.status ~= 'searching' then return '' end
local candidates = redis.call('ZRANGE', KEYS[1], 0, 255)
for _, candidateId in ipairs(candidates) do
  if candidateId ~= ARGV[1] then
    local candidateKey = ARGV[2] .. candidateId
    local candidateRaw = redis.call('GET', candidateKey)
    if not candidateRaw then
      redis.call('ZREM', KEYS[1], candidateId)
      redis.call('HINCRBY', KEYS[3], 'expiredTotal', 1)
    else
      local candidate = cjson.decode(candidateRaw)
      if candidate.status ~= 'searching' then
        redis.call('ZREM', KEYS[1], candidateId)
      else
        local claim = {
          matchId = ARGV[3], pool = ARGV[4], userA = candidateId, userB = ARGV[1],
          queuedAtA = candidate.queuedAt, queuedAtB = current.queuedAt,
          claimedAt = tonumber(ARGV[5])
        }
        local first = {
          status = 'pairing', pool = ARGV[4], userId = candidateId,
          queuedAt = candidate.queuedAt, claimedAt = tonumber(ARGV[5]),
          matchId = ARGV[3], opponentUserId = ARGV[1]
        }
        local second = {
          status = 'pairing', pool = ARGV[4], userId = ARGV[1],
          queuedAt = current.queuedAt, claimedAt = tonumber(ARGV[5]),
          matchId = ARGV[3], opponentUserId = candidateId
        }
        redis.call('ZREM', KEYS[1], candidateId, ARGV[1])
        redis.call('SET', candidateKey, cjson.encode(first), 'PX', ARGV[6])
        redis.call('SET', KEYS[2], cjson.encode(second), 'PX', ARGV[6])
        redis.call('SET', KEYS[4], cjson.encode(claim), 'PX', ARGV[6])
        return cjson.encode(claim)
      end
    end
  end
end
return ''
`;

const COMMIT_SCRIPT = String.raw`
local pairRaw = redis.call('GET', KEYS[1])
if not pairRaw then return 0 end
local pair = cjson.decode(pairRaw)
if pair.matchId ~= ARGV[1] then return 0 end
local matchedAt = tonumber(ARGV[5])
local firstMatched = {
  status = 'matched', pool = pair.pool, userId = pair.userA,
  matchId = ARGV[1], battleId = ARGV[2], roomCode = ARGV[3],
  opponentUserId = pair.userB, matchedAt = matchedAt
}
local secondMatched = {
  status = 'matched', pool = pair.pool, userId = pair.userB,
  matchId = ARGV[1], battleId = ARGV[2], roomCode = ARGV[3],
  opponentUserId = pair.userA, matchedAt = matchedAt
}
redis.call('SET', KEYS[2], cjson.encode(firstMatched), 'PX', ARGV[4])
redis.call('SET', KEYS[3], cjson.encode(secondMatched), 'PX', ARGV[4])
redis.call('DEL', KEYS[1])
redis.call('HINCRBY', KEYS[4], 'matchedTotal', 1)
local waitA = math.max(0, matchedAt - pair.queuedAtA) / 1000
local waitB = math.max(0, matchedAt - pair.queuedAtB) / 1000
redis.call('LPUSH', KEYS[5], tostring(waitA))
redis.call('LPUSH', KEYS[5], tostring(waitB))
redis.call('LTRIM', KEYS[5], 0, 511)
redis.call('HINCRBYFLOAT', KEYS[4], 'waitSumSeconds', waitA + waitB)
redis.call('HINCRBY', KEYS[4], 'waitCount', 2)
return 1
`;

const ROLLBACK_SCRIPT = String.raw`
local pairRaw = redis.call('GET', KEYS[1])
if not pairRaw then return 0 end
local pair = cjson.decode(pairRaw)
if pair.matchId ~= ARGV[1] then return 0 end
local function restore(userId, queuedAt, stateKey)
  if ARGV[2] ~= '' and userId == ARGV[2] then
    redis.call('DEL', stateKey)
    redis.call('ZREM', KEYS[2], userId)
    return
  end
  local state = {
    status = 'searching', pool = pair.pool, userId = userId,
    queuedAt = queuedAt, waitingCapacity = ARGV[5] == '1'
  }
  redis.call('SET', stateKey, cjson.encode(state), 'PX', ARGV[4])
  redis.call('ZADD', KEYS[2], queuedAt, userId)
end
restore(pair.userA, pair.queuedAtA, KEYS[3])
restore(pair.userB, pair.queuedAtB, KEYS[4])
redis.call('DEL', KEYS[1])
redis.call('HINCRBY', KEYS[5], 'failedTotal', 1)
return 1
`;

const CANCEL_SCRIPT = String.raw`
local raw = redis.call('GET', KEYS[2])
if not raw then
  redis.call('ZREM', KEYS[1], ARGV[1])
  return cjson.encode({ outcome = 'cancelled' })
end
local state = cjson.decode(raw)
if state.status == 'searching' then
  redis.call('ZREM', KEYS[1], ARGV[1])
  redis.call('DEL', KEYS[2])
  redis.call('HINCRBY', KEYS[3], 'cancelledTotal', 1)
  return cjson.encode({ outcome = 'cancelled' })
end
if state.status == 'pairing' then
  return cjson.encode({ outcome = 'match_committing', matchId = state.matchId })
end
return cjson.encode({ outcome = 'matched', state = state })
`;

const RELEASE_LOCK_SCRIPT = String.raw`
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export class MatchmakingStore {
  constructor(
    private readonly redis: Dependencies['redis'],
    private readonly prefix = 'clirace:mm',
  ) {
    if (!/^[a-z0-9:_-]{3,100}$/.test(prefix)) throw new Error('Invalid matchmaking Redis prefix.');
  }

  async enqueue(userId: string, pool: string, now: number, leaseMs: number): Promise<MatchmakingRedisState> {
    const raw = await this.redis.eval(ENQUEUE_SCRIPT, {
      keys: [this.queueKey(pool), this.userKey(userId), this.metricsKey()],
      arguments: [userId, pool, String(now), String(leaseMs)],
    });
    return parseState(raw);
  }

  async heartbeat(userId: string, leaseMs: number): Promise<MatchmakingRedisState | null> {
    const raw = await this.redis.eval(HEARTBEAT_SCRIPT, {
      keys: [this.userKey(userId)], arguments: [String(leaseMs)],
    });
    return raw ? parseState(raw) : null;
  }

  async markWaitingCapacity(userId: string, waiting: boolean, fallbackLeaseMs: number): Promise<MatchmakingRedisState | null> {
    const raw = await this.redis.eval(WAITING_CAPACITY_SCRIPT, {
      keys: [this.userKey(userId)], arguments: [waiting ? '1' : '0', String(fallbackLeaseMs)],
    });
    return raw ? parseState(raw) : null;
  }

  async claimOldest(
    userId: string,
    pool: string,
    matchId: string,
    now: number,
    pairingTtlMs: number,
  ): Promise<PairClaim | null> {
    const raw = await this.redis.eval(CLAIM_SCRIPT, {
      keys: [this.queueKey(pool), this.userKey(userId), this.metricsKey(), this.pairKey(matchId)],
      arguments: [userId, this.userKeyPrefix(), matchId, pool, String(now), String(pairingTtlMs)],
    });
    return raw ? parseJson<PairClaim>(raw) : null;
  }

  async commitMatch(claim: PairClaim, battle: { id: string; roomCode: string }, matchedAt: number, matchTtlMs: number): Promise<boolean> {
    const committed = await this.redis.eval(COMMIT_SCRIPT, {
      keys: [
        this.pairKey(claim.matchId), this.userKey(claim.userA), this.userKey(claim.userB),
        this.metricsKey(), this.waitsKey(),
      ],
      arguments: [claim.matchId, battle.id, battle.roomCode, String(matchTtlMs), String(matchedAt)],
    });
    return Number(committed) === 1;
  }

  async rollbackPair(
    claim: PairClaim,
    options: { invalidUserId?: string; leaseMs: number; waitingCapacity?: boolean },
  ): Promise<boolean> {
    const rolledBack = await this.redis.eval(ROLLBACK_SCRIPT, {
      keys: [
        this.pairKey(claim.matchId), this.queueKey(claim.pool), this.userKey(claim.userA),
        this.userKey(claim.userB), this.metricsKey(),
      ],
      arguments: [
        claim.matchId, options.invalidUserId ?? '', String(Date.now()), String(options.leaseMs),
        options.waitingCapacity ? '1' : '0',
      ],
    });
    return Number(rolledBack) === 1;
  }

  async cancel(userId: string, pool = QUICK_MATCH_POOL): Promise<
    { outcome: 'cancelled' }
    | { outcome: 'match_committing'; matchId: string }
    | { outcome: 'matched'; state: MatchedState }
  > {
    const raw = await this.redis.eval(CANCEL_SCRIPT, {
      keys: [this.queueKey(pool), this.userKey(userId), this.metricsKey()], arguments: [userId],
    });
    return parseJson(raw);
  }

  async getState(userId: string): Promise<{ state: MatchmakingRedisState; ttlMs: number } | null> {
    const [raw, ttlMs] = await Promise.all([
      this.redis.get(this.userKey(userId)), this.redis.pTTL(this.userKey(userId)),
    ]);
    return raw ? { state: parseState(raw), ttlMs: Math.max(0, ttlMs) } : null;
  }

  async getPair(matchId: string): Promise<PairClaim | null> {
    const raw = await this.redis.get(this.pairKey(matchId));
    return raw ? parseJson<PairClaim>(raw) : null;
  }

  async removeSearchingUser(userId: string): Promise<void> {
    await this.cancel(userId);
  }

  async clearState(userId: string, pool = QUICK_MATCH_POOL): Promise<void> {
    await Promise.all([
      this.redis.del(this.userKey(userId)),
      this.redis.zRem(this.queueKey(pool), userId),
    ]);
  }

  async listPairClaims(limit = 1_000): Promise<PairClaim[]> {
    const claims: PairClaim[] = [];
    for await (const entry of this.redis.scanIterator({ MATCH: `${this.prefix}:pair:*`, COUNT: 100 })) {
      const keys = Array.isArray(entry) ? entry : [entry];
      if (!keys.length) continue;
      const values = await this.redis.mGet(keys);
      for (const value of values) {
        if (value) claims.push(parseJson<PairClaim>(value));
        if (claims.length >= limit) return claims;
      }
    }
    return claims;
  }

  async listQueuedUserIds(pool = QUICK_MATCH_POOL, limit = 2_000): Promise<string[]> {
    return this.redis.zRange(this.queueKey(pool), 0, Math.max(0, limit - 1));
  }

  async sweepExpired(pool = QUICK_MATCH_POOL): Promise<number> {
    const userIds = await this.listQueuedUserIds(pool);
    if (!userIds.length) return 0;
    const states = await this.redis.mGet(userIds.map((userId) => this.userKey(userId)));
    const expired = userIds.filter((_userId, index) => !states[index]);
    if (!expired.length) return 0;
    await this.redis.zRem(this.queueKey(pool), expired);
    await this.redis.hIncrBy(this.metricsKey(), 'expiredTotal', expired.length);
    return expired.length;
  }

  async metrics(pool = QUICK_MATCH_POOL, now = Date.now()): Promise<MatchmakingMetricsSnapshot> {
    const [raw, queueDepth, oldest, waits] = await Promise.all([
      this.redis.hGetAll(this.metricsKey()),
      this.redis.zCard(this.queueKey(pool)),
      this.redis.zRangeWithScores(this.queueKey(pool), 0, 0),
      this.redis.lRange(this.waitsKey(), 0, 511),
    ]);
    const samples = waits.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
    return {
      queueDepth,
      oldestWaitSeconds: oldest[0] ? Math.max(0, now - oldest[0].score) / 1_000 : 0,
      enqueuedTotal: numberField(raw.enqueuedTotal),
      matchedTotal: numberField(raw.matchedTotal),
      cancelledTotal: numberField(raw.cancelledTotal),
      expiredTotal: numberField(raw.expiredTotal),
      failedTotal: numberField(raw.failedTotal),
      waitP50Seconds: percentile(samples, 0.5),
      waitP95Seconds: percentile(samples, 0.95),
      waitSumSeconds: numberField(raw.waitSumSeconds),
      waitCount: numberField(raw.waitCount),
    };
  }

  async acquirePairingLock(token: string, ttlMs = 15_000): Promise<boolean> {
    return await this.redis.set(this.lockKey(), token, { NX: true, PX: ttlMs }) === 'OK';
  }

  async releasePairingLock(token: string): Promise<void> {
    await this.redis.eval(RELEASE_LOCK_SCRIPT, { keys: [this.lockKey()], arguments: [token] });
  }

  async clearForTest(): Promise<void> {
    const keys: string[] = [];
    for await (const entry of this.redis.scanIterator({ MATCH: `${this.prefix}:*`, COUNT: 100 })) {
      if (Array.isArray(entry)) keys.push(...entry);
      else keys.push(entry);
    }
    if (keys.length) await this.redis.del(keys);
  }

  private queueKey(pool: string): string { return `${this.prefix}:pool:${pool}:queue`; }
  private userKeyPrefix(): string { return `${this.prefix}:user:`; }
  private userKey(userId: string): string { return `${this.userKeyPrefix()}${userId}`; }
  private pairKey(matchId: string): string { return `${this.prefix}:pair:${matchId}`; }
  private metricsKey(): string { return `${this.prefix}:metrics`; }
  private waitsKey(): string { return `${this.prefix}:waits`; }
  private lockKey(): string { return `${this.prefix}:lock:pairing`; }
}

function parseState(value: unknown): MatchmakingRedisState {
  return parseJson<MatchmakingRedisState>(value);
}

function parseJson<T>(value: unknown): T {
  if (typeof value !== 'string') throw new Error('Redis returned an invalid matchmaking payload.');
  return JSON.parse(value) as T;
}

function numberField(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function percentile(values: number[], quantile: number): number {
  if (!values.length) return 0;
  return values[Math.min(values.length - 1, Math.ceil(values.length * quantile) - 1)] ?? 0;
}
