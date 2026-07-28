import { describe, it, expect } from 'vitest';
import { classifyFailure, isPreGenerationStatus } from './bill-on-failure.js';

describe('bill-on-failure classifier (17 §4.5, B3.1)', () => {
  it('flags pre-generation statuses', () => {
    for (const s of [400, 401, 403, 413, 422, 429]) expect(isPreGenerationStatus(s)).toBe(true);
    for (const s of [200, 500, 502, 504]) expect(isPreGenerationStatus(s)).toBe(false);
  });

  it('pre-generation upstream error → $0, no bill, outcome error', () => {
    const d = classifyFailure({
      kind: 'upstream_error',
      reachedModel: false,
      inputTokens: 999,
      recoveredOutputTokens: 5,
    });
    expect(d).toMatchObject({ billed: false, outcome: 'error', inputTokens: 0, outputTokens: 0 });
  });

  it('post-generation upstream error → bill input floor + recovered output, estimated', () => {
    const d = classifyFailure({
      kind: 'upstream_error',
      reachedModel: true,
      inputTokens: 1000,
      recoveredOutputTokens: 30,
    });
    expect(d).toMatchObject({
      billed: true,
      outcome: 'error',
      inputTokens: 1000,
      outputTokens: 30,
      usageEstimated: true,
    });
  });

  it('non-stream client disconnect that REACHED the model → bill input floor, output 0, estimated', () => {
    const d = classifyFailure({
      kind: 'client_disconnect',
      stream: false,
      inputTokens: 1200,
      reachedModel: true,
    });
    expect(d).toMatchObject({
      billed: true,
      outcome: 'client_closed',
      inputTokens: 1200,
      outputTokens: 0,
      usageEstimated: true,
    });
  });

  it('non-stream client disconnect PRE-dispatch (never reached the model) → $0, not billed (red-team)', () => {
    const d = classifyFailure({
      kind: 'client_disconnect',
      stream: false,
      inputTokens: 1200,
      reachedModel: false,
    });
    expect(d).toMatchObject({
      billed: false,
      outcome: 'client_closed',
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('mid-stream client disconnect → bill parsed; estimated iff not a clean [DONE]', () => {
    const torn = classifyFailure({
      kind: 'client_disconnect',
      stream: true,
      parsedInputTokens: 100,
      parsedOutputTokens: 40,
      cleanDone: false,
    });
    expect(torn).toMatchObject({ billed: true, outcome: 'client_closed', usageEstimated: true });
    const clean = classifyFailure({
      kind: 'client_disconnect',
      stream: true,
      parsedInputTokens: 100,
      parsedOutputTokens: 40,
      cleanDone: true,
    });
    expect(clean.usageEstimated).toBe(false);
  });
});
