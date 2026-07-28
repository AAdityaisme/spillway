import type { FastifyPluginAsync } from 'fastify';
import {
  SpillwayError,
  openaiErrorBody,
  rateLimitHeaders,
  rateLimit429Body,
  budgetBlockHeaders,
  budget402Body,
  policyDenyBody,
  approvalRequiredBody,
  guardrailBlockHeaders,
} from '@spillway/shared';
import { buildPipelineContext, markStage, type DataPlaneDeps } from '../pipeline/context.js';
import { runAuth } from '../pipeline/auth.js';
import { runValidate } from '../pipeline/validate.js';
import { runRateLimit, releaseParallel } from '../pipeline/ratelimit.js';
import { runRoute } from '../pipeline/route.js';
import { runBudget } from '../pipeline/budget.js';
import { releaseBudgetReservation } from '../budget/reservation.js';
import { runPricing } from '../pipeline/pricing.js';
import { RouteError } from '../routing/resolve.js';
import { runDispatch } from '../dispatch.js';

/**
 * POST /v1/chat/completions. Pipeline:
 *   AUTH → VALIDATE → RATELIMIT → ROUTE → DISPATCH (sends the response + reconciles).
 *
 * The route owns the OUTER error boundary + the parallel-slot `finally` release (v2-code-seams §1).
 * A SpillwayError or RouteError thrown before the response is committed becomes an OpenAI-shaped
 * body with the right status (+ retry-after on a 429). Once DISPATCH has committed the response,
 * a later throw can only be logged.
 */

/** RouteError → SpillwayError (its codes are all SpillwayErrorCodes except ambiguous_provider). */
function routeErrorToSpillway(e: RouteError): SpillwayError {
  const code = e.code === 'ambiguous_provider' ? 'invalid_request' : e.code;
  return new SpillwayError(code, e.message, {
    httpStatus: e.status,
    ...(e.reason ? { details: { reason: e.reason } } : {}),
  });
}

export const chatCompletionsRoute: FastifyPluginAsync<{ deps: DataPlaneDeps }> = async (
  fastify,
  { deps },
) => {
  fastify.post('/chat/completions', async (req, reply) => {
    // prefix '/v1' from the plugin
    const ctx = buildPipelineContext(req, reply, deps);
    // Client hangup → abort the in-flight upstream fetch (DISPATCH disambiguates this from a
    // timeout). LANDMINE: this must listen on the RESPONSE stream. `req.raw` emits 'close' when
    // the request MESSAGE completes (Node ≥16) — i.e. on every request as soon as the body is
    // parsed, while the client is still connected — which pre-aborted every live upstream call
    // (empty 200 + floor-billed org). `reply.raw` 'close' with writableEnded=false means the
    // connection actually died before we finished answering. inject()-based tests never see the
    // difference; the real-socket test in abort-wiring.integration.test.ts does.
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) ctx.clientAbort.abort();
    });

    try {
      await runAuth(ctx);
      markStage(ctx, 'auth');
      runValidate(ctx); // sync: zod + allow-lists + clamps + knobs; throws 400/403/422
      markStage(ctx, 'validate');
      runRateLimit(ctx); // RPM/TPM/parallel; throws 429; acquires the parallel slot
      await runRoute(ctx); // PASS-1 guardrails (403 on deny/approval) + PASS-2 routing resolution
      await runBudget(ctx); // enforce budgets over the hoisted snapshot; 402 or serve-under-fallback
      await runPricing(ctx); // every reachable dispatch candidate must be priceable before serving
      // Flag effects annotate but never block — surface as a non-blocking 2xx header (16 §3.5).
      if (ctx.guardrailAnnotations.length > 0) {
        const flags = ctx.guardrailAnnotations
          .filter((a) => a.kind === 'flag')
          .map((a) => a.name ?? a.policyId);
        if (flags.length > 0) reply.header('x-spillway-guardrail-flags', flags.join(','));
      }
      // 20 §6: trace opt-in surfaces only the request id as a response header (the trace id IS the
      // request id). Non-streaming flushes via reply; the streaming path sets it in the SSE writeHead.
      if (ctx.knobs.traceEnabled) reply.header('x-spillway-trace-id', ctx.requestId);
      await runDispatch(ctx); // sends the client response + reconciles spend internally
    } catch (err) {
      // After a streaming hijack, reply.sent stays FALSE but headers ARE committed via reply.raw —
      // treat a hijacked/headers-sent reply as sent, else reply.code().send() throws
      // ERR_HTTP_HEADERS_SENT on top of the original error (ADR-033 landmine).
      if (reply.sent || ctx.hijacked || reply.raw.headersSent) {
        req.log.error({ err }, 'pipeline error after response was already committed');
        return;
      }
      const me =
        err instanceof SpillwayError
          ? err
          : err instanceof RouteError
            ? routeErrorToSpillway(err)
            : new SpillwayError('upstream_error', 'gateway error', { httpStatus: 502 });
      reply.code(me.httpStatus).header('x-spillway-request-id', ctx.requestId);
      // Blocks use the canonical nested block-body envelope (COMPAT N-3); everything else is flat.
      if (me.code === 'rate_limited') {
        for (const [k, v] of Object.entries(rateLimitHeaders(me))) reply.header(k, v);
        reply.send(rateLimit429Body(me)); // canonical nested envelope (COMPAT N-4), not the flat body
      } else if (me.code === 'budget_exceeded') {
        for (const [k, v] of Object.entries(budgetBlockHeaders(me))) reply.header(k, v);
        reply.send(budget402Body(me));
      } else if (me.code === 'rule_deny') {
        for (const [k, v] of Object.entries(guardrailBlockHeaders(me))) reply.header(k, v);
        reply.send(policyDenyBody(me));
      } else if (me.code === 'approval_required') {
        for (const [k, v] of Object.entries(guardrailBlockHeaders(me))) reply.header(k, v);
        reply.send(approvalRequiredBody(me));
      } else {
        reply.send(openaiErrorBody(me));
      }
    } finally {
      // Always release the in-flight parallel slot (idempotent via ctx.parallelAcquired).
      releaseParallel(ctx);
      // Release any budget hold that reconcile didn't (pre-dispatch failure: pricing 503, a throw
      // between BUDGET and DISPATCH). Idempotent via ctx.budgetReservationSettled — a no-op once
      // reconcile has already settled it. Fire-and-forget: never delay the response on the release.
      void releaseBudgetReservation(ctx);
    }
  });
};
