# Data plane (`/v1/*`) — the gateway

This is the OpenAI-compatible proxy: a client points its OpenAI SDK at us, we authenticate
the virtual key, enforce the key's policy, call the real provider, forward the response
verbatim, and record what it cost. The control plane (`/api/*`) never touches this path and
vice-versa — they share only `@spillway/shared` and the database.

> **If you are debugging this in production and don't have time to read the whole file:**
> jump to [Debugging by symptom](#debugging-by-symptom). Every request carries an
> `x-spillway-request-id` header that equals the `requests.id` row — start there.

As of M2 Phase B this implements exactly ONE endpoint, non-streaming, OpenAI only, one
provider candidate, no retry/fallback/budget/rate-limit. Everything else is a documented
seam (see [Phase seams](#phase-seams)). Don't assume a feature exists because the bible
describes it — the bible is the destination, this code is where we are.

## Request lifecycle

```
POST /v1/chat/completions
  routes/chat-completions.ts   ← owns the outer try/catch + error response
    → runAuth        (pipeline/auth.ts)      parse key → hash → load policy (cached 30s) → fail-closed
    → runValidate    (pipeline/validate.ts)  zod → reject stream → allow-lists → size guard → clamp
    → ROUTE-min                              one concrete candidate: {openai, requestedModel, key}
    → runDispatch    (dispatch.ts)           decrypt key → transform → fetch upstream → fork on status
        2xx → runBodyCapture → SEND RESPONSE → runReconcile   (spend write happens AFTER send)
        non-2xx → runReconcile (error row) → throw (route turns it into the client error)
```

`PipelineContext` (`pipeline/context.ts`) is the mutable bag threaded through every stage.
Fields are populated as the request advances (`policy` by AUTH, `validatedBody` by VALIDATE,
`candidate` by ROUTE, `usage`/`upstreamStatus` by DISPATCH). Dependencies (`db`, `encryptor`,
`dispatcher`) are captured by the plugin **closure** and passed in as `ctx.deps` — there is no
`fastify.decorate`/`req.server.db`. That's deliberate: the stage functions are plain functions
you can unit-test without booting Fastify.

## The landmines (read before you change anything here)

These are the things that already bit us, or will silently corrupt data if you "tidy" them.
Each one has a matching `WHY` comment at the call site.

1. **Reconcile MUST run inside `withOrg(db, orgId, …)`.** `requests` and `spend_counters` are
   under FORCE RLS. RLS reads the org from the transaction-local GUC `app.current_org_id`,
   which `withOrg` sets. A bare `db.insert(...)` outside `withOrg` does **not** error — it
   matches zero rows and writes **nothing, silently**. If spend stops recording, this is the
   first suspect. (`reconcile.ts`, the `withOrg` wrapper.)

2. **The spend write happens AFTER the response is sent** (success path only). We do not make
   the client wait on the audit write. Consequence: in tests and in any "did it record?" check,
   the row appears a few ms _after_ the client gets its 200 — poll, don't assume-synchronous.
   `runReconcile` therefore **never throws** to its caller (it catches + logs); throwing
   post-send would crash a handler for a response already on the wire. (`dispatch.ts` ordering,
   `reconcile.ts` outer try/catch.)

3. **`input_tokens = prompt_tokens − cached_tokens`** for OpenAI. OpenAI's `prompt_tokens`
   _includes_ cached tokens; `computeCost` bills full-rate input AND cached-read separately, so
   if you record raw `prompt_tokens` you double-bill the cached portion at the full rate. The
   subtraction lives in `providers/openai.ts:parseBody`. (The bible §1.5 snippet is stale — do
   not "fix" parseBody to match it.)

4. **Money is bigint micro-USD, formatted to a `numeric(14,6)` string at the DB edge.** Never
   `parseFloat`, never float math, never a bigint DB column. `computeCost` returns
   `costMicroUsd: bigint`; `formatUsd` turns it into the decimal string we store. The counter
   increment casts the bound param `::numeric` because `numeric + text` has no operator in PG.
   (`@spillway/pricing`, `reconcile.ts`.)

5. **RLS GUC reads are wrapped in `nullif(current_setting(...), '')`.** On a pooled postgres-js
   connection a transaction-local GUC reverts to empty-string `''`, and `''::uuid` throws. Every
   policy that casts a GUC to uuid uses `nullif(…, '')` first. (Migrations `0002`, `0006`, `0008`.)

6. **Data-plane auth reads `virtual_keys` with NO org context** (we don't know the org until we've
   found the key). Migration `0008` adds a bootstrap RLS policy gated on the GUC
   `app.lookup_key_hash`: AUTH arms that GUC inside a tx so the policy exposes exactly the one row
   whose `key_hash` matches — never a table scan. (`pipeline/auth.ts:loadBundle` + migration `0008`.)

7. **Auth fails CLOSED but distinguishes outage from rejection.** A DB error during policy load
   throws `503 service_unavailable`, NOT 401 — we don't tell an attacker their key is invalid when
   we simply couldn't check it. And not-found / revoked / expired all return the **same** 401
   (`key_not_found`) so the key can't be probed for existence. Paused is a separate 403. Don't
   "helpfully" split these back apart. (`pipeline/auth.ts:runAuth`.)

8. **Data-plane errors are OpenAI-shaped, not RFC7807.** `{error:{message,type:'spillway_error',
param,code}}`. Client SDKs parse this shape; send anything else (e.g. the control plane's body)
   and the SDK throws a parse error instead of surfacing our message. The data plane has its own
   `setErrorHandler` (`plugin.ts`) scoped by Fastify encapsulation.

9. **Upstream 4xx → client gets that 4xx; upstream 5xx → client gets 502.** A provider 400 is the
   caller's fault (bad body) so we echo it; a provider 500 is the provider's fault so we normalize
   to 502 and never leak the raw upstream body/HTML. `mapError` is **status-driven** — the body is
   advisory only and may be null or HTML. (`providers/openai.ts:mapError`, `dispatch.ts`.)

## File map

| File                         | Role                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `plugin.ts`                  | Registers CORS + the OpenAI-shaped error handler + the route; builds `deps`. |
| `routes/chat-completions.ts` | The endpoint. Outer try/catch, ROUTE-min, error response.                    |
| `pipeline/context.ts`        | `PipelineContext` + `DataPlaneDeps` + `buildPipelineContext`.                |
| `pipeline/auth.ts`           | Key → policy bundle, 30s LRU cache + invalidation bus, fail-closed.          |
| `pipeline/validate.ts`       | zod parse, stream reject, allow-lists, size guard, output clamp.             |
| `providers/openai.ts`        | `transform` (build upstream req), `parseBody` (usage), `mapError`.           |
| `providers/registry.ts`      | `getAdapter(provider)`.                                                      |
| `dispatch.ts`                | Decrypt → transform → fetch → fork on status → body capture.                 |
| `reconcile.ts`               | Price lookup → `computeCost` → `withOrg` insert + counter upsert.            |

## Debugging by symptom

- **"Spend / requests rows aren't being written."** Almost always landmine #1 (a write escaped
  `withOrg`) or #2 (you checked before the post-send write landed). Confirm RLS isn't silently
  dropping the row: re-run the query as the superuser (`adminSql` in tests) vs the app role. Check
  logs for `"reconcile failed — spend not recorded"`.
- **"Valid keys get 401."** Check the key hash path: AUTH does `sha256(rawKey)` and the stored
  `virtual_keys.key_hash` must match byte-for-byte. The `mk-` prefix is required (Bearer or
  `x-api-key`, both trimmed). A `503` instead means the DB load threw — look there, not at the key.
- **"Cached tokens look double-billed / cost is too high."** Landmine #3. Verify
  `requests.input_tokens` excludes cached, and `cached_read_tokens` is populated.
- **"Client gets a 502 on a request that should work."** Either the provider key failed to decrypt
  (`provider_key_decrypt_failed` — wrong `SPILLWAY_ENC_KEY_*` / rotated key missing), the upstream
  returned a 5xx, or the upstream 2xx body wasn't valid JSON (`failed to parse upstream response`).
  The `x-spillway-request-id` + logs disambiguate.
- **"Stale policy after I changed a key in the control plane."** The policy cache TTL is 30s
  (`pipeline/auth.ts`). The `internalBus` invalidation emits are wired in Phase E; until then, a
  change takes up to 30s to take effect on a running node. This is expected, not a bug.
- **A param the client sent didn't reach the provider.** Check the `x-spillway-dropped-params`
  response header — `transform` strips unknown/out-of-range params and records them there.

## Phase seams (what's intentionally NOT here yet)

- **Streaming / SSE** — rejected at VALIDATE today. Phase C adds `createStreamParser` + tee.
- **Retry / fallback / candidate chain** — `dispatch.ts` runs exactly one candidate. The Phase E
  seam is the `for (const c of ctx.candidateChain)` loop that would wrap the status fork.
- **Budgets / rate limits / routing rules / model aliases** — `PolicyBundle` is the Phase-B subset
  (no budgets/rpm/tpm/aliases). Phase D/E add them.
- **anthropic / gemini / openai_compat adapters** — only `openai` is registered. Phase D.
- **Usage estimation** — when upstream usage is absent we record `usage_estimated` zeros; the
  tokenizer-based estimator is Phase C.

See `docs/plans/m2-phase-b.md` (local, gitignored) for the full build plan and the ADRs in
`docs/bible/14-decisions.md` (ADR-024 through ADR-029) for the decision history.
