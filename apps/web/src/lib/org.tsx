import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type OrgMembership, type Plan, type Role } from './api.js';
import { useAuth } from './auth.js';
import { entitlementsForPlan, type Entitlement } from './entitlements.js';
import { pickActiveOrgId } from './app-gate.js';

/**
 * Org context layered over auth: resolves the caller's memberships (GET /api/orgs — the
 * canonical bootstrap; there is no /me endpoint), the active org's role + plan, and the
 * derived entitlement set. Org switching clears the query cache so no cross-org data
 * survives the swap (09-frontend §1.3).
 *
 * activeOrg is resolved via pickActiveOrgId, not a raw lookup of the stored id — it repairs two
 * cases the raw id can't: nothing stored yet (first login, or onboarding hasn't run) and a stored
 * id that no longer resolves (removed from the org, or stale from a previous login as someone
 * else). The resolution happens synchronously in render so there's no flicker; the effect below
 * only persists the repaired id back to localStorage/authRef for the next apiFetch and reload.
 */

interface OrgState {
  orgs: OrgMembership[];
  activeOrg: OrgMembership | null;
  role: Role | null;
  plan: Plan | null;
  entitlements: Set<Entitlement>;
  loading: boolean;
  /** The membership fetch failed. Distinct from `orgs.length === 0`, which means "known empty". */
  error: boolean;
  retry: () => void;
  switchOrg: (id: string) => void;
}

const OrgContext = createContext<OrgState | null>(null);

export function OrgProvider({ children }: { children: ReactNode }) {
  const { session, activeOrgId, setActiveOrg } = useAuth();
  const queryClient = useQueryClient();

  const q = useQuery({
    queryKey: ['orgs', session?.access_token ?? null],
    queryFn: api.listOrgs,
    enabled: !!session,
    staleTime: 60_000,
  });

  const orgs = q.data?.orgs ?? [];
  // Repair ONLY off a successful fetch. `!q.isLoading` was the wrong gate: react-query drops
  // isLoading to false when retries are exhausted while data stays undefined, so a failed request
  // presented as a confident empty membership list — pickActiveOrgId would resolve null, the
  // effect would clear a perfectly good stored org id, and AppShell would route an existing user
  // into onboarding because of one flaky response. Unknown is not empty.
  const resolvedActiveOrgId = q.isSuccess ? pickActiveOrgId(orgs, activeOrgId) : activeOrgId;
  const activeOrg = orgs.find((o) => o.id === resolvedActiveOrgId) ?? null;

  // A repair is resolved in render but not COMMITTED until the effect below runs. In between,
  // activeOrgId — which is what apiFetch sends as the tenancy header and what every child query
  // puts in its cache key — is still the old value. Mounting the dashboard in that window means
  // requests scoped to the wrong org, or cached rows from the previous org rendering briefly.
  // Keeping `loading` true until the repair lands closes the window instead of racing it.
  const repairPending = q.isSuccess && resolvedActiveOrgId !== activeOrgId;

  useEffect(() => {
    if (repairPending) setActiveOrg(resolvedActiveOrgId);
  }, [repairPending, resolvedActiveOrgId, setActiveOrg]);

  const switchOrg = (id: string): void => {
    setActiveOrg(id);
    // Purge every cached query — stale data from the previous org must never render.
    queryClient.clear();
  };

  return (
    <OrgContext.Provider
      value={{
        orgs,
        activeOrg,
        role: activeOrg?.role ?? null,
        plan: activeOrg?.plan ?? null,
        entitlements: entitlementsForPlan(activeOrg?.plan),
        loading: q.isLoading || repairPending,
        error: q.isError,
        retry: () => void q.refetch(),
        switchOrg,
      }}
    >
      {children}
    </OrgContext.Provider>
  );
}

export function useOrg(): OrgState {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error('useOrg used outside OrgProvider');
  return ctx;
}

/** True when the current role is at or above the given minimum (owner>admin>member>viewer). */
export function roleAtLeast(role: Role | null, min: Role): boolean {
  const rank: Record<Role, number> = { owner: 3, admin: 2, member: 1, viewer: 0 };
  return role !== null && rank[role] >= rank[min];
}
