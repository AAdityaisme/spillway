import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SpillwayError } from '@spillway/shared';
import type { Config } from '../config.js';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard nonce length
const KEY_BYTES = 32; // AES-256

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
  private readonly currentVersion: number;

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
    const cipher = createCipheriv(ALGO, this.keys.get(this.currentVersion)!, iv);
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
      const decipher = createDecipheriv(ALGO, key, sealed.iv);
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

/** Builds the Encryptor from config (SPILLWAY_ENC_KEY_V1, base64-encoded 32 bytes). */
export function makeEncryptor(config: Config): Encryptor {
  const key = Buffer.from(config.SPILLWAY_ENC_KEY_V1, 'base64');
  return new Encryptor(new Map([[1, key]]), 1);
}
