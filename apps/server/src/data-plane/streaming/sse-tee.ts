import { request as undiciRequest } from 'undici';
import { ssrfGuardedDispatcher } from '../egress-guard.js';
import { SpillwayError } from '@spillway/shared';
import type { Adapter, StreamParser, TransformResult } from '../providers/types.js';
import type { PipelineContext } from '../pipeline/context.js';
import { droppedParamsHeader } from '../headers.js';
import { SseEventParser } from './sse-parser.js';
import {
  makeAnthropicToOpenAiSseTranslator,
  makeOpenAiToAnthropicSseTranslator,
  providerWireShape,
  type SseTranslator,
} from '../providers/translate.js';
import { runReconcile } from '../reconcile.js';
import { healthKindFor, parseRetryAfter } from '../health/store.js';
import { candidateKeyOf } from '../routing/resolve.js';

/**
 * SSE TEE (05-gateway-core §7) — the streaming counterpart of runBodyCapture. Uses
 * `undici.request()` (NOT fetch) for the streaming branch (ADR-033 D2): it yields a Node
 * `Readable` body — matching the tee's `for await` + backpressure — and exposes native
 * `headersTimeout`/`bodyTimeout`.
 *
 * Control flow, and WHY each piece exists:
 *  - Inspect the upstream status BEFORE committing any client headers. A pre-first-byte non-2xx
 *    returns a normal JSON error with the real status (headers not yet hijacked). Only on a
 *    confirmed 2xx do we hijack.
 *  - EVERYTHING after hijack() runs inside one try/finally so the finally ALWAYS reconciles +
 *    tears down (a throw in writeHead — e.g. a hostile dropped-param name — must not escape to
 *    the route and lose the spend row: red-team ADR-034 C1). writeHead commits an immutable 200,
 *    so a later upstream failure is surfaced IN-BAND as an SSE error frame, never a status change.
 *  - Backpressure: reply.raw.write returning false means the client is slow; we wait for 'drain'
 *    but RACE it against client-abort / socket-close / a stall timeout so a half-open (zero-window)
 *    client can't hang the handler forever (→ pinned sockets + lost reconcile: red-team ADR-034 H).
 *  - Usage: a copy of every event feeds the adapter's StreamParser; getUsage() yields real usage
 *    (terminal usage chunk) or an estimate. Reconcile runs AFTER the stream ends, guarded by
 *    ctx.reconcileStarted (normal-end vs abort race) and bounded by a timeout so a stalled DB
 *    write can't hang shutdown (ADR-032 H1 / ADR-034).
 */

const STREAM_FIRST_BYTE_TIMEOUT_MS = 30_000;
const WRITE_STALL_TIMEOUT_MS = 60_000; // max wait for a single client 'drain' before bailing
const RECONCILE_TIMEOUT_MS = 15_000; // bound the post-stream spend write so drain/shutdown can't hang
const ERROR_BODY_TIMEOUT_MS = 10_000; // bound the pre-2xx error-body read (bodyTimeout:0 doesn't apply)
// Inter-chunk idle ceiling on the 2xx body. bodyTimeout:0 deliberately removes undici's TOTAL cap (a
// long valid stream must not be killed), but that also lets a wedged/trickling upstream that sent the
// 2xx headers then stalled (or emits one keep-alive byte every 59s) pin the for-await loop, the
// upstream socket, and the deferred-reconcile TaskTracker slot forever → socket/event-loop exhaustion
// DoS (expanded-audit M11). A generous idle gap (reset on every received chunk) aborts res.body and
// falls to the finally/estimate path, independent of the deliberate no-total-cap.
const STREAM_IDLE_TIMEOUT_MS = 180_000;
const MAX_TEE_BUFFER_BYTES = 2 * 1024 * 1024;
// §7.2 first-chunk peek: a bounded window to read the FIRST complete SSE event on a 2xx body BEFORE
// hijacking. Bounds a post-first-byte stall (bodyTimeout:0 removes undici's total cap) so the peek
// can't pin the loop pre-commit; the byte cap caps a first event with no delimiter (normal frames are
// tiny — an error frame more so — so a first "event" this large is not a normal chat frame).
const STREAM_FIRST_EVENT_TIMEOUT_MS = 30_000;
const PEEK_CAP_BYTES = 64 * 1024;
const LF2 = Buffer.from('\n\n');
const CRLF2 = Buffer.from('\r\n\r\n');

/** Did the CLIENT ask for the usage chunk? If not, we injected include_usage and must strip the
 *  terminal usage-only frame from the client stream (ADR-033 D1). */
function clientRequestedUsage(validatedBody: Record<string, unknown>): boolean {
  const so = validatedBody.stream_options;
  return !!(
    so &&
    typeof so === 'object' &&
    (so as { include_usage?: unknown }).include_usage === true
  );
}

/**
 * A usage-only frame = `usage` present AND choices absent-or-empty. Kept in lock-step with the
 * CAPTURE predicate (openai.ts mapOpenAiUsage on a choices-absent-or-empty chunk) so a frame is
 * STRIPPED iff it is CAPTURED — otherwise a no-`choices` usage frame would leak to a client that
 * didn't ask (red-team ADR-034 L11).
 */
function isUsageOnlyFrame(dataPayload: string): boolean {
  if (dataPayload === '[DONE]') return false;
  try {
    const c = JSON.parse(dataPayload) as { choices?: unknown; usage?: unknown };
    const noContentChoices = !Array.isArray(c.choices) || c.choices.length === 0;
    return noContentChoices && c.usage != null;
  } catch {
    return false;
  }
}

/** Earliest SSE event delimiter in raw bytes (\n\n or \r\n\r\n), scanning from `from`. */
function findDelimiter(buf: Buffer, from: number): { index: number; len: number } | null {
  const lf = buf.indexOf(LF2, from);
  const crlf = buf.indexOf(CRLF2, from);
  if (lf === -1 && crlf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) return { index: crlf, len: 4 };
  return { index: lf, len: 2 };
}

/**
 * Read the pre-2xx error body with a hard ceiling. The streaming request sets bodyTimeout:0 (a long
 * valid stream must not be killed), but that also means a provider that opens the response and then
 * stalls the ERROR body would hang this read forever, pinning the socket + blocking reconcile. Destroy
 * the body if json() hasn't resolved in time; a destroyed read rejects → null (same as a parse fail).
 */
/** Adapt undici.request's plain header object to the minimal `Headers.get` shape parseRetryAfter needs
 *  (case-insensitive; array values → first). undici lowercases header names already. */
function headersLike(h: Record<string, string | string[] | undefined>): Headers {
  return {
    get(name: string): string | null {
      const v = h[name.toLowerCase()];
      if (v === undefined) return null;
      return Array.isArray(v) ? (v[0] ?? null) : v;
    },
  } as Headers;
}

async function readErrorBodyBounded(
  body: { json(): Promise<unknown>; destroy(): void },
  ms: number,
): Promise<unknown> {
  const t = setTimeout(() => {
    try {
      body.destroy();
    } catch {
      /* already gone */
    }
  }, ms);
  if (typeof t.unref === 'function') t.unref();
  try {
    return await body.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * §7.2 first-chunk error peek. An SSE event's data JSON is an ERROR frame when it carries a top-level
 * `error` object (OpenAI: `{"error":{…}}`) or is Anthropic's `event: error` block (`{"type":"error",
 * "error":{…}}`). Some providers answer HTTP 200 then emit such a frame FIRST — a transient serving
 * failure the status code hid. Returns the error object (for logging) or null for any normal frame.
 */
export function sseErrorObject(data: string): Record<string, unknown> | null {
  const d = data.trim();
  if (d === '[DONE]' || !d.startsWith('{')) return null;
  try {
    const j = JSON.parse(d) as Record<string, unknown>;
    if (j.error && typeof j.error === 'object') return j.error as Record<string, unknown>;
    if (j.type === 'error') return (j.error as Record<string, unknown>) ?? j;
    return null;
  } catch {
    return null;
  }
}

/**
 * Pull raw chunks from the 2xx body iterator until the FIRST complete SSE event is parsed (or the
 * stream ends / the byte cap is hit), WITHOUT committing anything to the client. Returns the raw bytes
 * consumed (`peekBuf`, replayed into the normal loop when it is not an error) and the first event's
 * error object if it was an error frame. Bounded by a timeout that destroys the body — a stall/transport
 * fault surfaces as a thrown reject, which the caller maps to a retryable pre-commit failure.
 */
async function peekFirstEvent(
  res: { body: { destroy(err?: Error): void } },
  it: AsyncIterator<Buffer>,
): Promise<{ peekBuf: Buffer; error: Record<string, unknown> | null }> {
  const parser = new SseEventParser();
  let peekBuf = Buffer.alloc(0);
  const deadline = setTimeout(
    () => res.body.destroy(new Error('first-event peek timeout')),
    STREAM_FIRST_EVENT_TIMEOUT_MS,
  );
  if (typeof deadline.unref === 'function') deadline.unref();
  try {
    for (;;) {
      const r = await it.next();
      if (r.done) return { peekBuf, error: null }; // stream ended before any complete event
      const buf = r.value;
      peekBuf = Buffer.concat([peekBuf, buf]);
      const evs = parser.push(buf);
      if (evs.length > 0) return { peekBuf, error: sseErrorObject(evs[0]!.data) };
      if (peekBuf.length >= PEEK_CAP_BYTES) return { peekBuf, error: null }; // huge first frame → don't hold
    }
  } finally {
    clearTimeout(deadline);
  }
}

export async function runSseTee(
  ctx: PipelineContext,
  adapter: Adapter,
  transformed: TransformResult,
): Promise<void> {
  let res;
  try {
    res = await undiciRequest(transformed.url, {
      method: 'POST',
      headers: transformed.headers,
      body: JSON.stringify(transformed.body),
      signal: ctx.clientAbort.signal,
      headersTimeout: STREAM_FIRST_BYTE_TIMEOUT_MS, // TTFB cap
      bodyTimeout: 0, // NO total cap — a long valid stream must not be killed
      // SSRF: undici.request defaults maxRedirections:0 (no 3xx followed); the guarded dispatcher adds
      // the DNS-rebind check on the resolved IP (M2 red-team). Test seam = MockAgent.
      dispatcher: ctx.deps.dispatcher ?? ssrfGuardedDispatcher(),
    });
  } catch (err) {
    if (ctx.clientAbort.signal.aborted) {
      ctx.req.log.info({ err }, 'client disconnected before stream started');
      return; // nothing sent; nothing to reconcile (never reached upstream)
    }
    throw new SpillwayError('provider_unavailable', 'upstream connect/first-byte failed', {
      httpStatus: 504,
    });
  }

  ctx.activeCandidate = ctx.candidate;
  ctx.upstreamStatus = res.statusCode;

  // Pre-first-byte error: status known before any client bytes → JSON error with the real status
  // (headers NOT hijacked yet), like the non-streaming non-2xx fork.
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const errBody = await readErrorBodyBounded(res.body, ERROR_BODY_TIMEOUT_MS);
    const mapped = adapter.mapError(res.statusCode, errBody);
    ctx.errorCode = mapped.spillwayCode;
    // Honor an upstream Retry-After for the breaker cooldown, mirroring dispatch.ts's non-stream path —
    // the adapter can't see response headers, so thread the parsed value when it didn't set one. Without
    // this a streaming 429+Retry-After fell back to the default backoff and reopened sooner than the
    // provider asked (expanded-audit L10). undici.request yields a plain header object → adapt to the
    // Headers.get shape parseRetryAfter expects.
    if (mapped.retryAfterMs == null) {
      const ra = parseRetryAfter(headersLike(res.headers));
      if (ra != null) mapped.retryAfterMs = ra;
    }
    // Feed the circuit breaker — a streaming pre-2xx failure is a real provider signal; the non-stream
    // path records it, this path did not (expanded-audit HIGH #3: breaker was blind to stream failures).
    const kind = healthKindFor(mapped.errorClass);
    if (kind)
      ctx.deps.healthStore.recordFailure(
        candidateKeyOf(ctx.candidate),
        kind,
        mapped.retryAfterMs ?? undefined,
      );
    // Non-health class = the provider responded (reachable) → clear a stuck stored-open/half-open
    // breaker, mirroring the non-stream path (expanded-audit L18).
    else if (mapped.errorClass !== null)
      ctx.deps.healthStore.recordReachable(candidateKeyOf(ctx.candidate));
    await guardedReconcile(ctx, null); // record the error row (usage null → estimated zeros)
    throw new SpillwayError(
      mapped.isClientError ? 'invalid_request' : 'upstream_error',
      `upstream returned ${res.statusCode}`,
      {
        httpStatus: mapped.isClientError ? res.statusCode : 502,
        details: { upstream_status: res.statusCode },
      },
    );
  }

  // §7.2 first-chunk error peek: read the FIRST complete SSE event BEFORE committing. A provider that
  // answers HTTP 200 then emits an error frame first (overloaded/backend hiccup) would otherwise commit
  // a 200 + an in-band error and block fallback. Peeking pre-hijack lets a first-event error advance the
  // chain exactly like a pre-2xx failure — no client byte is sent until the first event is non-error.
  const bodyIter = res.body[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  let peek: { peekBuf: Buffer; error: Record<string, unknown> | null };
  try {
    peek = await peekFirstEvent(res, bodyIter);
  } catch (err) {
    // A client disconnect DURING the pre-commit peek is not a provider fault. Mirror the connect catch
    // (the pre-2xx `if (ctx.clientAbort.signal.aborted) return`): the deadline/abort tore the body, but
    // recording a provider failure here poisons the circuit breaker AND throws a retryable upstream_error
    // that advances the fallback chain onto the already-aborted request — which then no-ops without ever
    // writing a final row (red-team audit F6). Nothing was committed to the client, so bail cleanly.
    if (ctx.clientAbort.signal.aborted) {
      ctx.req.log.info({ err }, 'client disconnected during first-event peek');
      res.body.destroy();
      return;
    }
    // Genuine peek stall/failure pre-commit (the idle deadline destroyed the body) → retryable, mirror
    // the pre-2xx path so a remaining candidate can serve it.
    ctx.errorCode = 'upstream_stream_first_event_failed';
    ctx.deps.healthStore.recordFailure(candidateKeyOf(ctx.candidate), 'timeout');
    await guardedReconcile(ctx, null);
    res.body.destroy();
    throw new SpillwayError('upstream_error', 'upstream first stream event failed', {
      httpStatus: 504,
      cause: err,
    });
  }
  if (peek.error) {
    // The first event IS an error frame. A 200-then-in-band-error is a transient SERVING failure (the
    // request was accepted, so it is never a client-request rejection) → retryable upstream_error: a
    // remaining candidate makes runStreamChain advance (fallback); chain-exhausted surfaces 502.
    const code =
      (typeof peek.error.type === 'string' && peek.error.type) ||
      (typeof peek.error.code === 'string' && peek.error.code) ||
      'upstream_error_first_chunk';
    ctx.errorCode = 'upstream_stream_first_chunk_error';
    ctx.deps.healthStore.recordFailure(candidateKeyOf(ctx.candidate), 'server');
    await guardedReconcile(ctx, null);
    res.body.destroy();
    throw new SpillwayError(
      'upstream_error',
      'upstream returned an error as the first stream event',
      { httpStatus: 502, details: { upstream_error: code } },
    );
  }

  // Confirmed 2xx + a non-error first event → hijack (Fastify stops managing the response; reply.sent
  // stays false, so the route catch keys off ctx.hijacked). Setup that cannot throw stays outside the
  // try; everything that can (writeHead, the loop) is INSIDE so the finally always reconciles + tears
  // down. Committing a byte makes THIS candidate final — no fallback is possible once the stream starts
  // (ADR-008 / 15 §7.2), so even a non-last candidate that reaches 2xx reconciles as the final attempt.
  ctx.isFinalAttempt = true;
  ctx.hijacked = true;
  ctx.reply.hijack();
  const raw = ctx.reply.raw;
  const parser: StreamParser = adapter.createStreamParser(ctx.candidate);
  const usageParser = new SseEventParser();
  const wantsUsage = clientRequestedUsage(ctx.validatedBody);
  const model = ctx.candidate.model;
  // Cross-format streaming (06 §2.4b): when the client and the served provider speak different wire
  // shapes, the raw upstream SSE cannot be byte-forwarded — each event is translated to the client's
  // shape. Usage capture still feeds the adapter's (upstream-shape-aware) StreamParser above; the
  // translator ONLY reshapes the client-facing frames. null when shapes match (fast byte-forward path).
  const providerShape = providerWireShape(ctx.candidate.provider);
  const translator: SseTranslator | null =
    ctx.clientShape === providerShape
      ? null
      : ctx.clientShape === 'openai'
        ? makeAnthropicToOpenAiSseTranslator(model, wantsUsage)
        : makeOpenAiToAnthropicSseTranslator(model);
  let framingBuf: Buffer = Buffer.alloc(0);
  let streamEndedCleanly = false;
  let idleTimedOut = false;
  let idleTimer: NodeJS.Timeout | undefined;

  /** Write to the client with drain-backpressure, but never hang: bail on abort/close/stall. */
  const write = async (buf: Buffer): Promise<void> => {
    if (ctx.timings.firstByte === undefined) ctx.timings.firstByte = Date.now() - ctx.startedAt;
    if (raw.write(buf)) return;
    await new Promise<void>((resolve, reject) => {
      const signal = ctx.clientAbort.signal;
      const cleanup = (): void => {
        raw.off('drain', onDrain);
        raw.off('close', onFail);
        raw.off('error', onFail);
        signal.removeEventListener('abort', onFail);
        clearTimeout(timer);
      };
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onFail = (): void => {
        cleanup();
        reject(new Error('client write backpressure: aborted/closed/stalled'));
      };
      const timer = setTimeout(onFail, WRITE_STALL_TIMEOUT_MS);
      raw.once('drain', onDrain);
      raw.once('close', onFail);
      raw.once('error', onFail);
      signal.addEventListener('abort', onFail, { once: true });
    });
  };

  try {
    const headers: Record<string, string> = {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // defeat nginx/Fly SSE buffering
      'x-spillway-request-id': ctx.requestId,
    };
    const dp = droppedParamsHeader(ctx.droppedParams); // control-char-sanitized (ADR-034 C1)
    if (dp) headers['x-spillway-dropped-params'] = dp;
    if (ctx.knobs.traceEnabled) headers['x-spillway-trace-id'] = ctx.requestId; // 20 §6 (streaming)
    raw.writeHead(res.statusCode, headers);

    // Inter-chunk idle watchdog (expanded-audit M11): reset on every received chunk; if it fires the
    // upstream trickled/stalled → destroy res.body, which makes the for-await throw into the catch and
    // fall through to the finally/estimate path. unref'd so it never holds the loop open on its own.
    const armIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        res.body.destroy(new Error('stream idle timeout'));
      }, STREAM_IDLE_TIMEOUT_MS);
      if (typeof idleTimer.unref === 'function') idleTimer.unref();
    };
    armIdle();

    // Replay the peeked first-event bytes, then continue draining the SAME iterator. Never re-iterate
    // res.body directly — that starts a second reader and drops the already-consumed peeked bytes.
    const body: AsyncIterable<Buffer> = {
      async *[Symbol.asyncIterator]() {
        if (peek.peekBuf.length > 0) yield peek.peekBuf;
        for (let r = await bodyIter.next(); r.done !== true; r = await bodyIter.next())
          yield r.value;
      },
    };
    for await (const chunk of body) {
      armIdle(); // a chunk arrived → reset the idle deadline
      const buf = chunk as Buffer;
      // usage capture — feed a decoded COPY to the adapter parser (never touches client bytes)
      for (const ev of usageParser.push(buf)) {
        if (ev.data === '[DONE]' || isStreamTerminal(ev.data)) streamEndedCleanly = true;
        parser.processEvent(ev);
        if (translator)
          for (const f of translator.translate(ev)) await write(Buffer.from(f, 'utf8'));
      }
      if (translator) continue; // client frames were emitted by the translator above
      // The usage-frame strip only applies to OpenAI-shaped upstreams (it suppresses the include_usage
      // frame we injected for metering). An Anthropic-shaped upstream has no injected frame, and its
      // message_delta LOOKS usage-only (usage + no choices) — stripping it would drop the client's
      // stop_reason + final usage. So for non-OpenAI upstreams, pure passthrough (M2 red-team).
      if (wantsUsage || providerShape !== 'openai') {
        await write(buf); // pure byte-for-byte passthrough
      } else {
        framingBuf = Buffer.concat([framingBuf, buf]);
        if (framingBuf.length > MAX_TEE_BUFFER_BYTES)
          throw new Error('SSE frame exceeds tee buffer cap');
        framingBuf = await forwardFramesExceptUsage(framingBuf, write);
      }
    }
    for (const ev of usageParser.flush()) {
      if (ev.data === '[DONE]') streamEndedCleanly = true;
      parser.processEvent(ev);
      if (translator) for (const f of translator.translate(ev)) await write(Buffer.from(f, 'utf8'));
    }
    if (translator) {
      for (const f of translator.flush()) await write(Buffer.from(f, 'utf8')); // terminal client frames
    } else if (!wantsUsage && framingBuf.length > 0) {
      // Trailing incomplete tail (e.g. a final usage frame or [DONE] with no closing blank line):
      // apply the SAME strip so an undelimited usage frame doesn't leak (ADR-034 M5).
      const tailPayload = extractDataPayload(framingBuf.toString('utf8'));
      if (!(tailPayload !== null && isUsageOnlyFrame(tailPayload))) await write(framingBuf);
    }
  } catch (err) {
    // Post-hijack failure: 200 already committed. Surface IN-BAND as an SSE error frame (never a
    // status change), then end. A cut stream → getUsage estimates (no captured usage chunk).
    if (!ctx.clientAbort.signal.aborted) {
      ctx.errorCode = idleTimedOut ? 'upstream_stream_idle_timeout' : 'upstream_error_mid_stream';
      try {
        raw.write(
          `data: ${JSON.stringify({ error: { message: 'upstream stream error', type: 'spillway_error' } })}\n\n`,
        );
      } catch {
        /* socket already gone */
      }
    } else {
      ctx.errorCode = 'client_closed_request';
    }
    ctx.req.log.warn({ err, cleanly: streamEndedCleanly, idleTimedOut }, 'stream ended abnormally');
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    // getUsage returns real usage (usage_estimated=false) when a usage chunk was captured — even
    // if [DONE] never arrived — else an estimate (usage_estimated=true). No blanket override.
    ctx.usage = parser.getUsage(ctx.validatedBody, model);
    // COMMIT-BEFORE-ACK on the streaming path (17 §4.6, red-team B3-1): reconcile (durably commit
    // spend) BEFORE raw.end() sends the clean half-close, so a crash mid-reconcile can't leave the
    // client with a cleanly-ended stream (perceived success) and no spend row. guardedReconcile is
    // timeout-bounded, so only the half-close waits on the (bounded) reconcile round-trip.
    await guardedReconcile(ctx, ctx.usage);
    // Circuit-breaker success feedback (expanded-audit M12): a stream that ended cleanly with no error
    // and no client abort PROVES the candidate is healthy — the non-stream path resets the breaker on
    // success but this path did not, so on stream-heavy traffic consecutiveFailures drifted toward the
    // OPEN threshold and tripped a healthy provider. Mirror recordSuccess only on a clean end.
    if (streamEndedCleanly && !ctx.errorCode && !ctx.clientAbort.signal.aborted) {
      ctx.deps.healthStore.recordSuccess(candidateKeyOf(ctx.candidate));
    }
    try {
      raw.end();
    } catch {
      /* already ended */
    }
    res.body.destroy(); // never leak the upstream connection (bail paths above)
    ctx.timings.responseEnd = Date.now() - ctx.startedAt;
  }
}

/**
 * Forward each COMPLETE frame's exact bytes (byte-for-byte) except the injected usage-only frame;
 * return the retained incomplete tail. Scans raw bytes with Buffer.indexOf and decodes only each
 * frame's head (O(total), NOT the O(n²) decode-whole-buffer-per-frame the strip path used to do —
 * red-team ADR-034 M6). Usage is still captured separately via usageParser; we only suppress the
 * FORWARD of the usage frame.
 */
/**
 * Anthropic's terminal stream event (`message_stop`) — the shape-specific equivalent of OpenAI's
 * `[DONE]` sentinel, which Anthropic streams never send. Recognising it lets the circuit-breaker record
 * success on a cleanly-ended Anthropic stream instead of drifting toward OPEN (M2 red-team; audit M12).
 */
function isStreamTerminal(data: string): boolean {
  if (!data.startsWith('{')) return false;
  try {
    return (JSON.parse(data) as { type?: string }).type === 'message_stop';
  } catch {
    return false;
  }
}

async function forwardFramesExceptUsage(
  buf: Buffer,
  write: (b: Buffer) => Promise<void>,
): Promise<Buffer> {
  let offset = 0;
  for (;;) {
    const d = findDelimiter(buf, offset);
    if (!d) break;
    const frameEnd = d.index + d.len;
    const frame = buf.subarray(offset, frameEnd); // exact bytes incl. delimiter
    const headText = buf.toString('utf8', offset, d.index); // decode only this frame's head
    offset = frameEnd;

    const dataPayload = extractDataPayload(headText);
    if (dataPayload !== null && isUsageOnlyFrame(dataPayload)) continue; // strip: do not forward
    await write(frame);
  }
  return buf.subarray(offset);
}

/** Join the `data:` lines of a frame block (ignore event:/id:/comments). Null if none. */
function extractDataPayload(block: string): string | null {
  const lines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''));
  }
  return lines.length ? lines.join('\n') : null;
}

/**
 * Reconcile at most once (ctx.reconcileStarted guards the normal-end vs client-abort race).
 * Bounded by RECONCILE_TIMEOUT_MS so a stalled DB write can't keep the promise (and therefore the
 * TaskTracker Set + onClose drain) alive forever (red-team ADR-034 M7). Registered with the tracker
 * so a SIGTERM mid-write is drained on shutdown (D6). Never throws.
 */
export function guardedReconcile(
  ctx: PipelineContext,
  usage: PipelineContext['usage'],
): Promise<void> {
  if (ctx.reconcileStarted) return Promise.resolve();
  ctx.reconcileStarted = true;
  ctx.usage = usage;
  const reconcile = runReconcile(ctx).catch((e) =>
    ctx.req.log.error({ e }, 'stream reconcile failed'),
  );
  const bounded = Promise.race([reconcile, abandonAfter(RECONCILE_TIMEOUT_MS, ctx)]);
  ctx.deps.streamTasks?.track(bounded);
  return bounded;
}

/** Resolves after `ms` (unref'd so it never holds the loop) — the abandon arm of the reconcile race. */
function abandonAfter(ms: number, ctx: PipelineContext): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      ctx.req.log.error({ requestId: ctx.requestId }, 'stream reconcile timed out — abandoned');
      resolve();
    }, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}
