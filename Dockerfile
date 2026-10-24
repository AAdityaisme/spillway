# syntax=docker/dockerfile:1.7
# node:22.4-slim shipped corepack 0.28.2, which lacks the npm registry's rotated
# signing keys ("Cannot find matching keyid") and predates Node's default-on
# require-of-ESM (22.12+, see fly.toml's release_command comment). 22.23.1-slim
# carries corepack 0.34.6 and clears both.
FROM node:22.23.1-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Enable corepack for pnpm version locking (matches packageManager field in package.json)
RUN corepack enable

# ────────────────────────────────────────────
# Stage 1: fetch dependencies (pnpm fetch cache layer)
# Separate COPY of lockfile before source so this layer is cached unless lockfile changes.
# ────────────────────────────────────────────
FROM base AS deps
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY package.json ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/pricing/package.json ./packages/pricing/package.json
# Every workspace manifest must be here or `pnpm fetch` never caches that package's deps and the
# `--offline` install two stages down fails. certifier was added to the workspace after this list
# was written; nothing built the image in CI, so the gap stayed invisible until the image-smoke job.
COPY packages/certifier/package.json ./packages/certifier/package.json
# pnpm fetch: downloads all packages into the store without installing
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked pnpm fetch

# ────────────────────────────────────────────
# Stage 2: install all deps (dev + prod) and build web
# ────────────────────────────────────────────
FROM deps AS build-web
WORKDIR /app
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked pnpm install --frozen-lockfile --offline
RUN pnpm -F web build
# Output: apps/web/dist/

# ────────────────────────────────────────────
# Stage 3: build server (TypeScript → JS)
# ────────────────────────────────────────────
FROM deps AS build-server
WORKDIR /app
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked pnpm install --frozen-lockfile --offline
RUN pnpm build
# Assemble a production-only dependency tree for the server. The compiled server
# itself lives at /app/dist, so only runtime dependencies are deployed here.
# NOT --legacy. The workspace opts into injected packages (pnpm-workspace.yaml
# injectWorkspacePackages: true) precisely so this deploy replays pnpm-lock.yaml's
# resolutions verbatim. --legacy re-resolved the graph from the registry at image-build
# time — the production image could contain package versions no CI run ever tested, and
# the old comment here documented that as a cache-miss nuisance. It surfaced for real on
# the first release-gates Ring 1 run (2026-08-09): the fresh resolution pulled
# @types/node@22.20.1 (not in the lockfile, no prod path to it at all) whose
# undici-types@6.21.0 tripped ERR_PNPM_TRUST_DOWNGRADE — the trust policy was the only
# guard that caught the unpinned build. Lockfile-locked, the prod tree has no @types/*
# and every version is one CI tested.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm --filter @spillway/server deploy --prod --prefer-offline /prod
# Output: dist/ (server TS compiled) and apps/web/dist/ (SPA static)
# Copy web dist into server's static dir so single process serves SPA. apps/server's
# own tsc output lands at root dist/apps/server/src (tsconfig.build.json outDir), so
# nothing else creates apps/server/dist/ — cp -r needs the parent dir to pre-exist.
RUN mkdir -p apps/server/dist \
    && cp -r apps/web/dist apps/server/dist/public \
    # dist/public is served publicly under /app. A shipped .map lets anyone reconstruct the
    # dashboard source, including the client-side auth flow — belt-and-braces with the vite
    # sourcemap setting, since this holds no matter how the SPA was built.
    && find apps/server/dist/public -name '*.map' -delete

# ────────────────────────────────────────────
# Stage 4: production runtime — production deps only, non-root user
# ────────────────────────────────────────────
FROM node:22.23.1-slim AS runtime
WORKDIR /app

# Populated from CI (--build-arg COMMIT_SHA=$GITHUB_SHA --build-arg BUILD_DATE=...); default
# keeps local `docker build` (no build-args) working without empty-string OCI labels.
ARG COMMIT_SHA=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.source="https://github.com/AAdityaisme/v2" \
      org.opencontainers.image.revision="${COMMIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.title="spillway" \
      org.opencontainers.image.vendor="Spillway"

# dumb-init: PID 1 signal forwarding + zombie reaping
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init \
    && rm -rf /var/lib/apt/lists/*

# Strip the bundled npm CLI from the runtime image: nothing runs npm/npx/corepack here (the
# app and release_command are plain `node dist/...`), and node's bundled npm ships its own
# vendored deps that show up as FIXABLE vulns in image scans (picomatch/sigstore HIGHs at the
# time of writing) that no lockfile of ours can patch. Removing it also shrinks the image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

# Non-root user
RUN groupadd --system --gid 1001 spillway \
    && useradd --system --uid 1001 --gid spillway spillway

# Copy only the production build output and production node_modules
COPY --from=build-server --chown=spillway:spillway /app/dist ./dist
COPY --from=build-server --chown=spillway:spillway /app/apps/server/dist/public ./dist/public
COPY --from=build-server --chown=spillway:spillway /prod/node_modules ./node_modules
COPY --from=build-server --chown=spillway:spillway /prod/package.json ./
# Founder landing page — staticPlugin serves it at / from process.cwd()/apps/landing.
# EXPLICIT ALLOWLIST, not the whole directory: everything under apps/landing is served publicly
# and unauthenticated, and that directory is edited by hand during design work. A wildcard copy
# publishes whatever happens to be sitting there — a screenshot script, a variant draft, a note.
# Adding an asset means adding a line here; that friction is the point.
COPY --from=build-server --chown=spillway:spillway /app/apps/landing/index.html ./apps/landing/
COPY --from=build-server --chown=spillway:spillway /app/apps/landing/spillway-home.css ./apps/landing/
COPY --from=build-server --chown=spillway:spillway /app/apps/landing/gr-scene.js ./apps/landing/
COPY --from=build-server --chown=spillway:spillway /app/apps/landing/og.png ./apps/landing/
COPY --from=build-server --chown=spillway:spillway /app/apps/landing/apple-touch-icon.png ./apps/landing/
COPY --from=build-server --chown=spillway:spillway /app/apps/landing/vendor ./apps/landing/vendor

# Drizzle migration files (needed for release_command)
COPY --from=build-server --chown=spillway:spillway /app/apps/server/src/db/migrations ./apps/server/src/db/migrations
COPY --from=build-server --chown=spillway:spillway /app/drizzle.config.ts ./

USER spillway
EXPOSE 3000

# Healthcheck (Fly also does this via http_service health checks)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/healthz', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# dumb-init as PID 1; node as the supervised process
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/apps/server/src/index.js"]
