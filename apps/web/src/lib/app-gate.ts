import type { AuthStatus } from './auth.js';
import type { OrgMembership } from './api.js';

/**
 * First-run routing decisions (09-frontend §1.3 follow-up), pulled out as pure functions so the
 * five auth/org states — loading, signed out, zero orgs, valid org, stale/removed org — are
 * unit-testable without mounting AppShell. The `web` vitest project runs in plain Node with no
 * DOM (see vitest.workspace.ts), so anything that has to be verified by a test has to live here,
 * not in JSX.
 */

/** What AppShell should render for the current auth/org state. */
export type AppGate =
  | 'auth-loading' // session bootstrap in flight; unknown whether signed in
  | 'signed-out' // authoritatively anonymous
  | 'org-loading' // authenticated, but org memberships aren't known yet
  | 'org-error' // authenticated, but the membership fetch FAILED — count is unknown, not zero
  | 'onboarding' // authenticated, zero org memberships (known, not assumed)
  | 'dashboard'; // authenticated, at least one org membership

export function resolveAppGate(input: {
  authStatus: AuthStatus;
  orgsLoading: boolean;
  orgsError: boolean;
  orgCount: number;
}): AppGate {
  if (input.authStatus === 'loading') return 'auth-loading';
  if (input.authStatus === 'anonymous') return 'signed-out';
  // authenticated from here on
  if (input.orgsLoading) return 'org-loading';
  // A FAILED fetch must never be read as "zero orgs". react-query drops isLoading to false once
  // retries are exhausted while data stays undefined, so without this an existing user hits a
  // transient API blip and gets dumped into the onboarding wizard — and the repair effect wipes
  // their stored active org on the way. Unknown is not empty.
  if (input.orgsError) return 'org-error';
  if (input.orgCount === 0) return 'onboarding';
  return 'dashboard';
}

/**
 * Chooses which org should be active. Covers both "nothing stored yet" (first login, or the
 * onboarding wizard hasn't run) and "stored id no longer resolves" (removed from the org, or a
 * stale localStorage value left behind by a previous login as someone else) by falling back to
 * the first membership the API returns rather than wedging on an org the user can't reach.
 */
export function pickActiveOrgId(
  orgs: Pick<OrgMembership, 'id'>[],
  storedActiveOrgId: string | null,
): string | null {
  if (storedActiveOrgId && orgs.some((o) => o.id === storedActiveOrgId)) {
    return storedActiveOrgId;
  }
  return orgs[0]?.id ?? null;
}
