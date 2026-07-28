/**
 * Vitest setup file for the web project.  Stubs browser globals before any test module is
 * imported so module-level code in auth.tsx (localStorage.getItem at init) and api.ts
 * (window.location.origin) does not throw in the Node environment.
 *
 * Registered via vitest.workspace.ts `setupFiles`.
 */

/** Minimal synchronous localStorage shim. */
function makeLocalStorage(): Storage {
  const store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  };
}

globalThis.localStorage = makeLocalStorage();
// window is read only for its .location.origin in api.ts.
(globalThis as Record<string, unknown>).window = { location: { origin: 'http://localhost:3000' } };
// import.meta.env is set by vitest when running under vitest; define a safe fallback so auth.tsx's
// M50 guard evaluates typeof import.meta.env !== 'undefined' as true but env.DEV as also true
// (we are in a test/dev context, so the guard should NOT throw).
// Note: vitest already defines import.meta.env.DEV = true in test mode, so this is belt-and-suspenders.
