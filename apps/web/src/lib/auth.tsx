import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * Auth (09-frontend §1.3), re-based off Supabase onto WorkOS (ADR-023). Production flow (TODO M4-auth):
 * redirect to WorkOS AuthKit hosted login → exchange the code → hold the session JWT. Until that lands,
 * the DEV path reads a minted test JWT from localStorage['spillway_dev_token'] so the dashboard is
 * buildable + demoable against the real API. A module singleton mirrors the auth so the non-React API
 * client (lib/api.ts) can read the current token + active org.
 */

export interface Session {
  access_token: string;
}

interface AuthState {
  session: Session | null;
  activeOrgId: string | null;
  setActiveOrg: (id: string | null) => void;
  setDevToken: (jwt: string) => void;
  signOut: () => void;
}

let authRef: { session: Session | null; activeOrgId: string | null } = {
  session: null,
  activeOrgId: null,
};
/** Read by the API client outside the React tree (09-frontend §1.4). */
export function getAuthContext(): { session: Session | null; activeOrgId: string | null } {
  return authRef;
}

// M50: the dev-token localStorage path must ONLY ship in development bundles.  Vite tree-shakes
// import.meta.env.DEV to `false` in production builds, so everything inside this guard is
// dead-code-eliminated at `pnpm build`.  The real WorkOS AuthKit session (M4-auth) uses httpOnly
// cookies, not localStorage, so this entire file is replaced in M4.  Verify post-build:
//   grep -r 'spillway_dev_token' dist/  # must return zero results
//
// The typeof guard avoids a ReferenceError in the vitest Node environment where import.meta.env
// may not be defined; the Vite bundler always defines it so the guard is a no-op in real builds.
if (typeof import.meta.env !== 'undefined' && !import.meta.env.DEV) {
  throw new Error(
    '[spillway] dev auth path loaded in a non-dev build — replace with WorkOS AuthKit before shipping (M4-auth)',
  );
}

const DEV_TOKEN_KEY = 'spillway_dev_token';
const ACTIVE_ORG_KEY = 'spillway_active_org';
const AuthContext = createContext<AuthState | null>(null);

// L53: initialize synchronously from localStorage so apiFetch never reads a stale null on first
// paint — the useEffect below would otherwise leave authRef at its module-init null for one tick.
authRef = (() => {
  const t = localStorage.getItem(DEV_TOKEN_KEY);
  const o = localStorage.getItem(ACTIVE_ORG_KEY);
  return { session: t ? { access_token: t } : null, activeOrgId: o };
})();

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(() => {
    const t = localStorage.getItem(DEV_TOKEN_KEY);
    return t ? { access_token: t } : null;
  });
  const [activeOrgId, setActiveOrgId] = useState<string | null>(() =>
    localStorage.getItem(ACTIVE_ORG_KEY),
  );

  // Keep authRef in sync for React state changes (e.g. concurrent renders). Sync writes in
  // setDevToken / setActiveOrg / signOut ensure queries fired synchronously after calling those
  // functions see the latest values without waiting for the next effect flush.
  useEffect(() => {
    authRef = { session, activeOrgId };
  }, [session, activeOrgId]);

  const setActiveOrg = (id: string | null): void => {
    // L53: sync authRef immediately so apiFetch calls made synchronously after setActiveOrg see the
    // correct org header without waiting for the next useEffect flush.
    authRef = { ...authRef, activeOrgId: id };
    setActiveOrgId(id);
    if (id) localStorage.setItem(ACTIVE_ORG_KEY, id);
    else localStorage.removeItem(ACTIVE_ORG_KEY);
  };
  const setDevToken = (jwt: string): void => {
    const s = { access_token: jwt };
    // L53: sync write mirrors the above.
    authRef = { ...authRef, session: s };
    localStorage.setItem(DEV_TOKEN_KEY, jwt);
    setSession(s);
  };
  const signOut = (): void => {
    // L53: sync write so any in-flight query that reads authRef after signOut sees null.
    authRef = { session: null, activeOrgId: null };
    localStorage.removeItem(DEV_TOKEN_KEY);
    localStorage.removeItem(ACTIVE_ORG_KEY);
    setSession(null);
  };

  return (
    <AuthContext.Provider value={{ session, activeOrgId, setActiveOrg, setDevToken, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth used outside AuthProvider');
  return ctx;
}
