> For Mintlify product knowledge (components, configuration, writing standards),
> install the Mintlify skill: `npx skills add https://mintlify.com/docs`

# Documentation project instructions

## About this project

- Docs for **Spillway** — an OpenAI- and Anthropic-compatible AI gateway with a governance
  brain: hierarchical budgets with hard enforcement, guardrail policies, approval workflows,
  cost-aware routing, and chargeback reporting.
- Built on [Mintlify](https://mintlify.com). Pages are MDX files with YAML frontmatter.
  Configuration lives in `docs.json`.
- The API reference (`api-reference/`) is generated from `api-reference/openapi.json`, which
  is itself generated from the server's zod request/response schemas
  (`pnpm build:openapi` in the monorepo root). Do not hand-edit generated endpoint pages —
  regenerate the spec and re-copy it instead.
- Use the Mintlify MCP server, `https://mcp.mintlify.com`, to edit content and settings via MCP.

## Terminology

- The product is **Spillway**. Use that name everywhere in this directory, including in
  comments, examples, and regenerated OpenAPI output. Never use an earlier internal name.
- **Data plane** = the gateway (`/v1/*`, OpenAI/Anthropic-compatible). **Control plane** =
  the governance/admin API (`/api/*`).
- **Virtual key** (`mk-live-…`) authenticates the data plane. **Admin key** (`mk-admin-…`) +
  `X-Spillway-Org` header is *designed* to authenticate machine access to the control plane,
  but admin-key auth isn't wired up server-side yet — don't write docs that imply it works
  today. A **session token** authenticates human dashboard access to the control plane.
- **Budget** = a spend cap on a scope (org/team/virtual key/provider) over a period, with a
  `mode` (`enforce`/`alert`/`monitor`). **Guardrail policy** (`/api/policies`) = a
  match+effect rule. The schema defines three effects (`deny`/`require_approval`/`flag`), but
  **`require_approval` is not available to authors** — creating a policy with that effect
  returns `422`, because the grant mechanism that would let an approved caller's retry
  through is still unspecified pending an ADR. Don't write or imply anywhere in these docs
  that the guardrail `require_approval` effect works today; describe it as future/reserved,
  same treatment as `docs-mintlify/configuration/guardrails.mdx`.
  **Scope that caveat carefully — two different things share the name.** An *automation rule*
  also has a `require_approval` effect, and that one WORKS: it opens an approval request and
  freezes the chain (`apps/server/src/services/effects/registry.ts`, exercised by
  `services/automation/automation.integration.test.ts`). Writing "require_approval is not
  available" unqualified understates a working Governance-tier feature. Always say which one.
  **Routing rule** = model rewrite/fallback
  logic. Don't conflate the three — they're separate resources with separate CRUD endpoints.

## Style preferences

- Use active voice and second person ("you").
- Keep sentences concise — one idea per sentence.
- Use sentence case for headings.
- Bold for UI elements: Click **Settings**.
- Code formatting for file names, commands, paths, and code references.
- Ground every API claim in `api-reference/openapi.json` or the monorepo source. Never
  invent an endpoint, field, or default value.

## Content boundaries

- Document the public product surface: gateway usage, control-plane configuration, the API
  reference, architecture, troubleshooting, pricing.
- Do not document internal build history (ADRs, milestone tracking, audits) — that lives in
  the private `docs/bible`, `docs/research`, `docs/plans`, and `docs/audits` directories,
  which are gitignored on purpose and out of scope for this public site.
- Do not include real credentials, connection strings, or `.env` values in any example —
  placeholders only (`mk-live-…`, `sk-test_…`, etc.).
