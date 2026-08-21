import type { Dependencies } from './services.js';

const SENSITIVE_KEY = /(password|secret|token|cookie|authorization|password_hash|request_body)/i;

export interface AdminAuditEvent {
  actorUserId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  clientIp?: string | null;
}

export async function writeAdminAudit(
  dependencies: Dependencies,
  event: AdminAuditEvent,
): Promise<void> {
  await dependencies.postgres.query(`
    INSERT INTO admin_audit_log
      (actor_user_id, action, target_type, target_id, metadata, client_ip)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6::inet)
  `, [
    event.actorUserId ?? null,
    event.action.slice(0, 80),
    event.targetType.slice(0, 40),
    event.targetId?.slice(0, 128) ?? null,
    JSON.stringify(sanitizeMetadata(event.metadata ?? {})),
    normalizeIp(event.clientIp),
  ]);
}

export function sanitizeMetadata(value: unknown, depth = 0): unknown {
  if (depth > 3) return '[truncated]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 500);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeMetadata(item, depth + 1));
  if (typeof value !== 'object') return String(value).slice(0, 500);

  const safe: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 30)) {
    if (SENSITIVE_KEY.test(key)) continue;
    safe[key] = sanitizeMetadata(entry, depth + 1);
  }
  return safe;
}

function normalizeIp(value: string | null | undefined): string | null {
  if (!value) return null;
  const candidate = value.replace(/^::ffff:/, '');
  return /^[0-9a-f:.]+$/i.test(candidate) ? candidate : null;
}
