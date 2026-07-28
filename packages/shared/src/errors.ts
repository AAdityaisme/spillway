/**
 * Spillway error taxonomy (02-architecture §6).
 *
 * The data plane returns provider-shaped error JSON (OpenAI shape on
 * /v1/chat/completions, Anthropic shape on /v1/messages) so client SDKs behave;
 * Spillway-originated errors additionally carry `"type": "spillway_error"`, a
 * stable `code`, and a docs URL. The control plane returns RFC 7807-ish
 * `{ error: { code, message, details } }`.
 *
 * M0 scaffolds the class + code union + control-plane body helper. The exact
 * provider-shaped bodies (e.g. `budget402Body`) are completed in M1/M2 against
 * 04-api-contracts §1 and 05-gateway-core; their unit tests live in
 * packages/shared/src/errors.test.ts and apps/server/src/data-plane/**.
 */

/** Stable, documented Spillway error codes (02 §6; extended in 04/05). */
export type SpillwayErrorCode =
  | 'budget_exceeded'
  | 'rate_limited'
  | 'model_not_allowed'
  | 'key_not_found'
  | 'key_revoked'
  | 'key_paused'
  | 'rule_deny'
  | 'all_providers_failed'
  | 'upstream_error'
  | 'invalid_request'
  | 'internal_error'
  // control plane (M1)
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'validation_error'
  | 'org_required'
  | 'last_owner'
  | 'key_expired'
  // data plane (M2)
  | 'service_unavailable'
  | 'no_candidates'
  | 'unsupported_feature' // Part III adapter-contract §3: routed model's declared caps lack a required request feature (400, client-class, never retried)
  | 'provider_key_decrypt_failed'
  | 'provider_unavailable' // upstream timed out / refused the connection (504/502 at the gateway)
  | 'upstream_parse_error'
  | 'request_too_large'
  | 'model_not_found'
  // governance data plane (M3 Part II)
  | 'no_route_available' // ADR-042: hard-filter left no dispatchable candidate (503, fail-closed)
  | 'approval_required' // ADR-034/16 §3.4: a require_approval guardrail matched (403 + approval opened)
  | 'all_providers_failed' // 15 §7: every candidate in the chain failed (502)
  // governance control plane (M3 Part II CRUD — B6)
  | 'tier_required' // ADR-039/018: the org's plan lacks the entitlement for this feature (402)
  | 'plan_upgrade_required' // alias of tier_required for quota/limit gates (402)
  | 'cel_parse_error' // 16 §5.2 authoring-time CEL failures (422)
  | 'cel_type_error'
  | 'cel_cost_exceeded'
  | 'cel_ast_too_large'
  | 'cel_banned_macro'
  | 'cel_regex_too_long'
  | 'approval_chain_unsatisfiable' // 18 §2.1: a chain no set of approvers can satisfy (422)
  | 'not_pending' // 18 §2.8: a decision on an approval that is not pending (409)
  | 'self_approval_not_allowed' // 18 §2.9: the requester cannot approve their own request (403)
  | 'not_an_approver' // 18 §2.8: voter not in the current step's frozen approver set (403)
  | 'unknown_effect' // 18 §3.4: an automation/approval effect type with no registered handler (422)
  | 'invalid_action_token' // 18 §6: a tampered / expired / wrong-secret signed action token (401)
  | 'threshold_condition_not_isolated'; // 19: an anomaly alert threshold not isolated (422)

const DOCS_BASE = 'https://docs.spillway.dev/errors';

export interface SpillwayErrorOptions {
  /** HTTP status to return (e.g. 402 for budget_exceeded). */
  httpStatus: number;
  /** Structured, non-sensitive detail for the control-plane body. */
  details?: Record<string, unknown>;
  /** Underlying cause, never serialized into a response. */
  cause?: unknown;
}

/** A Spillway-originated error. Never carries prompt/completion bodies (ADR-013). */
export class SpillwayError extends Error {
  readonly type = 'spillway_error' as const;
  readonly code: SpillwayErrorCode;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;
  readonly docsUrl: string;

  constructor(code: SpillwayErrorCode, message: string, opts: SpillwayErrorOptions) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'SpillwayError';
    this.code = code;
    this.httpStatus = opts.httpStatus;
    this.details = opts.details;
    this.docsUrl = `${DOCS_BASE}/${code}`;
  }
}

export interface ControlPlaneErrorBody {
  error: {
    code: SpillwayErrorCode;
    message: string;
    docs_url: string;
    details?: Record<string, unknown>;
  };
}

/** RFC 7807-ish control-plane error body (`/api/*`). */
export function controlPlaneErrorBody(err: SpillwayError): ControlPlaneErrorBody {
  return {
    error: {
      code: err.code,
      message: err.message,
      docs_url: err.docsUrl,
      ...(err.details ? { details: err.details } : {}),
    },
  };
}

/** OpenAI-shaped error body for the data plane (`/v1/*`) so client SDKs parse it (02 §6). */
export interface OpenAIErrorBody {
  error: { message: string; type: 'spillway_error'; param: string | null; code: SpillwayErrorCode };
}

export function openaiErrorBody(err: SpillwayError): OpenAIErrorBody {
  return {
    error: {
      message: err.message,
      type: 'spillway_error',
      param: typeof err.details?.param === 'string' ? err.details.param : null,
      code: err.code,
    },
  };
}

/**
 * `retry-after` header for a 429 (v2-code-seams Finding 8 — openaiErrorBody carries no header).
 * Reads `retry_after` (seconds) from a rate_limited SpillwayError's details; defaults to 1s.
 */
export function rateLimitHeaders(err: SpillwayError): Record<string, string> {
  const ra = err.details?.retry_after;
  const sec = typeof ra === 'number' && ra > 0 ? Math.ceil(ra) : 1;
  // 17 §2.4 / COMPAT N-4: the 429 carries x-spillway-block-reason too, matching the 402/403 blocks.
  return { 'retry-after': String(sec), 'x-spillway-block-reason': 'rate_limited' };
}

/** `x-spillway-block-*` headers for a 402 budget block (17 §2.4). Reads the block detail off a
 *  budget_exceeded SpillwayError's details; omits any field that is absent. */
export function budgetBlockHeaders(err: SpillwayError): Record<string, string> {
  const d = err.details ?? {};
  const out: Record<string, string> = {};
  const put = (h: string, v: unknown): void => {
    if (typeof v === 'string' && v.length > 0) out[h] = v;
  };
  put('x-spillway-block-scope-type', d.scope_type);
  put('x-spillway-block-scope-id', d.scope_id);
  put('x-spillway-block-period', d.period);
  put('x-spillway-block-spent-usd', d.spent_usd);
  put('x-spillway-block-limit-usd', d.limit_usd);
  return out;
}

/**
 * The canonical data-plane BLOCK-body envelope (16 §3.3 / 17 §2.4, COMPAT N-3): OpenAI-parseable core
 * (message/type/code/param) + a nested `error.spillway` extension where `block_reason === code`. Used
 * for every block (rule_deny / approval_required / budget_exceeded) — the flat openaiErrorBody drops
 * `details`, so blocks are shaped past it.
 */
export interface BlockBody {
  error: {
    message: string;
    type: 'spillway_error';
    code: SpillwayErrorCode;
    param: null;
    spillway: Record<string, unknown>;
  };
}

export function blockBody(err: SpillwayError, spillway: Record<string, unknown> = {}): BlockBody {
  return {
    error: {
      message: err.message,
      type: 'spillway_error',
      code: err.code,
      param: null,
      spillway: { block_reason: err.code, ...spillway },
    },
  };
}

/** 403 guardrail-deny body (16 §3.3): nested envelope with the deciding policy + decision id. */
export function policyDenyBody(err: SpillwayError): BlockBody {
  const d = err.details ?? {};
  return blockBody(err, { policy_id: d.policy_id ?? null, decision_id: d.decision_id ?? null });
}

/** 403 require-approval body (16 §3.4): nested envelope with policy + opened approval request id. */
export function approvalRequiredBody(err: SpillwayError): BlockBody {
  const d = err.details ?? {};
  return blockBody(err, {
    policy_id: d.policy_id ?? null,
    decision_id: d.decision_id ?? null,
    approval_request_id: d.approval_request_id ?? null,
  });
}

/** 402 budget-block body (17 §2.4): nested envelope with the block scope/period/spend/limit. */
export function budget402Body(err: SpillwayError): BlockBody {
  const d = err.details ?? {};
  return blockBody(err, {
    scope_type: d.scope_type ?? null,
    scope_id: d.scope_id ?? null,
    period: d.period ?? null,
    period_key: d.period_key ?? null,
    spent_usd: d.spent_usd ?? null,
    limit_usd: d.limit_usd ?? null,
  });
}

/** 429 rate-limit body (17 §2.4 / COMPAT N-4): the SAME canonical nested envelope as 402/403 — not the
 *  flat generic body — so a client detecting `error.spillway` parses every block uniformly. */
export function rateLimit429Body(err: SpillwayError): BlockBody {
  const ra = err.details?.retry_after;
  const sec = typeof ra === 'number' && ra > 0 ? Math.ceil(ra) : 1;
  return blockBody(err, { retry_after: sec });
}

/** `x-spillway-*` headers for a guardrail deny/approval 403 (16 §3.3/§3.4). */
export function guardrailBlockHeaders(err: SpillwayError): Record<string, string> {
  const d = err.details ?? {};
  const out: Record<string, string> = { 'x-spillway-block-reason': err.code };
  const put = (h: string, v: unknown): void => {
    if (typeof v === 'string' && v.length > 0) out[h] = v;
  };
  put('x-spillway-policy-id', d.policy_id);
  put('x-spillway-decision-id', d.decision_id);
  put('x-spillway-approval-request-id', d.approval_request_id);
  return out;
}
