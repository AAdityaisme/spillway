/**
 * Static authoring-time bounds for CEL guardrail conditions (16 §5.3, ADR-034). Ported verbatim.
 * Node can't preempt a running expression, so the ONLY hard latency guarantee is the authoring-time
 * static-cost bound. A condition that passes is proven loop-free + small; the request path never
 * re-validates (16 §5.4). (Kubernetes-VAP pattern.)
 */

export const MAX_COST = 200; // max static cost units → cel_cost_exceeded
export const MAX_NODES = 64; // max AST node count → cel_ast_too_large
export const MAX_REGEX_LEN = 128; // max matches() regex literal length → cel_regex_too_long

/** Comprehension macros are the only unbounded-work CEL constructs — banned. has() is the only
 *  permitted macro (it expands to a test-only field select, not a comprehension). */
export const BANNED_MACROS = ['map', 'filter', 'all', 'exists', 'exists_one'] as const;

export type CelErrorCode =
  | 'cel_parse_error'
  | 'cel_type_error'
  | 'cel_cost_exceeded'
  | 'cel_ast_too_large'
  | 'cel_banned_macro'
  | 'cel_regex_too_long';

/** Thrown by compile() on any authoring-time violation — the "NO program persisted" guarantee. */
export class CelCompileError extends Error {
  readonly code: CelErrorCode;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(code: CelErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CelCompileError';
    this.code = code;
    this.details = details;
  }
}
