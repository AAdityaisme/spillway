import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Encryptor, providerKeyAad } from './encryptor.js';

const key = randomBytes(32);
const enc = new Encryptor(new Map([[1, key]]), 1);

describe('Encryptor', () => {
  it('roundtrips a secret and tags the version', () => {
    const sealed = enc.encrypt('sk-live-supersecret');
    expect(sealed.version).toBe(1);
    expect(enc.decrypt(sealed)).toBe('sk-live-supersecret');
  });

  it('uses a fresh IV per encryption', () => {
    expect(enc.encrypt('x').iv.equals(enc.encrypt('x').iv)).toBe(false);
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => new Encryptor(new Map([[1, randomBytes(16)]]), 1)).toThrow(/32 bytes/);
  });

  it('refuses when the current version has no key', () => {
    expect(() => new Encryptor(new Map([[1, key]]), 2)).toThrow(/current version/);
  });

  it('detects tampering via the GCM auth tag', () => {
    const sealed = enc.encrypt('y');
    sealed.ciphertext[0] = (sealed.ciphertext[0] ?? 0) ^ 0x01;
    expect(() => enc.decrypt(sealed)).toThrow(/authentication failed/);
  });

  it('throws on an unknown key version at decrypt', () => {
    const sealed = enc.encrypt('z');
    expect(() => enc.decrypt({ ...sealed, version: 9 })).toThrow(/no encryption key/);
  });

  // AAD binding (10-security §1.2): a provider-key ciphertext is bound to (org, key).
  it('round-trips with a matching AAD', () => {
    const aad = providerKeyAad('org1', 'key1');
    expect(enc.decrypt(enc.encrypt('sk-secret', aad), aad)).toBe('sk-secret');
  });

  it('cannot decrypt an AAD-sealed ciphertext under a different (org,key)', () => {
    const sealed = enc.encrypt('sk-secret', providerKeyAad('org1', 'key1'));
    expect(() => enc.decrypt(sealed, providerKeyAad('org2', 'key1'))).toThrow(/authentication/);
    expect(() => enc.decrypt(sealed, providerKeyAad('org1', 'key2'))).toThrow(/authentication/);
  });

  it('backward-compat: a legacy no-AAD ciphertext still decrypts when an AAD is supplied', () => {
    const legacy = enc.encrypt('sk-legacy'); // sealed before AAD binding
    expect(enc.decrypt(legacy, providerKeyAad('org1', 'key1'))).toBe('sk-legacy');
  });
});
