import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { SpillwayError } from '@spillway/shared';
import type { DatabaseClient } from '../../db/client.js';
import { orgContext } from '../../org-context.js';
import { withOrg } from '../../db/tenancy.js';
import { requireRole } from '../../auth/rbac.js';

export interface DecisionLogsDeps {
  db: DatabaseClient;
}

/**
 * Decision-log query API + shadow-impact (16 §6.6/§8.2). The per-request policy-evaluation record
 * (deny/flag/rewrite/budget_block/shadow) is written on the data plane; this exposes the READ side that
 * powers (1) the dashboard "why was this denied" drill-down and (2) the CFO shadow-mode promotion story
 * — "this guardrail WOULD have denied N requests / blocked $X over the last 7 days" — before a shadow
 * policy is ever turned on. Admin/owner only; rows are already masked at write (ADR-013, §6.4).
 */
const clampLimit = (raw: unknown): number => {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) ? Math.min(200, Math.max(1, n)) : 50;
};

// Whitelisted shadow-impact windows → a safe interval literal (never interpolate a raw user interval).
const WINDOWS: Record<string, string> = {
  '1d': '1 day',
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
};

const publicCols = sql`decision_id, request_id, created_at, effect, enforcement, would_have,
  deciding_policy_id, matched_policy_ids, routing_rule_id, reason, cel_error, config_snapshot_hash,
  input_snapshot`;

export const decisionLogsRoutes: FastifyPluginAsync<DecisionLogsDeps> = async (fastify, { db }) => {
  // Filtered list (§6.6). effect / policy_id / from / to / limit. Ordered newest-first (indexed).
  fastify.get('/decision-logs', async (request) => {
    requireRole('admin'); // admin/owner — decision logs expose policy structure, not viewer-visible
    const { orgId } = orgContext.require();
    const q = (request.query ?? {}) as {
      effect?: string;
      policy_id?: string;
      from?: string;
      to?: string;
      limit?: string;
    };
    const limit = clampLimit(q.limit);
    const rows = await withOrg(db, orgId, (tx) =>
      tx.execute(sql`
        select ${publicCols} from decision_logs
        where 1 = 1
          ${q.effect ? sql`and effect = ${q.effect}` : sql``}
          ${q.policy_id ? sql`and deciding_policy_id = ${q.policy_id}::uuid` : sql``}
          ${q.from ? sql`and created_at >= ${q.from}` : sql``}
          ${q.to ? sql`and created_at <= ${q.to}` : sql``}
        order by created_at desc
        limit ${limit}`),
    );
    return { decisionLogs: rows };
  });

  // Single record (§6.6) — the "why was this denied" drill-down.
  fastify.get<{ Params: { decisionId: string } }>('/decision-logs/:decisionId', async (request) => {
    requireRole('admin');
    const { orgId } = orgContext.require();
    const { decisionId } = request.params;
    const rows = (await withOrg(db, orgId, (tx) =>
      tx.execute(
        sql`select ${publicCols} from decision_logs where decision_id = ${decisionId}::uuid`,
      ),
    )) as unknown as unknown[];
    if (rows.length === 0)
      throw new SpillwayError('not_found', 'decision log not found', { httpStatus: 404 });
    return { decisionLog: rows[0] };
  });

  // §8.2 shadow-impact — "would have denied N requests / blocked $X" for a (shadow) policy.
  fastify.get<{ Params: { policyId: string } }>(
    '/policies/:policyId/shadow-impact',
    async (request) => {
      requireRole('admin');
      const { orgId } = orgContext.require();
      const { policyId } = request.params;
      const window = (request.query as { window?: string } | undefined)?.window ?? '7d';
      const interval = WINDOWS[window] ?? WINDOWS['7d']!;

      return withOrg(db, orgId, async (tx) => {
        const byEffect = (await tx.execute(sql`
          select effect,
                 count(*)::int              as would_have_count,
                 count(distinct request_id)::int as affected_requests,
                 min(created_at) as first_seen,
                 max(created_at) as last_seen
            from decision_logs
           where deciding_policy_id = ${policyId}::uuid
             and would_have = true
             and created_at >= now() - ${interval}::interval
           group by effect`)) as unknown as unknown[];
        // Dollar impact: what the org WOULD have saved had the policy been enforcing (join to requests).
        const [dollar] = (await tx.execute(sql`
          select coalesce(sum(r.cost_usd), 0)::text as would_have_usd
            from decision_logs d
            join requests r on r.id = d.request_id
           where d.deciding_policy_id = ${policyId}::uuid
             and d.would_have = true
             and d.created_at >= now() - ${interval}::interval`)) as unknown as {
          would_have_usd: string;
        }[];
        return {
          shadowImpact: {
            policyId,
            window,
            byEffect,
            wouldHaveUsd: dollar?.would_have_usd ?? '0',
          },
        };
      });
    },
  );
};
