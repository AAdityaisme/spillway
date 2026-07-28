import { describe, it, expect } from 'vitest';
import { sanitizeMeta } from './audit.js';

describe('sanitizeMeta (red-team: recursive + value-based redaction)', () => {
  it('redacts secret-named keys at the top level', () => {
    expect(sanitizeMeta({ apiKey: 'x', token: 'y', name: 'ok' })).toEqual({
      apiKey: '[redacted]',
      token: '[redacted]',
      name: 'ok',
    });
  });

  it('redacts secret keys nested in objects and arrays', () => {
    expect(
      sanitizeMeta({ action: { secret: 'x', label: 'ok' }, list: [{ password: 'p' }] }),
    ).toEqual({
      action: { secret: '[redacted]', label: 'ok' },
      list: [{ password: '[redacted]' }],
    });
  });

  it('redacts value-form secrets even under innocuous key names', () => {
    expect(sanitizeMeta({ note: 'sk-proj-abcdefghijklmnop' }).note).toBe('[redacted]');
    expect(sanitizeMeta({ h: 'Bearer abcdef12345678' }).h).toBe('[redacted]');
    expect(sanitizeMeta({ k: 'mk-live-ABCDEFGHIJKLMNOP' }).k).toBe('[redacted]');
  });

  it('keeps ordinary values intact', () => {
    expect(sanitizeMeta({ role: 'admin', count: 5, ok: true })).toEqual({
      role: 'admin',
      count: 5,
      ok: true,
    });
  });

  it('is depth-bounded and never throws on deep nesting', () => {
    let deep: unknown = 'sk-proj-abcdefghijklmnop';
    for (let i = 0; i < 12; i++) deep = { nested: deep };
    expect(() => sanitizeMeta(deep as Record<string, unknown>)).not.toThrow();
  });
});
