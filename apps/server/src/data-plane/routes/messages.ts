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
  AnthropicMessagesRequest,
} from '@spillway/shared';
import { buildPipelineContext, markStage, type DataPlaneDeps } from '../pipeline/context.js';
import { runAuth } from '../pipeline/auth.js';
import { applyValidatedBody } from '../pipeline/validate.js';
import { runRateLimit, releaseParallel } from '../pipeline/ratelimit.js';
import { runRoute } from '../pipeline/route.js';
import { runBudget } from '../pipeline/budget.js';
import { releaseBudgetReservation } from '../budget/reservation.js';
import { runPricing } from '../pipeline/pricing.js';
import { RouteError } from '../routing/resolve.js';
import { runDispatch } from '../dispatch.js';
import { anthropicRequestToOpenAI } from '../providers/translate.js';

/**
 * POST /v1/messages — the NATIVE Anthropic-shape entrypoint (06 §2.2b). Same pipeline as
 * /v1/chat/completions (AUTH → VALIDATE → RATELIMIT → ROUTE → BUDGET → PRICING → DISPATCH →
 * RECONCILE); the ONLY differences are the client shape and how VALIDATE consumes the body:
 *
 *  - The inbound body is Anthropic Messages shape. It is normalized to an OpenAI-CANONICAL body
 *    (`anthropicRequestToOpenAI`) so the shape-agnostic governance tail (allow-lists, input-size,
 *    output clamp, knobs, features) and the OpenAI-input adapters run unchanged.
 *  - The ORIGINAL native body is stashed as `ctx.clientNativeBody`. When the request routes to an
 *    Anthropic candidate, DISPATCH sends that native body verbatim (model-rewritten) — a true
 *    pass-through with no fidelity loss (cache_control / thinking preserved). When it routes to a
 *    non-Anthropic candidate, the openai-canonical body is transformed by that provider's adapter
 *    and the response is translated back to Anthropic shape (providers/translate.ts).
 *
 * Error bodies are OpenAI-shaped here as well (shared with the /v1/chat/completions error boundary);
 * translating gateway errors into Anthropic's `{type:'error',error:{…}}` envelope is a documented
 * v1 gap — upstream provider errors on a routed Anthropic candidate still surface via the same path.
 */

function routeErrorToSpillway(e: RouteError): SpillwayError {
  const code = e.code === 'ambiguous_provider' ? 'invalid_request' : e.code;
  return new SpillwayError(code, e.message, {
    httpStatus: e.status,
    ...(e.reason ? { details: { reason: e.reason } } : {}),
  });
}

/** VALIDATE for the Anthropic shape: zod-parse the native body, normalize to canonical, stash the
 *  native body for pass-through, and propagate the enforced output ceiling back onto the native body
 *  (the clamp is applied to the canonical body; the native pass-through path must honor it too). */
function runValidateMessages(ctx: ReturnType<typeof buildPipelineContext>): void {
  const parsed = AnthropicMessagesRequest.safeParse(ctx.req.body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new SpillwayError('invalid_request', first?.message ?? 'invalid request body', {
      httpStatus: 400,
      details: { param: first?.path.join('.') ?? null },
    });
  }
  const native = parsed.data as Record<string, unknown>;
  ctx.clientNativeBody = native;
  applyValidatedBody(ctx, anthropicRequestToOpenAI(native));
  // The output-token ceiling was clamped onto the canonical body; mirror it onto the native body so
  // the Anthropic pass-through transform can't exceed the key's max_output_tokens (governance parity).
  if (typeof ctx.validatedBody.max_tokens === 'number')
    native.max_tokens = ctx.validatedBody.max_tokens;
}

export const messagesRoute: FastifyPluginAsync<{ deps: DataPlaneDeps }> = async (
  fastify,
  { deps },
) => {
  fastify.post('/messages', async (req, reply) => {
    const ctx = buildPipelineContext(req, reply, deps, {
      endpoint: 'messages',
      clientShape: 'anthropic',
    });
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) ctx.clientAbort.abort();
    });

    try {
      await runAuth(ctx);
      markStage(ctx, 'auth');
      runValidateMessages(ctx);
      markStage(ctx, 'validate');
      runRateLimit(ctx);
      await runRoute(ctx);
      await runBudget(ctx);
      await runPricing(ctx);
      if (ctx.guardrailAnnotations.length > 0) {
        const flags = ctx.guardrailAnnotations
          .filter((a) => a.kind === 'flag')
          .map((a) => a.name ?? a.policyId);
        if (flags.length > 0) reply.header('x-spillway-guardrail-flags', flags.join(','));
      }
      if (ctx.knobs.traceEnabled) reply.header('x-spillway-trace-id', ctx.requestId); // 20 §6
      await runDispatch(ctx);
    } catch (err) {
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
      if (me.code === 'rate_limited') {
        for (const [k, v] of Object.entries(rateLimitHeaders(me))) reply.header(k, v);
        reply.send(rateLimit429Body(me)); // canonical nested envelope (COMPAT N-4)
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
      releaseParallel(ctx);
      void releaseBudgetReservation(ctx);
    }
  });
};
