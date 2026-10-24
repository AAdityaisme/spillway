import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { injectNonce, makeNonce, setNonce } from './csp.js';

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
 *
 * Both index documents are served by OUR OWN handlers rather than by @fastify/static, because each
 * response needs a fresh CSP nonce stamped into its script tags (csp.ts). @fastify/static streams
 * files straight from disk, which cannot be rewritten per request. Static routes beat the plugin's
 * `/*` wildcard in find-my-way, so registering these alongside it is enough to claim the documents.
 */

/**
 * Reads an HTML document, injecting a per-response nonce and recording it for the security-headers
 * hook. Cached at boot in production (the file is immutable in the image); re-read every request
 * otherwise, so editing the landing page during design work does not need a server restart.
 */
function makeDocumentHandler(file: string) {
  const cached = process.env.NODE_ENV === 'production' ? readFileSync(file, 'utf8') : null;
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const nonce = makeNonce();
    setNonce(request, nonce);
    const html = cached ?? readFileSync(file, 'utf8');
    return reply.type('text/html; charset=utf-8').send(injectNonce(html, nonce));
  };
}

export const staticPlugin: FastifyPluginAsync = async (fastify) => {
  const cwd = process.cwd();

  // Production image puts it at dist/public; a local `pnpm build` leaves it in apps/web/dist.
  const spaDir = [path.resolve(cwd, 'dist/public'), path.resolve(cwd, 'apps/web/dist')].find(
    (dir) => existsSync(path.join(dir, 'index.html')),
  );

  if (spaDir) {
    const spaIndex = makeDocumentHandler(path.join(spaDir, 'index.html'));
    await fastify.register(
      async (scope) => {
        await scope.register(fastifyStatic, {
          root: spaDir,
          prefix: '/',
          // The landing registration below owns reply.sendFile; registering it twice throws.
          decorateReply: false,
          // The document is ours (nonce injection); let the plugin serve only real asset files.
          index: false,
        });
        // Registering '/' inside a prefixed scope claims BOTH `/app` and `/app/` (Fastify's default
        // prefixTrailingSlash). Bare `/app` is load-bearing — the AuthKit callback redirects there —
        // and it used to need its own 302 because @fastify/static's wildcard does not match it.
        // Serving the document directly is one hop shorter. Vite's base is '/app/', so every asset
        // URL in the document is absolute and both spellings resolve identically.
        scope.get('/', spaIndex);
        // @fastify/static still serves a file by its EXPLICIT path even with `index: false`, so
        // without this line /app/index.html reached the browser straight off disk — no nonce on its
        // script tag and no script-src at all, which is the exact XSS→/auth/session path csp.ts
        // exists to close. The landing scope has the same line for the same reason. The hook in
        // security-headers.ts now also fails closed on un-nonced HTML, so a future gap breaks loudly.
        scope.get('/index.html', spaIndex);
        // History-API fallback: /app/budgets is a client-side route with no file behind it.
        // Without this, a deep link or a refresh anywhere off the index 404s.
        scope.setNotFoundHandler(spaIndex);
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
  const landingIndex = makeDocumentHandler(path.join(landingDir, 'index.html'));
  fastify.get('/', landingIndex);
  fastify.get('/index.html', landingIndex);
  await fastify.register(fastifyStatic, { root: landingDir, prefix: '/', index: false });
};
