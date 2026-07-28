# Quickstart

Spillway is an OpenAI- and Anthropic-compatible gateway. You keep your SDK; you change two lines —
the base URL and the API key. Every request is then metered, priced, governed, and logged.

- **Data plane** (the gateway): `https://api.spillway.dev/v1`
- **Control plane** (dashboard + admin API): `https://api.spillway.dev/api`
- **Local dev**: both are served from `http://localhost:3000`.

---

## 1. Get a virtual key

Sign in to the dashboard, open **Keys**, and create a virtual key. The plaintext (`mk-live-…`) is shown
**once** — copy it then; only its hash is stored.

Running locally? The seed mints one for you:

```bash
pnpm db:up && pnpm db:seed
# → virtual key: mk-live-…   (shown once)
```

---

## 2. Switch two lines

The only change to your code is the base URL and the key. Nothing else about your request changes.

**OpenAI SDK (Python)**

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://api.spillway.dev/v1",   # was: https://api.openai.com/v1
    api_key="mk-live-…",                       # your Spillway virtual key
)

resp = client.chat.completions.create(
    model="gpt-4.1-mini",
    messages=[{"role": "user", "content": "Say hello in five words."}],
)
print(resp.choices[0].message.content)
```

**OpenAI SDK (TypeScript)**

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://api.spillway.dev/v1',
  apiKey: process.env.SPILLWAY_KEY, // mk-live-…
});
```

**Anthropic SDK** — point it at `/v1` and pass the same key as `x-api-key`; call `client.messages.create(...)`
as usual. Spillway speaks both dialects natively and cross-translates when a request targets the other
provider's model.

**curl**

```bash
curl https://api.spillway.dev/v1/chat/completions \
  -H "authorization: Bearer mk-live-…" \
  -H "content-type: application/json" \
  -d '{"model":"gpt-4.1-mini","messages":[{"role":"user","content":"hi"}]}'
```

Every response carries an `x-spillway-request-id` header — the id of the logged request row.

---

## 3. Stream

Streaming works exactly as it does upstream. Spillway passes the SSE through untouched and injects
`stream_options.include_usage` so token usage (and therefore cost) is always accounted, even for
streamed responses.

```python
stream = client.chat.completions.create(
    model="gpt-4.1-mini",
    messages=[{"role": "user", "content": "Count to ten."}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

If the upstream connection drops mid-stream, the request is still recorded with
`usage_estimated=true` — you never lose a row, and you never lose the spend.

---

## 4. Watch a budget block the spend

Governance is the point. Create a budget in the dashboard (**Budgets → New**), scoped to your org, a
team, or a single key, with `mode: enforce`:

```jsonc
// POST /api/budgets   (control plane; session or admin-key auth)
{
  "scopeType": "virtual_key",
  "scopeId": "<key-uuid>",
  "period": "day",
  "limitUsd": "1.00",
  "mode": "enforce",
}
```

Once the scope's spend for the period would exceed the limit, the **next** request is blocked _before_
it reaches the provider — no upstream call, no charge:

```jsonc
// HTTP 402, OpenAI-shaped error your SDK parses natively
{
  "error": {
    "message": "daily budget exceeded for virtual_key",
    "type": "spillway_error",
    "code": "budget_exceeded",
  },
}
```

The block is written as a request row with `status: blocked` and `blockReason: budget_exceeded`, so it
shows in the live feed and the reports. Set `mode: alert` instead of `enforce` to fire an alert at
80%/100% without blocking, or `onExceed: fallback` to reroute to a cheaper alias instead of failing.

---

## Where next

- **[API reference](./reference/)** — every endpoint, generated from the request/response schemas.
- **[Pricing](./pricing.md)** — flat tiers; never a percentage of your spend.
