import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';
import { withOrg } from './tenancy.js';
import { RLS_COVERED_TABLES } from './schema.js';

/**
 * RLS coverage — RUNTIME proof (expanded-audit HIGH #1 + #2).
 *
 * The static rls-lint (rls-lint.test.ts) only proves a table NAME is present in RLS_COVERED_TABLES;
 * a name in a TypeScript Set is NOT evidence a policy was authored. A table added to the set with a
 * broken/absent CREATE POLICY would pass the lint and leak cross-org. This test closes both holes
 * against a live migrated DB, for EVERY table in the set (previously only 3 of 23 had any behavioral
 * proof):
 *   Part A — the policy actually EXISTS: ROW LEVEL SECURITY is enabled and there is a PERMISSIVE
 *            FOR ALL policy for spillway_app whose USING clause references app.current_org_id.
 *   Part B — it actually ISOLATES: a row inserted under org A is invisible to org A's app role when
 *            it acts as org B, and the empty-GUC (outside withOrg) case denies by default.
 *
 * NOTE on FORCE ROW LEVEL SECURITY: the design intentionally does NOT use it. spillway_app is GRANTed
 * DML but does not OWN the tables (0001_grant_roles.sql), and RLS binds all non-owner roles under a
 * plain ENABLE. Part B is the ground-truth that isolation is EFFECTIVE for the app role regardless.
 */

const CANONICAL_GUC = 'app.current_org_id';
const PROBE_USER_ID = 'user_rls_probe'; // users.id is TEXT (ADR-023); org_members.user_id FKs to it

/** Columns whose value must satisfy a CHECK constraint or a non-org FK — the generic synth can't
 *  guess a valid enum-ish text / positive number / distinct pair / real user id. Keep in sync with
 *  the CHECK constraints in the migrations. */
const OVERRIDES: Record<string, Record<string, string>> = {
  org_members: { user_id: `'${PROBE_USER_ID}'` },
  decision_logs: { effect: `'deny'`, enforcement: `'enforce'` },
  governance_policies: { effect: `'deny'` },
  budgets: { scope_type: `'org'`, period: `'day'`, limit_usd: `'1'` }, // limit_usd > 0 CK
  approver_delegations: {
    from_user: `'user_a'`,
    to_user: `'user_b'`, // from_user <> to_user CK
    starts_at: `now()`,
    ends_at: `now() + interval '1 day'`, // ends_at > starts_at CK
  },
};

/** Base-type value literal for a required column with no default. No enums exist in the schema (all
 *  "enum" columns are plain text), so a small type switch covers every case. */
function synthLiteral(dataType: string, udtName: string): string {
  switch (dataType) {
    case 'uuid':
      return 'gen_random_uuid()';
    case 'json':
    case 'jsonb':
      return `'{}'::jsonb`;
    case 'date':
    case 'timestamp with time zone':
    case 'timestamp without time zone':
      return 'now()';
    case 'boolean':
      return 'false';
    case 'integer':
    case 'smallint':
    case 'bigint':
    case 'numeric':
    case 'double precision':
    case 'real':
      return '0';
    case 'ARRAY':
      return `'{}'::${udtName.replace(/^_/, '')}[]`; // udt _uuid → uuid[]
    default:
      return `'x'`; // text / varchar / char / citext / …
  }
}

describe('RLS coverage (runtime) — every covered table proves policy existence + cross-org isolation', () => {
  let h: TestHarness;
  const orgA = randomUUID();
  const orgB = randomUUID();
  const parentReqA = randomUUID(); // a requests row so request_bodies/attempts probes satisfy request_id
  const tables = [...RLS_COVERED_TABLES].sort();

  beforeAll(async () => {
    h = await makeTestApp();
    await h.adminSql`INSERT INTO orgs (id, name, slug) VALUES
      (${orgA}, 'A', ${'a-' + orgA.slice(0, 8)}),
      (${orgB}, 'B', ${'b-' + orgB.slice(0, 8)})`;
    await h.adminSql`INSERT INTO requests (id, org_id, endpoint, status)
      VALUES (${parentReqA}, ${orgA}, 'chat_completions', 'ok')`;
    await h.adminSql`INSERT INTO users (id, email) VALUES (${PROBE_USER_ID}, 'rls@test.dev')`;
  });
  afterAll(async () => {
    await h.close();
  });

  /** Insert one minimal valid row into `t` under `org` via the superuser (bypasses RLS — we are
   *  testing the SELECT USING policy, not the INSERT path). Columns are introspected at runtime so a
   *  future schema change is covered automatically. Table name is from our own constant set. */
  async function insertProbe(t: string, org: string): Promise<void> {
    const cols = await h.adminSql<{ column_name: string; data_type: string; udt_name: string }[]>`
      SELECT column_name, data_type, udt_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ${t}
         AND is_nullable = 'NO' AND column_default IS NULL AND is_identity = 'NO'
       ORDER BY ordinal_position`;
    const names: string[] = [];
    const vals: string[] = [];
    for (const c of cols) {
      names.push(`"${c.column_name}"`);
      const override = OVERRIDES[t]?.[c.column_name];
      if (override) vals.push(override);
      else if (c.column_name === 'org_id') vals.push(`'${org}'::uuid`);
      else if (c.column_name === 'request_id') vals.push(`'${parentReqA}'::uuid`);
      else vals.push(synthLiteral(c.data_type, c.udt_name));
    }
    await h.adminSql.unsafe(`INSERT INTO "${t}" (${names.join(', ')}) VALUES (${vals.join(', ')})`);
  }

  const countIn = async (org: string, t: string): Promise<number> => {
    const rows = (await withOrg(h.db, org, (tx) =>
      tx.execute(sql.raw(`SELECT count(*)::int AS n FROM "${t}"`)),
    )) as unknown as { n: number }[];
    return Number(rows[0]?.n ?? -1);
  };

  // Part A — the policy exists at runtime, per table.
  for (const t of tables) {
    it(`${t}: RLS enabled + a PERMISSIVE FOR ALL spillway_app policy references ${CANONICAL_GUC}`, async () => {
      const [rel] = await h.adminSql<{ relrowsecurity: boolean }[]>`
        SELECT relrowsecurity FROM pg_class WHERE oid = ${'public.' + t}::regclass`;
      expect(rel?.relrowsecurity, `${t} must have ROW LEVEL SECURITY enabled`).toBe(true);

      const policies = await h.adminSql<
        {
          policyname: string;
          cmd: string;
          permissive: string;
          roles: string[];
          qual: string | null;
        }[]
      >`
        SELECT policyname, cmd, permissive, roles, qual
          FROM pg_policies WHERE schemaname = 'public' AND tablename = ${t}`;
      const isolation = policies.find(
        (p) =>
          p.permissive === 'PERMISSIVE' &&
          p.cmd === 'ALL' &&
          p.roles.includes('spillway_app') &&
          (p.qual ?? '').includes(CANONICAL_GUC),
      );
      expect(
        isolation,
        `${t} has no PERMISSIVE FOR ALL policy for spillway_app whose USING clause references ` +
          `${CANONICAL_GUC}. Being listed in RLS_COVERED_TABLES is not proof a policy was authored — ` +
          `add the CREATE POLICY to the appropriate RLS migration.`,
      ).toBeTruthy();
    });
  }

  // Part B — the policy actually isolates cross-org, per table.
  for (const t of tables) {
    it(`${t}: a row under org A is invisible to org B`, async () => {
      await insertProbe(t, orgA);
      expect(await countIn(orgB, t), `${t} leaked org A rows to org B`).toBe(0);
      expect(await countIn(orgA, t), `${t} hid org A's own rows from org A`).toBeGreaterThanOrEqual(
        1,
      );
    });
  }

  // Deny-by-default: outside withOrg the GUC is empty → nullif(...,'')::uuid = NULL → zero rows,
  // even though org A rows exist (inserted above). One transaction, every covered table.
  it('empty app.current_org_id denies all rows on every covered table (deny-by-default)', async () => {
    await h.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config(${CANONICAL_GUC}, '', true)`);
      for (const t of tables) {
        const rows = (await tx.execute(
          sql.raw(`SELECT count(*)::int AS n FROM "${t}"`),
        )) as unknown as { n: number }[];
        expect(Number(rows[0]?.n), `${t} returned rows with an empty org GUC`).toBe(0);
      }
    });
  });
});
