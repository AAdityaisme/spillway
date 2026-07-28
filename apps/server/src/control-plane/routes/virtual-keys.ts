import type { FastifyPluginAsync } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import {
  SpillwayError,
  internalBus,
  createVirtualKeySchema,
  updateVirtualKeySchema,
} from '@spillway/shared';
import type { DatabaseClient } from '../../db/client.js';
import { virtualKeys, teams } from '../../db/schema.js';
import { orgContext } from '../../org-context.js';
import { withOrg } from '../../db/tenancy.js';
import { requireRole } from '../../auth/rbac.js';
import { generateVirtualKey } from '../../auth/keys.js';
import { appendAudit } from '../../services/audit.js';
import { parse } from '../validate.js';

export interface VirtualKeysDeps {
  db: DatabaseClient;
}

/** Public projection — NEVER includes key_hash. */
const publicCols = {
  id: virtualKeys.id,
  name: virtualKeys.name,
  teamId: virtualKeys.teamId,
  keyPrefix: virtualKeys.keyPrefix,
  status: virtualKeys.status,
  allowedProviders: virtualKeys.allowedProviders,
  allowedModels: virtualKeys.allowedModels,
  rpmLimit: virtualKeys.rpmLimit,
  tpmLimit: virtualKeys.tpmLimit,
  expiresAt: virtualKeys.expiresAt,
  lastUsedAt: virtualKeys.lastUsedAt,
  metadata: virtualKeys.metadata,
  createdAt: virtualKeys.createdAt,
};

export const virtualKeysRoutes: FastifyPluginAsync<VirtualKeysDeps> = async (fastify, { db }) => {
  fastify.get('/virtual-keys', async () => {
    const { orgId, userId, role } = orgContext.require();
    // ADR-012 / 04-api §983: members see only their own keys; O/A/V see all.
    const rows = await withOrg(db, orgId, (tx) =>
      role === 'member'
        ? tx.select(publicCols).from(virtualKeys).where(eq(virtualKeys.createdBy, userId))
        : tx.select(publicCols).from(virtualKeys),
    );
    return { virtualKeys: rows };
  });

  fastify.post('/virtual-keys', async (request, reply) => {
    const { orgId, userId } = orgContext.require();
    requireRole('member'); // 04-api §571: members create + manage their own keys
    const body = parse(createVirtualKeySchema, request.body);
    const generated = generateVirtualKey();
    const key = await withOrg(db, orgId, async (tx) => {
      // A team FK only proves the team EXISTS; Postgres RI bypasses RLS, so a cross-org team
      // UUID would be accepted. Verify ownership under RLS (this SELECT only returns same-org
      // teams) — else a borrowed team_id poisons the team-scoped spend counter and, once it
      // collides with the real owner's row, RLS turns the upsert into a failing insert that
      // silently rolls back the whole reconcile tx (red-team ADR-032 H1).
      if (body.teamId) {
        const [team] = await tx
          .select({ id: teams.id })
          .from(teams)
          .where(eq(teams.id, body.teamId))
          .limit(1);
        if (!team)
          throw new SpillwayError('validation_error', 'team not found in this org', {
            httpStatus: 400,
            details: { param: 'teamId' },
          });
      }
      const [created] = await tx
        .insert(virtualKeys)
        .values({
          orgId,
          teamId: body.teamId ?? null,
          name: body.name,
          keyHash: generated.hash,
          keyPrefix: generated.prefix,
          allowedProviders: body.allowedProviders ?? null,
          allowedModels: body.allowedModels ?? null,
          rpmLimit: body.rpmLimit ?? null,
          tpmLimit: body.tpmLimit ?? null,
          maxInputTokens: body.maxInputTokens ?? null,
          maxOutputTokens: body.maxOutputTokens ?? null,
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
          metadata: body.metadata ?? {},
          createdBy: userId,
        })
        .returning(publicCols);
      if (!created) throw new Error('virtual key insert returned no row');
      await appendAudit(tx, {
        action: 'virtual_key.create',
        target: { type: 'virtual_key', id: created.id },
        meta: { name: body.name },
      });
      return created;
    });
    // Post-commit: evict any cached bundle for this key (17 §3.3 narrowing-write invalidation).
    internalBus.emit('virtual-key:mutated', { virtualKeyId: key.id });
    // Plaintext is shown exactly once and must never be cached.
    reply.code(201).header('Cache-Control', 'no-store');
    return { virtualKey: { ...key, key: generated.plaintext } };
  });

  fastify.patch<{ Params: { id: string } }>('/virtual-keys/:id', async (request) => {
    const { orgId, userId, role } = orgContext.require();
    requireRole('member'); // members may manage their OWN keys; A+ any
    const { id } = request.params;
    const body = parse(updateVirtualKeySchema, request.body);
    const key = await withOrg(db, orgId, async (tx) => {
      const scope =
        role === 'member'
          ? and(
              eq(virtualKeys.id, id),
              eq(virtualKeys.orgId, orgId),
              eq(virtualKeys.createdBy, userId),
            )
          : and(eq(virtualKeys.id, id), eq(virtualKeys.orgId, orgId));
      const [updated] = await tx
        .update(virtualKeys)
        .set({ status: body.status, updatedAt: sql`now()` })
        .where(scope)
        .returning(publicCols);
      if (!updated)
        throw new SpillwayError('not_found', 'virtual key not found', { httpStatus: 404 });
      await appendAudit(tx, {
        action: `virtual_key.${body.status}`,
        target: { type: 'virtual_key', id },
      });
      return updated;
    });
    // Post-commit: a status/limit change narrows the key — evict its cached bundle (17 §3.3).
    internalBus.emit('virtual-key:mutated', { virtualKeyId: id });
    return { virtualKey: key };
  });
};
