import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';
import { runSmoke } from './certifier-smoke.js';

/**
 * part-3/06 layer-2 — proves the LIVE smoke PROBE path end to end against a mocked provider (undici
 * MockAgent global dispatcher; global fetch honors it). The only difference from a real nightly run is
 * the fetch TARGET — the transform → fetch → parseBody → cost → PASS-classify → certifier_results INSERT
 * chain is identical. This is the maximum local verification of the live layer; the real-credential run
 * is the nightly CI job.
 */
describe('certifier-smoke probe path (mocked provider)', () => {
  let h: TestHarness;
  let prev: Dispatcher;
  let mock: MockAgent;
  const saved: Record<string, string | undefined> = {};

  const completion = {
    id: 'x',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
  };

  beforeAll(async () => {
    h = await makeTestApp();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.adminSql`TRUNCATE certifier_results, model_prices CASCADE`;
    await h.adminSql`INSERT INTO model_prices (provider, model, input_usd_per_m, output_usd_per_m, cache_read_usd_per_m, source, synced_at)
      VALUES ('openai', 'gpt-4o-mini', 0.15, 0.6, 0.05, 'litellm', now())`;
    prev = getGlobalDispatcher();
    mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    // Only OpenAI has a key this run → the other providers are skipped.
    for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY'])
      saved[k] = process.env[k];
    process.env.OPENAI_API_KEY = 'sk-test';
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  it('probes OpenAI, extracts usage, reconciles cost, and writes PASS results', async () => {
    // Two probed capabilities (CHAT_NONSTREAM + USAGE_EXTRACTION) → two live calls.
    mock
      .get('https://api.openai.com')
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, completion, { headers: { 'content-type': 'application/json' } })
      .times(2);

    const { written } = await runSmoke(h.jobsDb);
    expect(written).toBe(2); // openai only (anthropic/gemini skipped — no keys)

    const rows = await h.adminSql<
      { provider: string; capability: string; status: string; cost_usd: string | null }[]
    >`
      SELECT provider, capability, status, cost_usd FROM certifier_results ORDER BY capability`;
    expect(rows.map((r) => r.provider)).toEqual(['openai', 'openai']);
    expect(rows.every((r) => r.status === 'PASS')).toBe(true);
    expect(rows.map((r) => r.capability).sort()).toEqual(['CHAT_NONSTREAM', 'USAGE_EXTRACTION']);

    setGlobalDispatcher(prev);
    await mock.close();
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  });

  it('records FAIL with the upstream error body when the provider returns a non-transient error', async () => {
    mock
      .get('https://api.openai.com')
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(400, { error: { message: 'Your credit balance is too low' } })
      .times(2);

    await runSmoke(h.jobsDb);
    const rows = await h.adminSql<{ status: string; error_detail: string | null }[]>`
      SELECT status, error_detail FROM certifier_results`;
    expect(rows.every((r) => r.status === 'FAIL')).toBe(true);
    // the WHY must land in the row — a bare "upstream 400" forces a manual curl to re-diagnose
    for (const r of rows) {
      expect(r.error_detail).toContain('upstream 400');
      expect(r.error_detail).toContain('credit balance is too low');
    }

    setGlobalDispatcher(prev);
    await mock.close();
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  });
});
