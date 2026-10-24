import type { FastifyInstance } from 'fastify';
import { getNonce, htmlCsp } from './csp.js';

/**
 * Baseline security response headers (10-security §7.1). Registered as a ROOT-level onSend hook (not an
 * encapsulated plugin — a plugin-scoped hook would only wrap that plugin's own routes, missing every
 * sibling plugin) so it applies to EVERY response the server emits.
 *
 * The tricky constraint: this one server hosts three very different surfaces — the JSON control/data
 * plane, the dashboard SPA, and the founder's WebGL landing page (which uses inline scripts and must
 * not be altered without sign-off, ADR-019j). A blanket `default-src 'self'` CSP would break the
 * landing's inline scripts. So we split:
 *   - Universally safe headers (nosniff, frame-deny, referrer, permissions, HSTS on TLS) everywhere —
 *     none of these affect script/style execution, so no page can break.
 *   - A strict `default-src 'none'` CSP ONLY on JSON/CSV API responses, where there is nothing to render.
 *   - A nonce-based `script-src` on HTML DOCUMENTS (see csp.ts). The document routes in static.ts
 *     mint the nonce and stamp it into their script tags; this hook only reads it back. A request
 *     without a nonce is by definition not a document we rendered, so it never gets that policy.
 *   - `frame-ancestors 'none'` CSP everywhere else (clickjacking defense; does not restrict
 *     scripts/styles), which covers static assets — a CSP on a .css or .js response gates nothing.
 */
export function addSecurityHeaders(fastify: FastifyInstance): void {
  fastify.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), browsing-topics=()',
    );
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');

    // HSTS only makes sense over TLS. Read `request.protocol`, NOT the raw x-forwarded-proto header:
    // Fastify already derives protocol from the trusted hop (see TRUST_PROXY_HOPS in app.ts), so the
    // header is client-controlled input. Trusting it let a plaintext client pin itself with a
    // one-year HSTS header, and behind two proxies the header is a LIST ("https,http") that never
    // equals 'https' — silently dropping HSTS on genuinely TLS traffic. Both bugs, one line.
    if (request.protocol === 'https')
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

    const nonce = getNonce(request);
    const contentType = String(reply.getHeader('content-type') ?? '');
    if (nonce) {
      reply.header('Content-Security-Policy', htmlCsp(nonce));
    } else if (contentType.includes('text/html')) {
      // FAIL CLOSED. An HTML document with no nonce did not come from the document routes in
      // static.ts, so its script tags are unstamped and a nonce policy would block its own scripts
      // anyway. Serving it with only `frame-ancestors` would leave a page with NO script-src —
      // silently, which is how /app/index.html slipped past @fastify/static's `index: false` and
      // shipped uncovered. `script-src 'none'` turns any future gap into a blank page in review
      // instead of a hole in production. Every legitimate document goes through those routes.
      reply.header(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      );
    } else if (contentType.includes('application/json') || contentType.includes('text/csv')) {
      // API/CSV responses render nothing — lock them all the way down.
      reply.header(
        'Content-Security-Policy',
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      );
    } else {
      // HTML/asset responses: clickjacking defense only (safe — does not gate scripts/styles).
      reply.header('Content-Security-Policy', "frame-ancestors 'none'");
    }
    return payload;
  });
}
