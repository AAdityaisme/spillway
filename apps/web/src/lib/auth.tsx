import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * Auth (09-frontend §1.3) on WorkOS AuthKit (ADR-023, M4-auth).
 *
 * The server owns the session: `/auth/callback` seals it into an httpOnly cookie the SPA cannot
 * read, and `/auth/session` trades that cookie for a short-lived access token. That token lives
 * in MEMORY ONLY — deliberately never localStorage.
 *
 * BE PRECISE ABOUT WHAT THAT BUYS. It defeats credential theft by anything that can read storage
 * but not execute on this origin. It does NOT defeat XSS: script running here can just call
 * `/auth/session` itself — the cookie rides along automatically — and mint fresh tokens for the
 * cookie's whole lifetime. httpOnly hides the cookie's value, not its authority. The real
 * mitigation for that threat is a script-src CSP, not this split.
 *
 * Because it's in memory, a reload has no token until the bootstrap fetch resolves. That's what
 * `status: 'loading'` is for; routing must wait on it rather than treating "no token yet" as
 * logged out, or every refresh would flash the signed-out state.
 *
 * DEV ESCAPE HATCH: with no WorkOS configured locally, `pnpm dev:token` mints a JWT that can be
 * pasted into DevAuthBar. That path is dev-build-only and tree-shaken out of production.
 */

export interface Session {
  access_token: string;
}

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthState {
  session: Session | null;
  status: AuthStatus;
  activeOrgId: string | null;
  setActiveOrg: (id: string | null) => void;
  /** Dev-only seam; a no-op in production builds. */
  setDevToken: (jwt: string) => void;
  /** Sends the browser to AuthKit hosted login. */
  signIn: (opts?: { signUp?: boolean }) => void;
  signOut: () => void | Promise<void>;
}

const IS_DEV = typeof import.meta.env !== 'undefined' && import.meta.env.DEV;

const ACTIVE_ORG_KEY = 'spillway_active_org';
const AuthContext = createContext<AuthState | null>(null);

/** Access tokens are short-lived; re-ask the server before they lapse so requests never 401 mid-session. */
const REFRESH_INTERVAL_MS = 4 * 60 * 1000;

let authRef: { session: Session | null; activeOrgId: string | null } = {
  session: null,
  activeOrgId: null,
};
/** Read by the API client outside the React tree (09-frontend §1.4). */
export function getAuthContext(): { session: Session | null; activeOrgId: string | null } {
  return authRef;
}

/**
 * The storage key is written INLINE inside each IS_DEV branch rather than hoisted to a module
 * const. A hoisted const survives tree-shaking as a dead string, which trips the build canary
 * (`grep -r spillway_dev_token dist/` must return zero results). Inlined, Vite drops it with
 * the branch.
 */
function readDevToken(): string | null {
  if (!IS_DEV) return null;
  try {
    return localStorage.getItem('spillway_dev_token');
  } catch {
    return null;
  }
}

function readActiveOrg(): string | null {
  try {
    return localStorage.getItem(ACTIVE_ORG_KEY);
  } catch {
    return null;
  }
}

// L53: initialize synchronously so apiFetch never reads a stale null on first paint. Only the org
// id and (in dev) the pasted token are available synchronously — the real session arrives async.
authRef = (() => {
  const t = readDevToken();
  return { session: t ? { access_token: t } : null, activeOrgId: readActiveOrg() };
})();

/**
 * Result of asking the server who we are. The three-way split is the whole point: only an
 * AUTHORITATIVE rejection may log a user out.
 *
 * Collapsing every non-2xx into "anonymous" was wrong once `/auth/*` became rate limited. A whole
 * office shares one NAT address, so `/auth/session` — polled on page load and every few minutes —
 * can return 429 to a perfectly valid session, and the user would be shown the logged-out screen.
 * Their instinctive retry then hits `/auth/login`, which sits in the tighter bucket. A 5xx or a
 * WorkOS blip has the same shape: not proof of anything.
 */
type SessionResult =
  | { kind: 'session'; session: Session }
  | { kind: 'anonymous' } // authoritative: the server says this cookie is not a session
  | { kind: 'inconclusive' }; // rate limited, server error, or offline — verdict unknown

/** Exchanges the httpOnly session cookie for an access token. Only 401 means "not signed in". */
async function fetchSession(): Promise<SessionResult> {
  try {
    const res = await fetch('/auth/session', {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    if (res.status === 401) return { kind: 'anonymous' };
    if (!res.ok) return { kind: 'inconclusive' }; // 429 from the limiter, 503, any 5xx
    const body = (await res.json()) as { authenticated?: boolean; access_token?: string };
    return body.authenticated && body.access_token
      ? { kind: 'session', session: { access_token: body.access_token } }
      : { kind: 'anonymous' };
  } catch {
    // Network failure is not proof of being signed out; the caller keeps any existing session.
    return { kind: 'inconclusive' };
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const devToken = readDevToken();
  const [session, setSession] = useState<Session | null>(
    devToken ? { access_token: devToken } : null,
  );
  // A pasted dev token is authoritative immediately; otherwise we don't know until the fetch lands.
  const [status, setStatus] = useState<AuthStatus>(devToken ? 'authenticated' : 'loading');
  const [activeOrgId, setActiveOrgId] = useState<string | null>(readActiveOrg);

  useEffect(() => {
    authRef = { session, activeOrgId };
  }, [session, activeOrgId]);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap(initial: boolean): Promise<void> {
      const result = await fetchSession();
      if (cancelled) return;
      // An unknown verdict changes nothing: a loading app keeps loading and retries on the next
      // tick, and an authenticated one stays authenticated. Never demote on a non-answer.
      if (result.kind === 'inconclusive') return;
      if (result.kind === 'session') {
        const s = result.session;
        authRef = { ...authRef, session: s };
        setSession(s);
        setStatus('authenticated');
      } else if (initial && !readDevToken()) {
        // Only demote to anonymous on the FIRST resolution. A later failed refresh shouldn't
        // eject a working session on one flaky response — the next tick retries.
        authRef = { ...authRef, session: null };
        setSession(null);
        setStatus('anonymous');
      }
    }

    void bootstrap(true);
    const id = setInterval(() => void bootstrap(false), REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const setActiveOrg = (id: string | null): void => {
    // L53: sync authRef immediately so apiFetch calls made synchronously after setActiveOrg see
    // the correct org header without waiting for the next useEffect flush.
    authRef = { ...authRef, activeOrgId: id };
    setActiveOrgId(id);
    try {
      if (id) localStorage.setItem(ACTIVE_ORG_KEY, id);
      else localStorage.removeItem(ACTIVE_ORG_KEY);
    } catch {
      /* private-mode storage denial must not break org switching */
    }
  };

  const setDevToken = (jwt: string): void => {
    if (!IS_DEV) return;
    const s = { access_token: jwt };
    authRef = { ...authRef, session: s };
    localStorage.setItem('spillway_dev_token', jwt);
    setSession(s);
    setStatus('authenticated');
  };

  const signIn = (opts?: { signUp?: boolean }): void => {
    window.location.href = opts?.signUp ? '/auth/signup' : '/auth/login';
  };

  const signOut = async (): Promise<void> => {
    // L53: sync write so any in-flight query that reads authRef after signOut sees null.
    authRef = { session: null, activeOrgId: null };
    setSession(null);
    setStatus('anonymous');
    try {
      if (IS_DEV) localStorage.removeItem('spillway_dev_token');
      localStorage.removeItem(ACTIVE_ORG_KEY);
    } catch {
      /* ignore */
    }
    try {
      const res = await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
      const body = (await res.json()) as { logout_url?: string | null };
      // Bounce through WorkOS so the session is revoked there too; otherwise signing back in
      // is a silent no-prompt redirect that looks like sign-out never happened.
      window.location.href = body.logout_url ?? '/';
    } catch {
      window.location.href = '/';
    }
  };

  return (
    <AuthContext.Provider
      value={{ session, status, activeOrgId, setActiveOrg, setDevToken, signIn, signOut }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth used outside AuthProvider');
  return ctx;
}
