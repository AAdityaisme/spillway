import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { SpillwayError, internalBus, createProviderKeySchema } from '@spillway/shared';
import type { DatabaseClient } from '../../db/client.js';
import { providerKeys } from '../../db/schema.js';
import { orgContext } from '../../org-context.js';
import { withOrg } from '../../db/tenancy.js';
import { requireRole } from '../../auth/rbac.js';
import { assertSafeBaseUrl } from '../../auth/ssrf.js';
import { appendAudit } from '../../services/audit.js';
import { providerKeyAad, type Encryptor } from '../../services/encryptor.js';
import { parse } from '../validate.js';

export interface ProviderKeysDeps {
  db: DatabaseClient;
  encryptor: Encryptor;
}

/** Public projection — NEVER includes ciphertext/iv/tag. */
const publicCols = {
  id: providerKeys.id,
  provider: providerKeys.provider,
  label: providerKeys.label,
  baseUrl: providerKeys.baseUrl,
  keyPrefix: providerKeys.keyPrefix,
  status: providerKeys.status,
  createdAt: providerKeys.createdAt,
};

export const providerKeysRoutes: FastifyPluginAsync<ProviderKeysDeps> = async (
  fastify,
  { db, encryptor },
) => {
  fastify.get('/provider-keys', async () => {
    requireRole('admin'); // 04-api §851: A+ only — provider-key metadata is not viewer-visible
    const { orgId } = orgContext.require();
    const rows = await withOrg(db, orgId, (tx) => tx.select(publicCols).from(providerKeys));
    return { providerKeys: rows };
  });

  fastify.post('/provider-keys', async (request, reply) => {
    const { orgId, userId } = orgContext.require();
    requireRole('admin');
    const body = parse(createProviderKeySchema, request.body);
    // SSRF-validate any base_url that made it through the schema (which now only
    // permits it for openai_compat) — belt-and-braces against the bypass.
    if (body.baseUrl) assertSafeBaseUrl(body.baseUrl);

    // Generate the id up front so the seal can bind the ciphertext to (org, key) via AAD (§1.2).
    const keyId = randomUUID();
    const sealed = encryptor.encrypt(body.apiKey, providerKeyAad(orgId, keyId));
    const key = await withOrg(db, orgId, async (tx) => {
      const [created] = await tx
        .insert(providerKeys)
        .values({
          id: keyId,
          orgId,
          provider: body.provider,
          label: body.label,
          baseUrl: body.baseUrl ?? null,
          keyPrefix: body.apiKey.slice(0, 8),
          keyCiphertext: sealed.ciphertext,
          keyIv: sealed.iv,
          keyTag: sealed.tag,
          encVersion: sealed.version,
          createdBy: userId,
        })
        .returning(publicCols);
      if (!created) throw new Error('provider key insert returned no row');
      await appendAudit(tx, {
        action: 'provider_key.create',
        target: { type: 'provider_key', id: created.id },
        meta: { provider: body.provider, label: body.label },
      });
      return created;
    });
    // Post-commit: a new provider key changes the org's dispatchable key set → sweep org bundles.
    internalBus.emit('org:mutated', { orgId });
    reply.code(201);
    return { providerKey: key };
  });

  fastify.delete<{ Params: { id: string } }>('/provider-keys/:id', async (request, reply) => {
    const { orgId } = orgContext.require();
    requireRole('admin');
    const { id } = request.params;
    await withOrg(db, orgId, async (tx) => {
      const deleted = await tx
        .delete(providerKeys)
        .where(and(eq(providerKeys.id, id), eq(providerKeys.orgId, orgId)))
        .returning({ id: providerKeys.id });
      if (deleted.length === 0) {
        throw new SpillwayError('not_found', 'provider key not found', { httpStatus: 404 });
      }
      await appendAudit(tx, {
        action: 'provider_key.delete',
        target: { type: 'provider_key', id },
      });
    });
    // Post-commit: removing a provider key narrows every bundle in the org → sweep.
    internalBus.emit('org:mutated', { orgId });
    reply.code(204);
  });
};
