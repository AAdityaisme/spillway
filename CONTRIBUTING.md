# Contributing

Thanks for looking. This is a solo-maintained project, pre-1.0, moving fast — read this
before spending real time on a change.

## Before you write code

**Open an issue first** for anything beyond a typo or an obvious bug fix. Architecture here
is settled by ADR, and a PR that cuts against an existing ADR will be closed no matter how
good the code is. An issue costs you five minutes and saves you an afternoon.

Small, self-contained fixes with a test: just send the PR.

## Setup

Requires Node ≥22, pnpm 10, and Docker (for Postgres and integration tests).

```bash
pnpm install
cp .env.example .env      # fill in what you need; most of it is optional in dev
pnpm db:up                # dockerized Postgres
pnpm db:migrate
pnpm db:seed
pnpm dev                  # server on :3000
pnpm dev:web              # dashboard SPA on :5173
```

You do **not** need a WorkOS account or provider API keys to work on most of the codebase.
Integration tests mint their own JWTs (`packages/shared/src/test-utils/mint-jwt.ts`), and
provider calls run against recorded fixtures.

## The gate

One command has to pass before a PR is reviewable:

```bash
pnpm gate
```

That runs typecheck, lint, unit tests, web tests, integration tests, the RLS migration lint,
and the build. CI runs the same thing; running it locally first is faster than a red PR.

Useful subsets while iterating:

| Command                     | What it covers                       |
| --------------------------- | ------------------------------------ |
| `pnpm test`                 | unit only, no containers             |
| `pnpm test:integration`     | real Postgres via testcontainers     |
| `pnpm test:web`             | dashboard SPA                        |
| `pnpm migration-lint`       | every new table has RLS and a policy |
| `pnpm lint` / `pnpm format` | eslint + prettier                    |

Integration tests need Docker running. Don't run `pnpm stress` within ~15 s of an
integration run — the reaper from the previous session sweeps the stress harness's
containers and you get a confusing failure.

## What a good PR looks like

- **One concern.** No drive-by refactors bundled with a fix.
- **A test that fails without the change.** For a bug fix, that test is the proof; for a
  feature, it's the spec.
- **RLS on every new table.** `pnpm migration-lint` enforces it. Multi-tenancy is the
  security boundary, not a convention.
- **Money stays decimal.** The ledger is decimal-safe USD. Never introduce a float into a
  cost path.
- **Comments explain WHY.** The code already shows what it does. Comment the landmine, the
  ordering constraint, the reason the obvious approach doesn't work.
- **Migrations are additive.** Generate with `pnpm db:generate`; never hand-edit an applied
  migration.

## Commits

[Conventional commits](https://www.conventionalcommits.org/). The scope is the area, not the
file:

```
fix(budget): reserve and release lock counters in the same canonical order
feat(gateway): /v1/embeddings proxy with full-pipeline governance
docs(readme): correct the streaming reconciliation description
```

Keep the subject in the imperative and under ~72 characters. Explain the _why_ in the body
when it isn't obvious.

## Architecture decisions

Decisions live as terse ADRs. If your change alters an interface, a security boundary, a
data model, or an operational assumption, the PR should add or amend one. Don't write an
essay — state the decision, the alternatives considered, and the consequence.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the Apache License 2.0,
the same as the rest of the project.
