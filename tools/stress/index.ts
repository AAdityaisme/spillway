import { createHash, randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { MockAgent } from 'undici';
import { makeTestApp, type TestHarness } from '../../apps/server/test/helpers/app.js';
import { makeEffectRegistry } from '../../apps/server/src/services/effects/registry.js';
import { runPollerLeaseJob } from '../../apps/server/src/jobs/scheduler.js';
import {
  reconcilePercentile,
  reconcileSampleCount,
  resetReconcileSlo,
} from '../../apps/server/src/data-plane/reconcile.slo.js';

/**
 * Stress harness (pre-B9 load probe): real sockets against the full app over an isolated
 * RLS-enforced Postgres, upstream mocked at controlled latency. Each scenario asserts the
 * money-path invariants afterward (attempts == requests fired; org/day counter == SUM of
 * attempt costs; request_count == ok finals). Exit code 1 on any failure.
 *
 * Run: pnpm stress   (docker required — testcontainers)
 */

const OPENAI_ORIGIN = 'https://api.openai.com';
const MODEL = 'gpt-4.1';
const COST_PER_OK = 7050n; // micro-USD oracle: 800@2.5 + 200cached@0.25 + 500@10 per 1M

const completion = {
  id: 'chatcmpl-stress',
  object: 'chat.completion',
  created: 1_700_000_000,
  model: MODEL,
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: {
    prompt_tokens: 1000,
    completion_tokens: 500,
    total_tokens: 1500,
    prompt_tokens_details: { cached_tokens: 200 },
  },
};
const sseBody =
  `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'hi' } }] })}\n\n` +
  `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 200 } } })}\n\n` +
  'data: [DONE]\n\n';

const sha = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

let h: TestHarness;
let mockAgent: MockAgent;
/** Our testcontainer's docker id, captured at creation (undefined in CI). ryuk is disabled for stress
 *  (package.json), so cleanup() must remove it by this id — never by a port lookup that misfires as
 *  orphaned testcontainers accumulate. */
let containerId: string | undefined;
/** Guards against a double cleanup (e.g. a signal firing while the happy-path teardown is running). */
let cleanedUp = false;
let baseUrl: string;
const orgId = randomUUID();

let failures = 0;
function check(scenario: string, name: string, cond: boolean, detail = ''): void {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failures += 1;
  console.log(`  [${mark}] ${scenario}: ${name}${detail ? ` — ${detail}` : ''}`);
}

function pctl(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] ?? 0;
}

function interceptJson(delayMs: number, times: number): void {
  const i = mockAgent
    .get(OPENAI_ORIGIN)
    .intercept({ path: '/v1/chat/completions', method: 'POST' })
    .reply(200, completion as never, { headers: { 'content-type': 'application/json' } });
  if (delayMs > 0) i.delay(delayMs);
  i.times(times);
}
function interceptSse(times: number): void {
  mockAgent
    .get(OPENAI_ORIGIN)
    .intercept({ path: '/v1/chat/completions', method: 'POST' })
    .reply(200, sseBody, { headers: { 'content-type': 'text/event-stream' } })
    .times(times);
}
function statusTally(statuses: (number | string)[]): string {
  const t = new Map<string, number>();
  for (const s of statuses) t.set(String(s), (t.get(String(s)) ?? 0) + 1);
  return [...t.entries()].map(([k, v]) => `${k}x${v}`).join(' ');
}

async function seedKey(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const plaintext = `mk-stress-${name}-${randomUUID().slice(0, 8)}`;
  const id = randomUUID();
  await h.adminSql`INSERT INTO virtual_keys
      (id, org_id, name, key_hash, key_prefix, status, max_parallel, rpm_limit)
    VALUES (${id}, ${orgId}, ${name}, ${sha(plaintext)}, ${plaintext.slice(0, 12)}, 'active',
            ${(extra.max_parallel as number | undefined) ?? 32},
            ${(extra.rpm_limit as number | undefined) ?? null})`;
  return plaintext;
}

function post(key: string, payload: Record<string, unknown>, signal?: AbortSignal) {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      ...payload,
    }),
    signal,
  });
}

async function runPool<T>(
  n: number,
  concurrency: number,
  fn: (i: number) => Promise<T>,
): Promise<T[]> {
  const out: T[] = new Array(n);
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const i = next++;
        if (i >= n) return;
        out[i] = await fn(i);
      }
    }),
  );
  return out;
}

interface LedgerSnapshot {
  attempts: number;
  okAttempts: number;
  clientClosed: number;
  requestsRows: number;
  sumCostMicro: bigint;
  orgDayCounterMicro: bigint;
  requestCount: number;
}
async function ledger(): Promise<LedgerSnapshot> {
  const [a] = await h.adminSql<
    { attempts: string; ok: string; cc: string; cost: string | null }[]
  >`SELECT count(*) attempts,
           count(*) FILTER (WHERE outcome='ok') ok,
           count(*) FILTER (WHERE outcome='client_closed') cc,
           coalesce(sum(cost_usd),0)::text cost
      FROM request_attempts`;
  const [r] = await h.adminSql<{ n: string }[]>`SELECT count(*) n FROM requests`;
  const [c] = await h.adminSql<{ spent: string | null; rc: string | null }[]>`
    SELECT spent_usd::text spent, request_count::text rc FROM spend_counters
     WHERE scope_type='org' AND scope_id=${orgId}
       AND period_key = to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD')`;
  const micro = (s: string | null | undefined): bigint =>
    s == null ? 0n : BigInt(Math.round(Number(s) * 1e6));
  return {
    attempts: Number(a!.attempts),
    okAttempts: Number(a!.ok),
    clientClosed: Number(a!.cc),
    requestsRows: Number(r!.n),
    sumCostMicro: micro(a!.cost),
    orgDayCounterMicro: micro(c?.spent),
    requestCount: Number(c?.rc ?? 0),
  };
}
let probeKey: string | null = null;
/** Consume any interceptors a prior scenario left behind (e.g. requests aborted pre-match),
 *  so each scenario starts against a clean upstream mock. Probes 502 when the mock is empty. */
async function drainUpstream(): Promise<void> {
  probeKey ??= await seedKey('drain-probe', { max_parallel: 500 });
  for (;;) {
    const statuses = await Promise.all(
      Array.from({ length: 20 }, async () => (await post(probeKey!, {})).status),
    );
    if (statuses.every((st) => st !== 200)) return;
  }
}

async function resetLedger(): Promise<void> {
  await h.adminSql`TRUNCATE requests, request_bodies, request_attempts, spend_counters`;
}

/** Wait until reconciles settle (they run post-response). */
async function settleUntil(
  pred: (l: LedgerSnapshot) => boolean,
  ms = 8000,
): Promise<LedgerSnapshot> {
  const start = Date.now();
  for (;;) {
    const l = await ledger();
    if (pred(l) || Date.now() - start > ms) return l;
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ── scenarios ──────────────────────────────────────────────────────────────────

async function scenarioThroughput(): Promise<void> {
  const N = 400;
  const CONC = 40;
  await drainUpstream();
  interceptJson(30, N);
  const key = await seedKey('load', { max_parallel: 500 });
  await resetLedger();

  const latencies: number[] = [];
  const statuses = await runPool(N, CONC, async () => {
    const t0 = performance.now();
    const res = await post(key, {});
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    if (res.status === 200) latencies.push(performance.now() - t0);
    return res.status === 200 && body.choices?.[0]?.message?.content === 'ok' ? 200 : res.status;
  });

  const l = await settleUntil((s) => s.attempts >= N);
  const okResponses = statuses.filter((s) => s === 200).length;
  check(
    'throughput',
    `all ${N} connected clients got full 200 bodies`,
    okResponses === N,
    okResponses === N ? `${okResponses}/${N}` : statusTally(statuses),
  );
  check(
    'throughput',
    'every request settled exactly one ok attempt',
    l.okAttempts === N,
    `${l.okAttempts}`,
  );
  check('throughput', 'requests rows == N', l.requestsRows === N, `${l.requestsRows}`);
  check(
    'throughput',
    'org/day counter == SUM(attempt costs)',
    l.orgDayCounterMicro === l.sumCostMicro,
    `counter=${l.orgDayCounterMicro} sum=${l.sumCostMicro}`,
  );
  check(
    'throughput',
    'counter == N × oracle cost',
    l.orgDayCounterMicro === BigInt(N) * COST_PER_OK,
    `${l.orgDayCounterMicro} vs ${BigInt(N) * COST_PER_OK}`,
  );
  check('throughput', 'request_count == N', l.requestCount === N, `${l.requestCount}`);
  console.log(
    `  [info] e2e latency p50=${pctl(latencies, 50).toFixed(1)}ms p99=${pctl(latencies, 99).toFixed(1)}ms (upstream mock 30ms, conc ${CONC})`,
  );
}

async function scenarioDisconnectStorm(): Promise<void> {
  const N = 200;
  const CONC = 40;
  await drainUpstream();
  interceptJson(150, N);
  const key = await seedKey('storm', { max_parallel: 500 });
  await resetLedger();

  const outcomes = await runPool(N, CONC, async (i) => {
    const abortIt = i % 2 === 0;
    const ac = new AbortController();
    if (abortIt) setTimeout(() => ac.abort(), 20 + Math.random() * 80);
    try {
      const res = await post(key, {}, ac.signal);
      const body = (await res.json()) as { choices?: unknown[] };
      return res.status === 200 && !!body.choices ? 'ok' : `bad:${res.status}`;
    } catch {
      return 'aborted';
    }
  });

  const survivors = outcomes.filter((o) => o === 'ok').length;
  const aborted = outcomes.filter((o) => o === 'aborted').length;
  const bad = outcomes.filter((o) => o.startsWith('bad')).length;
  const l = await settleUntil((s) => s.attempts >= N);

  check('disconnect-storm', 'no survivor saw a bad/empty response', bad === 0, `${bad} bad`);
  check(
    'disconnect-storm',
    `every request settled exactly once (${survivors} ok + ${aborted} aborted)`,
    l.attempts === N,
    `${l.attempts}/${N}`,
  );
  // an abort landing after the response was sent settles 'ok' server-side while the client counts
  // itself aborted — allow that race, but ok+client_closed must still cover every request exactly once
  check(
    'disconnect-storm',
    'ok attempts >= surviving clients (abort-after-serve race allowed)',
    l.okAttempts >= survivors,
    `${l.okAttempts} vs ${survivors}`,
  );
  check(
    'disconnect-storm',
    'ok + client_closed == N',
    l.okAttempts + l.clientClosed === N,
    `${l.okAttempts}+${l.clientClosed}`,
  );
  check(
    'disconnect-storm',
    'requests rows == N (no orphan attempts)',
    l.requestsRows === N,
    `${l.requestsRows}`,
  );
  check(
    'disconnect-storm',
    'counter == SUM(costs) under mixed outcomes',
    l.orgDayCounterMicro === l.sumCostMicro,
    `counter=${l.orgDayCounterMicro} sum=${l.sumCostMicro}`,
  );
}

async function scenarioStreamStorm(): Promise<void> {
  const N = 100;
  const CONC = 25;
  await drainUpstream();
  interceptSse(N);
  const key = await seedKey('sse', { max_parallel: 500 });
  await resetLedger();

  const results = await runPool(N, CONC, async () => {
    const res = await post(key, { stream: true, stream_options: { include_usage: true } });
    const text = await res.text();
    if (res.status !== 200) return `bad:${res.status}`;
    return text.includes('data: [DONE]') ? 'done' : 'truncated';
  });
  const done = results.filter((r) => r === 'done').length;
  const truncated = results.filter((r) => r === 'truncated').length;
  const bad = results.filter((r) => r.startsWith('bad')).length;
  const l = await settleUntil((s) => s.okAttempts >= N);
  const [est] = await h.adminSql<{ n: string }[]>`
    SELECT count(*) n FROM request_attempts WHERE usage_estimated = true`;

  check('stream-storm', 'no stream failed outright', bad === 0, statusTally(results));
  check(
    'stream-storm',
    'every stream committed a spend row before ack',
    l.okAttempts === N,
    `${l.okAttempts}`,
  );
  // an upstream that truncates mid-stream is a real-world case: the gateway must settle those
  // with an ESTIMATED usage row (flagged), never $0 — measured rows must match completed streams
  check(
    'stream-storm',
    'truncated upstream streams settled estimated (flagged), completed settled measured',
    Number(est!.n) === truncated,
    `${truncated} truncated ↔ ${est!.n} estimated rows (${done} completed)`,
  );
  check(
    'stream-storm',
    'counter == SUM(costs)',
    l.orgDayCounterMicro === l.sumCostMicro,
    `counter=${l.orgDayCounterMicro} sum=${l.sumCostMicro}`,
  );
}

async function scenarioBudgetRace(): Promise<void> {
  const N = 30;
  await drainUpstream();
  interceptJson(40, N + 5);
  const key = await seedKey('budget', { max_parallel: 500 });
  await resetLedger();
  // limit ≈ 3 requests' cost; 30 fired concurrently race the snapshot read
  const vk = await h.adminSql<{ id: string }[]>`SELECT id FROM virtual_keys WHERE name = 'budget'`;
  await h.adminSql`INSERT INTO budgets (org_id, scope_type, scope_id, period, limit_usd, mode, on_exceed)
    VALUES (${orgId}, 'virtual_key', ${vk[0]!.id}, 'day', ${'0.021150'}, 'enforce', 'block')`;

  const statuses = await runPool(N, N, async () => (await post(key, {})).status);
  const ok = statuses.filter((s) => s === 200).length;
  const blocked = statuses.filter((s) => s === 402).length;
  const l = await settleUntil((s) => s.okAttempts >= ok);

  const limitMicro = 21_150n;
  const overshoot = l.orgDayCounterMicro > limitMicro ? l.orgDayCounterMicro - limitMicro : 0n;
  check(
    'budget-race',
    'every burst request either served or 402',
    ok + blocked === N,
    statusTally(statuses),
  );
  // phase 2: with the counter settled over the limit, follow-ups must hard-block
  const after = await runPool(5, 5, async () => (await post(key, {})).status);
  check(
    'budget-race',
    'post-settle requests all 402 (enforcement engaged)',
    after.every((s) => s === 402),
    statusTally(after),
  );
  // Snapshot-read design: in-flight spend is invisible → worst-case overshoot = concurrency × cost.
  check(
    'budget-race',
    'overshoot bounded by concurrency × per-request cost',
    overshoot <= BigInt(N) * COST_PER_OK,
    `overshoot=$${(Number(overshoot) / 1e6).toFixed(6)} (design bound $${(Number(BigInt(N) * COST_PER_OK) / 1e6).toFixed(6)})`,
  );
  console.log(
    `  [info] budget-race: limit $0.021150, final spend $${(Number(l.orgDayCounterMicro) / 1e6).toFixed(6)}, overshoot $${(Number(overshoot) / 1e6).toFixed(6)} @ concurrency ${N}`,
  );

  // ADR-007 composite bound at the DEFAULT key cap: max_parallel (32) gates how many requests
  // can race the snapshot, so worst-case overshoot = 32 × per-request ceiling even under a
  // 60-wide burst. This is the pilot guidance number: budget floor ≈ max_parallel × ceiling.
  await drainUpstream();
  interceptJson(40, 70);
  const dkey = await seedKey('budget-default'); // default max_parallel = 32
  await resetLedger();
  const dvk = await h.adminSql<
    { id: string }[]
  >`SELECT id FROM virtual_keys WHERE name = 'budget-default'`;
  await h.adminSql`INSERT INTO budgets (org_id, scope_type, scope_id, period, limit_usd, mode, on_exceed)
    VALUES (${orgId}, 'virtual_key', ${dvk[0]!.id}, 'day', ${'0.021150'}, 'enforce', 'block')`;
  const burst = await runPool(60, 60, async () => (await post(dkey, {})).status);
  const served = burst.filter((st) => st === 200).length;
  const l2 = await settleUntil((s2) => s2.okAttempts >= served);
  const overshoot2 = l2.orgDayCounterMicro > limitMicro ? l2.orgDayCounterMicro - limitMicro : 0n;
  check(
    'budget-race',
    'default-cap burst: every request served, 402d, or 429d',
    burst.every((st) => st === 200 || st === 402 || st === 429),
    statusTally(burst),
  );
  check(
    'budget-race',
    'overshoot at default cap ≤ 32 × per-request cost (ADR-007 composite bound)',
    overshoot2 <= 32n * COST_PER_OK,
    `overshoot=$${(Number(overshoot2) / 1e6).toFixed(6)} bound=$${(Number(32n * COST_PER_OK) / 1e6).toFixed(6)}`,
  );
  console.log(
    `  [info] budget-race default-cap: 60-burst → ${statusTally(burst)}, overshoot $${(Number(overshoot2) / 1e6).toFixed(6)} (formula: max_parallel × ceiling)`,
  );
}

async function scenarioParallelCap(): Promise<void> {
  const N = 20;
  await drainUpstream();
  interceptJson(300, N);
  const key = await seedKey('parcap', { max_parallel: 4 });
  await resetLedger();

  const statuses = await runPool(N, N, async () => (await post(key, {})).status);
  const ok = statuses.filter((s) => s === 200).length;
  const limited = statuses.filter((s) => s === 429).length;
  check(
    'parallel-cap',
    'all requests either served or 429',
    ok + limited === N,
    `${ok} ok + ${limited} limited`,
  );
  check(
    'parallel-cap',
    'cap enforced (≤ ~4 concurrent slots served the burst)',
    limited >= N - 8,
    `${limited} rejected of ${N} at cap 4`,
  );
  check('parallel-cap', 'some requests served', ok >= 1, `${ok}`);
}

async function scenarioPollerStorm(): Promise<void> {
  const EVENTS = 300;
  // Earlier scenarios legitimately fire threshold alert_events as counters cross caps; the poller
  // would process those too and `runs == EVENTS` counted 5-6 strays. Clean automation slate so the
  // check measures exactly THIS storm.
  await h.adminSql`TRUNCATE automation_runs, alert_events`;
  const vkId = randomUUID();
  await h.adminSql`INSERT INTO virtual_keys (id, org_id, name, key_hash, key_prefix, status)
    VALUES (${vkId}, ${orgId}, 'poller-target', ${sha('poller-' + vkId)}, 'mk-ptarget', 'active')`;
  await h.adminSql`INSERT INTO automation_rules
      (id, org_id, name, trigger_type, condition, action, state, priority, rate_cap_per_hour)
    VALUES (${randomUUID()}, ${orgId}, 'storm-rule', 'alert_fired',
            ${JSON.stringify({ event_kind: 'budget_threshold' })}::jsonb,
            ${JSON.stringify({ type: 'pause_key' })}::jsonb, 'active', 100, 100000)`;
  const payload = JSON.stringify({ event_type: 'budget_threshold', virtual_key_id: vkId });
  await h.adminSql`
    INSERT INTO alert_events (id, org_id, alert_id, fired_at, dedupe_key, payload)
    SELECT gen_random_uuid(), ${orgId}, null, now(), 'k:' || gs::text, ${payload}::jsonb
      FROM generate_series(1, ${EVENTS}) gs`;

  const registry = makeEffectRegistry({
    membershipFor: () => ({ byRoles: () => [], isMember: () => false }),
  });
  const deps = {
    jobsDb: h.jobsDb,
    db: h.db,
    log: { info: () => {}, error: () => {} },
    sink: null,
    registry,
  };
  // three racing schedulers, cycling until the backlog drains
  let cycles = 0;
  for (;;) {
    const results = await Promise.all([
      runPollerLeaseJob(deps),
      runPollerLeaseJob(deps),
      runPollerLeaseJob(deps),
    ]);
    cycles += 1;
    const winners = results.filter((r) => r !== null);
    const [st] = await h.adminSql<{ runs: string; pending: string }[]>`
      SELECT (SELECT count(*) FROM automation_runs WHERE org_id = ${orgId}) runs,
             (SELECT count(*) FROM alert_events ae
               WHERE ae.org_id = ${orgId}
                 AND NOT EXISTS (SELECT 1 FROM automation_runs r WHERE r.trigger_event_id = ae.id)) pending`;
    console.log(
      `  [info] poller cycle ${cycles}: ${winners.length} lease winner(s), runs=${st!.runs}, pending=${st!.pending}`,
    );
    if (Number(st!.pending) === 0) break;
    if (cycles > 20) {
      check(
        'poller-storm',
        'backlog drained',
        false,
        `${st!.pending} still pending after ${cycles} cycles`,
      );
      return;
    }
  }
  const runs = await h.adminSql<{ n: string; dup: string }[]>`
    SELECT count(*) n, count(*) - count(DISTINCT trigger_event_id) dup FROM automation_runs WHERE org_id = ${orgId}`;
  const [key] = await h.adminSql<
    { status: string }[]
  >`SELECT status FROM virtual_keys WHERE id = ${vkId}`;
  check(
    'poller-storm',
    `all ${EVENTS} events processed exactly once`,
    Number(runs[0]!.n) === EVENTS,
    `${runs[0]!.n} runs`,
  );
  check(
    'poller-storm',
    'zero duplicate applies under 3 racing schedulers',
    Number(runs[0]!.dup) === 0,
    `${runs[0]!.dup} dups`,
  );
  check('poller-storm', 'effect applied (key paused)', key!.status === 'paused', key!.status);
  console.log(`  [info] poller-storm: drained in ${cycles} lease cycles`);
}

/**
 * Idempotent teardown. Runs on the happy path, on a thrown error, AND on SIGINT/SIGTERM — every exit
 * path — so a crash or Ctrl-C can never leak the Postgres testcontainer. ryuk is deliberately disabled
 * for stress (scenarioDbOutage pauses the container; ryuk would reap it mid-scenario), so we remove it
 * ourselves by the id captured at creation. Best-effort: each step is guarded so one failure can't
 * strand the container.
 */
async function cleanup(): Promise<void> {
  if (cleanedUp) return;
  cleanedUp = true;
  // Remove the container FIRST — it's the leak-critical step. `docker rm -f` is synchronous and
  // self-contained, so it lands even if the connection teardown below hangs on an in-flight query
  // (a real risk when we're interrupted mid-scenario). The subsequent closes then fail fast against
  // a dead server and are swallowed.
  if (containerId) {
    try {
      execSync(`docker rm -f ${containerId}`, { stdio: 'ignore' });
    } catch (err) {
      console.error(`[cleanup] failed to remove container ${containerId}:`, err);
    }
  }
  try {
    await h?.close();
  } catch (err) {
    console.error('[cleanup] h.close failed:', err);
  }
  try {
    await mockAgent?.close();
  } catch (err) {
    console.error('[cleanup] mockAgent.close failed:', err);
  }
}

async function scenarioDbOutage(): Promise<void> {
  // ryuk is disabled for stress runs (package.json) — a docker-paused container would
  // otherwise be reaped mid-scenario. Cleanup happens in cleanup() on every exit path.
  const pg = containerId;
  if (pg === undefined) {
    // CI runs against an external Postgres (service container) — nothing to docker-pause. A SKIP,
    // not a failure: routing this through check(false) would exit 1 on every CI run.
    console.log(
      '  [SKIP] db-outage: external Postgres, no container to pause (scenario runs in local `pnpm stress`)',
    );
    return;
  }
  await drainUpstream();
  interceptJson(600, 20);
  const key = await seedKey('outage', { max_parallel: 500 });
  await resetLedger();

  // warm the policy bundle so AUTH serves from cache while the DB is down
  await runPool(2, 2, async () => (await post(key, {})).status);
  await settleUntil((l) => l.okAttempts >= 2);

  // fire 6 requests (upstream 600ms), kill Postgres while they're in flight
  const inFlight = runPool(6, 6, async () => {
    const res = await post(key, {});
    const body = (await res.json()) as { choices?: unknown[] };
    return res.status === 200 && !!body.choices ? 200 : res.status;
  });
  await new Promise((r) => setTimeout(r, 200));
  execSync(`docker pause ${pg}`); // freeze Postgres mid-flight (a stop would remap the port — harness artifact)

  // Commit-before-ack (standing directive #1): with the DB frozen, the settle hangs and the
  // response is deliberately HELD — the gateway never acks spend it hasn't durably metered.
  // So the clients hang for the blip and complete after the thaw.
  await new Promise((r) => setTimeout(r, 2500));
  execSync(`docker unpause ${pg}`);
  const statuses = await inFlight;

  check(
    'db-outage',
    'blip-window clients HELD then served full 200s (commit-before-ack, none dropped)',
    statuses.every((st) => st === 200),
    statusTally(statuses),
  );

  // recovery: fresh requests serve AND settle; the frozen-window settles must ALSO land
  // (their queries hung on the paused socket and complete after the thaw — nothing lost)
  interceptJson(0, 5);
  const after = await runPool(3, 3, async () => (await post(key, {})).status);
  const l = await settleUntil((s2) => s2.okAttempts >= 11, 20_000); // 2 warmup + 6 frozen-window + 3 recovery

  check(
    'db-outage',
    'post-recovery requests serve 200',
    after.every((st) => st === 200),
    statusTally(after),
  );
  check(
    'db-outage',
    'NOTHING LOST through the blip — every settle landed (incl. the 6 frozen mid-write)',
    l.okAttempts === 11,
    `${l.okAttempts}/11 settled`,
  );
  check(
    'db-outage',
    'ledger stays consistent after the blip',
    l.orgDayCounterMicro === l.sumCostMicro,
    `counter=${l.orgDayCounterMicro} sum=${l.sumCostMicro}`,
  );
  console.log(
    '  [info] db-outage: 2.5s full DB freeze mid-traffic — clients unharmed, all spend rows landed after thaw, server never crashed. (Hard-loss path — dead DB past the retry budget — is covered by reconcile.retry.integration.test.ts fault injection.)',
  );
}

// ── main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  h = await makeTestApp({
    dispatcher: mockAgent as unknown as NonNullable<
      Parameters<typeof makeTestApp>[0]
    >['dispatcher'],
  });
  // Capture the container id NOW, at creation — cleanup() removes it by this id on every exit path.
  containerId = h.containerId;

  await h.adminSql`INSERT INTO orgs (id, name, slug) VALUES (${orgId}, 'Stress', ${'stress-' + orgId.slice(0, 8)})`;
  const sealed = h.encryptor.encrypt('sk-stress-secret');
  await h.adminSql`INSERT INTO provider_keys
      (id, org_id, provider, label, key_prefix, key_ciphertext, key_iv, key_tag, enc_version, status)
    VALUES (${randomUUID()}, ${orgId}, 'openai', 'stress', 'sk-stres',
            ${sealed.ciphertext}, ${sealed.iv}, ${sealed.tag}, ${sealed.version}, 'active')`;
  await h.adminSql`INSERT INTO model_prices
      (provider, model, input_usd_per_m, output_usd_per_m, cache_read_usd_per_m, source, synced_at)
    VALUES ('openai', ${MODEL}, 2.5, 10, 0.25, 'litellm', now())`;

  await h.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = h.app.server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no bound address');
  baseUrl = `http://127.0.0.1:${addr.port}`;

  console.log('\n── stress run ──');
  const t0 = Date.now();
  // uncontended settle latency first (concurrency 1), before load pollutes the ring buffer
  interceptJson(0, 50);
  const benchKey = await seedKey('slo-bench', { max_parallel: 500 });
  await runPool(50, 1, async () => (await post(benchKey, {})).status);
  await settleUntil((l) => l.okAttempts >= 50);
  console.log(
    `  [info] reconcile settle UNCONTENDED (conc 1): p50=${reconcilePercentile(50)}ms p99=${reconcilePercentile(99)}ms over ${reconcileSampleCount()} settles`,
  );
  resetReconcileSlo();
  await resetLedger();
  await scenarioThroughput();
  await scenarioDisconnectStorm();
  await scenarioStreamStorm();
  await scenarioBudgetRace();
  await scenarioParallelCap();
  await scenarioPollerStorm();
  await scenarioDbOutage();

  console.log(
    `\n  [info] reconcile SLO instrument (17 §4.6 target p50≤5ms/p99≤15ms on prod infra; B9 owns the formal gate): p50=${reconcilePercentile(50)}ms p99=${reconcilePercentile(99)}ms over ${reconcileSampleCount()} settles on a testcontainer under full-load contention`,
  );

  console.log(
    `\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`} in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`,
  );
}

// Signal traps: Ctrl-C (SIGINT) or a kill (SIGTERM) must tear the container down, not leak it — ryuk
// is disabled, so nothing else will. Cleanup is idempotent, so a signal racing the happy-path teardown
// is harmless. 130/143 = conventional 128+signal exit codes.
for (const [sig, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const) {
  process.once(sig, () => {
    console.error(`\n[stress] received ${sig} — cleaning up…`);
    void cleanup().finally(() => process.exit(code));
  });
}

// try/finally at the top level: cleanup() runs whether the suite passes, fails, or throws.
main()
  .then(async () => {
    await cleanup();
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (err) => {
    console.error(err);
    await cleanup();
    process.exit(1);
  });
