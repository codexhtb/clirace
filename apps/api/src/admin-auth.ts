import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthService, type AuthUser } from './auth-service.js';

export async function requireAdmin(
  auth: AuthService,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthUser | null> {
  const user = await auth.currentUser(request);
  if (!user) {
    reply.code(401).send({
      error: 'Unauthorized',
      code: 'authentication_required',
      message: 'Требуется авторизация администратора.',
    });
    return null;
  }
  if (user.role !== 'admin') {
    reply.code(403).send({
      error: 'Forbidden',
      code: 'admin_required',
      message: 'Недостаточно прав для Operations Console.',
    });
    return null;
  }
  return user;
}
