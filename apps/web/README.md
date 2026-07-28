# apps/web — Spillway dashboard (M4)

React SPA over the control plane (`/api/*`). Vite + React 18 + TanStack Router/Query +
Tailwind v4 + Recharts + Radix primitives + sonner toasts.

## Run it locally

```bash
pnpm db:up && pnpm db:migrate     # docker postgres + drizzle migrations
pnpm dev:token                    # prints a dev JWT + org id (dev-only local JWKS)
pnpm seed:demo                    # 80 requests, 3 keys, 1 team, 2 budgets in "Dev Org"
pnpm dev                          # server :3000 (control /api, data /v1)
pnpm dev:web                      # vite :5173, proxies /api + /v1 → :3000
```

Open http://localhost:5173, paste the JWT + org id into the dev-auth bar. To see the
Governance surfaces (policies, chargeback, insights, traces), bump the demo org:
`docker exec spillway-pg psql -U spillway -d spillway_dev -c "UPDATE orgs SET plan='governance' WHERE slug='dev';"`

## How a screen gets its data

`pages/X.tsx` → `useQuery({ queryKey: [activeOrgId, 'resource', filters?] })` → `lib/api.ts`
(`apiFetch`: bearer + `X-Spillway-Org` headers, `/api` base, typed responses, 204 → undefined,
errors → `ApiError{status, code, message}`) → vite proxy → Fastify control plane.

- **Auth**: `lib/auth.tsx` is the WorkOS seam. Dev-only localStorage token path; the module
  throws in prod builds. A module-level `authRef` mirror lets non-React `api.ts` read the
  session. Replaced wholesale by AuthKit at M4-auth.
- **Org context**: `lib/org.tsx` — `GET /api/orgs` is the bootstrap (there is no `/me`).
  Role + plan come from the membership row; `entitlementsForPlan` (lib/entitlements.ts)
  mirrors the server resolver — keep them in sync. Org switch calls `queryClient.clear()`.
- **Errors**: `lib/query.ts` maps `ApiError.code` → sonner toasts (mutations always toast;
  queries only on first-load auth failures). Page sections render `SectionError` inline.
- **Money is exact**: every USD field is a decimal string from the server. Format with
  `lib/format.ts#usd`; never `parseFloat` for logic.

## Landmines (why-comments live at the call sites too)

- `apiFetch` sets `Content-Type: application/json` **only when a body exists** — Fastify
  400s a bodyless DELETE that declares a JSON content-type (FST_ERR_CTP_EMPTY_JSON_BODY).
- Three endpoints return **snake_case** (raw SQL passthroughs): `GET /approvals`,
  `GET /approvals/:id`, `GET /reports/insights`. The `/requests` pagination envelope keys
  (`has_more`, `next_cursor`) are snake_case while rows are camelCase. Query params are
  snake_case (`virtual_key_id`, `group_by`).
- Reveal-once: virtual-key plaintext exists ONLY in the 201 create response (`key` field).
  `KeyRevealDialog` is the single UI for it — no Escape/backdrop close.
- The chargeback CSV needs auth headers, so it downloads via `apiDownload` (fetch → blob),
  not an `<a href>`.
- Budget spend/utilization comes exclusively from `GET /api/kpi/overview`
  (`budgetUtilization`) — `GET /api/budgets` has no spend field; never recompute from rows.
- No pause/unpause/revoke endpoints: key status changes are `PATCH /virtual-keys/:id {status}`.
- Reads-are-free doctrine: gated resources list fine on any plan; only writes 402
  (`tier_required`). `PlanGate` wraps surfaces whose primary interaction is a gated write.

## Design register

Tokens in `src/styles/globals.css` — shared with the homepage ("the spillway line", light
register): paper `#f8f9fb` / card white / ink `#0b1220`, one blue `#0066cc`, semantic
amber = caught/blocked/pending, pass green = ok, danger red = destructive only. Every
numeral wears `.num` (JetBrains Mono, tabular). Labels use `.eyebrow`. Radius: 14px cards,
10px buttons, pill chips. Skeletons on page load, spinners only inside busy buttons.

## Tests

- Unit: `pnpm test:web` (vitest `web` project — node env, localStorage shim).
- E2E: `apps/web/tests/` (Playwright, `playwright.config.ts`). Needs the full stack running
  plus `SPILLWAY_DEV_JWT` / `SPILLWAY_DEV_ORG` env (from `pnpm dev:token`):
  `cd apps/web && SPILLWAY_DEV_JWT=… SPILLWAY_DEV_ORG=… pnpm exec playwright test`.
  Golden path: overview KPIs → blocked feed rows → request drawer w/ routing trace → key
  create/reveal/pause/revoke → budget editor → chargeback CSV → policy create/delete.
  Not part of `pnpm gate` (running servers are a precondition).

## Known deviations from bible 09-frontend (deliberate, API-grounded)

Code-based route tree (`src/router.tsx`) instead of file-based codegen; Radix instead of
native `<dialog>`; no audit-log page (no list API — the routing trace in the request drawer
is the audit surface); approvals are decide-only (the engine creates them); member invites
take a WorkOS user id, not an email; Reports defaults to the current month-to-date.
