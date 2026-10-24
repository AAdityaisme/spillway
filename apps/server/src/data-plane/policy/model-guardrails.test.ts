import { describe, it, expect } from 'vitest';
import {
  isModelDependent,
  selectModelDependentPolicies,
  evaluateCandidateGuardrails,
} from './model-guardrails.js';
import type { ConditionRunner } from './guardrails.js';
import type { CompiledPolicy } from './guardrail-types.js';
import type { AttributeActivation, CompiledCondition } from './condition-evaluator.js';

/**
 * PASS-2 model-drift re-check (red-team P0). These pin the two halves of the fix:
 *   1. WHICH policies get re-evaluated — only the ones whose verdict can move when routing serves a
 *      different model. Re-running the rest would double-count the flag/allow_shadow decision-log
 *      rows PASS-1 already wrote from the same match.
 *   2. THAT a candidate the routing layer produced is judged on its OWN model/provider, so a deny
 *      scoped to the rewrite TARGET (or to a chain tail) is no longer invisible.
 */

const alwaysRun: ConditionRunner = { evalCondition: () => true };

const cond = (refs: string[]): CompiledCondition =>
  ({ source: 'x', program: new Uint8Array(), cost: 1, refs }) as CompiledCondition;

const pol = (
  o: Partial<CompiledPolicy> & Pick<CompiledPolicy, 'id' | 'effect'>,
): CompiledPolicy => ({
  name: o.id,
  reason: `reason-${o.id}`,
  enforcement: 'enforce',
  match: {},
  effectConfig: {},
  ...o,
});

/** The activation PASS-1 builds: model_resolved is the ALIAS HEAD, before the routing layer runs. */
const pass1: AttributeActivation = {
  identity: { org_id: 'o', virtual_key_id: 'vk', key_tags: [], team_id: 't1' },
  request: {
    model_requested: 'cheap',
    model_resolved: 'gpt-4o-mini',
    provider: 'openai',
    endpoint: 'chat_completions',
  },
  spend: {},
  time: {},
};

/** The activation PASS-2 rebuilds for a concrete post-routing candidate. */
const forCandidate = (model: string, provider = 'openai'): AttributeActivation => ({
  ...pass1,
  request: { ...pass1.request, model_resolved: model, provider },
});

describe('model-dependence classification (which policies PASS-2 re-runs)', () => {
  it('match.models / match.providers make a policy model-dependent', () => {
    expect(isModelDependent(pol({ id: 'a', effect: 'deny', match: { models: ['gpt-4o'] } }))).toBe(
      true,
    );
    expect(
      isModelDependent(pol({ id: 'b', effect: 'deny', match: { providers: ['anthropic'] } })),
    ).toBe(true);
  });

  it('a policy that cannot move with the served model is NOT re-run (no double-counted shadow rows)', () => {
    // Wildcard, endpoint-scoped, team-scoped, key-tag CEL: every one of these returns the same
    // verdict for every candidate, so re-running it would only duplicate PASS-1's accounting.
    expect(isModelDependent(pol({ id: 'w', effect: 'flag' }))).toBe(false);
    expect(
      isModelDependent(pol({ id: 'e', effect: 'deny', match: { endpoints: ['embeddings'] } })),
    ).toBe(false);
    expect(isModelDependent(pol({ id: 't', effect: 'deny', match: { team_ids: ['t1'] } }))).toBe(
      false,
    );
    expect(
      isModelDependent(
        pol({ id: 'c', effect: 'deny', condition: cond(['identity.key_tags', 'request.stream']) }),
      ),
    ).toBe(false);
  });

  it('request.model_requested alone is NOT model-dependent — it is the client string, invariant', () => {
    expect(
      isModelDependent(
        pol({ id: 'r', effect: 'deny', condition: cond(['request.model_requested']) }),
      ),
    ).toBe(false);
  });

  it('a CEL condition reading the served model, provider, or provider spend IS model-dependent', () => {
    expect(
      isModelDependent(
        pol({ id: 'm', effect: 'deny', condition: cond(['request.model_resolved']) }),
      ),
    ).toBe(true);
    expect(
      isModelDependent(pol({ id: 'p', effect: 'deny', condition: cond(['request.provider']) })),
    ).toBe(true);
    // The CEL spend.provider bucket is keyed off the HEAD PROVIDER actually served, so a candidate on
    // another provider reads a different bucket entirely.
    expect(
      isModelDependent(
        pol({ id: 's', effect: 'deny', condition: cond(['spend.provider.month.used_usd']) }),
      ),
    ).toBe(true);
    expect(
      isModelDependent(
        pol({ id: 'o', effect: 'deny', condition: cond(['spend.org.month.used_usd']) }),
      ),
    ).toBe(false);
  });

  it('selectModelDependentPolicies keeps only the re-runnable subset', () => {
    const all = [
      pol({ id: 'flag-all', effect: 'flag' }),
      pol({ id: 'deny-4o', effect: 'deny', match: { models: ['gpt-4o'] } }),
    ];
    expect(selectModelDependentPolicies(all).map((p) => p.id)).toEqual(['deny-4o']);
  });
});

describe('PASS-2 re-check against the model actually served (red-team P0)', () => {
  const denyGpt4o = pol({ id: 'deny-4o', effect: 'deny', match: { models: ['gpt-4o'] } });
  const subset = selectModelDependentPolicies([denyGpt4o]);

  it('rewrite_model onto a denied model: invisible to PASS-1, denied by PASS-2', () => {
    // PASS-1 sees model_requested='cheap', model_resolved='gpt-4o-mini' (the alias head) — the deny
    // does not match, so the request is admitted. A rewrite_model rule then makes gpt-4o the served
    // candidate. Before this fix nothing looked again and the denied model was dispatched and billed.
    expect(evaluateCandidateGuardrails(subset, pass1, alwaysRun)).toBeNull();

    const denial = evaluateCandidateGuardrails(subset, forCandidate('gpt-4o'), alwaysRun);
    expect(denial?.effect).toBe('deny');
    expect(denial?.policyId).toBe('deny-4o');
    expect(denial?.reason).toBe('reason-deny-4o');
  });

  it('a chain advance onto a denied model is denied while the head stays allowed', () => {
    // alias 'cheap' → [gpt-4o-mini, gpt-4o]: PASS-1 only ever judged the head, so dispatch could walk
    // onto gpt-4o after a retryable failure. Each candidate must now be judged on its own model.
    const chain = ['gpt-4o-mini', 'gpt-4o'];
    const verdicts = chain.map((m) =>
      evaluateCandidateGuardrails(subset, forCandidate(m), alwaysRun) === null ? 'allow' : 'deny',
    );
    expect(verdicts).toEqual(['allow', 'deny']);
  });

  it('a provider-scoped deny catches a cross-provider rewrite', () => {
    const denyAnthropic = pol({
      id: 'deny-anthropic',
      effect: 'deny',
      match: { providers: ['anthropic'] },
    });
    const s = selectModelDependentPolicies([denyAnthropic]);
    expect(
      evaluateCandidateGuardrails(s, forCandidate('gpt-4o-mini', 'openai'), alwaysRun),
    ).toBeNull();
    expect(
      evaluateCandidateGuardrails(s, forCandidate('claude-3-5-sonnet', 'anthropic'), alwaysRun)
        ?.policyId,
    ).toBe('deny-anthropic');
  });

  it('require_approval on the served model is terminal too, and deny still overrides it', () => {
    const approval = pol({
      id: 'a-approval',
      effect: 'require_approval',
      match: { models: ['gpt-4o'] },
    });
    expect(evaluateCandidateGuardrails([approval], forCandidate('gpt-4o'), alwaysRun)?.effect).toBe(
      'require_approval',
    );
    // deny-overrides survives into PASS-2 (evaluateGuardrails is reused unchanged).
    expect(
      evaluateCandidateGuardrails([approval, denyGpt4o], forCandidate('gpt-4o'), alwaysRun)?.effect,
    ).toBe('deny');
  });

  it('a SHADOW deny on the served model records but never blocks (§8 semantics preserved)', () => {
    const shadow = pol({
      id: 'shadow-4o',
      effect: 'deny',
      enforcement: 'shadow',
      match: { models: ['gpt-4o'] },
    });
    expect(evaluateCandidateGuardrails([shadow], forCandidate('gpt-4o'), alwaysRun)).toBeNull();
  });

  it('PASS-2 never emits flags — annotations stay PASS-1-owned so they are logged exactly once', () => {
    const flagOn4o = pol({ id: 'flag-4o', effect: 'flag', match: { models: ['gpt-4o'] } });
    // The flag matches the served candidate, but PASS-2 only enforces terminal effects: a null
    // verdict means the candidate dispatches and no second flag/decision-log row is produced.
    expect(evaluateCandidateGuardrails([flagOn4o], forCandidate('gpt-4o'), alwaysRun)).toBeNull();
  });

  it('an empty subset short-circuits to null (no policies → no re-check cost)', () => {
    expect(evaluateCandidateGuardrails([], forCandidate('gpt-4o'), alwaysRun)).toBeNull();
  });
});
