/**
 * StreamTaskTracker (ADR-033 D6) — keeps in-flight deferred work (stream reconciles) alive
 * across shutdown. A streamed request reconciles AFTER the response is sent, fire-and-forget;
 * if the process gets SIGTERM (a deploy/restart) while that spend write is in flight, it would
 * be lost — the same governance-bypass class as ADR-032 H2. The data-plane plugin registers a
 * Fastify `onClose` hook that awaits drain() so those writes complete before the process exits.
 *
 * Single-process, single-threaded: a plain Set is race-free. Promises auto-remove on settle so
 * the set doesn't grow unbounded.
 */
export interface StreamTaskTracker {
  /** Register a fire-and-forget promise so drain() will await it on shutdown. */
  track(p: Promise<unknown>): void;
  /** Await all currently-pending tasks (called from onClose). Never rejects. */
  drain(): Promise<void>;
  /** Count of in-flight tasks (diagnostics/tests). */
  size(): number;
}

const DRAIN_DEADLINE_MS = 20_000;

export function createStreamTaskTracker(): StreamTaskTracker {
  const pending = new Set<Promise<unknown>>();
  return {
    track(p) {
      pending.add(p);
      void p.finally(() => pending.delete(p));
    },
    async drain() {
      // Deadline so onClose can't block shutdown indefinitely if a tracked reconcile never
      // settles (each is already timeout-bounded in guardedReconcile; this is belt-and-suspenders
      // — red-team ADR-034 M7).
      await Promise.race([
        Promise.allSettled([...pending]),
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, DRAIN_DEADLINE_MS);
          if (typeof t.unref === 'function') t.unref();
        }),
      ]);
    },
    size() {
      return pending.size;
    },
  };
}
