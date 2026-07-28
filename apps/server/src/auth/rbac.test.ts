import { describe, it, expect } from 'vitest';
import { ROLE_RANK, hasRole, requireRole, canManageMemberRole } from './rbac.js';
import { orgContext } from '../org-context.js';

describe('rbac', () => {
  it('ranks roles owner > admin > member > viewer', () => {
    expect(ROLE_RANK.owner).toBeGreaterThan(ROLE_RANK.admin);
    expect(ROLE_RANK.admin).toBeGreaterThan(ROLE_RANK.member);
    expect(ROLE_RANK.member).toBeGreaterThan(ROLE_RANK.viewer);
  });

  it('hasRole compares rank and fails closed on unknown roles', () => {
    expect(hasRole('admin', 'member')).toBe(true);
    expect(hasRole('member', 'member')).toBe(true);
    expect(hasRole('viewer', 'admin')).toBe(false);
    expect(hasRole('superadmin', 'viewer')).toBe(false);
  });

  it('requireRole passes when met, throws 403 when not', () => {
    orgContext.run({ orgId: 'o1', userId: 'u1', role: 'admin' }, () => {
      expect(() => requireRole('member')).not.toThrow();
      expect(() => requireRole('admin')).not.toThrow();
      expect(() => requireRole('owner')).toThrow(/owner/);
    });
  });

  it('requireRole throws without an org context', () => {
    expect(() => requireRole('viewer')).toThrow();
  });

  it('canManageMemberRole enforces owner/admin limits', () => {
    expect(canManageMemberRole('owner', 'owner')).toBe(true);
    expect(canManageMemberRole('owner', 'admin')).toBe(true);
    expect(canManageMemberRole('admin', 'member')).toBe(true);
    expect(canManageMemberRole('admin', 'viewer')).toBe(true);
    expect(canManageMemberRole('admin', 'owner')).toBe(false);
    expect(canManageMemberRole('admin', 'admin')).toBe(false);
    expect(canManageMemberRole('member', 'viewer')).toBe(false);
  });
});
