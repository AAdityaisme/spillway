import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Dispatcher } from 'undici';
import type { DatabaseClient } from '../../db/client.js';
import type { Encryptor } from '../../services/encryptor.js';
import type { Candidate, ParsedUsage } from '../providers/types.js';
import type { ProviderName } from '../routing/compile.js';
import type { RouteResult, SpendSnapshot } from '../routing/resolve.js';
import type { ConditionEvaluator } from '../policy/condition-evaluator.js';
import type { ConditionRunner } from '../policy/guardrails.js';
import type { GuardrailAnnotation } from '../policy/guardrail-types.js';
import type { ProviderHealthStore, HealthSnapshot } from '../health/store.js';
import type { SessionPinStore } from '../routing/session-pin.js';
import type { BurstTracker } from '../../services/alerts/burst.js';
import type { StreamTaskTracker } from '../streaming/task-tracker.js';
import type { PolicyBundle } from './auth.js';
import type { ModelPriceRow } from '@spillway/pricing';

/** The CEL evaluator singleton (plugin-instantiated): compiles policies at bundle-fill + runs them
 *  on the hot path (16 §5). Combines the authoring surface + the hot-path ConditionRunner. */
export type GuardrailEvaluator = ConditionEvaluator & ConditionRunner;

export type Endpoint = 'chat_completions' | 'messages' | 'embeddings';

/** The wire shape the CLIENT speaks. 'openai' = /v1/chat/completions; 'anthropic' = /v1/messages.
 *  Drives cross-format request/response translation (06 §2.3/§2.4b, providers/translate.ts). */
export type ClientShape = 'openai' | 'anthropic';

/** Per-request safe knobs (15 §5). Each only CONSTRAINS or is advisory — never loosens policy.
 *  Parsed + validated at VALIDATE into ctx.knobs; ROUTE consumes the validated struct. */
export interface SafeKnobs {
  sessionId: string | null; // §4.5 sticky pin
  requireCapabilities: string[] | null; // §5.1 capability hard-filter (default off)
  traceEnabled: boolean; // §5.2 opt-in routing trace
  provider: ProviderName | null; // §4.6 disambiguation for an ambiguous literal
}

/** Structural + outcome request features (19 §6.1, ADR-043). VALIDATE fills the structural subset
 *  onto ctx.requestFeatures (Partial); RECONCILE completes the outcome/quality fields + persists. */
export interface RequestFeatures {
  message_count: number;
  has_tools: boolean;
  tool_count: number;
  has_response_format: boolean;
  max_tokens: number | null;
  temperature: number | null;
  stream: boolean;
  n: number;
  estimated_input_tokens: number;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  q_fallback: boolean;
  q_provider_error: boolean;
  q_truncated: boolean;
}

/**
 * Dependencies captured by the plugin closure and threaded into every request's
 * context — replaces the bible's `req.server.db` / `req.server.encryptor` (which were
 * never decorated). Closure DI keeps the data-plane boundary clean + the stage
 * functions unit-testable without a Fastify instance.
 */
export interface DataPlaneDeps {
  db: DatabaseClient;
  encryptor: Encryptor;
  conditionEvaluator: GuardrailEvaluator; // CEL guardrail engine singleton (16 §5)
  healthStore: ProviderHealthStore; // cross-request circuit breaker (15 §6)
  sessionPinStore: SessionPinStore; // sticky session affinity (15 §4.5)
  burstTracker: BurstTracker; // in-process per-key RPM burst detector (19 §3.1)
  dispatcher?: Dispatcher; // test seam; undefined = global undici fetch
  streamTasks?: StreamTaskTracker; // Phase C: drains in-flight stream reconciles on shutdown
}

export interface TimingMarks {
  auth?: number;
  validate?: number;
  dispatchStart?: number;
  firstByte?: number; // streaming: ms to the first SSE byte written to the client → requests.ttft_ms
  responseEnd?: number;
}

/**
 * Per-request state, threaded through AUTH → VALIDATE → DISPATCH → RECONCILE. Fields
 * marked "set by X" are populated as the request advances; they are intentionally
 * non-optional (initialized via cast) so stage code reads them without `?` once their
 * stage has run — the pipeline order guarantees population.
 */
export interface PipelineContext {
  readonly requestId: string; // = req.id (uuid v4); becomes requests.id
  readonly startedAt: number;
  readonly req: FastifyRequest;
  readonly reply: FastifyReply;
  readonly endpoint: Endpoint;
  readonly clientShape: ClientShape; // set at context build (openai for /v1/chat/completions, anthropic for /v1/messages)
  readonly deps: DataPlaneDeps;
  readonly clientAbort: AbortController;

  policy: PolicyBundle; // set by AUTH
  validatedBody: Record<string, unknown>; // set by VALIDATE (post-clamp); ALWAYS OpenAI-canonical
  // The ORIGINAL client body when clientShape !== 'openai' (Anthropic Messages). DISPATCH sends this
  // verbatim (model-rewritten) when the served candidate is Anthropic → zero-fidelity pass-through
  // (06 §2.2b). null for OpenAI clients (validatedBody IS the native body).
  clientNativeBody: Record<string, unknown> | null;
  requestedModel: string; // set by VALIDATE
  knobs: SafeKnobs; // set by VALIDATE (15 §5)
  estimatedInputTokens: number; // set by VALIDATE (19 §6.2 / 17 §3.1 budget check)
  requestFeatures: Partial<RequestFeatures>; // structural at VALIDATE, completed at RECONCILE
  parallelAcquired: boolean; // set by RATELIMIT; released in the route finally (v2-code-seams §1)
  attemptNumber: number; // set by the dispatch chain executor (0 = primary); ledger key
  isFinalAttempt: boolean; // set by the dispatch chain executor (last attempt → aggregate)
  servedUnderBudgetFallback: boolean; // set by BUDGET when on_exceed=fallback serves a cheaper alias
  // Atomic budget hold placed by BUDGET before dispatch (expanded-audit H2). Released exactly once —
  // at reconcile, on a BUDGET block/fallback, or in the route finally (pre-dispatch failure).
  budgetReservation: {
    microUsd: bigint;
    rows: Array<{ scopeType: string; scopeId: string; periodKey: string }>;
  } | null;
  budgetReservationSettled: boolean;
  guardrailAnnotations: GuardrailAnnotation[]; // set by ROUTE (flag/require_approval) → x-spillway-guardrail-flags
  // §5.1 model-capability catalog, loaded ONLY when knobs.requireCapabilities is set — else null (the
  // no-filter path never queries it). Reused by BUDGET's fallback-alias resolution so a cheaper
  // fallback is capability-filtered on the same catalog.
  capabilityCatalog: ReadonlyMap<string, readonly string[]> | null;
  fallbackFrom: unknown[]; // budget/dispatch fallback markers (17 §4.7) → requests.fallback_from
  spendSnapshot: SpendSnapshot; // hoisted at ROUTE (17 §3.1); reused by BUDGET + guardrails
  healthSnapshot: HealthSnapshot; // snapshotted at ROUTE over the candidate keys (15 §6); executor reads it
  routeResult: RouteResult; // set by ROUTE (resolveRoute output)
  candidateChain: Candidate[]; // set by ROUTE (the working default chain, health-reordered)
  // Part III capability+residency admissibility predicate, built by ROUTE over the request's required
  // features and the key's compliance class. ROUTE applies it to the primary chain (via the two gates,
  // which keep distinct 400/503 codes) AND the typed-fallback variants; BUDGET's fallback path MUST
  // re-apply it so a substituted alias can't bypass either gate (red-team part-3 #1). Set unconditionally
  // by ROUTE before BUDGET runs.
  candidateAdmissible: (c: Candidate) => boolean;
  // Snapshotted before dispatch. Missing/partial pricing must never become $0 spend.
  priceByCandidate: ReadonlyMap<string, ModelPriceRow>;
  candidate: Candidate; // set by ROUTE (= candidateChain[0]); the dispatch executor advances it
  activeCandidate: Candidate; // set by DISPATCH on success
  upstreamResponse: Response; // set by DISPATCH
  upstreamStatus: number; // set by DISPATCH
  usage: ParsedUsage | null; // set by body capture (non-stream) or the SSE tee (stream)
  droppedParams: string[]; // set by transform → x-spillway-dropped-params
  errorCode: string | null; // set by DISPATCH on error paths → requests.error_code (why it failed)

  // set by VALIDATE from body.service_tier (openai 'flex'|'priority'|'default'|…). Feeds the pricing
  // service-tier multiplier at RECONCILE. null = standard rate. The APPLIED multiplier is snapshotted
  // on the row via unitPrices.service_tier_multiplier, so a settle retry re-derives the same cost.
  serviceTier: string | null;
  stream: boolean; // set by VALIDATE from body.stream; drives the dispatch fork + requests.stream
  // Streaming reconcile runs from TWO racing paths (normal stream-end AND the req.raw 'close'
  // client-abort listener, which also fires on normal completion). This check-and-set boolean
  // ensures exactly one reconcile — without it the second write hits the requests PK and rolls
  // back the whole tx → silent spend loss (ADR-032 H1 class). Single-threaded → race-free.
  reconcileStarted: boolean;
  // True once runSseTee called reply.hijack(): the response is committed via reply.raw, so the
  // route's error boundary must treat the reply as sent (reply.sent stays false after hijack).
  hijacked: boolean;

  timings: TimingMarks;
}

export function buildPipelineContext(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: DataPlaneDeps,
  opts: { endpoint?: Endpoint; clientShape?: ClientShape } = {},
): PipelineContext {
  return {
    requestId: req.id,
    startedAt: Date.now(),
    req,
    reply,
    deps,
    endpoint: opts.endpoint ?? 'chat_completions',
    clientShape: opts.clientShape ?? 'openai',
    clientAbort: new AbortController(),
    policy: undefined as unknown as PolicyBundle,
    validatedBody: {},
    clientNativeBody: null,
    requestedModel: '',
    knobs: { sessionId: null, requireCapabilities: null, traceEnabled: false, provider: null },
    estimatedInputTokens: 0,
    requestFeatures: {},
    parallelAcquired: false,
    attemptNumber: 0,
    isFinalAttempt: true, // single attempt = final; B5's chain executor sets false for non-final attempts
    servedUnderBudgetFallback: false,
    budgetReservation: null,
    budgetReservationSettled: false,
    guardrailAnnotations: [],
    capabilityCatalog: null,
    fallbackFrom: [],
    spendSnapshot: new Map(),
    healthSnapshot: new Map(),
    routeResult: undefined as unknown as RouteResult,
    candidateChain: [],
    candidateAdmissible: undefined as unknown as (c: Candidate) => boolean, // set by ROUTE before BUDGET reads it
    priceByCandidate: new Map(),
    candidate: undefined as unknown as Candidate,
    activeCandidate: undefined as unknown as Candidate,
    upstreamResponse: undefined as unknown as Response,
    upstreamStatus: 0,
    usage: null,
    droppedParams: [],
    errorCode: null,
    serviceTier: null,
    stream: false,
    reconcileStarted: false,
    hijacked: false,
    timings: {},
  };
}

export function markStage(ctx: PipelineContext, stage: keyof TimingMarks): void {
  ctx.timings[stage] = Date.now() - ctx.startedAt;
}
