import { describe, it, expect } from 'vitest';
import {
  InMemoryProviderHealthStore,
  healthKindFor,
  parseRetryAfter,
  type CandidateKey,
} from './store.js';

const KEY: CandidateKey = 'openai:gpt-4o';
const state = (store: InMemoryProviderHealthStore, t: () => number) => {
  void t;
  return store.snapshot([KEY]).get(KEY)!.state;
};

describe('InMemoryProviderHealthStore circuit breaker (15 §6, B5.2)', () => {
  it('unknown candidate reads closed', () => {
    const s = new InMemoryProviderHealthStore(() => 0);
    expect(state(s, () => 0)).toBe('closed');
  });

  it('opens after 5 consecutive failures; 4 stays closed', () => {
    const t = 1000;
    const s = new InMemoryProviderHealthStore(() => t);
    for (let i = 0; i < 4; i++) s.recordFailure(KEY, 'server');
    expect(s.snapshot([KEY]).get(KEY)!.state).toBe('closed');
    s.recordFailure(KEY, 'server'); // 5th
    expect(s.snapshot([KEY]).get(KEY)!.state).toBe('open');
  });

  it('fires the state listener on open and on recovery (breaker metric hook)', () => {
    const events: Array<{ key: CandidateKey; open: boolean }> = [];
    const s = new InMemoryProviderHealthStore(
      () => 1000,
      (key, open) => events.push({ key, open }),
    );
    for (let i = 0; i < 4; i++) s.recordFailure(KEY, 'server');
    expect(events).toEqual([]); // still closed → no transition
    s.recordFailure(KEY, 'server'); // 5th → opens
    expect(events).toEqual([{ key: KEY, open: true }]);
    s.recordSuccess(KEY); // clears → open=false
    expect(events).toEqual([
      { key: KEY, open: true },
      { key: KEY, open: false },
    ]);
    s.recordSuccess(KEY); // already closed → no duplicate event
    expect(events).toHaveLength(2);
  });

  it('failures more than the window apart do not accumulate to open', () => {
    let t = 0;
    const s = new InMemoryProviderHealthStore(() => t);
    for (let i = 0; i < 4; i++) {
      s.recordFailure(KEY, 'server');
      t += 61_000; // > WINDOW_MS → window resets each time
    }
    expect(s.snapshot([KEY]).get(KEY)!.state).toBe('closed');
  });

  it('recordSuccess resets to closed', () => {
    const t = 1000;
    const s = new InMemoryProviderHealthStore(() => t);
    for (let i = 0; i < 5; i++) s.recordFailure(KEY, 'server');
    expect(s.snapshot([KEY]).get(KEY)!.state).toBe('open');
    s.recordSuccess(KEY);
    expect(s.snapshot([KEY]).get(KEY)!.state).toBe('closed');
  });

  it('open → half-open lazily after cooldown (30s base)', () => {
    let t = 1000;
    const s = new InMemoryProviderHealthStore(() => t);
    for (let i = 0; i < 5; i++) s.recordFailure(KEY, 'server');
    expect(s.snapshot([KEY]).get(KEY)!.state).toBe('open');
    t += 29_000;
    expect(s.snapshot([KEY]).get(KEY)!.state).toBe('open'); // still cooling
    t += 2_000; // now > 30s past open
    expect(s.snapshot([KEY]).get(KEY)!.state).toBe('half-open');
  });

  it('a failed half-open trial re-opens harsher (longer cooldown)', () => {
    let t = 1000;
    const s = new InMemoryProviderHealthStore(() => t);
    for (let i = 0; i < 5; i++) s.recordFailure(KEY, 'server'); // open, cooldown 30s
    t += 31_000; // half-open window
    s.recordFailure(KEY, 'server'); // failed trial → re-open, cooldown 60s (2×)
    expect(s.snapshot([KEY]).get(KEY)!.state).toBe('open');
    t += 31_000; // 31s < 60s → still open (harsher cooldown)
    expect(s.snapshot([KEY]).get(KEY)!.state).toBe('open');
    t += 30_000; // now > 60s
    expect(s.snapshot([KEY]).get(KEY)!.state).toBe('half-open');
  });

  it('an explicit retryAfterMs overrides the computed cooldown', () => {
    let t = 1000;
    const s = new InMemoryProviderHealthStore(() => t);
    for (let i = 0; i < 4; i++) s.recordFailure(KEY, 'rate_limit');
    s.recordFailure(KEY, 'rate_limit', 120_000); // 5th → open with a 120s Retry-After
    t += 60_000;
    expect(s.snapshot([KEY]).get(KEY)!.state).toBe('open'); // still cooling (120s)
    t += 61_000;
    expect(s.snapshot([KEY]).get(KEY)!.state).toBe('half-open');
  });

  it('clamps an absurd upstream retryAfterMs to the max cooldown (no multi-year breaker pin)', () => {
    let t = 1000;
    const s = new InMemoryProviderHealthStore(() => t);
    for (let i = 0; i < 4; i++) s.recordFailure(KEY, 'rate_limit');
    s.recordFailure(KEY, 'rate_limit', 999_999_999_000); // hostile Retry-After → ~31y pin if unclamped
    expect(s.snapshot([KEY]).get(KEY)!.state).toBe('open');
    t += 300_001; // MAX_COOLDOWN_MS (300s) + 1ms
    expect(s.snapshot([KEY]).get(KEY)!.state).toBe('half-open'); // clamped, not pinned open
  });

  // expanded-audit L18: a half-open probe returning a non-health error class (e.g. a content_policy
  // 400) proves the provider is reachable — recordReachable must clear the breaker so it can't sit
  // stored-open forever (one probe per request, never progressing).
  it('recordReachable clears a half-open breaker (non-health-class probe = reachable)', () => {
    let t = 1000;
    const s = new InMemoryProviderHealthStore(() => t);
    for (let i = 0; i < 5; i++) s.recordFailure(KEY, 'server'); // open
    t += 31_000; // → half-open
    expect(s.snapshot([KEY]).get(KEY)!.state).toBe('half-open');
    s.recordReachable(KEY); // provider responded with a non-fault class
    expect(s.snapshot([KEY]).get(KEY)!.state).toBe('closed');
  });

  it('recordReachable clears a stored-open breaker too', () => {
    const t = 1000;
    const s = new InMemoryProviderHealthStore(() => t);
    for (let i = 0; i < 5; i++) s.recordFailure(KEY, 'server'); // open
    expect(s.snapshot([KEY]).get(KEY)!.state).toBe('open');
    s.recordReachable(KEY);
    expect(s.snapshot([KEY]).get(KEY)!.state).toBe('closed');
  });

  it('recordReachable is a no-op on an already-closed candidate (never manufactures a record)', () => {
    const events: Array<{ open: boolean }> = [];
    const s = new InMemoryProviderHealthStore(
      () => 1000,
      (_k, open) => events.push({ open }),
    );
    s.recordReachable(KEY); // unknown/closed → nothing happens, no gauge event
    expect(events).toEqual([]);
    for (let i = 0; i < 3; i++) s.recordFailure(KEY, 'server'); // 3 fails, still closed
    s.recordReachable(KEY); // still closed → no reset, no event
    expect(s.snapshot([KEY]).get(KEY)!.consecutiveFailures).toBe(3);
    expect(events).toEqual([]);
  });
});

describe('healthKindFor (15 §6.6, B5.2)', () => {
  it('only rate_limit/server/timeout count; client/auth/typed/null do not', () => {
    expect(healthKindFor('rate_limit')).toBe('rate_limit');
    expect(healthKindFor('server')).toBe('server');
    expect(healthKindFor('timeout')).toBe('timeout');
    expect(healthKindFor('auth')).toBeNull();
    expect(healthKindFor('client')).toBeNull();
    expect(healthKindFor('context_window')).toBeNull();
    expect(healthKindFor('content_policy')).toBeNull();
    expect(healthKindFor(null)).toBeNull();
  });
});

describe('parseRetryAfter (15 §6.3, B5.2)', () => {
  it('parses delta-seconds, http-date, and null', () => {
    expect(parseRetryAfter(new Headers({ 'retry-after': '30' }))).toBe(30_000);
    expect(parseRetryAfter(new Headers({}))).toBeNull();
    const future = new Date(Date.now() + 10_000).toUTCString();
    const ms = parseRetryAfter(new Headers({ 'retry-after': future }));
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThan(0);
    expect(parseRetryAfter(new Headers({ 'retry-after': 'garbage' }))).toBeNull();
  });
});
