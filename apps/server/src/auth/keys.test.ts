import { describe, it, expect } from 'vitest';
import { generateVirtualKey, generateAdminKey, sha256 } from './keys.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

describe('API key generation', () => {
  it('emits the documented prefixes and shapes', () => {
    const vk = generateVirtualKey();
    const ak = generateAdminKey();
    expect(vk.plaintext).toMatch(/^mk-live-[A-Za-z0-9]{43}$/);
    expect(ak.plaintext).toMatch(/^mk-admin-[A-Za-z0-9]{43}$/);
    // prefix is the display fragment persisted alongside the hash
    expect(vk.prefix).toBe(vk.plaintext.slice(0, 12));
    expect(vk.hash).toEqual(sha256(vk.plaintext));
  });

  it('never repeats a key', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateVirtualKey().plaintext));
    expect(seen.size).toBe(500);
  });

  /**
   * REGRESSION GUARD (CodeQL js/biased-cryptographic-random, 2026-08-08). The original
   * implementation did `randomBytes(n)[i] % 62`; because 256 = 4×62 + 8, bytes 248-255 folded onto
   * the first 8 letters and made them exactly 25% more frequent than the other 54 — measured 1.2488
   * over 2M samples, against a χ² of 13131 where the 0.1% critical value is ~112.
   *
   * This is a chi-square goodness-of-fit test over the observed character distribution. A correct
   * (uniform) generator exceeds the 0.1% critical value once in a thousand runs, so the threshold is
   * set well above it at 150 — far enough to be non-flaky, and nowhere near the four-digit χ² a
   * modulo-biased implementation produces. If someone "simplifies" this back to `% 62`, this fails.
   */
  it('is uniform over the alphabet — no modulo bias', () => {
    const counts = new Map<string, number>();
    let total = 0;
    for (let i = 0; i < 5_000; i++) {
      for (const c of generateVirtualKey().plaintext.slice(8)) {
        counts.set(c, (counts.get(c) ?? 0) + 1);
        total++;
      }
    }
    const expected = total / 62;
    let chiSquare = 0;
    for (const c of ALPHABET) {
      chiSquare += ((counts.get(c) ?? 0) - expected) ** 2 / expected;
    }
    expect(counts.size, 'every alphabet character should appear').toBe(62);
    expect(
      chiSquare,
      `chi-square ${chiSquare.toFixed(1)} — distribution is not uniform`,
    ).toBeLessThan(150);
  });
});
