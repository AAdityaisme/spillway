import { AsyncLocalStorage } from 'node:async_hooks';
import { SpillwayError } from '@spillway/shared';

/**
 * Request-scoped tenant context (02-architecture §4). Set once by the tenancy
 * middleware after membership is resolved, then read by services (audit actor,
 * RBAC) without threading the Fastify request through every call. Distinct from
 * the DB GUC armed by withOrg — this is the app-layer view of "who + which org".
 */
export interface OrgContext {
  orgId: string;
  userId: string; // WorkOS user id
  role: string; // owner | admin | member | viewer
  email?: string; // denormalized into audit_log (ADR-024), survives user deletion
  name?: string; // denormalized into audit_log (ADR-024)
}

const storage = new AsyncLocalStorage<OrgContext>();

export const orgContext = {
  /** Arm the context for the rest of the current request's async chain. */
  enterWith(ctx: OrgContext): void {
    storage.enterWith(ctx);
  },
  run<T>(ctx: OrgContext, fn: () => T): T {
    return storage.run(ctx, fn);
  },
  /** Current context, or throw — use inside org-scoped handlers/services. */
  require(): OrgContext {
    const ctx = storage.getStore();
    if (!ctx) {
      throw new SpillwayError('org_required', 'no organization context', { httpStatus: 400 });
    }
    return ctx;
  },
  get(): OrgContext | undefined {
    return storage.getStore();
  },
};
