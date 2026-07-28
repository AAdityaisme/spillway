import type { FastifyPluginAsync } from 'fastify';
import { SpillwayError } from '@spillway/shared';
import type { DatabaseClient } from '../../db/client.js';
import { orgContext } from '../../org-context.js';
import { requireRole } from '../../auth/rbac.js';
import {
  overviewKpis,
  spendTimeseries,
  modelMix,
  PERIOD_RE,
  DAY_RE,
  TIMESERIES_GROUP_BYS,
  type TimeseriesGroupBy,
} from '../../services/kpi.js';

export interface KpiDeps {
  db: DatabaseClient;
}

const MS_PER_DAY = 86_400_000;
const MAX_TIMESERIES_DAYS = 90;

/** Current UTC month key, the default period for the period-based endpoints. */
function currentMonthKey(): string {
  return new Date().toISOString().slice(0, 7);
}

function badRequest(message: string): never {
  throw new SpillwayError('validation_error', message, { httpStatus: 400 });
}

/**
 * Dashboard KPI read API (04-api-contracts §3.15; 09-frontend §3.4). Overview tiles, spend timeseries,
 * and model mix — the Overview page's data sources. All SQL-aggregate-backed (services/kpi.ts), V+
 * (any org member), no plan gate (basic dashboard, available on every tier). Read-only.
 */
export const kpiRoutes: FastifyPluginAsync<KpiDeps> = async (fastify, { db }) => {
  fastify.get('/kpi/overview', async (request) => {
    const { orgId } = orgContext.require();
    requireRole('viewer');
    const q = (request.query ?? {}) as { period?: string };
    const period = q.period ?? currentMonthKey();
    if (!PERIOD_RE.test(period)) badRequest('period must be YYYY-MM');
    return overviewKpis(db, orgId, period);
  });

  fastify.get('/kpi/spend-timeseries', async (request) => {
    const { orgId } = orgContext.require();
    requireRole('viewer');
    const q = (request.query ?? {}) as {
      start?: string;
      end?: string;
      group_by?: string;
      team_id?: string;
    };
    if (!q.start || !DAY_RE.test(q.start)) badRequest('start (YYYY-MM-DD) is required');
    if (!q.end || !DAY_RE.test(q.end)) badRequest('end (YYYY-MM-DD) is required');
    const startMs = new Date(`${q.start}T00:00:00Z`).getTime();
    const endMs = new Date(`${q.end}T00:00:00Z`).getTime();
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) badRequest('invalid start/end date');
    if (endMs < startMs) badRequest('end is before start');
    if ((endMs - startMs) / MS_PER_DAY > MAX_TIMESERIES_DAYS)
      badRequest(`range exceeds ${MAX_TIMESERIES_DAYS} days`);
    const groupBy: TimeseriesGroupBy = TIMESERIES_GROUP_BYS.includes(
      q.group_by as TimeseriesGroupBy,
    )
      ? (q.group_by as TimeseriesGroupBy)
      : 'none';
    return spendTimeseries(db, orgId, {
      start: q.start!,
      end: q.end!,
      groupBy,
      teamId: q.team_id,
    });
  });

  fastify.get('/kpi/model-mix', async (request) => {
    const { orgId } = orgContext.require();
    requireRole('viewer');
    const q = (request.query ?? {}) as { period?: string; limit?: string };
    const period = q.period ?? currentMonthKey();
    if (!PERIOD_RE.test(period)) badRequest('period must be YYYY-MM');
    const parsed = q.limit ? Number.parseInt(q.limit, 10) : 10;
    const limit = Number.isNaN(parsed) ? 10 : Math.min(50, Math.max(1, parsed));
    return modelMix(db, orgId, period, limit);
  });
};
