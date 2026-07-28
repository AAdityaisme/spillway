# Pricing

Flat monthly tiers. **Never a percentage of your spend** — a governance product that took a cut of
your bill would be rooting for your bill to grow. A 10× spend month costs you the same as a quiet one.

|                                          | **Free** | **Pro**         | **Governance**      | **Enterprise** |
| ---------------------------------------- | -------- | --------------- | ------------------- | -------------- |
| Price                                    | $0       | **$49**/mo      | **$299**/mo         | Talk to us     |
| Orgs                                     | 1        | Unlimited       | Unlimited           | Unlimited      |
| Virtual keys                             | 2        | Unlimited       | Unlimited           | Unlimited      |
| Included requests                        | 10K / mo | Metered overage | Metered overage     | Custom         |
| Request history                          | 7 days   | 90 days         | 90 days + audit API | Custom         |
| Budgets & spend alerts                   | ✓        | ✓               | ✓                   | ✓              |
| Cost-aware routing & guardrails          | —        | ✓               | ✓                   | ✓              |
| **Anomaly detection**                    | —        | —               | ✓                   | ✓              |
| Budget hierarchy & approval workflows    | —        | —               | ✓                   | ✓              |
| Chargeback & audit exports               | —        | —               | ✓                   | ✓              |
| In-region / on-prem, SSO/SAML, SCIM, SLA | —        | —               | —                   | ✓              |

Enterprise starts at a $2K/mo floor and adds in-region and on-prem deployment, SSO/SAML, SCIM, an SLA,
and solutions engineering. The policy engine is identical to the one the cloud runs.

## How overage works

Free includes 10,000 requests per month. Pro and Governance meter requests above the included volume at
a flat per-request rate — you are billed for _requests_, never for a slice of the model spend that flows
through them. Your provider bills (OpenAI, Anthropic, Google) remain yours, paid with your own provider
keys; Spillway sits in front and governs them.

## Why not percentage-of-spend

Percentage-of-spend is common for observability middleware, but it is the wrong incentive for a
governance product. Spillway's job is to _shrink_ wasteful spend — block runaway budgets, route to the
cheapest capable model, catch the anomaly before the invoice. If we charged a percentage of your bill,
every dollar we saved you would cost us revenue. Flat tiers keep us aligned with the outcome you bought.

---

_Tier entitlements follow ADR-018. Feature gating is enforced server-side; a call to a feature your plan
doesn't include returns `402 tier_required`._
