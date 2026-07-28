import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq, gte, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import { SpillwayError } from '@spillway/shared';
import type { DatabaseClient } from '../../db/client.js';
import { requests, routingRules, virtualKeys } from '../../db/schema.js';
import { orgContext } from '../../org-context.js';
import { withOrg, type Tx } from '../../db/tenancy.js';

export interface RequestsDeps {
  db: DatabaseClient;
}

/**
 * Traffic-log columns (04-api-contracts §3.11 list shape). camelCase to match every other V2
 * control-plane projection + the hand-written `apps/web` api client — the bible prose shows
 * snake_case, but that predates the two-plane split (it also still writes `/api/v1/orgs/:id/...`
 * while V2 routes org via the `X-Spillway-Org` header). `unit_prices` is detail-only, so it is
 * NOT selected here; internal columns (config_snapshot_hash, request_features) are never exposed.
 */
const listCols = {
  id: requests.id,
  orgId: requests.orgId,
  virtualKeyId: requests.virtualKeyId,
  teamId: requests.teamId,
  provider: requests.provider,
  model: requests.model,
  requestedModel: requests.requestedModel,
  endpoint: requests.endpoint,
  status: requests.status,
  blockReason: requests.blockReason,
  blockScopeType: requests.blockScopeType,
  blockScopeId: requests.blockScopeId,
  blockPeriod: requests.blockPeriod,
  errorCode: requests.errorCode,
  httpStatus: requests.httpStatus,
  stream: requests.stream,
  inputTokens: requests.inputTokens,
  outputTokens: requests.outputTokens,
  cachedReadTokens: requests.cachedReadTokens,
  cacheWriteTokens: requests.cacheWriteTokens,
  reasoningTokens: requests.reasoningTokens,
  usageEstimated: requests.usageEstimated,
  costUsd: requests.costUsd,
  latencyMs: requests.latencyMs,
  ttftMs: requests.ttftMs,
  fallbackFrom: requests.fallbackFrom,
  routingRuleId: requests.routingRuleId,
  metadata: requests.metadata,
  createdAt: requests.createdAt,
};

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * `created_at` at FULL microsecond precision for the cursor. The driver returns the column as a JS
 * `Date` (millisecond-only), so a cursor built from `.toISOString()` would round sub-millisecond
 * away — and any row that shares a page boundary's millisecond (routine on a gateway doing many
 * requests/ms) would then fall outside both keyset branches and be silently skipped ("nothing lost,
 * ever"). Rendering to ISO-with-`US` text preserves micros through the base64 round-trip, and the
 * cursor predicate casts it straight back to `timestamptz` for an exact comparison.
 */
const cursorTsExpr = sql<string>`to_char(${requests.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const listColsWithCursor = { ...listCols, cursorTs: cursorTsExpr };

interface Cursor {
  ts: string;
  id: string;
}

/** Opaque base64url of `{ts,id}` — the last row's (created_at, id) at full precision. §1.3. */
function encodeCursor(row: { cursorTs: string; id: string }): string {
  const c: Cursor = { ts: row.cursorTs, id: row.id };
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new SpillwayError('validation_error', 'malformed cursor', { httpStatus: 400 });
  }
  const c = parsed as Partial<Cursor>;
  if (typeof c.ts !== 'string' || typeof c.id !== 'string' || Number.isNaN(Date.parse(c.ts)))
    throw new SpillwayError('validation_error', 'malformed cursor', { httpStatus: 400 });
  return { ts: c.ts, id: c.id };
}

/** Clamp the requested page size into [1, 200], defaulting to 50 (§1.3). */
function clampLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, n));
}

/**
 * A member (ADR-012) sees only requests made with keys they created; O/A/V see all. This mirrors
 * `virtual-keys` GET — RLS already scopes the subquery to the org, so no cross-org leak is possible.
 * Returns the SQL predicate to AND into the WHERE, or `undefined` for the see-all roles.
 */
function memberScope(tx: Tx, role: string, userId: string): SQL | undefined {
  if (role !== 'member') return undefined;
  return inArray(
    requests.virtualKeyId,
    tx.select({ id: virtualKeys.id }).from(virtualKeys).where(eq(virtualKeys.createdBy, userId)),
  );
}

/**
 * Requests / traffic-log read API (04-api-contracts §3.11; 09-frontend §3.5–3.6). The live-feed +
 * request-log data source. Keyset pagination, newest-first, `created_at DESC, id DESC`. Every query
 * runs under `withOrg` (RLS-armed). Read-only — no audit rows, no mutations.
 */
export const requestsRoutes: FastifyPluginAsync<RequestsDeps> = async (fastify, { db }) => {
  fastify.get('/requests', async (request) => {
    const { orgId, userId, role } = orgContext.require();
    const q = (request.query ?? {}) as {
      limit?: string;
      cursor?: string;
      start?: string;
      end?: string;
      virtual_key_id?: string;
      team_id?: string;
      model?: string;
      provider?: string;
      status?: string;
      endpoint?: string;
    };
    const limit = clampLimit(q.limit);
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;

    const rows = await withOrg(db, orgId, async (tx) => {
      const where: (SQL | undefined)[] = [memberScope(tx, role, userId)];

      // Keyset predicate: fetch strictly-older rows than the cursor. A Postgres row-value comparison
      // `(created_at, id) < (ts, id)` is the exact lexicographic tie-break the `created_at DESC, id
      // DESC` order needs; `ts` is cast from the full-precision cursor text (see cursorTsExpr).
      if (cursor) {
        where.push(
          sql`(${requests.createdAt}, ${requests.id}) < (${cursor.ts}::timestamptz, ${cursor.id}::uuid)`,
        );
      }
      if (q.start) {
        const start = new Date(q.start);
        if (Number.isNaN(start.getTime()))
          throw new SpillwayError('validation_error', 'invalid start', { httpStatus: 400 });
        where.push(gte(requests.createdAt, start));
      }
      if (q.end) {
        const end = new Date(q.end);
        if (Number.isNaN(end.getTime()))
          throw new SpillwayError('validation_error', 'invalid end', { httpStatus: 400 });
        where.push(lte(requests.createdAt, end));
      }
      if (q.virtual_key_id) where.push(eq(requests.virtualKeyId, q.virtual_key_id));
      if (q.team_id) where.push(eq(requests.teamId, q.team_id));
      // `model` matches either the served model or the alias the client asked for (§3.11).
      if (q.model)
        where.push(or(eq(requests.model, q.model), eq(requests.requestedModel, q.model)));
      if (q.provider) where.push(eq(requests.provider, q.provider));
      if (q.status) where.push(eq(requests.status, q.status));
      if (q.endpoint) where.push(eq(requests.endpoint, q.endpoint));

      // Fetch limit+1 to know whether another page exists without a second COUNT query.
      return tx
        .select(listColsWithCursor)
        .from(requests)
        .where(and(...where.filter((c): c is SQL => c !== undefined)))
        .orderBy(desc(requests.createdAt), desc(requests.id))
        .limit(limit + 1);
    });

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last) : null;
    // cursorTs is an internal pagination field — strip it from the wire shape (§3.11 list contract).
    const data = pageRows.map(({ cursorTs: _cursorTs, ...row }) => row);
    return { data, pagination: { has_more: hasMore, next_cursor: nextCursor } };
  });

  fastify.get<{ Params: { id: string } }>(
    '/requests/:id',
    {
      // Reject a non-UUID id with a declared 400 before any DB round-trip (mirrors traces.ts / audit L39).
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
      },
    },
    async (request) => {
      const { orgId, userId, role } = orgContext.require();
      const row = await withOrg(db, orgId, async (tx) => {
        const scope = memberScope(tx, role, userId);
        const [r] = await tx
          .select({
            ...listCols,
            unitPrices: requests.unitPrices,
            routingRuleName: routingRules.description,
          })
          .from(requests)
          .leftJoin(routingRules, eq(routingRules.id, requests.routingRuleId))
          .where(and(eq(requests.id, request.params.id), scope))
          .limit(1);
        return r;
      });
      // 404 (not 403) for a member reaching another member's request — never leak existence.
      if (!row) throw new SpillwayError('not_found', 'request not found', { httpStatus: 404 });
      return { request: row };
    },
  );
};
