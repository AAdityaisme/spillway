import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { SpillwayError } from '@spillway/shared';
import type { DatabaseClient } from '../../db/client.js';
import { orgs } from '../../db/schema.js';
import { orgContext } from '../../org-context.js';
import { requireRole } from '../../auth/rbac.js';
import { resolveEntitlements } from '../../auth/entitlements.js';
import { sql } from 'drizzle-orm';
import { withOrg } from '../../db/tenancy.js';
import {
  buildChargebackStatement,
  generateHierarchicalStatement,
  statementToCsv,
  type ChargebackGroupBy,
} from '../../services/chargeback.js';
import { runInsightsForOrg } from '../../jobs/insights.js';

export interface ReportsDeps {
  db: DatabaseClient;
}

const GROUP_BYS: ChargebackGroupBy[] = ['virtual_key', 'team', 'model', 'none'];

/** Default period = calendar-month-to-date (UTC). */
function defaultPeriod(): { start: Date; end: Date } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  // Exclusive upper bound = now. The comparison in buildChargebackStatement is `created_at < end`, so
  // a row stamped at exactly `now` is excluded (correct: it isn't in the closed past yet). The old
  // now+1s fudge made every default window non-month-boundary-aligned, needlessly interacting with the
  // counter-arm's whole-month gate (audit L41). `end = now` is the clean exclusive bound.
  const end = new Date(now.getTime());
  return { start, end };
}

/** Max reportable span. A wider window forces a full-history scan+join+aggregate per call (audit M18/L26). */
const MAX_REPORT_SPAN_MS = 366 * 24 * 60 * 60 * 1000;

/**
 * Reporting API (Part II §20 §2). GET /api/reports/chargeback — spend attributed per scope over a
 * period, JSON or CSV (?format=csv). Governance-tier ('chargeback'), admin+. The statement carries a
 * ledger-reconciliation block so a consumer can trust the total or see the warning.
 */
export const reportsRoutes: FastifyPluginAsync<ReportsDeps> = async (fastify, { db }) => {
  async function requireChargeback(orgId: string): Promise<void> {
    const [row] = await db
      .select({ plan: orgs.plan })
      .from(orgs)
      .where(eq(orgs.id, orgId))
      .limit(1);
    if (!resolveEntitlements(row?.plan ?? 'free').has('chargeback'))
      throw new SpillwayError(
        'tier_required',
        'chargeback reporting requires the Governance plan',
        {
          httpStatus: 402,
          details: { entitlement: 'chargeback' },
        },
      );
  }

  fastify.get('/reports/chargeback', async (request, reply) => {
    const { orgId } = orgContext.require();
    requireRole('admin');
    await requireChargeback(orgId);
    const q = (request.query ?? {}) as {
      start?: string;
      end?: string;
      group_by?: string;
      format?: string;
      view?: string;
      month?: string;
    };
    // view=hierarchical → the finance-grade org → team → key → model statement for a UTC month (20 §2.1).
    if (q.view === 'hierarchical') {
      const month =
        q.month && /^\d{4}-\d{2}$/.test(q.month) ? q.month : new Date().toISOString().slice(0, 7);
      const statement = await generateHierarchicalStatement(db, orgId, month);
      return { statement };
    }
    const groupBy: ChargebackGroupBy = GROUP_BYS.includes(q.group_by as ChargebackGroupBy)
      ? (q.group_by as ChargebackGroupBy)
      : 'virtual_key';
    const period = defaultPeriod();
    const start = q.start ? new Date(q.start) : period.start;
    const end = q.end ? new Date(q.end) : period.end;
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end)
      throw new SpillwayError('validation_error', 'invalid start/end window', { httpStatus: 400 });
    // Bound the span so a single call can't force an unbounded full-history scan (audit M18/L26).
    if (end.getTime() - start.getTime() > MAX_REPORT_SPAN_MS)
      throw new SpillwayError('validation_error', 'reporting window exceeds 366 days', {
        httpStatus: 400,
      });

    const statement = await buildChargebackStatement(db, orgId, { start, end, groupBy });
    if (q.format === 'csv') {
      void reply.header('content-type', 'text/csv; charset=utf-8');
      void reply.header('content-disposition', 'attachment; filename="chargeback.csv"');
      return statementToCsv(statement);
    }
    return { statement };
  });

  // Savings insights (§19 §8). GET returns the latest saved insight; POST regenerates it now (manual
  // trigger alongside the weekly job). Governance-tier, admin+.
  fastify.get('/reports/insights', async (_request) => {
    const { orgId } = orgContext.require();
    requireRole('admin');
    await requireChargeback(orgId);
    const rows = await withOrg(db, orgId, (tx) =>
      tx.execute(sql`
        select period, generated_at, summary, detail from savings_insights
         order by period desc limit 1`),
    );
    return { insight: (rows as unknown[])[0] ?? null };
  });

  fastify.post('/reports/insights/trigger', async (request, reply) => {
    const { orgId } = orgContext.require();
    requireRole('admin');
    await requireChargeback(orgId);
    const result = await runInsightsForOrg(db, orgId, new Date());
    reply.code(200);
    return { result };
  });
};
