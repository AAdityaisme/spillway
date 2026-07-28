import { describe, it, expect } from 'vitest';
import { maskDecisionInput } from './decision-log.js';

/**
 * maskDecisionInput redaction (16 §6.4). expanded-audit M7 (coverage gap on the redaction path) +
 * M9 (identity.actor / identity.key_tags values were logged unmasked — a bearer token stuffed into
 * metadata.actor leaked into decision_logs).
 */
describe('maskDecisionInput — redaction (16 §6.4, M7/M9)', () => {
  it('redacts sensitive request.metadata.* paths (key/secret/token/password/bearer/credential)', () => {
    const out = maskDecisionInput({
      'request.metadata.api_key': 'sk-abc',
      'request.metadata.session_token': 't-1',
      'request.metadata.user_password': 'p',
      'request.metadata.bearer': 'b',
      'request.metadata.credential_id': 'c',
    });
    expect(out['request.metadata.api_key']).toBe('[REDACTED]');
    expect(out['request.metadata.session_token']).toBe('[REDACTED]');
    expect(out['request.metadata.user_password']).toBe('[REDACTED]');
    expect(out['request.metadata.bearer']).toBe('[REDACTED]');
    expect(out['request.metadata.credential_id']).toBe('[REDACTED]');
  });

  it('passes non-sensitive metadata + non-metadata paths through untouched', () => {
    const out = maskDecisionInput({
      'request.metadata.env': 'prod',
      'identity.org_id': 'org-1',
      'request.model_requested': 'gpt-4o',
      'spend.org.month.used_usd': '1.500000',
    });
    expect(out['request.metadata.env']).toBe('prod');
    expect(out['identity.org_id']).toBe('org-1');
    expect(out['request.model_requested']).toBe('gpt-4o');
    expect(out['spend.org.month.used_usd']).toBe('1.500000');
  });

  it('redacts a secret embedded in identity.actor value (M9 — value scan, not just path)', () => {
    const out = maskDecisionInput({
      'identity.actor': 'Bearer sk-live-deadbeef',
    });
    expect(out['identity.actor']).toBe('[REDACTED]');
  });

  it('leaves a plain identity.actor untouched', () => {
    const out = maskDecisionInput({ 'identity.actor': 'alice@example.com' });
    expect(out['identity.actor']).toBe('alice@example.com');
  });

  it('redacts only the secret-looking entries in identity.key_tags (array value scan)', () => {
    const out = maskDecisionInput({
      'identity.key_tags': ['team:eng', 'token=sk-secret', 'env:prod'],
    });
    expect(out['identity.key_tags']).toEqual(['team:eng', '[REDACTED]', 'env:prod']);
  });

  it('returns a NEW object (does not mutate the input snapshot)', () => {
    const input = { 'request.metadata.token': 'x' };
    const out = maskDecisionInput(input);
    expect(out).not.toBe(input);
    expect(input['request.metadata.token']).toBe('x'); // original untouched
  });
});
