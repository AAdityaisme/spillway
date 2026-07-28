import { sql } from 'drizzle-orm';
import type { DatabaseClient } from '../db/client.js';
import { withOrg } from '../db/tenancy.js';

/**
 * Routing trace (Part II §20 §6) — assembled ON RETRIEVAL from the durable request record: the
 * `requests` row + its `decision_logs` (guardrail / rewrite / budget_block decisions) + its
 * `request_attempts` (the dispatched chain). Read-only, additive-stable (new fields tolerated by
 * consumers, never in a hot-path body). Answers "why did this request route, transform, and cost the
 * way it did".
 */

export interface TraceDecision {
  effect: string;
  enforcement: string;
  decidingPolicyId: string | null;
  routingRuleId: string | null;
  reason: string | null;
}

export interface TraceAttempt {
  attemptNumber: number;
  provider: string | null;
  model: string | null;
  outcome: string;
  errorCode: string | null;
  costUsd: string | null;
}

export interface RoutingTrace {
  requestId: string;
  requestedModel: string | null;
  status: string;
  costUsd: string | null;
  configSnapshotHash: string | null;
  createdAt: string;
  decisions: TraceDecision[];
  attempts: TraceAttempt[];
}

/** Assemble the trace for one request under the org GUC. null when the request isn't in this org. */
export async function assembleTrace(
  db: DatabaseClient,
  orgId: string,
  requestId: string,
): Promise<RoutingTrace | null> {
  return withOrg(db, orgId, async (tx) => {
    const [req] = (await tx.execute(sql`
      SELECT id, requested_model, status, cost_usd::text AS cost_usd,
             config_snapshot_hash, created_at
        FROM requests WHERE id = ${requestId}`)) as unknown as {
      id: string;
      requested_model: string | null;
      status: string;
      cost_usd: string | null;
      config_snapshot_hash: string | null;
      created_at: string;
    }[];
    if (!req) return null;

    const decisions = (await tx.execute(sql`
      SELECT effect, enforcement, deciding_policy_id, routing_rule_id, reason
        FROM decision_logs WHERE request_id = ${requestId}
       ORDER BY effect`)) as unknown as {
      effect: string;
      enforcement: string;
      deciding_policy_id: string | null;
      routing_rule_id: string | null;
      reason: string | null;
    }[];

    const attempts = (await tx.execute(sql`
      SELECT attempt_number, provider, model, outcome, error_code, cost_usd::text AS cost_usd
        FROM request_attempts WHERE request_id = ${requestId}
       ORDER BY attempt_number`)) as unknown as {
      attempt_number: number;
      provider: string | null;
      model: string | null;
      outcome: string;
      error_code: string | null;
      cost_usd: string | null;
    }[];

    return {
      requestId: req.id,
      requestedModel: req.requested_model,
      status: req.status,
      costUsd: req.cost_usd,
      configSnapshotHash: req.config_snapshot_hash,
      createdAt: String(req.created_at),
      decisions: decisions.map((d) => ({
        effect: d.effect,
        enforcement: d.enforcement,
        decidingPolicyId: d.deciding_policy_id,
        routingRuleId: d.routing_rule_id,
        reason: d.reason,
      })),
      attempts: attempts.map((a) => ({
        attemptNumber: a.attempt_number,
        provider: a.provider,
        model: a.model,
        outcome: a.outcome,
        errorCode: a.error_code,
        costUsd: a.cost_usd,
      })),
    };
  });
}
