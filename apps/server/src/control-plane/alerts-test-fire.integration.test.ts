import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';

/**
 * §5.6 test-fire endpoint. Drives POST /api/alerts/:id/test through the REAL HTTP channel sink over a
 * MockAgent global dispatcher (global fetch honors it), so the whole path — auth/entitlement gate, alert
 * lookup, channel parse, synthetic delivery, per-channel result — is exercised end to end. disableNetConnect
 * makes any unexpected outbound call fail loudly.
 */
describe('POST /api/alerts/:id/test — test-fire (§5.6)', () => {
  let h: TestHarness;
  let prevDispatcher: Dispatcher;
  let mock: MockAgent;

  beforeEach(async () => {
    h = await makeTestApp();
    prevDispatcher = getGlobalDispatcher();
    mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
  });
  afterEach(async () => {
    setGlobalDispatcher(prevDispatcher);
    await mock.close();
    await h.close();
  });

  async function seed(plan = 'pro'): Promise<{ org: string; hdr: Record<string, string> }> {
    const tok = await h.token('user_tf');
    const org = (
      await h.app.inject({
        method: 'POST',
        url: '/api/orgs',
        headers: { authorization: `Bearer ${tok}` },
        payload: { name: 'A', slug: 'org-tf' },
      })
    ).json<{ org: { id: string } }>().org.id;
    await h.adminSql`UPDATE orgs SET plan = ${plan} WHERE id = ${org}`;
    return { org, hdr: { authorization: `Bearer ${tok}`, 'x-spillway-org': org } };
  }

  async function insertAlert(
    org: string,
    kind: string,
    channels: Record<string, string>[],
  ): Promise<string> {
    const id = randomUUID();
    await h.adminSql`
      INSERT INTO alerts (id, org_id, name, kind, scope_type, scope_id, config, channels, enabled)
      VALUES (${id}, ${org}, 'a', ${kind}, NULL, NULL, ${h.adminSql.json({})}, ${h.adminSql.json(channels)}, true)`;
    return id;
  }

  it('delivers a synthetic event to a slack channel and reports ok', async () => {
    const { org, hdr } = await seed();
    const id = await insertAlert(org, 'anomaly', [
      { type: 'slack', webhook_url: 'https://hooks.slack.test/x' },
    ]);
    let sentBody = '';
    mock
      .get('https://hooks.slack.test')
      .intercept({ path: '/x', method: 'POST' })
      .reply((opts) => {
        sentBody = String(opts.body);
        return { statusCode: 200, data: {} };
      });

    const res = await h.app.inject({ method: 'POST', url: `/api/alerts/${id}/test`, headers: hdr });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      kind: string;
      delivered: number;
      results: { channel: string; target: string; ok: boolean }[];
    }>();
    expect(body.kind).toBe('anomaly');
    expect(body.delivered).toBe(1);
    expect(body.results).toEqual([
      { channel: 'slack', target: 'https://hooks.slack.test/x', ok: true },
    ]);
    expect(sentBody).toContain('anomaly'); // the synthetic event actually hit the wire
  });

  it('reports ok:false for a channel whose endpoint 5xxes (never a request error)', async () => {
    const { org, hdr } = await seed();
    const id = await insertAlert(org, 'anomaly', [
      { type: 'webhook', url: 'https://hook.test/w', secret: 's' },
    ]);
    mock.get('https://hook.test').intercept({ path: '/w', method: 'POST' }).reply(500, {});

    const res = await h.app.inject({ method: 'POST', url: `/api/alerts/${id}/test`, headers: hdr });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ delivered: number; results: { ok: boolean; error?: string }[] }>();
    expect(body.delivered).toBe(0);
    expect(body.results[0]!.ok).toBe(false);
  });

  it('404 for an unknown alert id', async () => {
    const { hdr } = await seed();
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/alerts/${randomUUID()}/test`,
      headers: hdr,
    });
    expect(res.statusCode).toBe(404);
  });

  it('free plan → 402 tier_required', async () => {
    const { org, hdr } = await seed('free');
    const id = await insertAlert(org, 'anomaly', []);
    const res = await h.app.inject({ method: 'POST', url: `/api/alerts/${id}/test`, headers: hdr });
    expect(res.statusCode).toBe(402);
  });
});
