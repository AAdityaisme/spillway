import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  generateKeyPair,
  exportJWK,
  importJWK,
  createLocalJWKSet,
  SignJWT,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
  type JWK,
} from 'jose';

/**
 * DEV-ONLY auth key material. The dev server (index.ts, when running without WorkOS) verifies session
 * JWTs against this keypair's public JWKS, and `pnpm dev:token` signs tokens with its private key. The
 * keypair is PERSISTED to a gitignored file so the two SEPARATE processes share ONE key — a per-process
 * ephemeral key (as the test keypair is) would make the server reject the script's tokens. This exists
 * only to make the dashboard usable locally; the whole path is unreachable in production (see index.ts).
 */
const KEY_PATH = path.resolve(process.cwd(), '.dev-auth-key.json');

interface StoredKeypair {
  privateJwk: JWK;
  publicJwk: JWK;
}

async function loadOrCreateKeypair(): Promise<StoredKeypair> {
  try {
    return JSON.parse(await readFile(KEY_PATH, 'utf8')) as StoredKeypair;
  } catch {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
    const stored: StoredKeypair = {
      privateJwk: await exportJWK(privateKey),
      publicJwk: await exportJWK(publicKey),
    };
    await writeFile(KEY_PATH, JSON.stringify(stored), 'utf8');
    return stored;
  }
}

/** Local JWKS (public key) to inject into the verifier in dev — instead of fetching WorkOS's JWKS. */
export async function devJwks(): Promise<JWTVerifyGetKey> {
  const { publicJwk } = await loadOrCreateKeypair();
  const jwks: JSONWebKeySet = { keys: [{ ...publicJwk, alg: 'RS256', use: 'sig' }] };
  return createLocalJWKSet(jwks);
}

/** Mint a dev session JWT signed with the persisted dev key (verifiable by devJwks). */
export async function mintDevToken(opts: {
  issuer: string;
  sub: string;
  email: string;
  expiresInSeconds?: number;
}): Promise<string> {
  const { privateJwk } = await loadOrCreateKeypair();
  const privateKey = await importJWK(privateJwk, 'RS256');
  return new SignJWT({ email: opts.email })
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject(opts.sub)
    .setIssuer(opts.issuer)
    .setAudience('spillway')
    .setIssuedAt()
    .setExpirationTime(`${opts.expiresInSeconds ?? 86_400}s`)
    .sign(privateKey);
}
