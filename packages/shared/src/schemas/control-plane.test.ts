import { describe, it, expect } from 'vitest';
import {
  createProviderKeySchema,
  createOrgSchema,
  createTeamSchema,
  createVirtualKeySchema,
} from './control-plane.js';

describe('createProviderKeySchema', () => {
  const base = { provider: 'openai' as const, label: 'k', apiKey: 'sk-test123' };

  it('accepts a clean key', () => {
    expect(createProviderKeySchema.safeParse(base).success).toBe(true);
  });

  it('rejects an API key with CRLF / control chars (header-injection guard)', () => {
    expect(
      createProviderKeySchema.safeParse({ ...base, apiKey: 'sk-test\r\nX-Injected: 1' }).success,
    ).toBe(false);
    expect(createProviderKeySchema.safeParse({ ...base, apiKey: 'sk\tnull' }).success).toBe(false);
  });

  it('rejects custom upstream URLs until egress-safe compat dispatch exists', () => {
    expect(createProviderKeySchema.safeParse({ ...base, baseUrl: 'https://x.com' }).success).toBe(
      false,
    );
  });

  it('rejects providers without a shipped adapter', () => {
    expect(createProviderKeySchema.safeParse({ ...base, provider: 'anthropic' }).success).toBe(
      false,
    );
  });
});

// M48: C0 control characters in human-facing name fields must be rejected so they cannot forge
// log lines, inject email headers, or corrupt Slack alert templates.
describe('safeName — C0 control-char guard (M48)', () => {
  it('createOrgSchema accepts a clean name', () => {
    expect(createOrgSchema.safeParse({ name: 'Acme Corp', slug: 'acme-corp' }).success).toBe(true);
  });

  it.each([
    ['newline (LF)', 'Acme\nCorp'],
    ['carriage return (CR)', 'Acme\rCorp'],
    ['tab', 'Acme\tCorp'],
    ['NUL', 'Acme\x00Corp'],
    ['DEL (0x7f)', 'Acme\x7fCorp'],
    ['ESC (ANSI)', 'Acme\x1bCorp'],
  ])('createOrgSchema rejects name with %s', (_, name) => {
    expect(createOrgSchema.safeParse({ name, slug: 'acme' }).success).toBe(false);
  });

  it('createTeamSchema rejects name with control chars', () => {
    expect(createTeamSchema.safeParse({ name: 'Team\nA', slug: 'team-a' }).success).toBe(false);
  });

  it('createVirtualKeySchema rejects name with control chars', () => {
    expect(createVirtualKeySchema.safeParse({ name: 'key\x01name' }).success).toBe(false);
  });
});

// L48: virtual-key metadata — empty-string keys and over-limit size must be caught early.
describe('createVirtualKeySchema — metadata guards (L48)', () => {
  it('accepts valid metadata', () => {
    expect(createVirtualKeySchema.safeParse({ name: 'k', metadata: { env: 'prod' } }).success).toBe(
      true,
    );
  });

  it('rejects an empty-string metadata key', () => {
    expect(createVirtualKeySchema.safeParse({ name: 'k', metadata: { '': 'value' } }).success).toBe(
      false,
    );
  });

  it('rejects metadata with more than 20 entries', () => {
    const meta: Record<string, string> = {};
    for (let i = 0; i < 21; i++) meta[`k${i}`] = 'v';
    expect(createVirtualKeySchema.safeParse({ name: 'k', metadata: meta }).success).toBe(false);
  });

  it('accepts exactly 20 entries', () => {
    const meta: Record<string, string> = {};
    for (let i = 0; i < 20; i++) meta[`k${i}`] = 'v';
    expect(createVirtualKeySchema.safeParse({ name: 'k', metadata: meta }).success).toBe(true);
  });
});
