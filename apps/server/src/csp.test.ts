import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { testConfig } from '../test/helpers/config.js';
import { htmlCsp, injectNonce, makeNonce } from './csp.js';

/**
 * Nonce-based script-src (Phase 1 of the pre-launch security program).
 *
 * The property that matters: an injected `<script>` in the landing or SPA document must not
 * execute, because it cannot carry the nonce. Everything below is a proxy for that — the browser
 * is what enforces it, so these tests pin the two halves we control (the header says nonce-X, the
 * document's OWN scripts carry exactly that X, and a fresh X is minted per response).
 */
describe('CSP nonce', () => {
  it('mints a fresh 128-bit nonce per call', () => {
    const a = makeNonce();
    const b = makeNonce();
    expect(a).not.toBe(b);
    expect(Buffer.from(a, 'base64')).toHaveLength(16);
  });

  it('stamps every script tag, whatever its attributes', () => {
    const html = injectNonce(
      '<script>inline()</script><script type="module" src="/a.js"></script>',
      'N',
    );
    expect(html).toBe(
      '<script nonce="N">inline()</script><script nonce="N" type="module" src="/a.js"></script>',
    );
  });

  it('does not maul a tag that merely starts with "script"', () => {
    expect(injectNonce('<scripty-thing>', 'N')).toBe('<scripty-thing>');
  });

  it("keeps 'self' in script-src so ES module imports still resolve", () => {
    // gr-scene.js imports ./vendor/three.module.min.js — imports do NOT inherit a nonce, so
    // dropping 'self' would silently black-hole the landing page's WebGL scene.
    expect(htmlCsp('N')).toContain("script-src 'self' 'nonce-N'");
  });

  it('never emits unsafe-inline or unsafe-eval for scripts', () => {
    const scriptSrc = htmlCsp('N')
      .split('; ')
      .find((d) => d.startsWith('script-src'))!;
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(scriptSrc).not.toContain('unsafe-eval');
  });

  it('blocks plugin, base-tag and off-origin form-post escapes', () => {
    const csp = htmlCsp('N');
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'self'");
  });
});

describe('CSP nonce — wired end to end', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
  });

  it('serves the landing document with a header nonce matching its script tags', async () => {
    app = await buildApp({ config: testConfig() });
    const res = await app.inject({ method: 'GET', url: '/' });

    expect(res.statusCode).toBe(200);
    const csp = String(res.headers['content-security-policy']);
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();

    // Every script tag in the document carries THAT nonce, and none is left bare.
    const tags = res.body.match(/<script[^>]*>/gi) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) expect(tag).toContain(`nonce="${nonce}"`);
  });

  it('re-rolls the nonce on every response (a fixed one is no better than unsafe-inline)', async () => {
    app = await buildApp({ config: testConfig() });
    const nonceOf = async () =>
      /'nonce-([^']+)'/.exec(
        String((await app.inject({ method: 'GET', url: '/' })).headers['content-security-policy']),
      )?.[1];
    expect(await nonceOf()).not.toBe(await nonceOf());
  });

  it('covers /index.html on BOTH surfaces — @fastify/static serves it by explicit path', async () => {
    // Regression: `index: false` stops the plugin serving a DIRECTORY index, not a file requested
    // by name. /app/index.html was reaching the browser straight off disk with a bare <script> and
    // no script-src at all — the exact XSS -> /auth/session token-minting path this CSP exists for.
    app = await buildApp({ config: testConfig() });
    for (const url of ['/', '/index.html', '/app', '/app/', '/app/index.html', '/app/budgets']) {
      const res = await app.inject({ method: 'GET', url });
      const csp = String(res.headers['content-security-policy']);
      const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
      expect(nonce, `${url} served without a nonce CSP`).toBeTruthy();
      for (const tag of res.body.match(/<script[^>]*>/gi) ?? [])
        expect(tag, `${url} has an unstamped script tag`).toContain(`nonce="${nonce}"`);
    }
  });

  it('fails CLOSED: HTML that skipped the document routes gets script-src none', async () => {
    // Defence in depth for the bug above. Enumerating document paths is fragile; this makes any
    // future gap render a blank page in review instead of shipping a page with no script-src.
    app = await buildApp({ config: testConfig() });
    app.get('/__raw', async (_req, reply) => reply.type('text/html').send('<script>x()</script>'));
    const csp = String(
      (await app.inject({ method: 'GET', url: '/__raw' })).headers['content-security-policy'],
    );
    expect(csp).toContain("script-src 'none'");
    expect(csp).not.toContain('nonce-');
  });

  it('leaves the strict default-src none CSP on JSON responses', async () => {
    app = await buildApp({ config: testConfig() });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(String(res.headers['content-security-policy'])).toContain("default-src 'none'");
    expect(String(res.headers['content-security-policy'])).not.toContain('nonce-');
  });
});
