# syntax=docker/dockerfile:1.7
FROM node:22.4-slim AS base
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
# pnpm 10 requires --legacy unless the workspace opts into injected packages.
# Keep the deploy offline: the preceding fetch stage populates this shared cache.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm --filter @spillway/server deploy --prod --legacy --offline /prod
# Output: dist/ (server TS compiled) and apps/web/dist/ (SPA static)
# Copy web dist into server's static dir so single process serves SPA
RUN cp -r apps/web/dist apps/server/dist/public \
    # dist/public is served publicly under /app. A shipped .map lets anyone reconstruct the
    # dashboard source, including the client-side auth flow — belt-and-braces with the vite
    # sourcemap setting, since this holds no matter how the SPA was built.
    && find apps/server/dist/public -name '*.map' -delete

# ────────────────────────────────────────────
# Stage 4: production runtime — production deps only, non-root user
# ────────────────────────────────────────────
FROM node:22.4-slim AS runtime
WORKDIR /app

# dumb-init: PID 1 signal forwarding + zombie reaping
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init \
    && rm -rf /var/lib/apt/lists/*

# Non-root user
RUN groupadd --system --gid 1001 spillway \
    && useradd --system --uid 1001 --gid spillway spillway

# Copy only the production build output and production node_modules
COPY --from=build-server --chown=spillway:spillway /app/dist ./dist
COPY --from=build-server --chown=spillway:spillway /app/apps/server/dist/public ./dist/public
COPY --from=build-server --chown=spillway:spillway /prod/node_modules ./node_modules
COPY --from=build-server --chown=spillway:spillway /prod/package.json ./
# Founder landing page — staticPlugin serves it at / from process.cwd()/apps/landing
COPY --from=build-server --chown=spillway:spillway /app/apps/landing ./apps/landing

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
