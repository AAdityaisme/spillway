# Spillway docs

Public documentation site for Spillway, built on [Mintlify](https://mintlify.com). Licensed
under the same terms as the rest of the monorepo (see the root [`LICENSE`](../LICENSE)) —
this directory has no license of its own.

## Local development

```bash
npx mint dev
```

Run from this directory (where `docs.json` lives). Preview at `http://localhost:3000` —
note this is the same port the app server's local dev uses, so don't run both at once.

## Structure

- `docs.json` — navigation, theme, and site config.
- `*.mdx` — guide pages (quickstart, installation, configuration, architecture,
  troubleshooting, pricing).
- `api-reference/openapi.json` — the API spec. Regenerate it from the monorepo root with
  `pnpm build:openapi`, then copy `apps/docs/reference/openapi.json` here — see
  [`api-reference/introduction.mdx`](./api-reference/introduction.mdx). Mintlify
  auto-generates the endpoint pages from this file; don't hand-edit them.

## Publishing

Not yet connected to a Mintlify project. Deploying requires a Mintlify account and pushing
this directory to the connected repo/branch — deliberately not done as part of building
this site locally. See the top-level `docs-mintlify` friction log for what that
last step involves.
