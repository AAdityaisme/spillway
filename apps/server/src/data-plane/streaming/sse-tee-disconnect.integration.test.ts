import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { MockAgent, Agent } from 'undici';
import { createTestDb } from '../../../test/helpers/db.js';
import { runSseTee } from './sse-tee.js';
import { releaseBudgetReservation } from '../budget/reservation.js';
import { getAdapter } from '../providers/registry.js';
import { BurstTracker } from '../../services/alerts/burst.js';
import type { PipelineContext } from '../pipeline/context.js';
import type { Adapter, TransformResult } from '../providers/types.js';
import type { Candidate } from '../routing/compile.js';

/**
 * Red-team P0: a client disconnect during stream connect/peek used to just `return` — no reconcile,
 * no ledger row, and the pre-dispatch budget hold silently refunded via the route's own finally, even
 * when the upstream call had already been issued and the provider may already be billing real tokens.
 * These call `runSseTee` directly (below `dispatch.ts`/the route) so the two disconnect moments can be
 * driven deterministically instead of racing a real socket — see `abort-wiring.integration.test.ts` for
 * why a real socket is otherwise needed to observe a genuine client abort at all.
 */

const OPENAI_ORIGIN = 'https://api.openai.com';

let h: Awaited<ReturnType<typeof createTestDb>>;
let mockAgent: MockAgent;
let stallServer: Server;
let stallOrigin: string;
const orgId = randomUUID();
const adapter: Adapter = getAdapter('openai');

/** Only fills the fields the code under test (runSseTee's abort paths, guardedReconcile, runReconcile,
 *  releaseBudgetReservation) actually reads — the `buildCtx` pattern used by budget/reservation.test.ts. */
function buildCtx(): PipelineContext {
  const candidate: Candidate = {
    provider: 'openai',
    model: 'gpt-4o-mini',
    providerKeyId: 'pk-test',
  };
  return {
    requestId: randomUUID(),
    startedAt: Date.now(),
    req: { headers: {}, log: { info() {}, warn() {}, error() {} } },
    reply: {},
    endpoint: 'chat_completions',
    clientShape: 'openai',
    deps: {
      db: h.db,
      dispatcher: mockAgent,
      burstTracker: new BurstTracker(),
    },
    clientAbort: new AbortController(),
    policy: {
      orgId,
      virtualKeyId: randomUUID(),
      teamId: null,
      budgets: [],
      configSnapshotHash: 'test',
    },
    validatedBody: {},
    clientNativeBody: null,
    requestedModel: candidate.model,
    knobs: { sessionId: null, requireCapabilities: null, traceEnabled: false, provider: null },
    estimatedInputTokens: 250, // nonzero: proves the §4.5 input floor actually lands, not a $0 row
    requestFeatures: {},
    fallbackFrom: [],
    attemptNumber: 0,
    isFinalAttempt: false, // the fix must force this true once it reconciles a disconnect
    reconcileStarted: false,
    hijacked: false,
    priceByCandidate: new Map(),
    candidate,
    candidateChain: [candidate],
    upstreamStatus: 0,
    usage: null,
    droppedParams: [],
    errorCode: null,
    serviceTier: null,
    stream: true,
    budgetReservation: {
      microUsd: 500_000n,
      rows: [{ scopeType: 'org', scopeId: orgId, periodKey: 'test-period' }],
    },
    budgetReservationSettled: false,
    timings: {},
  } as unknown as PipelineContext;
}

const transformed: TransformResult = {
  url: `${OPENAI_ORIGIN}/v1/chat/completions`,
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
  body: { model: 'gpt-4o-mini', stream: true, messages: [{ role: 'user', content: 'hi' }] },
};

/** A minimal OpenAI SSE frame — content irrelevant to these tests since every abort fires before it
 *  could ever be parsed (before any status, or before any event delimiter). */
const sseBody = (): string =>
  `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`;

async function ledgerRows(): Promise<{ attempts: number; requests: number }> {
  const attempts = await h.adminSql`SELECT 1 FROM request_attempts WHERE org_id = ${orgId}`;
  const requests = await h.adminSql`SELECT 1 FROM requests WHERE org_id = ${orgId}`;
  return { attempts: attempts.length, requests: requests.length };
}

beforeAll(async () => {
  h = await createTestDb();
  await h.adminSql`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'SseDisconnect', ${'ssed-' + orgId.slice(0, 8)})`;

  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();

  // Real local server, NOT MockAgent, for the peek-phase case: MockAgent materializes a mocked
  // response's headers + body together (its `.delay()` delays the whole reply), so it cannot express
  // "2xx headers already delivered, first SSE event never arrives" — exactly the window
  // peekFirstEvent's abort branch runs in. A real socket that writes headers then never writes body
  // bytes reproduces that window precisely.
  stallServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders(); // deliberately never write body bytes or end() — hold past headers
  });
  await new Promise<void>((resolve) => stallServer.listen(0, '127.0.0.1', resolve));
  const addr = stallServer.address();
  if (addr === null || typeof addr === 'string') throw new Error('no bound address');
  stallOrigin = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await mockAgent.close();
  stallServer.closeAllConnections();
  await new Promise<void>((resolve) => stallServer.close(() => resolve()));
  await h.cleanup();
});

beforeEach(async () => {
  await h.adminSql`TRUNCATE requests, request_bodies, request_attempts, spend_counters`;
});

describe('runSseTee: client disconnect during connect/peek (red-team P0)', () => {
  it('disconnect BEFORE the upstream call is ever issued: no reconcile, no ledger row', async () => {
    const ctx = buildCtx();
    ctx.clientAbort.abort(); // already gone before runSseTee's first (synchronous) abort check

    await runSseTee(ctx, adapter, transformed);

    expect(ctx.reconcileStarted).toBe(false); // sse-tee never touched reconcile for this case
    expect(ctx.budgetReservationSettled).toBe(false); // ...nor the hold — that's the route's job
    expect(await ledgerRows()).toEqual({ attempts: 0, requests: 0 });

    // Mirrors what routes/{chat-completions,messages,embeddings}.ts do in their own `finally` for
    // exactly this case — proving the hold DOES still get released, just not by sse-tee.
    await releaseBudgetReservation(ctx);
    expect(ctx.budgetReservationSettled).toBe(true);
  });

  it('disconnect WHILE the connect call is in flight (no status ever received): floor-billed client_closed, never a silent refund', async () => {
    const ctx = buildCtx();
    mockAgent
      .get(OPENAI_ORIGIN)
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, sseBody(), { headers: { 'content-type': 'text/event-stream' } })
      .delay(1500); // upstream slower than the client's patience

    setTimeout(() => ctx.clientAbort.abort(), 150);
    await runSseTee(ctx, adapter, transformed);

    expect(ctx.reconcileStarted).toBe(true);
    expect(ctx.isFinalAttempt).toBe(true); // no further candidate will be tried once the client is gone
    expect(ctx.budgetReservationSettled).toBe(true); // released BY reconcile's settle, not a bare refund

    const rows = await h.adminSql<
      {
        outcome: string;
        error_code: string;
        input_tokens: number;
        output_tokens: number;
        usage_estimated: boolean;
      }[]
    >`SELECT outcome, error_code, input_tokens, output_tokens, usage_estimated FROM request_attempts WHERE org_id = ${orgId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('client_closed');
    expect(rows[0]!.error_code).toBe('client_closed_request');
    // §4.5 input-token floor: the org pays for prompt tokens the provider may already have ingested,
    // never a silent $0 that would make a well-timed disconnect free inference.
    expect(Number(rows[0]!.input_tokens)).toBeGreaterThan(0);
    expect(Number(rows[0]!.output_tokens)).toBe(0);
    expect(rows[0]!.usage_estimated).toBe(true);

    const requestsRows = await h.adminSql`SELECT status FROM requests WHERE org_id = ${orgId}`;
    expect(requestsRows).toHaveLength(1); // isFinalAttempt forced true → the aggregate row IS written
  });

  it('disconnect DURING the pre-hijack peek (2xx already confirmed): reconciles the same as mid-connect', async () => {
    const ctx = buildCtx();
    ctx.deps.dispatcher = new Agent(); // plain loopback dispatcher — no SSRF guard needed against 127.0.0.1 in-test
    const stalled: TransformResult = { ...transformed, url: `${stallOrigin}/v1/chat/completions` };

    setTimeout(() => ctx.clientAbort.abort(), 150);
    await runSseTee(ctx, adapter, stalled);

    expect(ctx.reconcileStarted).toBe(true);
    expect(ctx.isFinalAttempt).toBe(true);
    expect(ctx.budgetReservationSettled).toBe(true);

    const rows = await h.adminSql<
      { outcome: string; error_code: string; input_tokens: number; usage_estimated: boolean }[]
    >`SELECT outcome, error_code, input_tokens, usage_estimated FROM request_attempts WHERE org_id = ${orgId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('client_closed');
    expect(rows[0]!.error_code).toBe('client_closed_request');
    expect(Number(rows[0]!.input_tokens)).toBeGreaterThan(0);
    expect(rows[0]!.usage_estimated).toBe(true);
  });
});
