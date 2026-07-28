import { createContext, useContext, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type OrgMembership, type Plan, type Role } from './api.js';
import { useAuth } from './auth.js';
import { entitlementsForPlan, type Entitlement } from './entitlements.js';

/**
 * Org context layered over auth: resolves the caller's memberships (GET /api/orgs — the
 * canonical bootstrap; there is no /me endpoint), the active org's role + plan, and the
 * derived entitlement set. Org switching clears the query cache so no cross-org data
 * survives the swap (09-frontend §1.3).
 */

interface OrgState {
  orgs: OrgMembership[];
  activeOrg: OrgMembership | null;
  role: Role | null;
  plan: Plan | null;
  entitlements: Set<Entitlement>;
  loading: boolean;
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
  const activeOrg = orgs.find((o) => o.id === activeOrgId) ?? null;

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
        loading: q.isLoading,
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
