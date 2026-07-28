import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';

/**
 * Traffic-log read API (04-api-contracts §3.11; 09-frontend §3.5–3.6). The live-feed + request-log
 * data source. Covers: keyset pagination (newest-first), filters, member key-scoping (ADR-012), the
 * detail projection (unit_prices + routing_rule_name), and RLS cross-org isolation.
 */
describe('requests traffic-log API (M4 §3.11)', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await makeTestApp();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.close();
  });

  async function seedOrg() {
    const tok = await h.token('owner_u');
    const org = (
      await h.app.inject({
        method: 'POST',
        url: '/api/orgs',
        headers: { authorization: `Bearer ${tok}` },
        payload: { name: 'A', slug: 'org-a' },
      })
    ).json<{ org: { id: string } }>().org.id;
    return { org, tok, hdr: { authorization: `Bearer ${tok}`, 'x-spillway-org': org } };
  }

  interface ReqOverrides {
    id?: string;
    createdAt?: Date;
    virtualKeyId?: string | null;
    teamId?: string | null;
    provider?: string | null;
    model?: string | null;
    requestedModel?: string | null;
    endpoint?: string;
    status?: string;
    blockReason?: string | null;
    blockScopeType?: string | null;
    blockPeriod?: string | null;
    costUsd?: string | null;
    routingRuleId?: string | null;
  }

  async function insertReq(org: string, o: ReqOverrides = {}): Promise<string> {
    const id = o.id ?? randomUUID();
    await h.adminSql`
      INSERT INTO requests
        (id, org_id, virtual_key_id, team_id, provider, model, requested_model, endpoint, status,
         block_reason, block_scope_type, block_period, cost_usd, routing_rule_id, created_at)
      VALUES
        (${id}, ${org}, ${o.virtualKeyId ?? null}, ${o.teamId ?? null}, ${o.provider ?? 'openai'},
         ${o.model ?? 'gpt-4o'}, ${o.requestedModel ?? null}, ${o.endpoint ?? 'chat_completions'},
         ${o.status ?? 'ok'}, ${o.blockReason ?? null}, ${o.blockScopeType ?? null},
         ${o.blockPeriod ?? null}, ${o.costUsd ?? null}, ${o.routingRuleId ?? null},
         ${o.createdAt ?? new Date()})`;
    return id;
  }

  it('returns an empty page with a well-formed envelope for a fresh org', async () => {
    const { hdr } = await seedOrg();
    const res = await h.app.inject({ method: 'GET', url: '/api/requests', headers: hdr });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [], pagination: { has_more: false, next_cursor: null } });
  });

  it('lists newest-first with a camelCase projection', async () => {
    const { org, hdr } = await seedOrg();
    await insertReq(org, { model: 'old', createdAt: new Date('2026-01-01T00:00:00Z') });
    await insertReq(org, { model: 'mid', createdAt: new Date('2026-02-01T00:00:00Z') });
    await insertReq(org, {
      model: 'new',
      costUsd: '1.250000',
      createdAt: new Date('2026-03-01T00:00:00Z'),
    });
    const res = await h.app.inject({ method: 'GET', url: '/api/requests', headers: hdr });
    const body = res.json<{ data: Array<Record<string, unknown>> }>();
    expect(body.data.map((r) => r.model)).toEqual(['new', 'mid', 'old']);
    const top = body.data[0]!;
    // camelCase keys, not the bible's snake_case prose.
    expect(top).toHaveProperty('virtualKeyId');
    expect(top).toHaveProperty('createdAt');
    expect(top.costUsd).toBe('1.250000');
    // unit_prices is detail-only — never on the list projection.
    expect(top).not.toHaveProperty('unitPrices');
  });

  it('paginates by keyset without overlap', async () => {
    const { org, hdr } = await seedOrg();
    for (let i = 0; i < 3; i++)
      await insertReq(org, { model: `m${i}`, createdAt: new Date(`2026-0${i + 1}-01T00:00:00Z`) });

    const p1 = (
      await h.app.inject({ method: 'GET', url: '/api/requests?limit=2', headers: hdr })
    ).json<{
      data: Array<{ id: string }>;
      pagination: { has_more: boolean; next_cursor: string };
    }>();
    expect(p1.data).toHaveLength(2);
    expect(p1.pagination.has_more).toBe(true);
    expect(p1.pagination.next_cursor).toBeTruthy();

    const p2 = (
      await h.app.inject({
        method: 'GET',
        url: `/api/requests?limit=2&cursor=${encodeURIComponent(p1.pagination.next_cursor)}`,
        headers: hdr,
      })
    ).json<{ data: Array<{ id: string }>; pagination: { has_more: boolean } }>();
    expect(p2.data).toHaveLength(1);
    expect(p2.pagination.has_more).toBe(false);
    const ids = new Set(p1.data.map((r) => r.id));
    expect(ids.has(p2.data[0]!.id)).toBe(false);
  });

  it('paginates across rows sharing a millisecond without skipping (microsecond cursor)', async () => {
    const { org, hdr } = await seedOrg();
    // Four rows in the SAME millisecond, distinct microseconds — the case a JS-Date (ms) cursor drops.
    const base = '2026-05-01T12:00:00.123';
    const micros = ['456', '457', '458', '459'];
    for (const u of micros) {
      await h.adminSql`
        INSERT INTO requests (id, org_id, endpoint, status, model, created_at)
        VALUES (${randomUUID()}, ${org}, 'chat_completions', 'ok', ${'m-' + u}, ${base + u + 'Z'}::timestamptz)`;
    }

    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const url: string = `/api/requests?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const body = (await h.app.inject({ method: 'GET', url, headers: hdr })).json<{
        data: Array<{ id: string }>;
        pagination: { has_more: boolean; next_cursor: string | null };
      }>();
      for (const r of body.data) {
        expect(seen.has(r.id)).toBe(false); // no row served twice
        seen.add(r.id);
      }
      if (!body.pagination.has_more) break;
      cursor = body.pagination.next_cursor;
    }
    expect(seen.size).toBe(micros.length); // and none skipped
  });

  it('rejects a malformed cursor with 400', async () => {
    const { hdr } = await seedOrg();
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/requests?cursor=not-base64-json',
      headers: hdr,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('validation_error');
  });

  it('filters by status, provider, endpoint, and model (served or requested)', async () => {
    const { org, hdr } = await seedOrg();
    await insertReq(org, { status: 'ok', provider: 'openai', model: 'gpt-4o' });
    await insertReq(org, {
      status: 'blocked',
      blockReason: 'budget_exceeded',
      blockScopeType: 'org',
      blockPeriod: 'month',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      requestedModel: 'fast-alias',
      endpoint: 'messages',
    });

    const blocked = (
      await h.app.inject({ method: 'GET', url: '/api/requests?status=blocked', headers: hdr })
    ).json<{ data: Array<{ blockReason: string; status: string }> }>();
    expect(blocked.data).toHaveLength(1);
    expect(blocked.data[0]!.blockReason).toBe('budget_exceeded');

    const byProvider = (
      await h.app.inject({ method: 'GET', url: '/api/requests?provider=anthropic', headers: hdr })
    ).json<{ data: unknown[] }>();
    expect(byProvider.data).toHaveLength(1);

    const byEndpoint = (
      await h.app.inject({ method: 'GET', url: '/api/requests?endpoint=messages', headers: hdr })
    ).json<{ data: unknown[] }>();
    expect(byEndpoint.data).toHaveLength(1);

    // `model` matches the alias the client asked for as well as the served model.
    const byAlias = (
      await h.app.inject({ method: 'GET', url: '/api/requests?model=fast-alias', headers: hdr })
    ).json<{ data: unknown[] }>();
    expect(byAlias.data).toHaveLength(1);
  });

  it('scopes a member to their own keys; owner sees all (ADR-012)', async () => {
    const { org, hdr } = await seedOrg();
    // Seed a member with a key they created via the real path.
    await h.adminSql`INSERT INTO users (id, email) VALUES ('mem_u', 'mem@t.dev') ON CONFLICT (id) DO NOTHING`;
    await h.adminSql`INSERT INTO org_members (org_id, user_id, role) VALUES (${org}, 'mem_u', 'member')`;
    const memTok = await h.token('mem_u');
    const memHdr = { authorization: `Bearer ${memTok}`, 'x-spillway-org': org };
    const memKey = (
      await h.app.inject({
        method: 'POST',
        url: '/api/virtual-keys',
        headers: memHdr,
        payload: { name: 'member-key' },
      })
    ).json<{ virtualKey: { id: string } }>().virtualKey.id;
    const ownerKey = (
      await h.app.inject({
        method: 'POST',
        url: '/api/virtual-keys',
        headers: hdr,
        payload: { name: 'owner-key' },
      })
    ).json<{ virtualKey: { id: string } }>().virtualKey.id;

    await insertReq(org, { virtualKeyId: memKey, model: 'members-call' });
    await insertReq(org, { virtualKeyId: ownerKey, model: 'owners-call' });

    const asMember = (
      await h.app.inject({ method: 'GET', url: '/api/requests', headers: memHdr })
    ).json<{ data: Array<{ model: string }> }>();
    expect(asMember.data.map((r) => r.model)).toEqual(['members-call']);

    const asOwner = (
      await h.app.inject({ method: 'GET', url: '/api/requests', headers: hdr })
    ).json<{ data: unknown[] }>();
    expect(asOwner.data).toHaveLength(2);
  });

  it('returns detail with unitPrices + routingRuleName; 404 unknown, 400 non-uuid', async () => {
    const { org, hdr } = await seedOrg();
    const ruleId = randomUUID();
    await h.adminSql`
      INSERT INTO routing_rules (id, org_id, priority, description, match, action)
      VALUES (${ruleId}, ${org}, 1, 'cheap-route', ${h.adminSql.json({})}, ${h.adminSql.json({})})`;
    const reqId = randomUUID();
    await h.adminSql`
      INSERT INTO requests (id, org_id, endpoint, status, routing_rule_id, unit_prices, created_at)
      VALUES (${reqId}, ${org}, 'chat_completions', 'ok', ${ruleId},
              ${h.adminSql.json({ input_per_1m: '2.500000' })}, ${new Date()})`;

    const detail = await h.app.inject({
      method: 'GET',
      url: `/api/requests/${reqId}`,
      headers: hdr,
    });
    expect(detail.statusCode).toBe(200);
    const r = detail.json<{ request: { unitPrices: unknown; routingRuleName: string } }>().request;
    expect(r.routingRuleName).toBe('cheap-route');
    expect(r.unitPrices).toEqual({ input_per_1m: '2.500000' });

    const notFound = await h.app.inject({
      method: 'GET',
      url: `/api/requests/${randomUUID()}`,
      headers: hdr,
    });
    expect(notFound.statusCode).toBe(404);

    const badId = await h.app.inject({
      method: 'GET',
      url: '/api/requests/not-a-uuid',
      headers: hdr,
    });
    expect(badId.statusCode).toBe(400);
  });

  it('never leaks another org’s requests (RLS)', async () => {
    const { hdr } = await seedOrg();
    const otherOrg = randomUUID();
    await h.adminSql`INSERT INTO orgs (id, name, slug) VALUES (${otherOrg}, 'B', ${'b-' + otherOrg.slice(0, 8)})`;
    await insertReq(otherOrg, { model: 'other-org-call' });
    const res = (await h.app.inject({ method: 'GET', url: '/api/requests', headers: hdr })).json<{
      data: unknown[];
    }>();
    expect(res.data).toHaveLength(0);
  });
});
