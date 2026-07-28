import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError } from './api.js';

/**
 * Global error taxonomy (09-frontend §1.4): ApiError codes → toasts. Queries surface
 * section-level errors inline too; the toast is the always-on floor so no failure is silent.
 */
function toastForError(err: unknown): void {
  if (!(err instanceof ApiError)) {
    toast.error('Something went wrong. Try again.');
    return;
  }
  switch (err.code) {
    case 'unauthenticated':
      toast.error('Session expired — reconnect to continue.');
      return;
    case 'org_required':
      // Pre-org state; the shell routes to org selection — not a user-facing failure.
      return;
    case 'forbidden':
      toast.error("You don't have permission to do that.");
      return;
    case 'not_found':
      toast.warning('Resource not found.');
      return;
    case 'conflict':
      toast.warning(`Already exists — ${err.message}`);
      return;
    case 'last_owner':
      toast.warning('An org must keep at least one owner.');
      return;
    case 'validation_error':
      toast.error(`Invalid input: ${err.message}`);
      return;
    case 'tier_required':
      toast.info('Upgrade to the Governance plan to use this feature.');
      return;
    case 'not_pending':
      toast.warning('This approval was already decided.');
      return;
    case 'self_approval_not_allowed':
      toast.warning("You can't approve your own request.");
      return;
    case 'not_an_approver':
      toast.warning("You're not an approver for this step.");
      return;
    case 'internal_error':
      toast.error('Something went wrong. Try again or contact support.');
      return;
    default:
      toast.error(err.message);
  }
}

// Queries toast only unexpected failures — per-section UI owns expected error rendering,
// and a background refetch failure shouldn't spam. Mutations always toast.
export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError(err, query) {
      if (query.state.data !== undefined) return; // background refetch — section keeps stale data
      if (err instanceof ApiError && (err.status === 401 || err.status === 400)) toastForError(err);
    },
  }),
  mutationCache: new MutationCache({
    onError(err) {
      toastForError(err);
    },
  }),
  defaultOptions: {
    queries: { retry: 1, staleTime: 15_000 },
  },
});
