import { fetch as undiciFetch } from 'undici';
import { ssrfGuardedDispatcher } from './egress-guard.js';
import { SpillwayError } from '@spillway/shared';
import { providerKeyAad, type Encryptor } from '../services/encryptor.js';
import { getAdapter } from './providers/registry.js';
import type { Adapter, Candidate, MappedError, TransformResult } from './providers/types.js';
import type { ProviderKeyRow } from './pipeline/auth.js';
import { candidateKeyOf, selectTypedFallback, reorderByHealth } from './routing/resolve.js';
import { healthKindFor, parseRetryAfter } from './health/store.js';
import { classifyFailure } from './ledger/bill-on-failure.js';
import { runReconcile } from './reconcile.js';
import { runSseTee, guardedReconcile } from './streaming/sse-tee.js';
import { estimateInputTokens, estimateTokensFromChars } from './streaming/estimator.js';
import { droppedParamsHeader } from './headers.js';
import {
  anthropicPassthroughTransform,
  anthropicResponseToOpenAI,
  openaiResponseToAnthropic,
  providerWireShape,
} from './providers/translate.js';
import type { PipelineContext } from './pipeline/context.js';

/**
 * DISPATCH (05-gateway-core §7, 15 §7) — the candidate-chain executor.
 *
 * Non-streaming: loop over ctx.candidateChain (health-reordered). Each attempt writes its own
 * request_attempts row (per-attempt ledger, 17 §4). A retryable failure (429 / 5xx / timeout /
 * connect) records health + advances — into the typed-fallback variant on a context_window /
 * content_policy error (15 §7.1), else the next candidate. A client error (4xx) is a terminal
 * sentinel that surfaces immediately (never cascades). On success: reconcile (commit-before-ack)
 * then send. Exhausted → 502 all_providers_failed. The FINAL attempt (success or last failure)
 * reconciles with isFinalAttempt=true → the aggregated requests row; non-final attempts don't.
 *
 * Streaming: the same chain executor, but fallback is only possible BEFORE the first byte reaches the
 * client (ADR-008 / 15 §7.2). Two pre-commit failure modes advance the chain: a retryable PRE-2xx
 * upstream failure, AND a 200 whose FIRST SSE event is an error frame (the tee peeks it pre-hijack —
 * runSseTee's first-chunk peek — and throws upstream_error before committing). Once the tee commits a
 * byte the candidate is final and no advance is possible.
 */

const TIMEOUT_BODY_NON_STREAM_MS = 120_000; // 05 §7 non-streaming ceiling

function decryptProviderKey(row: ProviderKeyRow, encryptor: Encryptor, orgId: string): string {
  return encryptor.decrypt(
    { ciphertext: row.keyCiphertext, iv: row.keyIv, tag: row.keyTag, version: row.encVersion },
    providerKeyAad(orgId, row.id), // AAD binds the ciphertext to (org, key) — §1.2
  );
}

/** Decrypt the candidate's provider key + build the upstream request. Throws 502 on a missing/corrupt
 *  key — a config fault, not a chain-advance case. */
function prepareCandidate(
  ctx: PipelineContext,
  candidate: Candidate,
): { adapter: Adapter; transformed: ReturnType<Adapter['transform']> } {
  const adapter = getAdapter(candidate.provider);
  const keyRow = ctx.policy.providerKeys.find((k) => k.id === candidate.providerKeyId);
  if (!keyRow)
    throw new SpillwayError('provider_key_decrypt_failed', 'provider key not found', {
      httpStatus: 502,
    });
  let decrypted: string;
  try {
    decrypted = decryptProviderKey(keyRow, ctx.deps.encryptor, ctx.policy.orgId);
  } catch {
    throw new SpillwayError('provider_key_decrypt_failed', 'provider key decryption failed', {
      httpStatus: 502,
    });
  }
  // Zero-fidelity-loss pass-through: an Anthropic client (/v1/messages) served by an Anthropic
  // candidate sends its ORIGINAL native body (model-rewritten) — never the lossy openai-canonical
  // round-trip (06 §2.2b). Every other combination uses the adapter's OpenAI-input transform; the
  // response is then translated to the client shape in runBodyCapture / the tee.
  let transformed: TransformResult;
  if (ctx.endpoint === 'embeddings') {
    // Defense-in-depth: ROUTE's capability hard-gate already excluded providers without an
    // embeddings API; a candidate reaching here without the method is a catalog/adapter drift.
    if (!adapter.transformEmbeddings) {
      throw new SpillwayError(
        'unsupported_feature',
        `${candidate.provider} has no embeddings API`,
        { httpStatus: 400 },
      );
    }
    transformed = adapter.transformEmbeddings(ctx.validatedBody, candidate, decrypted);
  } else {
    transformed =
      ctx.clientShape === 'anthropic' &&
      candidate.provider === 'anthropic' &&
      ctx.clientNativeBody !== null
        ? anthropicPassthroughTransform(ctx.clientNativeBody, candidate, decrypted, ctx.stream)
        : adapter.transform(ctx.validatedBody, candidate, decrypted, { injectUsage: ctx.stream });
  }
  ctx.droppedParams = transformed.dropped ?? [];
  return { adapter, transformed };
}

/**
 * Translate a non-streaming upstream body into the CLIENT's wire shape (06 §2.3). Passthrough when
 * the client and provider speak the same shape; otherwise convert Anthropic↔OpenAI. Reconcile always
 * bills from the adapter's ParsedUsage — this only reshapes the client-facing JSON.
 */
function translateResponseForClient(ctx: PipelineContext, upstreamBody: unknown): unknown {
  const providerShape = providerWireShape(ctx.activeCandidate.provider);
  if (ctx.clientShape === providerShape) return upstreamBody; // no translation needed
  const model = ctx.activeCandidate.model;
  return ctx.clientShape === 'openai'
    ? anthropicResponseToOpenAI(upstreamBody, model) // openai client, anthropic upstream
    : openaiResponseToAnthropic(upstreamBody, model); // anthropic client, openai upstream
}

type AttemptOutcome =
  | { kind: 'ok'; adapter: Adapter }
  | { kind: 'client_abort'; reachedModel: boolean }
  | { kind: 'error'; mapped: MappedError };

/** Synthetic MappedError for a transport failure (no HTTP response to map). */
function transportError(
  errorClass: 'timeout' | 'server',
  httpStatus: number,
  code: string,
): MappedError {
  return {
    spillwayCode: code,
    httpStatus,
    isRetryable: true,
    isClientError: false,
    errorClass,
    retryAfterMs: null,
    rawBody: null,
  };
}

/** One upstream call for a candidate. Sets ctx.upstreamResponse/upstreamStatus on a real response. */
async function attemptCandidate(
  ctx: PipelineContext,
  candidate: Candidate,
): Promise<AttemptOutcome> {
  let adapter: Adapter;
  let transformed: ReturnType<Adapter['transform']>;
  try {
    ({ adapter, transformed } = prepareCandidate(ctx, candidate));
  } catch (err) {
    // A prepare fault (missing/corrupt provider key, unknown provider) is a config error for THIS
    // candidate — not a provider outage. Return an advanceable synthetic error so the chain tries the
    // next candidate instead of aborting a request that may have healthy fallbacks (red-team B5-3).
    // errorClass null → NOT counted toward circuit-breaker health (it isn't a provider fault).
    const code = err instanceof SpillwayError ? err.code : 'provider_key_decrypt_failed';
    ctx.req.log.warn({ err, candidate: candidateKeyOf(candidate) }, 'candidate prepare failed');
    return {
      kind: 'error',
      mapped: {
        spillwayCode: code,
        httpStatus: 502,
        isRetryable: true,
        isClientError: false,
        errorClass: null,
        retryAfterMs: null,
        rawBody: null,
      },
    };
  }
  ctx.timings.dispatchStart = Date.now() - ctx.startedAt;

  const timeout = AbortSignal.timeout(TIMEOUT_BODY_NON_STREAM_MS);
  const signal = AbortSignal.any([ctx.clientAbort.signal, timeout]);

  // If the client already hung up before we transmit, undici rejects before the request reaches the
  // provider → nothing generated → $0 (not the input floor). A disconnect DURING the in-flight fetch
  // did reach the provider → bill the floor (red-team post-B9 abort-billing).
  const reachedModel = !ctx.clientAbort.signal.aborted;
  let upstream: Response;
  try {
    upstream = (await undiciFetch(transformed.url, {
      method: 'POST',
      headers: transformed.headers,
      body: JSON.stringify(transformed.body),
      signal,
      // SSRF (M2 red-team): reject 3xx so a compromised openai_compat upstream can't redirect us to a
      // private/metadata host; the guarded dispatcher re-checks the RESOLVED IP (DNS-rebind defense).
      redirect: 'error',
      dispatcher: ctx.deps.dispatcher ?? ssrfGuardedDispatcher(),
    })) as unknown as Response;
  } catch (err) {
    if (ctx.clientAbort.signal.aborted) {
      ctx.req.log.info({ err }, 'client disconnected before upstream responded');
      return { kind: 'client_abort', reachedModel };
    }
    if (timeout.aborted)
      return { kind: 'error', mapped: transportError('timeout', 504, 'upstream_timeout') };
    return { kind: 'error', mapped: transportError('server', 502, 'upstream_connect_failed') };
  }

  ctx.upstreamResponse = upstream;
  ctx.upstreamStatus = upstream.status;
  if (upstream.status >= 200 && upstream.status < 300) return { kind: 'ok', adapter };

  const errBody = await upstream.json().catch(() => null);
  const mapped = adapter.mapError(upstream.status, errBody);
  // Honor an upstream Retry-After for the circuit-breaker cooldown (§6.3, red-team B5-5): the adapter
  // can't see response headers, so thread the parsed value here when it didn't set one.
  if (mapped.retryAfterMs == null) {
    const ra = parseRetryAfter(upstream.headers as unknown as Headers);
    if (ra != null) mapped.retryAfterMs = ra;
  }
  return { kind: 'error', mapped };
}

export async function runDispatch(ctx: PipelineContext): Promise<void> {
  if (ctx.stream) {
    await runStreamChain(ctx);
    return;
  }
  await runNonStreamChain(ctx);
}

/**
 * Streaming dispatch with pre-commit fallback (15 §7.2). Fallback is only possible BEFORE any byte
 * reaches the client (ADR-008 — a committed stream can't be un-sent). So each candidate is dispatched
 * through the SSE tee, which peeks the upstream status pre-hijack: a retryable pre-2xx failure with a
 * candidate left advances the chain (the failed attempt reconciles NON-final, attempt-row only); a
 * client 4xx or the exhausted chain surfaces terminally; and the moment the tee commits a byte the
 * candidate is final (runSseTee sets isFinalAttempt) and no advance is possible. Mirrors
 * runNonStreamChain's attempt-numbering + fallback_from provenance so the two paths bill identically.
 */
async function runStreamChain(ctx: PipelineContext): Promise<void> {
  const list = ctx.candidateChain;
  const attempted = new Set<string>();
  const fallbackFrom: Array<Record<string, unknown>> = [
    ...(ctx.fallbackFrom as Array<Record<string, unknown>>),
  ];
  let attemptNumber = 0;

  for (let idx = 0; ; ) {
    while (idx < list.length && attempted.has(candidateKeyOf(list[idx]!))) idx++;
    if (idx >= list.length) {
      throw new SpillwayError('all_providers_failed', 'all candidates failed', { httpStatus: 502 });
    }
    const candidate = list[idx]!;
    attempted.add(candidateKeyOf(candidate));
    const hasNext = list.slice(idx + 1).some((c) => !attempted.has(candidateKeyOf(c)));
    ctx.candidate = candidate;
    ctx.activeCandidate = candidate;
    ctx.attemptNumber = attemptNumber;
    ctx.fallbackFrom = fallbackFrom;
    // Tentatively final only when it's the last candidate; runSseTee flips this to true on commit.
    ctx.isFinalAttempt = !hasNext;

    try {
      const { adapter, transformed } = prepareCandidate(ctx, candidate);
      ctx.timings.dispatchStart = Date.now() - ctx.startedAt;
      await runSseTee(ctx, adapter, transformed);
      return; // committed + streamed (success, or committed-then-in-band error — never re-tried)
    } catch (err) {
      // Once a byte is committed we can NEVER advance (ADR-008); runSseTee reconciled internally. Rethrow.
      if (ctx.hijacked || ctx.timings.firstByte !== undefined) throw err;
      // Pre-commit failure. Ensure it's recorded: a prepareCandidate fault never reached runSseTee, so
      // reconcile here (idempotent — a no-op if runSseTee already reconciled the pre-2xx error row).
      if (!ctx.errorCode)
        ctx.errorCode = err instanceof SpillwayError ? err.code : 'provider_key_decrypt_failed';
      await guardedReconcile(ctx, null);
      // Advance only on a retryable (server / transport / prepare) failure with a candidate left; a
      // client 4xx or the exhausted chain surfaces (this attempt reconciled FINAL, isFinalAttempt was true).
      const retryable =
        err instanceof SpillwayError &&
        (err.code === 'upstream_error' ||
          err.code === 'provider_unavailable' ||
          err.code === 'provider_key_decrypt_failed');
      if (!retryable) throw err; // a client 4xx (invalid_request) surfaces immediately, never cascades
      if (!hasNext) {
        // Every candidate failed retryably → the chain is exhausted (this last attempt reconciled final).
        throw new SpillwayError('all_providers_failed', 'all candidates failed', {
          httpStatus: 502,
        });
      }
      fallbackFrom.push({
        attempt_number: attemptNumber,
        provider: candidate.provider,
        model: candidate.model,
        error: ctx.errorCode,
      });
      // Reset the per-attempt reconcile guard so the NEXT candidate's stream reconciles its own attempt
      // (guardedReconcile's reconcileStarted latch is per-request; without this the fallback attempt's
      // reconcile is silently swallowed — the served-model attempt row + requests row would be lost).
      ctx.reconcileStarted = false;
      ctx.errorCode = null; // reset for the next attempt's clean reconcile
      attemptNumber++;
      idx++;
    }
  }
}

async function runNonStreamChain(ctx: PipelineContext): Promise<void> {
  const result = ctx.routeResult;
  const attempted = new Set<string>();
  let list: Candidate[] = ctx.candidateChain;
  let idx = 0;
  let attemptNumber = 0;
  // Preserve any marker BUDGET already set (the budget_fallback provenance, attempt_number:-1); the
  // chain-failover markers below append to it. Starting from [] here wiped the budget substitution
  // record, so requests.fallback_from came back null for a budget-served fallback (expanded-audit M5).
  const fallbackFrom: Array<Record<string, unknown>> = [
    ...(ctx.fallbackFrom as Array<Record<string, unknown>>),
  ];
  const log = (e: unknown, m: string): void => ctx.req.log.error({ e }, m);

  for (;;) {
    while (idx < list.length && attempted.has(candidateKeyOf(list[idx]!))) idx++;
    if (idx >= list.length) {
      throw new SpillwayError('all_providers_failed', 'all candidates failed', { httpStatus: 502 });
    }
    const candidate = list[idx]!;
    const key = candidateKeyOf(candidate);
    attempted.add(key);
    ctx.candidate = candidate;
    ctx.activeCandidate = candidate;
    ctx.attemptNumber = attemptNumber;
    ctx.fallbackFrom = fallbackFrom;

    const outcome = await attemptCandidate(ctx, candidate);

    if (outcome.kind === 'ok') {
      ctx.isFinalAttempt = true;
      ctx.errorCode = null;
      await runBodyCapture(ctx, outcome.adapter); // reconcile (final, ok) → send
      ctx.deps.healthStore.recordSuccess(key);
      return;
    }
    if (outcome.kind === 'client_abort') {
      // Client gone. If the request REACHED the provider (server-side generation billed the org's key),
      // bill the provably-correct input-token FLOOR (17 §4.5) — never usage=null → $0 (un-metered spend
      // / budget bypass; red-team B0-6 F1). If it aborted PRE-dispatch (nothing generated), bill $0
      // (reachedModel=false → billed:false → zero usage, no counter bump; red-team post-B9). Record the
      // final client_closed attempt either way (no throw, no advance).
      const bill = classifyFailure({
        kind: 'client_disconnect',
        stream: false,
        inputTokens: ctx.estimatedInputTokens,
        reachedModel: outcome.reachedModel,
      });
      ctx.usage = {
        input_tokens: bill.inputTokens,
        output_tokens: bill.outputTokens,
        cached_read_tokens: 0,
        cache_write_5m_tokens: 0,
        cache_write_1h_tokens: 0,
        cache_type: null,
        reasoning_tokens: 0,
        usage_estimated: bill.usageEstimated,
      };
      ctx.isFinalAttempt = true;
      ctx.upstreamStatus = 499;
      ctx.errorCode = 'client_closed_request';
      await runReconcile(ctx).catch((e) => log(e, 'reconcile after client-disconnect failed'));
      return;
    }

    const mapped = outcome.mapped;
    const kind = healthKindFor(mapped.errorClass);
    if (kind) ctx.deps.healthStore.recordFailure(key, kind, mapped.retryAfterMs ?? undefined);
    // A non-health error class (4xx client / content_policy / context_window) means the provider
    // RESPONDED — it's reachable. Clear any stored-open/half-open breaker so a half-open probe that
    // returns a non-fault class can't leave it stuck open forever (expanded-audit L18). errorClass
    // null = a prepare fault (no upstream contact) → not reachable, don't clear.
    else if (mapped.errorClass !== null) ctx.deps.healthStore.recordReachable(key);

    // Typed-chain switch: a context_window / content_policy error advances into that variant (§7.1).
    // Use the single exported selectTypedFallback (expanded-audit L20) — dispatch previously kept an
    // INLINE copy of this branch that could drift from the export a future fix would land in. It
    // returns the typed variant only for a typed class with a non-empty variant; for every other class
    // (or an empty variant) it returns result.chain.slice(1), which for our purposes means "no switch"
    // → keep walking the CURRENT working list.
    const typed = selectTypedFallback(result, mapped.errorClass);
    const switchesVariant =
      (mapped.errorClass === 'context_window' && result.typedFallbacks.context_window.length > 0) ||
      (mapped.errorClass === 'content_policy' && result.typedFallbacks.content_policy.length > 0);
    // Health-reorder the variant before dispatching into it (expanded-audit M19): route.ts snapshots
    // the typed-variant candidates' health, so a variant whose head breaker is OPEN would otherwise be
    // dispatched into blind, guaranteeing a failure+latency before walking to a healthy tail.
    const nextList = switchesVariant ? reorderByHealth(typed, ctx.healthSnapshot) : list;
    const canAdvance =
      mapped.isRetryable &&
      !mapped.isClientError &&
      nextList.some((c) => !attempted.has(candidateKeyOf(c)));

    ctx.upstreamStatus = mapped.httpStatus;
    ctx.errorCode = mapped.spillwayCode;

    if (!canAdvance) {
      // Terminal (client sentinel) or exhausted → this attempt is final; reconcile then surface.
      ctx.isFinalAttempt = true;
      await runReconcile(ctx).catch((e) =>
        log(e, 'reconcile after terminal upstream error failed'),
      );
      if (mapped.isClientError) {
        // 4xx = the caller's fault → echo the upstream status (never cascade a client error).
        throw new SpillwayError('invalid_request', `upstream returned ${mapped.httpStatus}`, {
          httpStatus: mapped.httpStatus,
          details: { upstream_status: mapped.httpStatus },
        });
      }
      throw new SpillwayError('all_providers_failed', 'all candidates failed', {
        httpStatus: 502,
        details: { last_upstream_status: mapped.httpStatus },
      });
    }

    // Retryable + more to try → reconcile this (non-final) attempt + advance.
    ctx.isFinalAttempt = false;
    await runReconcile(ctx).catch((e) => log(e, 'reconcile after non-final attempt failed'));
    fallbackFrom.push({
      attempt_number: attemptNumber,
      reason: mapped.errorClass ?? mapped.spillwayCode,
      from: key,
    });
    attemptNumber += 1;
    if (nextList !== list) {
      list = nextList;
      idx = 0;
    } else {
      idx += 1;
    }
  }
}

/**
 * Read the upstream 2xx body, extract usage, RECONCILE, then forward it (commit-before-ack, 17 §4.6).
 * A parse failure is a real failure (2xx we couldn't read) → 502. Reconcile runs before the send +
 * swallows its own errors: a spend-write failure must not fail a 200 the client is about to receive.
 */
/** Visible output text of a non-stream 2xx body, wire-shape tolerant (openai `choices`, anthropic
 *  `content`, gemini `candidates`). Estimation input ONLY — never treated as exact. */
function outputTextOf(body: unknown): string {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object') return '';
  const parts: string[] = [];
  if (Array.isArray(b.choices)) {
    for (const c of b.choices as Array<{ message?: { content?: unknown } }>) {
      if (typeof c?.message?.content === 'string') parts.push(c.message.content);
    }
  }
  if (Array.isArray(b.content)) {
    for (const c of b.content as Array<{ text?: unknown }>) {
      if (typeof c?.text === 'string') parts.push(c.text);
    }
  }
  if (Array.isArray(b.candidates)) {
    for (const c of b.candidates as Array<{ content?: { parts?: Array<{ text?: unknown }> } }>) {
      for (const p of c?.content?.parts ?? []) {
        if (typeof p?.text === 'string') parts.push(p.text);
      }
    }
  }
  return parts.join('');
}

async function runBodyCapture(ctx: PipelineContext, adapter: Adapter): Promise<void> {
  let body: unknown;
  try {
    body = await ctx.upstreamResponse.json();
  } catch {
    throw new SpillwayError('upstream_error', 'failed to parse upstream response', {
      httpStatus: 502,
    });
  }

  ctx.usage = adapter.parseBody(body, ctx.activeCandidate, ctx.validatedBody);
  if (ctx.usage === null) {
    // A served 2xx whose body carries no readable usage (compat servers routinely omit it) billed
    // exactly $0 — real provider spend invisible in the ledger, the precise hole this gateway
    // exists to close (red-team task #9). Mirror the STREAMING path's contract (07 §6: a served
    // request always produces a metered row): estimate from the request + the response text,
    // flagged usage_estimated so dashboards can distinguish measured from estimated spend.
    const model = ctx.activeCandidate?.model ?? '';
    ctx.usage = {
      input_tokens: estimateInputTokens(ctx.validatedBody, model),
      output_tokens: estimateTokensFromChars(outputTextOf(body).length, model),
      cached_read_tokens: 0,
      cache_write_5m_tokens: 0,
      cache_write_1h_tokens: 0,
      cache_type: null,
      reasoning_tokens: 0,
      usage_estimated: true,
    };
  }

  await runReconcile(ctx).catch((e) => ctx.req.log.error({ e }, 'reconcile before ack failed'));

  // Reshape the upstream body to the client's wire shape (cross-format translation) before send.
  const clientBody = translateResponseForClient(ctx, body);
  const dp = droppedParamsHeader(ctx.droppedParams);
  ctx.reply
    .status(ctx.upstreamResponse.status)
    .headers({
      'content-type': 'application/json',
      'x-spillway-request-id': ctx.requestId,
      ...(dp ? { 'x-spillway-dropped-params': dp } : {}),
    })
    .send(clientBody);
  ctx.timings.responseEnd = Date.now() - ctx.startedAt;
}
