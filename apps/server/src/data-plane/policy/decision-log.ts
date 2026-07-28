import { withOrg } from '../../db/tenancy.js';
import { decisionLogs } from '../../db/schema.js';
import type { DatabaseClient } from '../../db/client.js';

/**
 * decision_logs shared writer + input masking (16 §6). The structured "explain WHY" (OPA decision-log
 * schema, ADR-041 §2). Used by ch15 (rewrite), ch17 (budget_block), and the guardrail layer (deny/
 * approval/flag/shadow). Fire-and-forget: writeDecisionLog swallows failures so a log-write error
 * NEVER converts a clean decision into a 500 (§3.6). Ported from the lab; refit to withOrg + drizzle.
 *
 * Masking (§6.4): the attribute catalog (§4.1) is entirely structural — no path from a body to a log
 * by construction (ADR-013). maskDecisionInput additionally redacts sensitive request.metadata keys.
 */

export interface DecisionRecord {
  decisionId: string; // request id (live) or a generated uuid (replay)
  requestId: string | null;
  effect:
    | 'deny'
    | 'require_approval'
    | 'flag'
    | 'rewrite'
    | 'budget_block'
    | 'allow_shadow'
    | 'allow';
  enforcement: 'enforce' | 'shadow';
  wouldHave: boolean;
  evaluatedPolicyIds: string[];
  matchedPolicyIds: string[];
  decidingPolicyId: string | null;
  routingRuleId: string | null;
  reason: string | null;
  configSnapshotHash: string;
  inputSnapshot: Record<string, unknown>; // already-masked snapshot (§4.3, §6.4)
  celError: boolean;
}

const SENSITIVE_KEY = /key|secret|token|password|bearer|credential/i;
const METADATA_PATH = /^request\.metadata\.(.+)$/;
// Caller-controlled snapshot paths (metadata.actor → identity.actor, vk metadata keys →
// identity.key_tags) whose VALUES can carry a secret a caller stuffed in. Path-only metadata masking
// missed these, leaking a bearer token in metadata.actor into decision_logs (expanded-audit M9).
const SCANNED_VALUE_PATHS = new Set(['identity.actor', 'identity.key_tags']);

/** Redact any string that looks like it embeds a secret (bearer/token/key-ish payload). */
function looksSecret(v: unknown): boolean {
  return typeof v === 'string' && SENSITIVE_KEY.test(v);
}

/** Mask the §4.3 snapshot before persist (§6.4). Redacts sensitive metadata tags (path-based) AND
 *  scans identity.actor / identity.key_tags VALUES for embedded secrets; new-object. */
export function maskDecisionInput(snapshot: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(snapshot)) {
    const md = METADATA_PATH.exec(path);
    if (md && SENSITIVE_KEY.test(md[1] ?? '')) {
      out[path] = '[REDACTED]';
      continue;
    }
    if (SCANNED_VALUE_PATHS.has(path)) {
      if (looksSecret(value)) {
        out[path] = '[REDACTED]';
        continue;
      }
      if (Array.isArray(value) && value.some(looksSecret)) {
        out[path] = value.map((v) => (looksSecret(v) ? '[REDACTED]' : v));
        continue;
      }
    }
    out[path] = value;
  }
  return out;
}

/**
 * The shared writer (§6.5). Fire-and-forget: swallows on failure (§3.6). ON CONFLICT (decision_id)
 * DO NOTHING dedupes a shadow row racing the enforce row for the same request (first write wins).
 * MUST run inside withOrg or RLS silently drops the row. Returns a promise so tests can await it.
 */
export async function writeDecisionLog(
  db: DatabaseClient,
  orgId: string,
  rec: DecisionRecord,
  onError?: (error: unknown) => void,
): Promise<void> {
  try {
    await withOrg(db, orgId, (tx) =>
      tx
        .insert(decisionLogs)
        .values({
          decisionId: rec.decisionId,
          orgId,
          requestId: rec.requestId,
          effect: rec.effect,
          enforcement: rec.enforcement,
          wouldHave: rec.wouldHave,
          evaluatedPolicyIds: rec.evaluatedPolicyIds,
          matchedPolicyIds: rec.matchedPolicyIds,
          decidingPolicyId: rec.decidingPolicyId,
          routingRuleId: rec.routingRuleId,
          reason: rec.reason,
          configSnapshotHash: rec.configSnapshotHash,
          inputSnapshot: rec.inputSnapshot,
          celError: rec.celError,
        })
        .onConflictDoNothing({ target: decisionLogs.decisionId }),
    );
  } catch (error) {
    onError?.(error);
  }
}
