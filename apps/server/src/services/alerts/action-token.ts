import { createHmac, timingSafeEqual } from 'node:crypto';
import { SpillwayError } from '@spillway/shared';

/**
 * Signed action tokens (Part II §18 §6) — the one-click "pause this key" button in a Slack/email alert
 * carries a self-contained HMAC token instead of a session. Format: base64url(payloadJson).base64url(sig),
 * sig = HMAC-SHA256(payloadJson, secret). Verification is fail-closed: a tampered payload OR signature,
 * a wrong org, or an expired token all reject 401. Reuse is bounded by (a) the short TTL and (b) the
 * target effect being idempotent (pause_key no-ops on an already-paused key) — no server-side nonce
 * store in v1 (documented; add one here if a non-idempotent action is ever token-gated).
 */

export interface ActionTokenPayload {
  action: 'pause_key';
  orgId: string;
  refId: string; // the virtual_key_id to pause
  exp: number; // epoch ms expiry
}

const b64url = (b: Buffer): string => b.toString('base64url');

function sign(payloadJson: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(payloadJson).digest());
}

/** Mint a token for `payload` (caller sets exp). */
export function signActionToken(payload: ActionTokenPayload, secret: string): string {
  const json = JSON.stringify(payload);
  return `${b64url(Buffer.from(json))}.${sign(json, secret)}`;
}

/**
 * Verify + decode. Throws SpillwayError('invalid_action_token', 401) on any tamper/format/expiry
 * failure (never leaks which). `now` injectable for deterministic expiry tests.
 */
export function verifyActionToken(
  token: string,
  secret: string,
  now: number = Date.now(),
): ActionTokenPayload {
  const reject = (): never => {
    throw new SpillwayError('invalid_action_token', 'invalid or expired action token', {
      httpStatus: 401,
    });
  };
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) reject();
  const payloadPart = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);

  let json: string;
  try {
    json = Buffer.from(payloadPart, 'base64url').toString('utf8');
  } catch {
    return reject();
  }
  const expected = sign(json, secret);
  const a = Buffer.from(sigPart);
  const b = Buffer.from(expected);
  // constant-time; length mismatch is itself a reject (timingSafeEqual throws on unequal length).
  if (a.length !== b.length || !timingSafeEqual(a, b)) reject();

  let payload: ActionTokenPayload;
  try {
    payload = JSON.parse(json) as ActionTokenPayload;
  } catch {
    return reject();
  }
  if (payload.action !== 'pause_key' || typeof payload.exp !== 'number') reject();
  if (now > payload.exp) reject();
  return payload;
}
