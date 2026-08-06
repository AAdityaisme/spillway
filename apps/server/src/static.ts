import type { FastifyPluginAsync } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Static assets (02-architecture §1):
 *   /      → the marketing landing page (apps/landing)
 *   /app   → the dashboard SPA (M4-auth)
 *
 * The Dockerfile has always copied the SPA build to dist/public, but nothing served it — so
 * /app 404'd and the AuthKit callback redirected into a void. This wires it.
 *
 * The SPA is mounted in an ENCAPSULATED scope so its catch-all only claims /app/*. A root-level
 * notFoundHandler would swallow unknown /api and /v1 paths and answer them with HTML, turning
 * clean 404 JSON into something an SDK cannot parse.
 */
export const staticPlugin: FastifyPluginAsync = async (fastify) => {
  const cwd = process.cwd();

  // Production image puts it at dist/public; a local `pnpm build` leaves it in apps/web/dist.
  const spaDir = [path.resolve(cwd, 'dist/public'), path.resolve(cwd, 'apps/web/dist')].find(
    (dir) => existsSync(path.join(dir, 'index.html')),
  );

  if (spaDir) {
    const indexHtml = readFileSync(path.join(spaDir, 'index.html'), 'utf8');
    // A prefixed scope matches `/app/...` but NOT bare `/app`, which would otherwise fall through
    // to the landing scope and 404. The AuthKit callback redirects here, so this is load-bearing.
    fastify.get('/app', async (_request, reply) => reply.redirect('/app/', 302));
    await fastify.register(
      async (scope) => {
        await scope.register(fastifyStatic, {
          root: spaDir,
          prefix: '/',
          // The landing registration below owns reply.sendFile; registering it twice throws.
          decorateReply: false,
        });
        // History-API fallback: /app/budgets is a client-side route with no file behind it.
        // Without this, a deep link or a refresh anywhere off the index 404s.
        scope.setNotFoundHandler((_request, reply) => {
          reply.type('text/html').send(indexHtml);
        });
      },
      { prefix: '/app' },
    );
  } else {
    fastify.log.warn({ cwd }, 'dashboard SPA bundle not found; /app will 404');
  }

  const landingDir = path.resolve(cwd, 'apps/landing');
  if (!existsSync(landingDir)) {
    fastify.log.warn({ landingDir }, 'landing assets not found; static plugin idle');
    return;
  }
  await fastify.register(fastifyStatic, { root: landingDir, prefix: '/' });
};
