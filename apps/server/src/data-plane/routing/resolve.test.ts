import { describe, it, expect } from 'vitest';
import {
  resolveRoute,
  resolveFallbackAlias,
  selectTypedFallback,
  reorderByHealth,
  RouteError,
  type RoutingPolicy,
  type RouteEnv,
  type SafeKnobs,
  type RouteResult,
} from './resolve.js';
import { ALLOW_OUTCOME } from '../policy/guardrail-types.js';
import {
  InMemoryProviderHealthStore,
  type CandidateKey,
  type HealthSnapshot,
} from '../health/store.js';
import type { Candidate } from './compile.js';

/**
 * Unit coverage for the ROUTE decision surface (expanded-audit L16 / M21). This is the RBAC +
 * tenant-isolation seam of the data plane (allowed_models / allowed_providers gating, budget
 * fallback fail-closed, typed-fallback selection) — it had ZERO tests, so a regression in any of
 * these access-control paths would ship green.
 */

const KEY_ID = 'pk-openai';
const ANTH_KEY_ID = 'pk-anthropic';

function policy(over: Partial<RoutingPolicy> = {}): RoutingPolicy {
  return {
    virtualKeyId: 'vk-1',
    orgId: 'org-1',
    teamId: null,
    allowedProviders: null,
    allowedModels: null,
    aliases: [],
    routingRules: [],
    providerKeys: [
      { id: KEY_ID, provider: 'openai', status: 'active' },
      { id: ANTH_KEY_ID, provider: 'anthropic', status: 'active' },
    ],
    ...over,
  };
}

const knobs: SafeKnobs = {
  sessionId: null,
  requireCapabilities: null,
  traceEnabled: false,
  provider: null,
};

const env: RouteEnv = { guardrailOutcome: ALLOW_OUTCOME, metadata: {} };
const NO_HEALTH: HealthSnapshot = new Map();
const NO_SPEND = new Map<string, bigint>();

function run(model: string, p: RoutingPolicy, health: HealthSnapshot = NO_HEALTH): RouteResult {
  return resolveRoute(model, p, NO_SPEND, health, knobs, env);
}

describe('resolveRoute — allowed_models / allowed_providers gating', () => {
  it('403 model_not_allowed when the requested model is off the allow-list', () => {
    const p = policy({ allowedModels: ['gpt-4o-mini'] });
    expect(() => run('gpt-4o', p)).toThrow(RouteError);
    try {
      run('gpt-4o', p);
    } catch (e) {
      expect((e as RouteError).code).toBe('model_not_allowed');
      expect((e as RouteError).status).toBe(403);
    }
  });

  it('serves an allow-listed model', () => {
    const p = policy({ allowedModels: ['gpt-4o'] });
    const r = run('gpt-4o', p);
    expect(r.chain[0]).toMatchObject({ provider: 'openai', model: 'gpt-4o' });
  });

  it('403 when the head provider is not in allowed_providers', () => {
    const p = policy({
      allowedProviders: ['anthropic'],
      aliases: [{ alias: 'x', targets: { default: [{ provider: 'openai', model: 'gpt-4o' }] } }],
    });
    try {
      run('x', p);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as RouteError).code).toBe('model_not_allowed');
      expect((e as RouteError).status).toBe(403);
    }
  });
});

describe('resolveRoute — health reorder (§4.11, never-drop)', () => {
  it('appends an OPEN candidate behind a closed one but never drops it', () => {
    const p = policy({
      aliases: [
        {
          alias: 'multi',
          targets: {
            default: [
              { provider: 'openai', model: 'gpt-4o' },
              { provider: 'anthropic', model: 'claude-3' },
            ],
          },
        },
      ],
    });
    const store = new InMemoryProviderHealthStore(() => 1000);
    for (let i = 0; i < 5; i++) store.recordFailure('openai:gpt-4o', 'server'); // open the head
    const health = store.snapshot(['openai:gpt-4o', 'anthropic:claude-3'] as CandidateKey[]);
    const r = run('multi', p, health);
    expect(r.chain.map((c) => c.model)).toEqual(['claude-3', 'gpt-4o']); // healthy first, open last
    expect(r.chain).toHaveLength(2); // never dropped
  });
});

describe('resolveFallbackAlias — budget on_exceed access control (expanded-audit M21)', () => {
  const p = policy({
    allowedModels: ['gpt-4o-mini'],
    aliases: [
      { alias: 'cheap', targets: { default: [{ provider: 'anthropic', model: 'claude-3-opus' }] } },
      { alias: 'ok', targets: { default: [{ provider: 'openai', model: 'gpt-4o-mini' }] } },
    ],
  });

  it('fails CLOSED to 402 when the fallback alias resolves to a model the vk is forbidden from', () => {
    try {
      resolveFallbackAlias('cheap', p, NO_HEALTH);
      throw new Error('expected a 402 — claude-3-opus is not in allowed_models');
    } catch (e) {
      expect(e).toBeInstanceOf(RouteError);
      expect((e as RouteError).code).toBe('budget_exceeded');
      expect((e as RouteError).status).toBe(402);
    }
  });

  it('serves a fallback alias whose model IS allow-listed', () => {
    const r = resolveFallbackAlias('ok', p, NO_HEALTH);
    expect(r.chain[0]).toMatchObject({ provider: 'openai', model: 'gpt-4o-mini' });
    expect(r.servedUnderBudgetFallback).toBe(true);
  });

  it('unrestricted vk (allowedModels null) still resolves any fallback alias', () => {
    const open = policy({
      aliases: [
        { alias: 'cheap', targets: { default: [{ provider: 'anthropic', model: 'claude-3' }] } },
      ],
    });
    const r = resolveFallbackAlias('cheap', open, NO_HEALTH);
    expect(r.chain[0]!.model).toBe('claude-3');
  });

  it('402 on a missing alias', () => {
    expect(() => resolveFallbackAlias('nope', p, NO_HEALTH)).toThrow(RouteError);
  });

  // §5.1: a budget fallback must not silently downgrade a require_capabilities request into an
  // incapable model (same bypass class as the allowed_models fail-closed above).
  it('fails CLOSED to 402 when the fallback model lacks a required capability', () => {
    const capPolicy = policy({
      aliases: [
        { alias: 'cheap', targets: { default: [{ provider: 'openai', model: 'gpt-4o-mini' }] } },
      ],
      capabilities: new Map([['openai:gpt-4o-mini', ['vision']]]), // no 'tools'
    });
    try {
      resolveFallbackAlias('cheap', capPolicy, NO_HEALTH, ['tools']);
      throw new Error('expected a 402 — the fallback model does not advertise tools');
    } catch (e) {
      expect(e).toBeInstanceOf(RouteError);
      expect((e as RouteError).code).toBe('budget_exceeded');
      expect((e as RouteError).status).toBe(402);
    }
  });

  it('serves the fallback when its model advertises the required capability', () => {
    const capPolicy = policy({
      aliases: [
        { alias: 'cheap', targets: { default: [{ provider: 'openai', model: 'gpt-4o-mini' }] } },
      ],
      capabilities: new Map([['openai:gpt-4o-mini', ['tools', 'vision']]]),
    });
    const r = resolveFallbackAlias('cheap', capPolicy, NO_HEALTH, ['tools']);
    expect(r.chain[0]).toMatchObject({ provider: 'openai', model: 'gpt-4o-mini' });
  });

  it('no capability filter (null) leaves the fallback path unchanged', () => {
    const r = resolveFallbackAlias('ok', p, NO_HEALTH, null);
    expect(r.chain[0]).toMatchObject({ provider: 'openai', model: 'gpt-4o-mini' });
  });
});

describe('selectTypedFallback (§7.1, expanded-audit L20 — single source of truth)', () => {
  const result: RouteResult = {
    chain: [
      { provider: 'openai', model: 'a', providerKeyId: KEY_ID },
      { provider: 'openai', model: 'b', providerKeyId: KEY_ID },
    ],
    typedFallbacks: {
      context_window: [{ provider: 'anthropic', model: 'big-ctx', providerKeyId: ANTH_KEY_ID }],
      content_policy: [],
    },
    requestedModel: 'a',
    routingRuleId: null,
    resolvedViaAlias: null,
    servedUnderBudgetFallback: false,
    sessionPinned: false,
    guardrailAnnotations: [],
  };

  it('a context_window error switches into the typed variant', () => {
    expect(selectTypedFallback(result, 'context_window').map((c) => c.model)).toEqual(['big-ctx']);
  });

  it('an EMPTY typed variant falls through to the default tail', () => {
    expect(selectTypedFallback(result, 'content_policy').map((c) => c.model)).toEqual(['b']);
  });

  it('a non-typed class walks the default tail', () => {
    expect(selectTypedFallback(result, 'server').map((c) => c.model)).toEqual(['b']);
  });
});

describe('reorderByHealth', () => {
  it('is a stable dispatchable-first partition', () => {
    const cands: Candidate[] = [
      { provider: 'openai', model: 'x', providerKeyId: KEY_ID },
      { provider: 'anthropic', model: 'y', providerKeyId: ANTH_KEY_ID },
    ];
    const store = new InMemoryProviderHealthStore(() => 1000);
    for (let i = 0; i < 5; i++) store.recordFailure('openai:x', 'server');
    const health = store.snapshot(['openai:x', 'anthropic:y'] as CandidateKey[]);
    expect(reorderByHealth(cands, health).map((c) => c.model)).toEqual(['y', 'x']);
  });
});

describe('resolveRoute — capability hard-filter (§5.1)', () => {
  const capsKnobs = (caps: string[]): SafeKnobs => ({ ...knobs, requireCapabilities: caps });

  it('fails OPEN when no capability catalog is loaded (best-effort, not a guaranteed 503)', () => {
    // policy.capabilities is undefined → without the catalog, hard-filtering would empty the pool and
    // 503 every require-capabilities request. Degrade to best-effort forwarding instead.
    const r = resolveRoute('gpt-4o', policy(), NO_SPEND, NO_HEALTH, capsKnobs(['tools']), env);
    expect(r.chain.length).toBeGreaterThan(0);
    expect(r.chain[0]).toMatchObject({ provider: 'openai', model: 'gpt-4o' });
  });

  it('applies the hard filter once the catalog carries entries', () => {
    const caps = new Map<string, readonly string[]>([['openai:gpt-4o', ['vision']]]);
    const p = policy({ capabilities: caps });
    // requires 'tools' but the model only advertises 'vision' → pool empties → 503 no_route_available
    try {
      resolveRoute('gpt-4o', p, NO_SPEND, NO_HEALTH, capsKnobs(['tools']), env);
      throw new Error('expected a RouteError');
    } catch (e) {
      expect(e).toBeInstanceOf(RouteError);
      expect((e as RouteError).code).toBe('no_route_available');
    }
    // requiring the advertised cap passes the filter
    const ok = resolveRoute('gpt-4o', p, NO_SPEND, NO_HEALTH, capsKnobs(['vision']), env);
    expect(ok.chain.length).toBeGreaterThan(0);
  });
});

describe('resolveRoute — sticky session pin (§4.5)', () => {
  const pinKnobs: SafeKnobs = { ...knobs, sessionId: 'sess-1' };
  const multiPolicy = policy({
    aliases: [
      {
        alias: 'multi',
        targets: {
          default: [
            { provider: 'openai', model: 'gpt-4o' },
            { provider: 'anthropic', model: 'claude-3' },
          ],
        },
      },
    ],
  });
  const envWith = (pin: unknown): RouteEnv => ({
    guardrailOutcome: ALLOW_OUTCOME,
    metadata: {},
    sessionPin: pin as RouteEnv['sessionPin'],
  });
  const claudePin = {
    candidate: { provider: 'anthropic', model: 'claude-3', providerKeyId: ANTH_KEY_ID },
    expiresAt: Number.MAX_SAFE_INTEGER,
  };

  it('pins the served candidate to the front of the chain when the pin is still routable', () => {
    const r = resolveRoute('multi', multiPolicy, NO_SPEND, NO_HEALTH, pinKnobs, envWith(claudePin));
    expect(r.sessionPinned).toBe(true);
    expect(r.chain[0]).toMatchObject({ provider: 'anthropic', model: 'claude-3' }); // not the default head
  });

  it('ignores a pin the key is no longer allowed to use (allow-list guard, never a loosener)', () => {
    // A sticky pin can only re-order within what the key may already use — it must never resurrect a
    // model the allow-list now forbids (§5: a knob can only constrain).
    const restricted = policy({
      allowedModels: ['multi', 'gpt-4o', 'claude-3'], // the requested alias + its resolved models
      aliases: multiPolicy.aliases,
    });
    const forbiddenPin = {
      candidate: { provider: 'gemini', model: 'gemini-x', providerKeyId: 'x' },
      expiresAt: Number.MAX_SAFE_INTEGER,
    };
    const r = resolveRoute(
      'multi',
      restricted,
      NO_SPEND,
      NO_HEALTH,
      pinKnobs,
      envWith(forbiddenPin),
    );
    expect(r.sessionPinned).toBe(false);
    expect(r.chain[0]).toMatchObject({ provider: 'openai', model: 'gpt-4o' }); // normal default head
  });

  it('applies no pin without a session id even if one is supplied', () => {
    const r = resolveRoute('multi', multiPolicy, NO_SPEND, NO_HEALTH, knobs, envWith(claudePin));
    expect(r.sessionPinned).toBe(false);
  });
});
