import type { FastifyPluginAsync } from 'fastify';
import cors from '@fastify/cors';
import type { JWTVerifyGetKey } from 'jose';
import { SpillwayError, controlPlaneErrorBody } from '@spillway/shared';
import { pgErrorCode } from '../db/pg-error.js';
import { registerControlPlaneRateLimit } from './rate-limit.js';
import type { Config } from '../config.js';
import type { DatabaseClient } from '../db/client.js';
import type { VerifyOptions } from '../auth/workos-jwt.js';
import { makeAuthHook } from '../auth/workos-plugin.js';
import { makeEncryptor } from '../services/encryptor.js';
import { makeTenancyHook } from './middleware/tenancy.js';
import { orgsRoutes } from './routes/orgs.js';
import { orgSettingsRoutes } from './routes/org-settings.js';
import { membersRoutes } from './routes/members.js';
import { teamsRoutes } from './routes/teams.js';
import { providerKeysRoutes } from './routes/provider-keys.js';
import { virtualKeysRoutes } from './routes/virtual-keys.js';
import { adminApiKeysRoutes } from './routes/admin-api-keys.js';
import { budgetsRoutes } from './routes/budgets.js';
import { aliasesRoutes } from './routes/aliases.js';
import { routingRulesRoutes } from './routes/routing-rules.js';
import { policiesRoutes } from './routes/policies.js';
import { decisionLogsRoutes } from './routes/decision-logs.js';
import { alertsRoutes } from './routes/alerts.js';
import { approvalsRoutes } from './routes/approvals.js';
import { automationRulesRoutes } from './routes/automation-rules.js';
import { approvalPoliciesRoutes } from './routes/approval-policies.js';
import { delegationsRoutes } from './routes/delegations.js';
import { reportsRoutes } from './routes/reports.js';
import { tracesRoutes } from './routes/traces.js';
import { requestsRoutes } from './routes/requests.js';
import { kpiRoutes } from './routes/kpi.js';

export interface ControlPlaneOptions {
  config?: Config;
  db?: DatabaseClient;
  /** Test seam: inject a local JWKS + verify options instead of WorkOS's remote JWKS. */
  auth?: { jwks?: JWTVerifyGetKey; verifyOpts?: VerifyOptions };
}

/**
 * CONTROL PLANE (`/api/*`) — the dashboard API (02-architecture §1, §4; ADR-003).
 *
 * Hard boundary: never imports the data plane. Pipeline per request: auth
 * (onRequest, all routes) → tenancy (preHandler, org-scoped routes) → handler
 * (zod-validate → RBAC → service via withOrg → audit append). CORS is locked to
 * DASHBOARD_ORIGIN, deny-all if unset. Without db/config (boot/smoke tests) it
 * registers only the error handler + CORS — no routes.
 */
export const controlPlanePlugin: FastifyPluginAsync<ControlPlaneOptions> = async (
  fastify,
  opts,
) => {
  await fastify.register(cors, {
    origin: opts.config?.DASHBOARD_ORIGIN ?? false,
    credentials: false, // bearer-only auth; no cookies; 10-security §5.5 [corrected 2026-06-22]
  });

  fastify.setErrorHandler((error, request, reply) => {
    if (error instanceof SpillwayError) {
      reply.code(error.httpStatus).send(controlPlaneErrorBody(error));
      return;
    }
    // Unwrap DrizzleQueryError → PostgresError SQLSTATE (see db/pg-error). Without this every DB
    // constraint failure — duplicate, FK, bad-uuid — collapses to an opaque 500.
    const pgCode = pgErrorCode(error);
    if (pgCode === '23505') {
      const e = new SpillwayError('conflict', 'resource already exists', { httpStatus: 409 });
      reply.code(409).send(controlPlaneErrorBody(e));
      return;
    }
    if (pgCode === '23503') {
      const e = new SpillwayError('not_found', 'referenced entity does not exist', {
        httpStatus: 404,
      });
      reply.code(404).send(controlPlaneErrorBody(e));
      return;
    }
    if (pgCode === '22P02') {
      // invalid text representation — e.g. a malformed uuid path param reaching the DB
      const e = new SpillwayError('validation_error', 'malformed identifier', { httpStatus: 422 });
      reply.code(422).send(controlPlaneErrorBody(e));
      return;
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const e = new SpillwayError('invalid_request', (error as Error).message, {
        httpStatus: status,
      });
      reply.code(status).send(controlPlaneErrorBody(e));
      return;
    }
    request.log.error({ err: error }, 'control-plane error');
    const e = new SpillwayError('internal_error', 'internal server error', { httpStatus: 500 });
    reply.code(500).send(controlPlaneErrorBody(e));
  });

  if (!opts.config || !opts.db) return;
  const { config, db } = opts;
  const encryptor = makeEncryptor(config);

  // IP rate limiting (10-security §5.4) — registered BEFORE auth so an unauthenticated flood is
  // throttled too. Loopback bypasses, so local dev + the test harness are unaffected.
  registerControlPlaneRateLimit(fastify);

  fastify.addHook(
    'onRequest',
    makeAuthHook({ config, db, jwks: opts.auth?.jwks, verifyOpts: opts.auth?.verifyOpts }),
  );

  // Non-org-scoped (auth only): list my orgs, create org.
  await fastify.register(orgsRoutes, { db });

  // Org-scoped (auth + tenancy via X-Spillway-Org).
  await fastify.register(async (scoped) => {
    scoped.addHook('preHandler', makeTenancyHook(db));
    await scoped.register(orgSettingsRoutes, { db });
    await scoped.register(membersRoutes, { db });
    await scoped.register(teamsRoutes, { db });
    await scoped.register(providerKeysRoutes, { db, encryptor });
    await scoped.register(virtualKeysRoutes, { db });
    await scoped.register(adminApiKeysRoutes, { db });
    await scoped.register(budgetsRoutes, { db });
    await scoped.register(aliasesRoutes, { db });
    await scoped.register(routingRulesRoutes, { db });
    await scoped.register(policiesRoutes, { db });
    await scoped.register(decisionLogsRoutes, { db });
    await scoped.register(alertsRoutes, { db });
    await scoped.register(approvalsRoutes, { db });
    await scoped.register(automationRulesRoutes, { db });
    await scoped.register(approvalPoliciesRoutes, { db });
    await scoped.register(delegationsRoutes, { db });
    await scoped.register(reportsRoutes, { db });
    await scoped.register(tracesRoutes, { db });
    await scoped.register(requestsRoutes, { db });
    await scoped.register(kpiRoutes, { db });
  });
};
