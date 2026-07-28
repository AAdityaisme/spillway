import { ChatCompletionsRequest, EmbeddingsRequest, SpillwayError } from '@spillway/shared';
import { estimateInputTokens } from '../streaming/estimator.js';
import type { ProviderName } from '../routing/compile.js';
import type { PipelineContext, SafeKnobs } from './context.js';

const KNOWN_CAPABILITIES = new Set([
  'tools',
  'response_format',
  'json_schema',
  'seed',
  'reasoning',
  'vision',
  'stream',
]);
const PROVIDER_NAMES = new Set<ProviderName>(['openai', 'anthropic', 'gemini', 'openai_compat']);
const SESSION_ID_RE = /^[A-Za-z0-9._:-]+$/;

const header = (ctx: PipelineContext, name: string): string | null => {
  const v = ctx.req.headers[name];
  return typeof v === 'string' ? v.trim() : null;
};

/** Parse + validate the per-request safe knobs (15 §5). Header wins over body; each knob can only
 *  constrain. Invalid → 422 invalid_request; a disallowed provider → 403 model_not_allowed. */
function parseKnobs(ctx: PipelineContext, body: Record<string, unknown>): SafeKnobs {
  // Session pin — header wins, else top-level body.session_id.
  const rawSession =
    header(ctx, 'x-spillway-session-id') ?? (body.session_id as string | undefined);
  let sessionId: string | null = null;
  if (rawSession !== undefined && rawSession !== null && rawSession !== '') {
    if (
      typeof rawSession !== 'string' ||
      rawSession.length > 256 ||
      !SESSION_ID_RE.test(rawSession)
    )
      throw new SpillwayError('invalid_request', 'invalid session id', {
        httpStatus: 422,
        details: { param: 'session_id' },
      });
    sessionId = rawSession;
  }

  // Capability hard-filter — header comma-list or body spillway.require_capabilities (string[]).
  // Bound the RAW list length BEFORE map/dedupe: a giant array of duplicate valid caps would dedupe
  // to a small passing set while .map(String) allocated a huge intermediate — the cardinality check
  // was bypassed by duplication (expanded-audit L2). KNOWN_CAPABILITIES.size is the natural ceiling.
  const MAX_RAW_CAPS = KNOWN_CAPABILITIES.size;
  const rejectCaps = (): never => {
    throw new SpillwayError('invalid_request', 'unknown or too many capabilities', {
      httpStatus: 422,
      details: { param: 'spillway.require_capabilities' },
    });
  };
  const capHeader = header(ctx, 'x-spillway-require-capabilities');
  const capBody = body['spillway.require_capabilities'];
  let requireCapabilities: string[] | null = null;
  let rawCaps: string[] | null = null;
  if (capHeader) {
    const parts = capHeader.split(',');
    if (parts.length > MAX_RAW_CAPS) rejectCaps();
    rawCaps = parts.map((c) => c.trim()).filter(Boolean);
  } else if (Array.isArray(capBody)) {
    if (capBody.length > MAX_RAW_CAPS) rejectCaps();
    rawCaps = (capBody as unknown[]).map(String);
  }
  if (rawCaps && rawCaps.length > 0) {
    const set = [...new Set(rawCaps)]; // treated as a SET (dedupe)
    if (set.length > KNOWN_CAPABILITIES.size || set.some((c) => !KNOWN_CAPABILITIES.has(c)))
      throw new SpillwayError('invalid_request', 'unknown or too many capabilities', {
        httpStatus: 422,
        details: { param: 'spillway.require_capabilities' },
      });
    requireCapabilities = set;
  }

  // Provider disambiguation — must be a real provider AND in the merged allow-list.
  const provRaw = header(ctx, 'x-spillway-provider');
  let provider: ProviderName | null = null;
  if (provRaw) {
    if (!PROVIDER_NAMES.has(provRaw as ProviderName))
      throw new SpillwayError('invalid_request', `unknown provider: ${provRaw}`, {
        httpStatus: 422,
        details: { param: 'x-spillway-provider' },
      });
    if (ctx.policy.allowedProviders && !ctx.policy.allowedProviders.includes(provRaw))
      throw new SpillwayError(
        'model_not_allowed',
        `provider ${provRaw} not permitted for this key`,
        {
          httpStatus: 403,
          details: { param: 'x-spillway-provider' },
        },
      );
    provider = provRaw as ProviderName;
  }

  return {
    sessionId,
    requireCapabilities,
    // 20 §6: opt in with `x-spillway-trace: on` (also `1` / `true`; case-insensitive), else off.
    traceEnabled: ['on', '1', 'true'].includes(
      (header(ctx, 'x-spillway-trace') ?? '').toLowerCase(),
    ),
    provider,
  };
}

/**
 * VALIDATE (02 §3 steps 1–2). Structural zod parse → reject streaming (Phase C) →
 * enforce the virtual key's model/provider allow-lists → input-size guard → clamp
 * max_tokens to the key ceiling (stashing the original for the reconcile audit).
 * Throws are caught by the route's try/catch → data-plane (OpenAI-shaped) error body.
 */
export function runValidate(ctx: PipelineContext): void {
  const parsed = ChatCompletionsRequest.safeParse(ctx.req.body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new SpillwayError('invalid_request', first?.message ?? 'invalid request body', {
      httpStatus: 400,
      details: { param: first?.path.join('.') ?? null },
    });
  }
  applyValidatedBody(ctx, parsed.data as Record<string, unknown>);
}

/** model allow-list (vk.allowed_models; NULL = all models permitted) — shared by every endpoint. */
function enforceModelAllowList(ctx: PipelineContext): void {
  const allowed = ctx.policy.allowedModels;
  if (allowed && !allowed.includes(ctx.requestedModel)) {
    throw new SpillwayError(
      'model_not_allowed',
      `model ${ctx.requestedModel} is not permitted for this key`,
      { httpStatus: 403, details: { param: 'model' } },
    );
  }
}

/**
 * VALIDATE for POST /v1/embeddings (task #9). Same governance head as chat — allow-list,
 * input-size guard, knobs, input estimate — minus everything output-shaped: embeddings has no
 * streaming, no sampling, no output tokens, so the output clamp would be meaningless. The guard
 * counts `input`, the only payload field.
 */
export function runValidateEmbeddings(ctx: PipelineContext): void {
  const parsed = EmbeddingsRequest.safeParse(ctx.req.body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new SpillwayError('invalid_request', first?.message ?? 'invalid request body', {
      httpStatus: 400,
      details: { param: first?.path.join('.') ?? null },
    });
  }
  const body = parsed.data as Record<string, unknown>;
  delete body.original_max_tokens; // never client-suppliable, same as chat

  ctx.stream = false; // no streaming semantics — keeps dispatch on the JSON path
  ctx.serviceTier = null;
  ctx.requestedModel = body.model as string;
  enforceModelAllowList(ctx);

  // ONE estimate feeds the size guard, TPM accounting, and the budget hold — the estimator counts
  // token-array inputs 1:1, so the guard can't be undercut by a shape the estimator prices higher.
  ctx.estimatedInputTokens = estimateInputTokens(body, ctx.requestedModel);
  if (ctx.policy.maxInputTokens !== null && ctx.estimatedInputTokens > ctx.policy.maxInputTokens) {
    throw new SpillwayError('request_too_large', 'request exceeds max input tokens for this key', {
      httpStatus: 400,
    });
  }

  ctx.validatedBody = body;
  ctx.knobs = parseKnobs(ctx, body);
  ctx.requestFeatures = {
    message_count: 0,
    has_tools: false,
    tool_count: 0,
    has_response_format: false,
    max_tokens: null,
    temperature: null,
    stream: false,
    n: 1,
    estimated_input_tokens: ctx.estimatedInputTokens,
  };
}

/**
 * The shape-agnostic tail of VALIDATE (allow-lists → input-size guard → output clamp → knobs →
 * features), operating on an OpenAI-CANONICAL body. `runValidate` feeds it a zod-parsed
 * /v1/chat/completions body; the /v1/messages route feeds it the canonical translation of an
 * Anthropic body (so one governance path covers both client shapes). Throws → route error body.
 */
export function applyValidatedBody(ctx: PipelineContext, body: Record<string, unknown>): void {
  // original_max_tokens is INTERNAL (set only by the clamp below). Strip any client-
  // supplied value so a caller can't poison the reconcile audit trail (red-team).
  delete body.original_max_tokens;

  // Phase C: streaming is supported. Record intent for the dispatch fork + requests.stream.
  // Every guard below (allow-lists, input-size, output clamp) applies UNCHANGED to streams —
  // streaming requests get the exact same governance.
  ctx.stream = body.stream === true;

  // service_tier (openai flex/priority/…) drives the pricing multiplier at RECONCILE. Capture the
  // request-time intent here; without this the multiplier in computeCost was dead (nothing set it).
  ctx.serviceTier = typeof body.service_tier === 'string' ? body.service_tier : null;

  ctx.requestedModel = body.model as string;
  enforceModelAllowList(ctx);
  // NOTE: the per-candidate `allowed_providers` gate is enforced in ROUTE (resolve.ts
  // assembleDefault/assembleVariant) against the RESOLVED provider — not here — because the
  // requested model's provider isn't known until routing. All four providers are now supported.

  // cheap input-size guard (chars/4 ≈ tokens) → 400 before we pay an upstream call.
  // MUST include system + tools: the adapter prepends top-level `system` and forwards
  // `tools`, so counting only `messages` let a huge system/tools blob bypass the cap (red-team).
  if (ctx.policy.maxInputTokens !== null) {
    const promptChars =
      JSON.stringify(body.messages ?? '').length +
      (typeof body.system === 'string' ? body.system.length : 0) +
      (body.tools ? JSON.stringify(body.tools).length : 0);
    const est = Math.ceil(promptChars / 4);
    if (est > ctx.policy.maxInputTokens) {
      throw new SpillwayError(
        'request_too_large',
        'request exceeds max input tokens for this key',
        {
          httpStatus: 400,
        },
      );
    }
  }

  // Clamp the EFFECTIVE output budget to the key ceiling. Three holes closed (red-team):
  //  - max_completion_tokens: the adapter maps it → max_tokens (max_tokens wins), so clamping
  //    ONLY max_tokens let a client cap-bypass via max_completion_tokens alone.
  //  - `n` completions MULTIPLY total output (n×max_tokens billed), so divide the ceiling by n
  //    to bound TOTAL output, not per-completion (ADR-032 H4).
  //  - an OMITTED max_tokens left the ceiling unenforced entirely (model default applied), so
  //    impose the ceiling even when the client sent no limit.
  if (ctx.policy.maxOutputTokens !== null) {
    const n = typeof body.n === 'number' && Number.isInteger(body.n) && body.n > 0 ? body.n : 1;
    const ceiling = Math.max(1, Math.floor(ctx.policy.maxOutputTokens / n));
    const requested =
      typeof body.max_tokens === 'number'
        ? body.max_tokens
        : typeof body.max_completion_tokens === 'number'
          ? body.max_completion_tokens
          : null;
    const effective = requested === null ? ceiling : Math.min(requested, ceiling);
    if (requested === null || requested !== effective) {
      if (requested !== null) body.original_max_tokens = requested; // record only a real clamp-down
      body.max_tokens = effective;
      delete body.max_completion_tokens; // adapter prefers max_tokens; drop the stale alias
    }
  }

  ctx.validatedBody = body;

  // Safe knobs (15 §5) + cheap input estimate (17 §3.1 budget check / 19 §6.2).
  ctx.knobs = parseKnobs(ctx, body);
  ctx.estimatedInputTokens = estimateInputTokens(body, ctx.requestedModel);

  // Structural request features (19 §6.2) — outcome/quality fields completed at RECONCILE.
  const tools = Array.isArray(body.tools) ? body.tools : null;
  ctx.requestFeatures = {
    message_count: Array.isArray(body.messages) ? body.messages.length : 0,
    has_tools: tools !== null && tools.length > 0,
    tool_count: tools ? tools.length : 0,
    has_response_format: body.response_format != null,
    max_tokens: typeof body.max_tokens === 'number' ? body.max_tokens : null,
    temperature: typeof body.temperature === 'number' ? body.temperature : null,
    stream: ctx.stream,
    n: typeof body.n === 'number' && Number.isInteger(body.n) && body.n > 0 ? body.n : 1,
    estimated_input_tokens: ctx.estimatedInputTokens,
  };
}
