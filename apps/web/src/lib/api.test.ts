/**
 * M51 — web subsystem unit coverage for the auth/API seam (apps/web/src/lib).
 *
 * Browser globals (window, localStorage, fetch) are provided by apps/web/src/test-setup.ts which
 * runs as a vitest setupFile before any module-level code, so auth.tsx's module-init IIFE and
 * api.ts's window reference never throw in the Node environment.
 *
 * Tests exercise: L53 authRef init timing, L54 empty-bearer omission, L51 org-header gating,
 * ApiError shape from JSON + non-JSON error bodies, and query-param serialization.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { getAuthContext } from './auth.js';
import { apiFetch, ApiError } from './api.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('authRef — module-init sync (L53)', () => {
  it('getAuthContext returns null session when localStorage had no token at import time', () => {
    // test-setup.ts provides an empty localStorage → authRef.session is null after module init.
    const ctx = getAuthContext();
    expect(ctx.session).toBeNull();
    expect(ctx.activeOrgId).toBeNull();
  });
});

describe('ApiError', () => {
  it('preserves status, code, message, and name', () => {
    const err = new ApiError(401, 'unauthorized', 'token expired');
    expect(err.status).toBe(401);
    expect(err.code).toBe('unauthorized');
    expect(err.message).toBe('token expired');
    expect(err.name).toBe('ApiError');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('apiFetch — header assembly and error mapping', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Reset the localStorage shim between tests so auth state does not bleed across cases.
    localStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // L54: the old code sent `Authorization: Bearer ` with an empty credential whenever session was
  // null, producing a deterministic 401 on every unauthenticated request.  The fix omits the
  // header entirely when no token is present.
  it('L54 — omits Authorization header when no session token is present', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ virtualKeys: [] }));

    await apiFetch('/virtual-keys');

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  // L51: org-scoped queries with no X-Spillway-Org header return 400 org_required from the server.
  // The fix gates enabled on !!session && !!activeOrgId (App.tsx), but the header-build logic in
  // apiFetch must also correctly omit the header when activeOrgId is null.
  it('L51 — omits X-Spillway-Org header when activeOrgId is null', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));

    await apiFetch('/virtual-keys');

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Spillway-Org']).toBeUndefined();
  });

  it('maps a non-2xx JSON error body to ApiError with the correct code and message', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: { code: 'org_required', message: 'X-Spillway-Org header is required' } },
        400,
      ),
    );

    await expect(apiFetch('/virtual-keys')).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ApiError &&
        e.status === 400 &&
        e.code === 'org_required' &&
        e.message === 'X-Spillway-Org header is required',
    );
  });

  it('maps a non-2xx non-JSON body to ApiError with code=unknown', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));

    await expect(apiFetch('/virtual-keys')).rejects.toSatisfy(
      (e: unknown) => e instanceof ApiError && e.status === 500 && e.code === 'unknown',
    );
  });

  it('appends defined query params to the URL', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));

    await apiFetch('/budgets', { params: { limit: 10, active: true } });

    const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.searchParams.get('limit')).toBe('10');
    expect(url.searchParams.get('active')).toBe('true');
  });

  it('skips undefined param values', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));

    await apiFetch('/budgets', { params: { limit: undefined, active: true } });

    const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.searchParams.has('limit')).toBe(false);
    expect(url.searchParams.get('active')).toBe('true');
  });

  it('serializes a body as JSON for non-GET methods', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ virtualKey: { id: 'vk_1', name: 'test', status: 'active' } }, 200),
    );

    await apiFetch('/virtual-keys', { method: 'POST', body: { name: 'test' } });

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ name: 'test' }));
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });
});
