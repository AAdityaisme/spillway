<!-- Security fixes: do not open a public PR. See SECURITY.md. -->

## What and why

<!-- What changes, and the reason. Link the issue: Closes #123 -->

## How it was verified

<!--
Not "tests pass" — what did you actually exercise? A failing-then-passing test, a curl
against the running gateway, a screenshot of the console. Say which.
-->

## Checklist

- [ ] `pnpm gate` passes locally
- [ ] A test fails without this change
- [ ] Any new table has RLS and a policy (`pnpm migration-lint`)
- [ ] No float introduced into a cost or ledger path
- [ ] Migration is additive; no applied migration was hand-edited
- [ ] Commit messages follow conventional commits
- [ ] An ADR is added or amended if this changes an interface, security boundary, data
      model, or operational assumption
- [ ] No secrets, real keys, or connection strings in the diff
