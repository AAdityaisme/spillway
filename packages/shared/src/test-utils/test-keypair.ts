import { generateKeyPair, exportJWK, type JSONWebKeySet } from 'jose';

/**
 * Module-scoped RSA keypair for tests (RS256), generated once per process.
 * Integration/unit tests mint tokens with the private key and verify against the
 * matching public JWKS — so the auth path is exercised end-to-end with NO live
 * WorkOS connection (ADR-023). RSA keygen is ~100ms, hence the singleton.
 */
let keyPairPromise: ReturnType<typeof generateKeyPair> | null = null;

export function getTestKeyPair() {
  keyPairPromise ??= generateKeyPair('RS256', { extractable: true });
  return keyPairPromise;
}

/** Local JWKS (public key only) — inject into the verifier in tests instead of fetching WorkOS. */
export async function getTestJwks(): Promise<JSONWebKeySet> {
  const { publicKey } = await getTestKeyPair();
  const jwk = await exportJWK(publicKey);
  return { keys: [{ ...jwk, alg: 'RS256', use: 'sig' }] };
}
