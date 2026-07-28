import type { FastifyPluginAsync } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { SpillwayError, createAdminKeySchema } from '@spillway/shared';
import type { DatabaseClient } from '../../db/client.js';
import { adminApiKeys } from '../../db/schema.js';
import { orgContext } from '../../org-context.js';
import { withOrg } from '../../db/tenancy.js';
import { requireRole } from '../../auth/rbac.js';
import { generateAdminKey } from '../../auth/keys.js';
import { appendAudit } from '../../services/audit.js';
import { parse } from '../validate.js';

export interface AdminApiKeysDeps {
  db: DatabaseClient;
}

/**
 * ⚠️ NON-FUNCTIONAL CREDENTIAL (expanded-audit LOW): admin API keys (`mk-admin-`) are minted, hashed,
 * revealed-once, listed, and revoked here — but NO request-auth path verifies them yet (runAuth only
 * accepts `mk-live-` virtual keys via data-plane/pipeline/auth.ts). So a revealed admin key currently
 * grants NOTHING. Until an admin-key auth path lands (hash lookup → role → orgContext, mirroring
 * runAuth's fail-closed 401 + lastUsedAt bump), the create response carries an explicit `warning` so
 * an operator can't silently rely on a dead credential. When wiring the verify path, delete the
 * warning and add a lastUsedAt-updating lookup.
 */
const ADMIN_KEY_NONFUNCTIONAL_WARNING =
  'Admin API key authentication is not yet enabled — this key does not grant access until the verify path ships.';

const publicCols = {
  id: adminApiKeys.id,
  name: adminApiKeys.name,
  keyPrefix: adminApiKeys.keyPrefix,
  role: adminApiKeys.role,
  status: adminApiKeys.status,
  createdAt: adminApiKeys.createdAt,
  lastUsedAt: adminApiKeys.lastUsedAt,
};

const updateAdminKeySchema = z.object({ status: z.enum(['active', 'revoked']) }).strict();

export const adminApiKeysRoutes: FastifyPluginAsync<AdminApiKeysDeps> = async (fastify, { db }) => {
  fastify.get('/admin-api-keys', async () => {
    requireRole('admin'); // credential-management surface — not viewer-visible
    const { orgId } = orgContext.require();
    const rows = await withOrg(db, orgId, (tx) => tx.select(publicCols).from(adminApiKeys));
    return { adminApiKeys: rows };
  });

  fastify.post('/admin-api-keys', async (request, reply) => {
    const { orgId, userId } = orgContext.require();
    requireRole('owner'); // admin API keys are powerful — owner-only
    const body = parse(createAdminKeySchema, request.body);
    const generated = generateAdminKey();
    const key = await withOrg(db, orgId, async (tx) => {
      const [created] = await tx
        .insert(adminApiKeys)
        .values({
          orgId,
          name: body.name,
          keyHash: generated.hash,
          keyPrefix: generated.prefix,
          role: body.role,
          createdBy: userId,
        })
        .returning(publicCols);
      if (!created) throw new Error('admin key insert returned no row');
      await appendAudit(tx, {
        action: 'admin_api_key.create',
        target: { type: 'admin_api_key', id: created.id },
        meta: { name: body.name, role: body.role },
      });
      return created;
    });
    reply.code(201).header('Cache-Control', 'no-store');
    return {
      adminApiKey: { ...key, key: generated.plaintext },
      warning: ADMIN_KEY_NONFUNCTIONAL_WARNING,
    };
  });

  fastify.patch<{ Params: { id: string } }>('/admin-api-keys/:id', async (request) => {
    const { orgId } = orgContext.require();
    requireRole('owner');
    const { id } = request.params;
    const body = parse(updateAdminKeySchema, request.body);
    const key = await withOrg(db, orgId, async (tx) => {
      const [updated] = await tx
        .update(adminApiKeys)
        .set({ status: body.status })
        .where(and(eq(adminApiKeys.id, id), eq(adminApiKeys.orgId, orgId)))
        .returning(publicCols);
      if (!updated)
        throw new SpillwayError('not_found', 'admin key not found', { httpStatus: 404 });
      await appendAudit(tx, {
        action: `admin_api_key.${body.status}`,
        target: { type: 'admin_api_key', id },
      });
      return updated;
    });
    return { adminApiKey: key };
  });
};
