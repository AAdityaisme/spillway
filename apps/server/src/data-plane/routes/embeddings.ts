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
import { runValidateEmbeddings } from '../pipeline/validate.js';
import { runRateLimit, releaseParallel } from '../pipeline/ratelimit.js';
import { runRoute } from '../pipeline/route.js';
import { runBudget } from '../pipeline/budget.js';
import { releaseBudgetReservation } from '../budget/reservation.js';
import { runPricing } from '../pipeline/pricing.js';
import { RouteError } from '../routing/resolve.js';
import { runDispatch } from '../dispatch.js';

/**
 * POST /v1/embeddings (task #9). The SAME pipeline as /v1/chat/completions — this endpoint exists
 * because embedding traffic that routes AROUND the gateway under-counts the ledger and falsifies
 * chargeback: every stage (auth, allow-lists, rate limits, routing, budgets, pricing, reconcile)
 * applies unchanged. Differences from chat are all subtractive: embeddings-shaped VALIDATE
 * (runValidateEmbeddings — no output clamp, ctx.stream always false), ROUTE hard-gates on the
 * 'embeddings' capability, and DISPATCH uses the adapter's transformEmbeddings. Non-streaming only,
 * so no SSE/hijack handling in the error boundary.
 */

/** RouteError → SpillwayError (its codes are all SpillwayErrorCodes except ambiguous_provider). */
function routeErrorToSpillway(e: RouteError): SpillwayError {
  const code = e.code === 'ambiguous_provider' ? 'invalid_request' : e.code;
  return new SpillwayError(code, e.message, {
    httpStatus: e.status,
    ...(e.reason ? { details: { reason: e.reason } } : {}),
  });
}

export const embeddingsRoute: FastifyPluginAsync<{ deps: DataPlaneDeps }> = async (
  fastify,
  { deps },
) => {
  fastify.post('/embeddings', async (req, reply) => {
    // prefix '/v1' from the plugin
    const ctx = buildPipelineContext(req, reply, deps, { endpoint: 'embeddings' });
    // Client hangup → abort the in-flight upstream fetch. Same landmine as chat: listen on the
    // RESPONSE stream (reply.raw), not req.raw — see chat-completions.ts for the full story.
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) ctx.clientAbort.abort();
    });

    try {
      await runAuth(ctx);
      markStage(ctx, 'auth');
      runValidateEmbeddings(ctx); // zod + allow-list + input guard + knobs; never streams
      markStage(ctx, 'validate');
      runRateLimit(ctx); // RPM/TPM/parallel; throws 429; acquires the parallel slot
      await runRoute(ctx); // guardrails + routing; hard-gates the 'embeddings' capability
      await runBudget(ctx); // reserve-ahead enforce; 402 or serve-under-fallback
      await runPricing(ctx); // every reachable candidate must be priceable before serving
      if (ctx.guardrailAnnotations.length > 0) {
        const flags = ctx.guardrailAnnotations
          .filter((a) => a.kind === 'flag')
          .map((a) => a.name ?? a.policyId);
        if (flags.length > 0) reply.header('x-spillway-guardrail-flags', flags.join(','));
      }
      if (ctx.knobs.traceEnabled) reply.header('x-spillway-trace-id', ctx.requestId);
      await runDispatch(ctx); // sends the client response + reconciles spend internally
    } catch (err) {
      if (reply.sent || reply.raw.headersSent) {
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
      if (me.code === 'rate_limited') {
        for (const [k, v] of Object.entries(rateLimitHeaders(me))) reply.header(k, v);
        reply.send(rateLimit429Body(me));
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
      releaseParallel(ctx); // idempotent via ctx.parallelAcquired
      // Release any budget hold reconcile didn't settle (pre-dispatch failure). Idempotent;
      // fire-and-forget so the response is never delayed on the release.
      void releaseBudgetReservation(ctx);
    }
  });
};
