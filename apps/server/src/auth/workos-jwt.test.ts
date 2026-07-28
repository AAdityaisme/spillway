import { describe, it, expect, beforeAll } from 'vitest';
import { createLocalJWKSet, SignJWT, type JWTVerifyGetKey } from 'jose';
import { mintTestJwt, getTestJwks, getTestKeyPair } from '@spillway/shared/test-utils/mint-jwt';
import { verifyWorkosJwt } from './workos-jwt.js';

const ISSUER = 'https://api.workos.com/';

describe('verifyWorkosJwt', () => {
  let jwks: JWTVerifyGetKey;
  beforeAll(async () => {
    jwks = createLocalJWKSet(await getTestJwks());
  });

  it('accepts a valid token and returns sub + email', async () => {
    const token = await mintTestJwt({ issuer: ISSUER, sub: 'user_abc', email: 'a@b.com' });
    expect(await verifyWorkosJwt(token, jwks, { issuer: ISSUER })).toEqual({
      sub: 'user_abc',
      email: 'a@b.com',
    });
  });

  it('rejects an expired token', async () => {
    const token = await mintTestJwt({ issuer: ISSUER, expiresInSeconds: -10 });
    await expect(verifyWorkosJwt(token, jwks, { issuer: ISSUER })).rejects.toThrow(
      /invalid or expired/,
    );
  });

  it('rejects a token that carries no exp claim (an exp-less token would never expire)', async () => {
    const { privateKey } = await getTestKeyPair();
    const noExp = await new SignJWT({ email: 'a@b.com' })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('user_noexp')
      .setIssuer(ISSUER)
      .setAudience('spillway')
      .setIssuedAt()
      .sign(privateKey); // deliberately NO setExpirationTime
    await expect(verifyWorkosJwt(noExp, jwks, { issuer: ISSUER })).rejects.toThrow(
      /invalid or expired/,
    );
  });

  it('rejects a token from the wrong issuer', async () => {
    const token = await mintTestJwt({ issuer: 'https://evil.example' });
    await expect(verifyWorkosJwt(token, jwks, { issuer: ISSUER })).rejects.toThrow();
  });

  it('rejects a tampered signature', async () => {
    const token = await mintTestJwt({ issuer: ISSUER });
    await expect(
      verifyWorkosJwt(token.slice(0, -3) + 'AAA', jwks, { issuer: ISSUER }),
    ).rejects.toThrow();
  });

  it('rejects a token with an empty subject', async () => {
    const token = await mintTestJwt({ issuer: ISSUER, sub: '' });
    await expect(verifyWorkosJwt(token, jwks, { issuer: ISSUER })).rejects.toThrow(/subject/);
  });

  it('enforces aud when configured — mismatched audience is rejected', async () => {
    const token = await mintTestJwt({ issuer: ISSUER, audience: 'someone-else' });
    await expect(
      verifyWorkosJwt(token, jwks, { issuer: ISSUER, audience: 'client_test' }),
    ).rejects.toThrow(/invalid or expired/);
  });

  it('accepts the configured audience; ignores aud when not configured', async () => {
    const token = await mintTestJwt({ issuer: ISSUER, sub: 'user_aud', audience: 'client_test' });
    expect(
      (await verifyWorkosJwt(token, jwks, { issuer: ISSUER, audience: 'client_test' })).sub,
    ).toBe('user_aud');
    const stray = await mintTestJwt({ issuer: ISSUER, sub: 'user_any', audience: 'whatever' });
    expect((await verifyWorkosJwt(stray, jwks, { issuer: ISSUER })).sub).toBe('user_any');
  });
});
