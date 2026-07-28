import { jwtVerify, createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import { SpillwayError } from '@spillway/shared';
import { workosJwksUrl, workosIssuer, type Config } from '../config.js';

/** The verified principal extracted from a WorkOS access token. */
export interface AuthenticatedUser {
  /** WorkOS user id (the `sub` claim) — mirrors to users.id. */
  sub: string;
  email: string | undefined;
  name: string | undefined; // denormalized into audit_log (ADR-024)
}

/**
 * Remote JWKS resolver for WorkOS (ADR-023). jose caches keys + handles rotation
 * with a cooldown, so build this ONCE at boot and reuse it across requests.
 */
export function makeWorkosJwks(config: Config): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(workosJwksUrl(config)));
}

export interface VerifyOptions {
  issuer: string;
  /** Optional — enforced iff set (WORKOS_JWT_AUD; WorkOS aud isn't stable on every plan). */
  audience?: string;
}

/** VerifyOptions derived from config — the production defaults. */
export function verifyOptionsFromConfig(config: Config): VerifyOptions {
  return {
    issuer: workosIssuer(config),
    ...(config.WORKOS_JWT_AUD ? { audience: config.WORKOS_JWT_AUD } : {}),
  };
}

/**
 * Verifies a WorkOS AuthKit access token (RS256 over JWKS). `jwks` is injected so
 * tests pass a local key set (test-keypair) and never touch the network. Throws
 * a 401 SpillwayError on any failure — signature, expiry, alg, issuer, or a
 * missing subject. The `cause` is attached but never serialized to the client.
 */
export async function verifyWorkosJwt(
  token: string,
  jwks: JWTVerifyGetKey,
  opts: VerifyOptions,
): Promise<AuthenticatedUser> {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, jwks, {
      issuer: opts.issuer,
      ...(opts.audience !== undefined ? { audience: opts.audience } : {}),
      algorithms: ['RS256'],
      // Require exp — jose rejects a token that carries no exp claim (an exp-less token never
      // expires, so a leaked one would grant access forever). WorkOS always issues exp.
      requiredClaims: ['exp'],
    }));
  } catch (cause) {
    throw new SpillwayError('unauthenticated', 'invalid or expired token', {
      httpStatus: 401,
      cause,
    });
  }

  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new SpillwayError('unauthenticated', 'token missing subject', { httpStatus: 401 });
  }
  return {
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    name: typeof payload.name === 'string' ? payload.name : undefined,
  };
}
