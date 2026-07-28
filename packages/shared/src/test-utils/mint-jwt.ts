import { SignJWT } from 'jose';
import { getTestKeyPair } from './test-keypair.js';

export interface TestJwtOptions {
  sub?: string; // WorkOS user id; default: a stable test id
  email?: string; // default: 'test@spillway.dev'
  /** iss claim — must match the issuer the server verifies against (workosJwksUrl base). */
  issuer: string;
  /** aud claim; default: 'spillway'. */
  audience?: string;
  expiresInSeconds?: number; // default: 3600
  /** Override to mint an already-expired token (negative) for tests. */
  notBeforeOffsetSeconds?: number;
}

/**
 * Mints a WorkOS-compatible RS256 JWT for tests, signed with the module test
 * keypair (test-keypair.ts). The server verifies it against the matching public
 * JWKS — no live WorkOS call (ADR-023). Claims mirror an AuthKit access token:
 * sub = WorkOS user id, plus email.
 *
 * Usage:
 *   const token = await mintTestJwt({ issuer: workosJwksUrl(config) });
 *   app.inject({ headers: { Authorization: `Bearer ${token}` } });
 */
export async function mintTestJwt(opts: TestJwtOptions): Promise<string> {
  const { privateKey } = await getTestKeyPair();
  const sub = opts.sub ?? 'user_01TESTUSER000000000000000';
  const jwt = new SignJWT({ email: opts.email ?? 'test@spillway.dev' })
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject(sub)
    .setIssuer(opts.issuer)
    .setAudience(opts.audience ?? 'spillway')
    .setIssuedAt()
    .setExpirationTime(`${opts.expiresInSeconds ?? 3600}s`);
  if (opts.notBeforeOffsetSeconds !== undefined)
    jwt.setNotBefore(`${opts.notBeforeOffsetSeconds}s`);
  return jwt.sign(privateKey);
}

export { getTestKeyPair, getTestJwks } from './test-keypair.js';
