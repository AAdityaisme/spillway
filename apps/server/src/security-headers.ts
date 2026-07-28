import type { FastifyInstance } from 'fastify';

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
 *   - `frame-ancestors 'none'` CSP everywhere (clickjacking defense; does not restrict scripts/styles).
 * A full script-src CSP for the SPA/landing is a deliberate follow-up (needs per-page nonces to avoid
 * breaking the WebGL landing) and is tracked, not silently dropped.
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

    // HSTS only makes sense over TLS; behind Fly's proxy the original scheme is x-forwarded-proto.
    const proto = (request.headers['x-forwarded-proto'] as string | undefined) ?? request.protocol;
    if (proto === 'https')
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

    const contentType = String(reply.getHeader('content-type') ?? '');
    if (contentType.includes('application/json') || contentType.includes('text/csv')) {
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
