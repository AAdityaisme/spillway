import type { Candidate } from './compile.js';

/**
 * SessionPinStore — sticky session affinity (15 §4.5, ADR-042.3). Ported verbatim from the lab.
 *
 * A deterministic lookup table (NOT ML, NOT a routing rule): an explicit session_id pins the
 * resolved {provider, model, providerKeyId} for consistency across a multi-turn conversation.
 * Behind an interface for the ADR-016 Redis swap. TTL = 5 min of INACTIVITY (reset on every
 * observed dispatch, in the executor success path — never in ROUTE, which only reads). Key is
 * `${orgId}:${session_id}` — org-scoped so one tenant's session id can never read another's pin.
 */

export type SessionPinKey = `${string}:${string}`;

export interface SessionPin {
  candidate: Candidate;
  expiresAt: number;
}

export interface SessionPinStore {
  get(key: SessionPinKey): SessionPin | undefined; // undefined at/after expiresAt
  set(key: SessionPinKey, candidate: Candidate): void; // sets expiresAt = now + TTL
}

/** Org-scoped key — the isolation guarantee (§4.5). */
export function sessionPinKey(orgId: string, sessionId: string): SessionPinKey {
  return `${orgId}:${sessionId}`;
}

const DEFAULT_TTL_MS = 300_000; // 5 minutes

export class InMemorySessionPinStore implements SessionPinStore {
  readonly #map = new Map<SessionPinKey, SessionPin>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.#ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.#now = opts.now ?? Date.now;
  }

  get(key: SessionPinKey): SessionPin | undefined {
    const pin = this.#map.get(key);
    if (pin === undefined) return undefined;
    if (this.#now() >= pin.expiresAt) {
      this.#map.delete(key);
      return undefined;
    }
    return pin;
  }

  set(key: SessionPinKey, candidate: Candidate): void {
    this.#map.set(key, { candidate, expiresAt: this.#now() + this.#ttlMs });
  }
}
