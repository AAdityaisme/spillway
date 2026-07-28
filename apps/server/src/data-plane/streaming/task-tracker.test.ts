import { describe, it, expect } from 'vitest';
import { createStreamTaskTracker } from './task-tracker.js';

/**
 * StreamTaskTracker drain coverage (expanded-audit M14). The tracker keeps deferred stream-reconcile
 * writes alive across SIGTERM: a regression (tasks not tracked, size not decrementing, drain not
 * awaiting settleable tasks) would silently lose real spend rows on every deploy with no test to
 * catch it.
 */
describe('createStreamTaskTracker', () => {
  it('size() reflects in-flight tasks and decrements on settle', async () => {
    const t = createStreamTaskTracker();
    let resolveA!: () => void;
    const a = new Promise<void>((r) => (resolveA = r));
    t.track(a);
    expect(t.size()).toBe(1);
    resolveA();
    await a;
    await Promise.resolve(); // let the .finally() microtask run
    expect(t.size()).toBe(0);
  });

  it('drain() awaits all resolvable pending tasks before returning', async () => {
    const t = createStreamTaskTracker();
    const settled: string[] = [];
    const slow = new Promise<void>((r) =>
      setTimeout(() => {
        settled.push('slow');
        r();
      }, 20),
    );
    const fast = Promise.resolve().then(() => {
      settled.push('fast');
    });
    t.track(slow);
    t.track(fast);
    await t.drain();
    expect(settled).toContain('fast');
    expect(settled).toContain('slow'); // drain waited for the slow one too
    await Promise.resolve();
    expect(t.size()).toBe(0);
  });

  it('drain() on an empty tracker resolves immediately', async () => {
    const t = createStreamTaskTracker();
    await expect(t.drain()).resolves.toBeUndefined();
  });
});
