import { auditLog } from '../db/schema.js';
import { orgContext } from '../org-context.js';
import type { Tx } from '../db/tenancy.js';

const SECRET_KEY_RE = /key|secret|token|password|authorization|ciphertext|credential/i;
// Value-form secrets: provider/admin keys (sk-…, mk-…, xai-…), bearer tokens.
const SECRET_VALUE_RE =
  /\b(?:sk|mk|xai|rk|pk|ghp|gho|api)[-_][A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{8,}/i;
const REDACTED = '[redacted]';
const MAX_DEPTH = 6;

function sanitizeValue(value: unknown, keyIsSecret: boolean, depth: number): unknown {
  if (keyIsSecret) return REDACTED;
  if (depth > MAX_DEPTH) return REDACTED;
  if (typeof value === 'string') return SECRET_VALUE_RE.test(value) ? REDACTED : value;
  if (Array.isArray(value)) return value.map((v) => sanitizeValue(v, false, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitizeValue(v, SECRET_KEY_RE.test(k), depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Recursively redacts secret-looking keys AND values before an audit row is
 * persisted (ADR-013). Descends nested objects + arrays (depth-bounded) and
 * catches value-form secrets (sk-/mk-/bearer) that a key-name-only scan misses.
 */
export function sanitizeMeta(meta: Record<string, unknown>): Record<string, unknown> {
  return sanitizeValue(meta, false, 0) as Record<string, unknown>;
}

export interface AuditInput {
  action: string; // e.g. 'virtual_key.create'
  target: { type: string; id?: string; [k: string]: unknown };
  meta?: Record<string, unknown>;
  fieldDiff?: Record<string, unknown> | null; // before/after on updates
}

/**
 * Explicit actor for a non-request audit write (20 §4.5) — system/automation effects and the
 * approval decision engine, which know their actor from parameters and must NOT depend on the request
 * org context (they can run outside a request). Omit to denormalize the actor from `orgContext`.
 */
export interface AuditActor {
  orgId: string;
  actorType?: 'user' | 'system' | 'automation';
  actorId?: string | null;
  actorName?: string | null;
  actorEmail?: string | null;
  actorRole?: string | null;
}

/**
 * Appends an audit_log entry for a control-plane mutation. MUST run inside the
 * SAME withOrg transaction as the mutation: RLS arms the org_id, the entry commits
 * or rolls back atomically with the change, and the grant makes audit_log
 * append-only. Actor identity is denormalized (ADR-024) so the trail survives the
 * actor being deleted — from the passed `actor` when given, else the org context.
 */
export async function appendAudit(tx: Tx, input: AuditInput, actor?: AuditActor): Promise<void> {
  const a: AuditActor = actor ?? readOrgContextActor();
  await tx.insert(auditLog).values({
    orgId: a.orgId,
    actorType: a.actorType ?? 'user',
    actorId: a.actorId ?? null,
    actorName: a.actorName ?? null,
    actorEmail: a.actorEmail ?? null,
    actorRole: a.actorRole ?? null,
    action: input.action,
    target: input.target,
    meta: sanitizeMeta(input.meta ?? {}),
    fieldDiff: input.fieldDiff ? sanitizeMeta(input.fieldDiff) : null,
  });
}

function readOrgContextActor(): AuditActor {
  const ctx = orgContext.require();
  return {
    orgId: ctx.orgId,
    actorType: 'user',
    actorId: ctx.userId,
    actorName: ctx.name ?? null,
    actorEmail: ctx.email ?? null,
    actorRole: ctx.role,
  };
}
