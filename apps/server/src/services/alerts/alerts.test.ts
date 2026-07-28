import { describe, it, expect } from 'vitest';
import { signActionToken, verifyActionToken, type ActionTokenPayload } from './action-token.js';
import { bandsCrossed, thresholdSeverity, budgetThresholdDedupeKey } from './threshold.js';
import { defaultSeverityForKind } from '../alert-kinds.js';

const usd = (n: number): bigint => BigInt(Math.round(n * 1_000_000));
const SECRET = 'test-signing-secret';
const base: ActionTokenPayload = {
  action: 'pause_key',
  orgId: 'org-1',
  refId: 'vk-1',
  exp: 2_000_000_000_000,
};

describe('signed action tokens (§18 §6)', () => {
  it('round-trips a valid token', () => {
    const t = signActionToken(base, SECRET);
    expect(verifyActionToken(t, SECRET)).toMatchObject({ action: 'pause_key', refId: 'vk-1' });
  });

  it('rejects a tampered payload (signature mismatch)', () => {
    const t = signActionToken(base, SECRET);
    const [p, s] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ ...base, refId: 'vk-EVIL' })).toString('base64url');
    expect(() => verifyActionToken(`${forged}.${s}`, SECRET)).toThrow(/action token/i);
    expect(() => verifyActionToken(`${p}.deadbeef`, SECRET)).toThrow(/action token/i);
  });

  it('rejects a token signed with a different secret', () => {
    expect(() => verifyActionToken(signActionToken(base, 'other'), SECRET)).toThrow(
      /action token/i,
    );
  });

  it('rejects an expired token', () => {
    const t = signActionToken({ ...base, exp: 1_000 }, SECRET);
    expect(() => verifyActionToken(t, SECRET, 2_000)).toThrow(/action token/i);
  });

  it('rejects a malformed token', () => {
    expect(() => verifyActionToken('garbage', SECRET)).toThrow(/action token/i);
    expect(() => verifyActionToken('.', SECRET)).toThrow(/action token/i);
  });
});

describe('budget threshold crossing (§17 §5)', () => {
  it('fires the 80 band when this request crosses 80%', () => {
    // pre 0 → post 85 crosses 80 only
    expect(bandsCrossed(usd(0), usd(85), usd(100))).toEqual([80]);
    // already past 80 (pre 80 → post 85): no re-fire
    expect(bandsCrossed(usd(80), usd(85), usd(100))).toEqual([]);
  });
  it('fires 100 at limit even when 80 was crossed earlier', () => {
    // pre 85 (80 already crossed) → post 100 crosses only 100
    expect(bandsCrossed(usd(85), usd(100), usd(100))).toEqual([100]);
    // a single request jumping 0 → 120 crosses both bands ascending
    expect(bandsCrossed(usd(0), usd(120), usd(100))).toEqual([80, 100]);
  });
  it('no bands when the request does not move the counter past a band', () => {
    expect(bandsCrossed(usd(50), usd(70), usd(100))).toEqual([]);
  });
  it('no bands for a zero/unset limit', () => {
    expect(bandsCrossed(usd(0), usd(50), 0n)).toEqual([]);
  });
  it('dedupe key is b<budget>:<pct>:<period> (§5.3)', () => {
    expect(budgetThresholdDedupeKey('3f7a', 80, '2026-07')).toBe('b3f7a:80:2026-07');
  });
});

/**
 * Severity mapping for threshold bands and system events (expanded-audit M33): every producer must
 * stamp severity so the delivery tier can page-vs-suppress correctly instead of silently defaulting
 * all events to 'warning'.
 */
describe('thresholdSeverity (M33)', () => {
  it('100% band → critical (should page)', () => {
    expect(thresholdSeverity(100)).toBe('critical');
  });
  it('80% band → warning', () => {
    expect(thresholdSeverity(80)).toBe('warning');
    expect(thresholdSeverity(90)).toBe('warning');
    expect(thresholdSeverity(99)).toBe('warning');
  });
  it('below 80% → info (informational, no page)', () => {
    expect(thresholdSeverity(50)).toBe('info');
    expect(thresholdSeverity(79)).toBe('info');
  });
});

describe('defaultSeverityForKind (M33)', () => {
  it('approval_notification and automation_notification are info (never page)', () => {
    expect(defaultSeverityForKind('approval_notification')).toBe('info');
    expect(defaultSeverityForKind('automation_notification')).toBe('info');
  });
  it('anomaly_confirmed is always critical (19 §3, AND-gated high-confidence signal)', () => {
    expect(defaultSeverityForKind('anomaly_confirmed')).toBe('critical');
  });
  it('unknown kinds default to warning (safe default)', () => {
    expect(defaultSeverityForKind('budget_threshold')).toBe('warning');
    expect(defaultSeverityForKind('anything_new')).toBe('warning');
  });
});
