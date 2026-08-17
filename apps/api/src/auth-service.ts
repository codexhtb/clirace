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
    }>(`
      SELECT id, username, email, created_at
      FROM users
      WHERE id = $1
    `, [userId]);
    const row = result.rows[0];
    if (!row) {
      await this.dependencies.redis.del(sessionKey(token));
      return null;
    }
    return {
      id: row.id,
      username: row.username,
      email: row.email,
      createdAt: row.created_at.toISOString(),
    };
  }

  private readSessionToken(request: FastifyRequest): string | undefined {
    const token = readCookie(request, this.config.AUTH_COOKIE_NAME);
    return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
  }
}

function sessionKey(token: string): string {
  return `${SESSION_PREFIX}${createHash('sha256').update(token).digest('hex')}`;
}
