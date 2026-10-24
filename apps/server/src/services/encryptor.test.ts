import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Encryptor, makeEncryptor, providerKeyAad } from './encryptor.js';
import { testConfig } from '../../test/helpers/config.js';

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

// ADR-014 rotation: every configured key version is loaded for decrypt, only the current one seals.
describe('makeEncryptor', () => {
  const v1 = randomBytes(32).toString('base64');
  const v2 = randomBytes(32).toString('base64');

  it('a V1-only config behaves exactly as before — one key, sealing at v1', () => {
    const only = makeEncryptor(testConfig({ SPILLWAY_ENC_KEY_V1: v1 }));
    expect(only.currentVersion).toBe(1);
    expect(only.encrypt('sk').version).toBe(1);
    expect(() => only.decrypt({ ...only.encrypt('sk'), version: 2 })).toThrow(/no encryption key/);
  });

  it('loads V2 for decrypt while still sealing at v1 (pre-cutover)', () => {
    const both = makeEncryptor(testConfig({ SPILLWAY_ENC_KEY_V1: v1, SPILLWAY_ENC_KEY_V2: v2 }));
    const atV2 = makeEncryptor(
      testConfig({
        SPILLWAY_ENC_KEY_V1: v1,
        SPILLWAY_ENC_KEY_V2: v2,
        SPILLWAY_ENC_KEY_CURRENT: '2',
      }),
    ).encrypt('sk-v2');
    expect(both.encrypt('sk').version).toBe(1);
    expect(both.decrypt(atV2)).toBe('sk-v2'); // the v2 row a flipped peer wrote
  });

  it('seals at v2 and still opens v1 rows once the current version is flipped', () => {
    const before = makeEncryptor(testConfig({ SPILLWAY_ENC_KEY_V1: v1 }));
    const after = makeEncryptor(
      testConfig({
        SPILLWAY_ENC_KEY_V1: v1,
        SPILLWAY_ENC_KEY_V2: v2,
        SPILLWAY_ENC_KEY_CURRENT: '2',
      }),
    );
    expect(after.encrypt('new').version).toBe(2);
    expect(after.decrypt(before.encrypt('old'))).toBe('old');
  });

  it('fails closed once V1 is retired: a surviving v1 row does not decrypt to garbage', () => {
    const legacyRow = makeEncryptor(testConfig({ SPILLWAY_ENC_KEY_V1: v1 })).encrypt('old');
    const retired = makeEncryptor(
      testConfig({
        SPILLWAY_ENC_KEY_V1: undefined,
        SPILLWAY_ENC_KEY_V2: v2,
        SPILLWAY_ENC_KEY_CURRENT: '2',
      }),
    );
    expect(() => retired.decrypt(legacyRow)).toThrow(/no encryption key for version 1/);
  });
});
