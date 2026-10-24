import { describe, expect, it } from 'vitest';
import { pickActiveOrgId, resolveAppGate } from './app-gate.js';

describe('resolveAppGate', () => {
  it('auth bootstrap in flight always wins, regardless of org state', () => {
    expect(
      resolveAppGate({ authStatus: 'loading', orgsLoading: false, orgsError: false, orgCount: 3 }),
    ).toBe('auth-loading');
    expect(
      resolveAppGate({ authStatus: 'loading', orgsLoading: true, orgsError: false, orgCount: 0 }),
    ).toBe('auth-loading');
  });

  it('unauthenticated -> the existing sign-in gate', () => {
    expect(
      resolveAppGate({
        authStatus: 'anonymous',
        orgsLoading: false,
        orgsError: false,
        orgCount: 0,
      }),
    ).toBe('signed-out');
  });

  it('authenticated, orgs still loading -> a loading state, never onboarding or the sign-in gate', () => {
    // This is the "must not flash onboarding or the sign-in gate at a user who has orgs" case:
    // orgCount is unknown while orgsLoading is true, so it must not be trusted either way.
    expect(
      resolveAppGate({
        authStatus: 'authenticated',
        orgsLoading: true,
        orgsError: false,
        orgCount: 0,
      }),
    ).toBe('org-loading');
  });

  it('authenticated, zero orgs once loaded -> onboarding', () => {
    expect(
      resolveAppGate({
        authStatus: 'authenticated',
        orgsLoading: false,
        orgsError: false,
        orgCount: 0,
      }),
    ).toBe('onboarding');
  });

  it('authenticated, has orgs -> dashboard', () => {
    expect(
      resolveAppGate({
        authStatus: 'authenticated',
        orgsLoading: false,
        orgsError: false,
        orgCount: 1,
      }),
    ).toBe('dashboard');
    expect(
      resolveAppGate({
        authStatus: 'authenticated',
        orgsLoading: false,
        orgsError: false,
        orgCount: 5,
      }),
    ).toBe('dashboard');
  });
});

describe('pickActiveOrgId', () => {
  const orgs = [{ id: 'org_a' }, { id: 'org_b' }];

  it('keeps the stored id when it resolves to a real membership', () => {
    expect(pickActiveOrgId(orgs, 'org_b')).toBe('org_b');
  });

  it('picks the first membership when nothing is stored', () => {
    expect(pickActiveOrgId(orgs, null)).toBe('org_a');
  });

  it('picks the first membership when the stored id points at an org the user no longer belongs to', () => {
    // Removed from the org, or a stale value left behind by a previous login as someone else —
    // either way it must not wedge on an id that can never resolve.
    expect(pickActiveOrgId(orgs, 'org_deleted')).toBe('org_a');
  });

  it('returns null when the user has zero orgs, stored id or not', () => {
    expect(pickActiveOrgId([], null)).toBeNull();
    expect(pickActiveOrgId([], 'org_stale')).toBeNull();
  });
});

describe('resolveAppGate — a failed membership fetch is not an empty one', () => {
  // react-query drops isLoading to false once retries are exhausted while data stays undefined,
  // so `orgCount: 0` here is "we don't know", not "they have none". Reading it as zero routed an
  // existing user into the onboarding wizard on one flaky response, and the repair effect cleared
  // their stored active org on the way through. Greptile caught this on PR #22.
  it('returns org-error, NOT onboarding, when the fetch failed', () => {
    expect(
      resolveAppGate({
        authStatus: 'authenticated',
        orgsLoading: false,
        orgsError: true,
        orgCount: 0,
      }),
    ).toBe('org-error');
  });

  it('still returns org-error when a stale cache leaves a non-zero count behind', () => {
    expect(
      resolveAppGate({
        authStatus: 'authenticated',
        orgsLoading: false,
        orgsError: true,
        orgCount: 2,
      }),
    ).toBe('org-error');
  });

  it('prefers loading over error while a retry is in flight', () => {
    expect(
      resolveAppGate({
        authStatus: 'authenticated',
        orgsLoading: true,
        orgsError: true,
        orgCount: 0,
      }),
    ).toBe('org-loading');
  });

  it('never shows an org state to someone who is not signed in', () => {
    expect(
      resolveAppGate({
        authStatus: 'anonymous',
        orgsLoading: false,
        orgsError: true,
        orgCount: 0,
      }),
    ).toBe('signed-out');
  });
});
