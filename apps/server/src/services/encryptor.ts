import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SpillwayError } from '@spillway/shared';
import { ENC_KEY_FIELDS, type Config } from '../config.js';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard nonce length
const KEY_BYTES = 32; // AES-256
// Pinned on BOTH cipher directions: without it Node's setAuthTag accepts truncated tags
// (4–16 bytes), letting a tampered Sealed row downgrade forgery resistance from 2^-128
// to 2^-32. With it, a short tag throws before any plaintext is produced.
const TAG_BYTES = 16;

/** An encrypted blob — stored as three bytea columns + a smallint version (ADR-014). */
export interface Sealed {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  version: number;
}

/**
 * Versioned envelope encryptor for provider-key secrets (ADR-014, 10-security §3).
 * AES-256-GCM with a random 12-byte IV per encryption; the GCM auth tag detects
 * tampering on decrypt. Multiple key versions are held so rotation can decrypt old
 * ciphertexts while encrypting new data under the current version. Refuses to
 * construct with a key that is not exactly 32 bytes (boot fails loud, not silent).
 */
export class Encryptor {
  private readonly keys: Map<number, Buffer>;
  /** Version new ciphertexts are sealed under — also the re-seal target (jobs/reseal-provider-keys.ts). */
  readonly currentVersion: number;

  constructor(keys: Map<number, Buffer>, currentVersion: number) {
    for (const [version, key] of keys) {
      if (key.length !== KEY_BYTES) {
        throw new Error(`encryption key v${version} must be ${KEY_BYTES} bytes, got ${key.length}`);
      }
    }
    if (!keys.has(currentVersion)) {
      throw new Error(`no encryption key for current version ${currentVersion}`);
    }
    this.keys = keys;
    this.currentVersion = currentVersion;
  }

  /**
   * `aad` (additional authenticated data, 10-security §1.2) binds the ciphertext to a context — for
   * provider keys, `${org_id}:${provider_key_id}` — so a sealed secret authenticated under one context
   * cannot be authenticated under another (a moved/swapped ciphertext fails the tag). It is NOT stored
   * (the caller reconstructs it on decrypt).
   */
  encrypt(plaintext: string, aad?: Buffer): Sealed {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, this.keys.get(this.currentVersion)!, iv, {
      authTagLength: TAG_BYTES,
    });
    if (aad) cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { ciphertext, iv, tag: cipher.getAuthTag(), version: this.currentVersion };
  }

  decrypt(sealed: Sealed, aad?: Buffer): string {
    const key = this.keys.get(sealed.version);
    if (!key) {
      throw new SpillwayError('internal_error', `no encryption key for version ${sealed.version}`, {
        httpStatus: 500,
      });
    }
    const attempt = (useAad: boolean): string => {
      const decipher = createDecipheriv(ALGO, key, sealed.iv, { authTagLength: TAG_BYTES });
      if (useAad && aad) decipher.setAAD(aad);
      decipher.setAuthTag(sealed.tag);
      return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
    };
    try {
      return attempt(true);
    } catch (cause) {
      // Backward-compat: a ciphertext sealed BEFORE AAD binding (or by a seed path that passes none)
      // fails the AAD-authenticated decrypt. Retry without the AAD so legacy keys still decrypt; a
      // genuinely tampered / wrong-key ciphertext fails both. Re-sealing on rotation drops the legacy
      // path. (No weakening for AAD-sealed keys: their tag only verifies WITH the matching AAD.)
      if (aad) {
        try {
          return attempt(false);
        } catch {
          /* fall through to the shared error */
        }
      }
      throw new SpillwayError('internal_error', 'ciphertext authentication failed', {
        httpStatus: 500,
        cause,
      });
    }
  }
}

/** Canonical AAD for a provider-key secret (10-security §1.2): binds the ciphertext to (org, key). */
export function providerKeyAad(orgId: string, providerKeyId: string): Buffer {
  return Buffer.from(`provider_key:${orgId}:${providerKeyId}`, 'utf8');
}

/**
 * Builds the Encryptor from config: EVERY `SPILLWAY_ENC_KEY_V*` that is set becomes a decryptable
 * version, and `SPILLWAY_ENC_KEY_CURRENT` selects the one that encrypts. Loading the old key
 * alongside the new one is what makes rotation zero-downtime — rows still stamped with the old
 * `enc_version` keep opening while the re-seal walks them forward.
 *
 * config's superRefine has already guaranteed the current version has a key; the constructor's
 * identical check is the backstop for callers that build a Config some other way.
 */
export function makeEncryptor(config: Config): Encryptor {
  const keys = new Map<number, Buffer>();
  for (const [version, field] of ENC_KEY_FIELDS) {
    const b64 = config[field];
    if (b64) keys.set(version, Buffer.from(b64, 'base64'));
  }
  return new Encryptor(keys, config.SPILLWAY_ENC_KEY_CURRENT);
}
