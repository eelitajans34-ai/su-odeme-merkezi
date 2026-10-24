import type { DbClient } from '../db.js';
import { redact } from '../lib/redact.js';

export interface AuditInput {
  actorUserId?: string | null;
  actorType: 'USER' | 'ADMIN' | 'SYSTEM' | 'CLI';
  action: string;
  targetType?: string;
  targetId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  details?: Record<string, unknown>;
}

export async function audit(db: DbClient, a: AuditInput): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (actor_user_id, actor_type, action, target_type, target_id, ip_address, user_agent, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      a.actorUserId ?? null,
      a.actorType,
      a.action,
      a.targetType ?? null,
      a.targetId ?? null,
      a.ip ?? null,
      a.userAgent?.slice(0, 300) ?? null,
      JSON.stringify(redact(a.details ?? {})),
    ],
  );
}
