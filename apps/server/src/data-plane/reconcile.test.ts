import { describe, it, expect } from 'vitest';
import { extractMetadata } from './reconcile.js';
import type { PipelineContext } from './pipeline/context.js';

const mkCtx = (headers: Record<string, unknown>, body: Record<string, unknown>): PipelineContext =>
  ({ req: { headers }, validatedBody: body }) as unknown as PipelineContext;

describe('extractMetadata', () => {
  it('caps at 16 own keys and is NOT bypassable via prototype property names (red-team M2)', () => {
    const meta: Record<string, string> = {};
    for (let i = 0; i < 16; i++) meta['k' + i] = 'v';
    // inherited names that `key in {}` would resolve to true — must not slip past the cap
    for (const proto of ['toString', 'constructor', 'hasOwnProperty', 'valueOf', 'isPrototypeOf'])
      meta[proto] = 'x';
    const out = extractMetadata(mkCtx({}, { metadata: meta }));
    expect(Object.keys(out).length).toBeLessThanOrEqual(16);
  });

  it('does not pollute Object.prototype via a __proto__ tag key; captures it as a plain own key', () => {
    extractMetadata(mkCtx({ 'x-spillway-tags': '{"__proto__":"pwned","a":"b"}' }, {}));
    expect(({} as Record<string, unknown>).pwned).toBeUndefined();
    const out = extractMetadata(mkCtx({ 'x-spillway-tags': '{"__proto__":"x"}' }, {}));
    expect(Object.hasOwn(out, '__proto__')).toBe(true);
  });

  it('body.metadata wins over x-spillway-tags on collision; both sources merge', () => {
    const out = extractMetadata(
      mkCtx(
        { 'x-spillway-tags': JSON.stringify({ team: 'header', h2: 'y' }) },
        {
          metadata: { team: 'body' },
        },
      ),
    );
    expect(out.team).toBe('body');
    expect(out.h2).toBe('y');
  });

  it('truncates values to 256 chars and ignores a malformed tags header', () => {
    const out = extractMetadata(
      mkCtx(
        { 'x-spillway-tags': 'not json' },
        {
          metadata: { big: 'z'.repeat(1000) },
        },
      ),
    );
    expect((out.big ?? '').length).toBe(256);
  });
});
