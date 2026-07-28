/**
 * RLS coverage for the two GUC-armed bootstrap policies that run BEFORE an org is
 * resolved — the data-plane auth primitive and the login membership lookup. These
 * policies are security-critical and were previously unproven (audit M22 + L21).
 *
 *  - M22 virtual_keys_dataplane_lookup (0008): the gateway resolves a virtual key
 *    by sha256(key_hash) with only `app.lookup_key_hash` armed. Must expose exactly
 *    the matching row, must NOT table-scan when the GUC is empty/unset, and must
 *    return zero rows on a hash mismatch.
 *  - L21 org_members_user_bootstrap (0002): login resolves a user's memberships
 *    with only `app.current_user_id` armed. Must expose only THAT user's rows, and
 *    is FOR SELECT only (no write through this path).
 *
 * Also asserts the FORCE-RLS guarantee per covered table via pg_class
 * (audit L22): FORCE is applied on every org-scoped table, so even a table owner
 * is subject to RLS. A dropped FORCE clause in a future migration fails here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';

describe('data-plane auth + bootstrap RLS policies', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await makeTestApp();
  });
  afterEach(async () => {
    await h.close();
  });

  /** Seed an org + a virtual key (as superuser, bypassing RLS) and return the hash. */
  async function seedVirtualKey(name: string): Promise<{ orgId: string; hashHex: string }> {
    const orgId = randomUUID();
    const hashHex = createHash('sha256').update(`plaintext-${name}-${randomUUID()}`).digest('hex');
    await h.adminSql`insert into orgs (id, name, slug) values (${orgId}, ${name}, ${name})`;
    await h.adminSql`
      insert into virtual_keys (org_id, name, key_hash, key_prefix)
      values (${orgId}, ${name}, decode(${hashHex}, 'hex'), 'mk-live-abc')`;
    return { orgId, hashHex };
  }

  // ── M22: virtual_keys_dataplane_lookup ────────────────────────────────────────
  it('M22: app role sees ONLY the key whose hash matches app.lookup_key_hash', async () => {
    const a = await seedVirtualKey('org-a');
    await seedVirtualKey('org-b'); // decoy in a different org

    const rows = await h.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.lookup_key_hash', ${a.hashHex}, true)`);
      return tx.execute(sql`select id, org_id from virtual_keys`);
    });
    expect(rows).toHaveLength(1);
    expect((rows[0] as { org_id: string }).org_id).toBe(a.orgId);
  });

  it('M22: a bare SELECT with no GUC armed returns zero rows (no table scan)', async () => {
    await seedVirtualKey('org-a');
    await seedVirtualKey('org-b');

    // app.lookup_key_hash unset AND app.current_org_id unset → both policies false.
    const rows = await h.db.execute(sql`select id from virtual_keys`);
    expect(rows).toHaveLength(0);
  });

  it('M22: an empty-string GUC returns zero rows (nullif guard)', async () => {
    await seedVirtualKey('org-a');
    const rows = await h.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.lookup_key_hash', '', true)`);
      return tx.execute(sql`select id from virtual_keys`);
    });
    expect(rows).toHaveLength(0);
  });

  it('M22: a mismatched hash returns zero rows', async () => {
    await seedVirtualKey('org-a');
    const otherHash = createHash('sha256').update('nonexistent').digest('hex');
    const rows = await h.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.lookup_key_hash', ${otherHash}, true)`);
      return tx.execute(sql`select id from virtual_keys`);
    });
    expect(rows).toHaveLength(0);
  });

  // ── L21: org_members_user_bootstrap ───────────────────────────────────────────
  it('L21: bootstrap read exposes only the armed user_id and hides other users', async () => {
    const orgId = randomUUID();
    await h.adminSql`insert into orgs (id, name, slug) values (${orgId}, 'org', 'org')`;
    await h.adminSql`insert into users (id, email) values ('user_a', 'a@test.dev')`;
    await h.adminSql`insert into users (id, email) values ('user_b', 'b@test.dev')`;
    await h.adminSql`insert into org_members (org_id, user_id, role) values (${orgId}, 'user_a', 'owner')`;
    await h.adminSql`insert into org_members (org_id, user_id, role) values (${orgId}, 'user_b', 'member')`;

    const rows = await h.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_user_id', 'user_a', true)`);
      return tx.execute(sql`select user_id from org_members`);
    });
    expect(rows).toHaveLength(1);
    expect((rows[0] as { user_id: string }).user_id).toBe('user_a');
  });

  it('L21: the bootstrap path is SELECT-only — a write is denied', async () => {
    const orgId = randomUUID();
    await h.adminSql`insert into orgs (id, name, slug) values (${orgId}, 'org', 'org')`;
    await h.adminSql`insert into users (id, email) values ('user_a', 'a@test.dev')`;

    // With only app.current_user_id armed (no org GUC), the org_isolation policy's
    // WITH CHECK is false, so the bootstrap SELECT-only policy cannot authorize a write.
    await expect(
      h.db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.current_user_id', 'user_a', true)`);
        await tx.execute(
          sql`insert into org_members (org_id, user_id, role) values (${orgId}, 'user_a', 'owner')`,
        );
      }),
    ).rejects.toThrow();
  });

  // ── L22: FORCE RLS is applied on every covered table ──────────────────────────
  it('L22: FORCE row-level security is set on every org-scoped table', async () => {
    const forced = [
      'org_members',
      'teams',
      'provider_keys',
      'virtual_keys',
      'admin_api_keys',
      'audit_log',
      'requests',
      'request_bodies',
      'spend_counters',
      'model_aliases',
      'routing_rules',
    ];
    const rows = await h.adminSql<{ relname: string; relforcerowsecurity: boolean }[]>`
      select relname, relforcerowsecurity
      from pg_class
      where relname in ${h.adminSql(forced)} and relkind = 'r'`;
    expect(rows).toHaveLength(forced.length);
    for (const r of rows) {
      expect(r.relforcerowsecurity, `${r.relname} must have FORCE RLS`).toBe(true);
    }
  });
});
