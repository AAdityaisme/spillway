# Spillway docs

The control plane for AI spend — one OpenAI- and Anthropic-compatible gateway that meters, prices,
governs, and logs every request behind budgets, approvals, anomaly detection, and cost-aware routing.

## Start here

- **[Quickstart](./quickstart.md)** — switch two lines, make your first governed request, watch a
  budget block spend before it happens.
- **[API reference](./reference/)** — every data-plane and control-plane endpoint, generated from the
  zod schemas in `@spillway/shared` (`pnpm build:openapi`). The raw spec is
  [`reference/openapi.json`](./reference/openapi.json).
- **[Pricing](./pricing.md)** — flat monthly tiers; never a percentage of your spend.

## The two planes

| Plane   | Base URL | Auth                                                   | What it is                                                    |
| ------- | -------- | ------------------------------------------------------ | ------------------------------------------------------------- |
| Data    | `/v1/*`  | `Authorization: Bearer mk-live-…` (or `x-api-key`)     | The LLM gateway. Your SDK points here.                        |
| Control | `/api/*` | Session token, or `mka-…` admin key + `X-Spillway-Org` | Dashboard and machine API: keys, budgets, approvals, reports. |

Production: `https://api.spillway.dev`. Local dev: `http://localhost:3000` serves both.

## Regenerating the reference

The API reference is generated, not hand-written — the request/response schemas are the single source
of truth, so the spec cannot drift from what the server validates:

```bash
pnpm build:openapi   # → apps/docs/reference/openapi.json + reference/index.html
```
