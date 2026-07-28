import type { FastifyPluginAsync } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { SpillwayError, createAlertSchema, updateAlertSchema } from '@spillway/shared';
import type { DatabaseClient } from '../../db/client.js';
import { alerts, orgs } from '../../db/schema.js';
import { orgContext } from '../../org-context.js';
import { withOrg } from '../../db/tenancy.js';
import { requireRole } from '../../auth/rbac.js';
import { assertSafeBaseUrl } from '../../auth/ssrf.js';
import {
  parseChannels,
  deliverTestFire,
  makeHttpChannelSink,
  type ChannelSink,
} from '../../services/alerts/delivery.js';
import { resolveEntitlements } from '../../auth/entitlements.js';
import { appendAudit } from '../../services/audit.js';
import { isKnownAlertKind, isUserConfigurableKind } from '../../services/alert-kinds.js';
import { parse } from '../validate.js';

export interface AlertsDeps {
  db: DatabaseClient;
  /** §5.6 test-fire channel sink (test seam). Defaults to the production HTTP router over global fetch. */
  channelSink?: ChannelSink;
}

const publicCols = {
  id: alerts.id,
  name: alerts.name,
  kind: alerts.kind,
  scopeType: alerts.scopeType,
  scopeId: alerts.scopeId,
  config: alerts.config,
  channels: alerts.channels,
  enabled: alerts.enabled,
  createdAt: alerts.createdAt,
};

/**
 * Alerts CRUD (19 §5). Entitlement 'alerts' (Pro+). Admin+. `kind` is validated against the
 * ALERT_KINDS registry (unknown → 422; system kinds are not user-creatable). Alerts are NOT a routing-
 * bundle input (read by the anomaly/delivery jobs, not the hot path), so mutations do NOT emit a
 * bundle-invalidation event — correctly absent from the B1.2 lint.
 */
export const alertsRoutes: FastifyPluginAsync<AlertsDeps> = async (
  fastify,
  { db, channelSink },
) => {
  // Default to the production HTTP channel router (Slack + HMAC webhook out of the box; email needs a
  // Resend sender wired, same as the delivery job). Injectable so tests drive a recording sink.
  const sink: ChannelSink =
    channelSink ??
    makeHttpChannelSink({
      fetch: fetch as unknown as (
        url: string,
        init: Record<string, unknown>,
      ) => Promise<{ ok: boolean; status: number }>,
    });

  async function requireAlerts(orgId: string): Promise<void> {
    const [row] = await db
      .select({ plan: orgs.plan })
      .from(orgs)
      .where(eq(orgs.id, orgId))
      .limit(1);
    if (!resolveEntitlements(row?.plan ?? 'free').has('alerts'))
      throw new SpillwayError('tier_required', 'alerts require the Pro plan or higher', {
        httpStatus: 402,
        details: { entitlement: 'alerts' },
      });
  }

  // DECISION (audit 2026-07-08): reads are entitlement-FREE by design across gated resources —
  // an org that downgrades must still SEE its configured alerts/rules/policies (and the 402
  // upsell needs the list view). Writes stay tier-gated. Locked by reads-free.integration.test.ts.
  fastify.get('/alerts', async () => {
    const { orgId } = orgContext.require();
    const rows = await withOrg(db, orgId, (tx) => tx.select(publicCols).from(alerts));
    return { alerts: rows };
  });

  // §5.1: every channel webhook/URL is SSRF-validated on write (HTTPS-only, public IPs, no redirects) so
  // a delivery target can never be pointed at an internal service.
  function validateChannelUrls(channels: unknown): void {
    for (const ch of parseChannels(channels)) {
      if (ch.type === 'slack') assertSafeBaseUrl(ch.webhook_url);
      else if (ch.type === 'webhook') assertSafeBaseUrl(ch.url);
    }
  }

  fastify.post('/alerts', async (request, reply) => {
    const { orgId } = orgContext.require();
    requireRole('admin');
    await requireAlerts(orgId);
    const body = parse(createAlertSchema, request.body);
    validateChannelUrls(body.channels);
    if (!isKnownAlertKind(body.kind))
      throw new SpillwayError('validation_error', `unknown alert kind: ${body.kind}`, {
        httpStatus: 422,
        details: { param: 'kind' },
      });
    if (!isUserConfigurableKind(body.kind))
      throw new SpillwayError('validation_error', `alert kind ${body.kind} is system-managed`, {
        httpStatus: 422,
        details: { param: 'kind' },
      });
    const created = await withOrg(db, orgId, async (tx) => {
      const [row] = await tx
        .insert(alerts)
        .values({
          orgId,
          name: body.name,
          kind: body.kind,
          scopeType: body.scopeType ?? null,
          scopeId: body.scopeId ?? null,
          config: body.config,
          channels: body.channels,
        })
        .returning(publicCols);
      if (!row) throw new Error('alert insert returned no row');
      await appendAudit(tx, {
        action: 'alert.create',
        target: { type: 'alert', id: row.id },
        meta: { kind: body.kind },
      });
      return row;
    });
    reply.code(201);
    return { alert: created };
  });

  fastify.patch<{ Params: { id: string } }>('/alerts/:id', async (request) => {
    const { orgId } = orgContext.require();
    requireRole('admin');
    await requireAlerts(orgId);
    const { id } = request.params;
    const body = parse(updateAlertSchema, request.body);
    if (body.channels !== undefined) validateChannelUrls(body.channels);
    const updated = await withOrg(db, orgId, async (tx) => {
      const [row] = await tx
        .update(alerts)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.config !== undefined ? { config: body.config } : {}),
          ...(body.channels !== undefined ? { channels: body.channels } : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          updatedAt: sql`now()`,
        })
        .where(and(eq(alerts.id, id), eq(alerts.orgId, orgId)))
        .returning(publicCols);
      if (!row) throw new SpillwayError('not_found', 'alert not found', { httpStatus: 404 });
      await appendAudit(tx, { action: 'alert.update', target: { type: 'alert', id } });
      return row;
    });
    return { alert: updated };
  });

  fastify.delete<{ Params: { id: string } }>('/alerts/:id', async (request, reply) => {
    const { orgId } = orgContext.require();
    requireRole('admin');
    await requireAlerts(orgId);
    const { id } = request.params;
    await withOrg(db, orgId, async (tx) => {
      const del = await tx
        .delete(alerts)
        .where(and(eq(alerts.id, id), eq(alerts.orgId, orgId)))
        .returning({ id: alerts.id });
      if (del.length === 0)
        throw new SpillwayError('not_found', 'alert not found', { httpStatus: 404 });
      await appendAudit(tx, { action: 'alert.delete', target: { type: 'alert', id } });
    });
    reply.code(204);
  });

  // §5.6 test-fire: synchronously deliver a synthetic `test:true` payload to the alert's configured
  // channels so the operator can verify wiring. Bypasses the queue + dedupe, delivers directly, returns
  // per-channel results (a failed channel is a 200 with ok:false, not a request error), 15 s timeout,
  // NO audit entry. Admin + entitlement-gated like the mutations (it hits external endpoints).
  fastify.post<{ Params: { id: string } }>('/alerts/:id/test', async (request) => {
    const { orgId } = orgContext.require();
    requireRole('admin');
    await requireAlerts(orgId);
    const { id } = request.params;
    const alert = await withOrg(db, orgId, async (tx) => {
      const [row] = await tx
        .select({ kind: alerts.kind, channels: alerts.channels })
        .from(alerts)
        .where(and(eq(alerts.id, id), eq(alerts.orgId, orgId)))
        .limit(1);
      return row;
    });
    if (!alert) throw new SpillwayError('not_found', 'alert not found', { httpStatus: 404 });
    const channels = parseChannels(alert.channels);
    const results = await deliverTestFire({ orgId, kind: alert.kind, channels }, sink);
    return { kind: alert.kind, delivered: results.filter((r) => r.ok).length, results };
  });
};
