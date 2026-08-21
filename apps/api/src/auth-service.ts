import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from './config.js';
import {
  clearSessionCookie,
  createSessionCookie,
  readCookie,
} from './http-security.js';
import type { Dependencies } from './services.js';

const SESSION_PREFIX = 'clirace:auth:session:';

export interface AuthUser {
  id: string;
  username: string;
  email: string;
  createdAt: string;
  role: 'user' | 'admin';
  accountStatus: 'active' | 'suspended';
}

export class AuthService {
  constructor(
    private readonly config: AppConfig,
    private readonly dependencies: Dependencies,
  ) {}

  async startSession(userId: string, request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = randomBytes(32).toString('base64url');
    const key = sessionKey(token);
    await this.dependencies.redis.set(key, userId, { EX: this.config.AUTH_SESSION_TTL_SECONDS });
    reply.header('set-cookie', createSessionCookie(
      this.config.AUTH_COOKIE_NAME,
      token,
      this.config.AUTH_SESSION_TTL_SECONDS,
      this.config.AUTH_COOKIE_SECURE || request.protocol === 'https',
    ));
  }

  async endSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = this.readSessionToken(request);
    if (token) await this.dependencies.redis.del(sessionKey(token));
    reply.header('set-cookie', clearSessionCookie(
      this.config.AUTH_COOKIE_NAME,
      this.config.AUTH_COOKIE_SECURE || request.protocol === 'https',
    ));
  }

  async currentUser(request: FastifyRequest): Promise<AuthUser | null> {
    const token = this.readSessionToken(request);
    if (!token) return null;
    const userId = await this.dependencies.redis.get(sessionKey(token));
    if (!userId) return null;

    const result = await this.dependencies.postgres.query<{
      id: string;
      username: string;
      email: string;
      created_at: Date;
      role: 'user' | 'admin';
      account_status: 'active' | 'suspended';
    }>(`
      SELECT id, username, email, created_at, role, account_status
      FROM users
      WHERE id = $1
    `, [userId]);
    const row = result.rows[0];
    if (!row || row.account_status !== 'active') {
      await this.dependencies.redis.del(sessionKey(token));
      return null;
    }
    return {
      id: row.id,
      username: row.username,
      email: row.email,
      createdAt: row.created_at.toISOString(),
      role: row.role,
      accountStatus: row.account_status,
    };
  }

  async revokeAllSessions(userId: string): Promise<number> {
    let revoked = 0;
    for await (const entry of this.dependencies.redis.scanIterator({
      MATCH: `${SESSION_PREFIX}*`,
      COUNT: 100,
    })) {
      const keys = Array.isArray(entry) ? entry : [entry];
      if (keys.length === 0) continue;
      const values = await this.dependencies.redis.mGet(keys);
      const matching = keys.filter((_key, index) => values[index] === userId);
      if (matching.length > 0) revoked += await this.dependencies.redis.del(matching);
    }
    return revoked;
  }

  private readSessionToken(request: FastifyRequest): string | undefined {
    const token = readCookie(request, this.config.AUTH_COOKIE_NAME);
    return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
  }
}

function sessionKey(token: string): string {
  return `${SESSION_PREFIX}${createHash('sha256').update(token).digest('hex')}`;
}
