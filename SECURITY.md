# Security Policy

Spillway sits in the request path and holds provider API keys, so a vulnerability here is
a vulnerability in someone's spend and someone's credentials. Reports are taken seriously.

## Supported versions

Pre-1.0. Only the tip of `main` is supported. There are no backported security fixes for
older commits or tags.

## Reporting a vulnerability

**Do not open a public issue.**

Use GitHub's private vulnerability reporting — the **Security** tab → **Report a
vulnerability**. That opens a private advisory only you and the maintainer can see.

If that is unavailable, email **aadityasharma.ca@gmail.com** with `SECURITY` in the
subject.

Please include:

- What the issue is and which component (`apps/server`, `apps/web`, `packages/*`)
- Steps to reproduce, or a proof-of-concept request
- The impact you believe it has — credential disclosure, budget bypass, tenant crossover,
  denial of service
- Any commit SHA you tested against

## What to expect

- **Acknowledgement within 72 hours.** This is a solo-maintained project; that window is a
  commitment to reply, not to have a fix.
- An assessment and a rough remediation timeline within 7 days.
- Credit in the advisory unless you ask otherwise.

Please give a reasonable window to ship a fix before public disclosure.

## In scope

Anything that lets a caller escape the guarantees the gateway is supposed to enforce:

- **Budget bypass** — getting spend through a cap that should have returned `402`
- **Tenant crossover** — reading or writing another org's keys, ledger rows, or config.
  RLS is the primary control here (`apps/server/src/db`); a hole in it is high severity.
- **Provider-key disclosure** — anything that surfaces a decrypted provider key. Keys are
  AES-256-GCM encrypted at rest (ADR-014).
- **Auth bypass** — forged or replayed session JWTs, virtual-key forgery, privilege
  escalation across roles
- **Approval-link forgery** — the one-click approve/deny HMAC (ADR-019i)
- **Ledger tampering** — anything that makes recorded spend disagree with actual spend
- SSRF, injection, or deserialization reachable from a request

## Out of scope

- Findings against a deployment you do not own
- Missing hardening headers with no demonstrated impact
- Automated scanner output with no working proof-of-concept
- Anything requiring `ENABLE_TEST_SEEDER=true`, which is documented as never-in-production
- Dependency advisories with no reachable call path — open a normal issue for those
- Rate-limit exhaustion on a single-instance deployment; the limiter is in-process and
  documented as such until the Redis bundle lands (ADR-016)

## Handling secrets

Never paste real provider keys, connection strings, or session tokens into an issue, a PR,
or an advisory. `.gitleaks.toml` runs in CI, but it is a net, not a guarantee.
