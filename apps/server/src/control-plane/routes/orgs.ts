import type { FastifyPluginAsync } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { createOrgSchema, SpillwayError } from '@spillway/shared';
import type { DatabaseClient } from '../../db/client.js';
import { orgs, orgMembers, auditLog, modelAliases, users } from '../../db/schema.js';
import { requireUser } from '../../auth/workos-plugin.js';
import { parse } from '../validate.js';

export interface OrgsDeps {
  db: DatabaseClient;
}

/**
 * Non-org-scoped org routes (auth only, no X-Spillway-Org): list the caller's
 * orgs and create a new one. These run before any org is selected, so they set
 * the GUCs manually rather than going through the tenancy middleware.
 */
export const orgsRoutes: FastifyPluginAsync<OrgsDeps> = async (fastify, { db }) => {
  fastify.get('/orgs', async (request) => {
    const user = requireUser(request);
    const rows = await db.transaction(async (tx) => {
      // arm the ADR-025 bootstrap policy so the caller sees their own memberships
      await tx.execute(sql`select set_config('app.current_user_id', ${user.sub}, true)`);
      return tx
        .select({
          id: orgs.id,
          name: orgs.name,
          slug: orgs.slug,
          plan: orgs.plan,
          role: orgMembers.role,
        })
        .from(orgMembers)
        .innerJoin(orgs, eq(orgs.id, orgMembers.orgId))
        .where(eq(orgMembers.userId, user.sub));
    });
    return { orgs: rows };
  });

  // M23: per-user cap on org creation — a single authenticated user scripting thousands of
  // POST /api/orgs exhausts DB storage and audit_log rows with no throttle. The IP-level
  // rate-limit (@fastify/rate-limit) is deferred until it's added as a dependency; this
  // application-level guard prevents unbounded growth per user today.
  const MAX_ORGS_PER_USER = 20;

  // Default seeded aliases (08-routing §2). Regular rows the org can later edit/delete — the seed
  // reflects insertion-time June-2026 pricing/capability, NOT a permanent contract. Ordered targets:
  // the head leads on quality/price, the tail is a same-tier cross-provider fallback for outages.
  const DEFAULT_ALIASES: Array<{
    alias: string;
    targets: Array<{ provider: string; model: string }>;
  }> = [
    {
      alias: 'spillway/cheap',
      targets: [
        { provider: 'gemini', model: 'gemini-2.5-flash-lite' },
        { provider: 'openai', model: 'gpt-4.1-nano' },
      ],
    },
    {
      alias: 'spillway/balanced',
      targets: [
        { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        { provider: 'openai', model: 'gpt-5.4' },
        { provider: 'gemini', model: 'gemini-2.5-pro' },
      ],
    },
    {
      alias: 'spillway/premium',
      targets: [
        { provider: 'anthropic', model: 'claude-opus-4-8' },
        { provider: 'openai', model: 'gpt-5.5' },
      ],
    },
  ];

  fastify.post('/orgs', async (request, reply) => {
    const user = requireUser(request);
    const body = parse(createOrgSchema, request.body);

    // Count the caller's current org memberships AND the org insert (+ default-alias seeding)
    // now share one transaction, gated by a per-user advisory lock, so concurrent POST /orgs from
    // the same user can't all read count<MAX_ORGS_PER_USER before any of them commits an insert
    // (the TOCTOU that let one user create unboundedly many orgs). Two-int form keeps this in its
    // own lock space, separate from the scheduler's and reconcile's advisory locks (see
    // reconcile.ts) — a shared space would serialize unrelated subsystems together.
    const org = await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_user_id', ${user.sub}, true)`);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('spillway:org:create'), hashtext(${user.sub}))`,
      );

      const [ownedRow] = (await tx.execute(
        sql`select count(*)::int as n from org_members where user_id = ${user.sub}`,
      )) as unknown as { n: number }[];
      if ((ownedRow?.n ?? 0) >= MAX_ORGS_PER_USER) {
        throw new SpillwayError(
          'validation_error',
          `exceeded the maximum of ${MAX_ORGS_PER_USER} organizations per user`,
          { httpStatus: 429, details: { limit: MAX_ORGS_PER_USER } },
        );
      }

      // The auth hook mirrors the WorkOS user into `users` FIRE-AND-FORGET (M25: a transient
      // write failure must never 401 an otherwise-valid token). org_members.user_id is a NOT NULL
      // FK to users.id, so on a brand-new user's FIRST request — which on the signup path is
      // exactly this one — the membership insert below can beat the mirror and die on the FK,
      // surfacing as a bogus "referenced entity does not exist". Load makes it MORE likely, so it
      // reads like flake while actually being a broken signup.
      //
      // Making this transaction self-sufficient removes the ordering dependency entirely without
      // giving up M25's availability property. Idempotent, and it never clobbers a mirrored
      // profile with the token's (possibly staler) claims.
      await tx
        .insert(users)
        .values({
          id: user.sub,
          email: user.email ?? `${user.sub}@users.workos`,
          name: user.name ?? null,
        })
        .onConflictDoNothing({ target: users.id });

      const [created] = await tx
        .insert(orgs)
        .values({ name: body.name, slug: body.slug })
        .returning();
      if (!created) throw new Error('org insert returned no row');
      // arm org_isolation for THIS new org so the owner membership + audit insert
      await tx.execute(sql`select set_config('app.current_org_id', ${created.id}, true)`);
      await tx.insert(orgMembers).values({ orgId: created.id, userId: user.sub, role: 'owner' });
      await tx.insert(auditLog).values({
        orgId: created.id,
        actorType: 'user',
        actorId: user.sub,
        actorName: user.name ?? null,
        actorEmail: user.email ?? null,
        actorRole: 'owner',
        action: 'org.create',
        target: { type: 'org', id: created.id },
        meta: {},
      });
      // Seed the three default routing aliases inside the SAME tx (org_isolation GUC is armed above),
      // so a new org has a working spillway/{cheap,balanced,premium} routing surface immediately (§2).
      await tx
        .insert(modelAliases)
        .values(
          DEFAULT_ALIASES.map((a) => ({ orgId: created.id, alias: a.alias, targets: a.targets })),
        );
      // Seed the org-wide default approval policy (18 §2.10): a one-step require_any(admin|owner) chain,
      // behaviorally identical to the pre-M3 "any admin approves" flow. This makes policy selection
      // (§2.1.2) never return null, so the require_approval automation effect AND human-initiated
      // approval requests always find a chain to freeze. kind='*' + scope_type NULL = the org default.
      const defaultApprovalPolicy = {
        tiers: [
          {
            min_amount_usd: '0',
            steps: [{ approvers: { roles: ['admin', 'owner'] }, quorum: 'any' }],
          },
        ],
        expiry_hours: 336,
      };
      await tx.execute(sql`
        insert into approval_policies
          (org_id, name, kind, scope_type, scope_id, definition, version, enabled, created_by)
        values (${created.id}, 'Default approval', '*', null, null,
                ${JSON.stringify(defaultApprovalPolicy)}::jsonb, 1, true, ${user.sub})`);
      return created;
    });
    reply.code(201);
    return { org };
  });
};
