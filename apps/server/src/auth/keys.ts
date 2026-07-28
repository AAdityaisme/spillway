import { createHash, randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** A freshly generated API key: plaintext shown ONCE, hash + prefix persisted. */
export interface GeneratedKey {
  plaintext: string;
  hash: Buffer; // sha256(plaintext) — stored in key_hash (ADR-006, never bcrypt)
  prefix: string; // first 12 chars, stored for display ("mk-live-AbCd")
}

function randomBase62(length: number): string {
  const buf = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[(buf[i] ?? 0) % 62];
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
