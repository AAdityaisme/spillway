/**
 * Bill-on-failure classifier (17 §4.5, ADR-035; PENDING-2 RESOLVED → bill provider-consumed tokens).
 * Ported verbatim from the red-teamed lab — pure. "Bill provider-consumed tokens; skip only when
 * nothing reached the model." A classification, not an all-or-nothing switch (Bifrost tracker.go).
 */

export type FailureClass =
  | 'pre_generation'
  | 'post_generation_error'
  | 'client_disconnect_non_stream'
  | 'client_disconnect_mid_stream';

export interface BillDecision {
  failureClass: FailureClass;
  outcome: 'error' | 'client_closed'; // pre-gen + upstream errors → error; client aborts → client_closed
  billed: boolean; // false ⇒ nothing reached the model ⇒ $0, attempt row only, NO counter bump
  inputTokens: number;
  outputTokens: number;
  usageEstimated: boolean;
}

/** Upstream statuses where nothing was generated (pre-generation) → $0. */
export function isPreGenerationStatus(status: number): boolean {
  return (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 413 ||
    status === 422 ||
    status === 429
  );
}

export type FailureInput =
  | {
      kind: 'upstream_error';
      reachedModel: boolean; // authoritative discriminator (§4.5 col 2)
      inputTokens: number;
      recoveredOutputTokens: number;
    }
  | { kind: 'client_disconnect'; stream: false; inputTokens: number; reachedModel: boolean }
  | {
      kind: 'client_disconnect';
      stream: true;
      parsedInputTokens: number;
      parsedOutputTokens: number;
      cleanDone: boolean;
    };

export function classifyFailure(f: FailureInput): BillDecision {
  if (f.kind === 'upstream_error') {
    if (!f.reachedModel) {
      return {
        failureClass: 'pre_generation',
        outcome: 'error',
        billed: false,
        inputTokens: 0,
        outputTokens: 0,
        usageEstimated: false,
      };
    }
    return {
      failureClass: 'post_generation_error',
      outcome: 'error',
      billed: true,
      inputTokens: f.inputTokens,
      outputTokens: f.recoveredOutputTokens,
      usageEstimated: true,
    };
  }

  if (!f.stream) {
    // A disconnect BEFORE the request reached the provider generated nothing → $0, attempt row only,
    // no counter bump (red-team: don't bill the input floor for a pre-dispatch abort). §4.5.
    if (!f.reachedModel) {
      return {
        failureClass: 'pre_generation',
        outcome: 'client_closed',
        billed: false,
        inputTokens: 0,
        outputTokens: 0,
        usageEstimated: false,
      };
    }
    return {
      failureClass: 'client_disconnect_non_stream',
      outcome: 'client_closed',
      billed: true,
      inputTokens: f.inputTokens,
      outputTokens: 0,
      usageEstimated: true,
    };
  }

  return {
    failureClass: 'client_disconnect_mid_stream',
    outcome: 'client_closed',
    billed: true,
    inputTokens: f.parsedInputTokens,
    outputTokens: f.parsedOutputTokens,
    usageEstimated: !f.cleanDone,
  };
}
