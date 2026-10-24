import { createHash, randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** A freshly generated API key: plaintext shown ONCE, hash + prefix persisted. */
export interface GeneratedKey {
  plaintext: string;
  hash: Buffer; // sha256(plaintext) — stored in key_hash (ADR-006, never bcrypt)
  prefix: string; // first 12 chars, stored for display ("mk-live-AbCd")
}

// Largest multiple of 62 that fits in a byte (4 × 62). Bytes at or above this are DISCARDED.
const UNBIASED_CEILING = 248;

/**
 * Uniform base62 over crypto bytes.
 *
 * The obvious `randomBytes(n)[i] % 62` is biased: 256 = 4×62 + 8, so bytes 248-255 fold back onto
 * the first 8 letters and make them exactly 25% more likely than the other 54 (measured: ratio
 * 1.2488 over 2M samples, chi-square 13131 where the 0.1% critical value is ~112). That silently
 * costs entropy in the ONE primitive where it matters most — this generates every virtual key and
 * admin key (ADR-006), and those keys are the product's whole custody claim. Found by CodeQL
 * js/biased-cryptographic-random, 2026-08-08.
 *
 * Rejection sampling instead: draw, discard anything ≥ 248, retry until the string is full. ~3% of
 * bytes are rejected, so the buffer is over-drawn to make one round almost always sufficient; the
 * loop is there for correctness, not for the common case. Only NEW keys change — stored keys are
 * sha256 hashes and are unaffected. keys.test.ts guards the distribution.
 */
function randomBase62(length: number): string {
  let out = '';
  while (out.length < length) {
    const buf = randomBytes(length - out.length + 8);
    for (const b of buf) {
      if (b >= UNBIASED_CEILING) continue;
      out += ALPHABET[b % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

export function sha256(input: string): Buffer {
  return createHash('sha256').update(input).digest();
}

function generate(prefix: 'mk-live-' | 'mk-admin-'): GeneratedKey {
  const plaintext = `${prefix}${randomBase62(43)}`; // ~256 bits of entropy
  return { plaintext, hash: sha256(plaintext), prefix: plaintext.slice(0, 12) };
}

/** Gateway virtual key — used by SDK clients on the data plane. */
export function generateVirtualKey(): GeneratedKey {
  return generate('mk-live-');
}

/** Control-plane admin API key — programmatic dashboard access. */
export function generateAdminKey(): GeneratedKey {
  return generate('mk-admin-');
}
