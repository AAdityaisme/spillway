import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { SpillwayError, DEFAULT_ERRORS_DOCS_URL, setErrorsDocsUrl } from '@spillway/shared';
import { buildApp, LOG_REDACT_PATHS } from './app.js';
import { testConfig } from '../test/helpers/config.js';

/**
 * Phase 1 hardening invariants that live in app.ts: whose x-forwarded-for entry becomes `req.ip`,
 * and what pino is allowed to write to the log stream.
 */

describe('trustProxy hop count', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
  });

  /** Echoes the IP every IP-keyed control (rate limits, JWT-fail lockout) keys on. */
  async function ipFor(xff?: string): Promise<string> {
    app = await buildApp({ config: testConfig() });
    app.get('/__ip', async (req) => ({ ip: req.ip }));
    const res = await app.inject({
      method: 'GET',
      url: '/__ip',
      ...(xff ? { headers: { 'x-forwarded-for': xff } } : {}),
    });
    return JSON.parse(res.body).ip;
  }

  it('takes the LAST forwarded entry — the one our own proxy appended', async () => {
    // With `trustProxy: true` this returned '1.1.1.1', the leftmost value, which the CLIENT writes.
    // Any attacker could then mint a fresh identity per request and never hit a rate limit.
    expect(await ipFor('1.1.1.1, 2.2.2.2')).toBe('2.2.2.2');
  });

  it('always takes the rightmost entry however long the client makes the chain', async () => {
    // This is the actual defense. A client cannot APPEND to x-forwarded-for — our proxy appends
    // last, after whatever the client sent. So padding the header only pushes the forged values
    // further left, away from the one slot we read. With `trustProxy: true` the opposite was true:
    // the more a client prepended, the further the trusted value moved out of reach.
    expect(await ipFor('1.1.1.1, 2.2.2.2, 3.3.3.3, 4.4.4.4')).toBe('4.4.4.4');
  });

  it('reads a lone entry as proxy-supplied (exactly one hop is configured)', async () => {
    // Only sound while the socket peer really is our proxy. If this process is ever exposed
    // directly to the internet, a client speaks to it with no proxy in between and this value is
    // attacker-chosen — which is why TRUST_PROXY_HOPS must track the real topology, not a guess.
    expect(await ipFor('9.9.9.9')).toBe('9.9.9.9');
  });

  it('falls back to the socket address with no header at all', async () => {
    expect(await ipFor()).toBe('127.0.0.1');
  });
});

describe('SPILLWAY_DOCS_URL wiring', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
    // Errors' docs base is shared module state (packages/shared/src/errors.ts) — buildApp only
    // SETS it when a config is passed, it never resets. Restore it explicitly so this test's
    // override doesn't leak into whatever runs next in this file/process.
    setErrorsDocsUrl(DEFAULT_ERRORS_DOCS_URL);
  });

  it('propagates config.SPILLWAY_DOCS_URL into every SpillwayError constructed afterward', async () => {
    app = await buildApp({
      config: testConfig({ SPILLWAY_DOCS_URL: 'https://docs.example.com/errors' }),
    });
    expect(new SpillwayError('internal_error', 'boom', { httpStatus: 500 }).docsUrl).toBe(
      'https://docs.example.com/errors#internal_error',
    );
  });

  it('an app built without an explicit config leaves the shared default in place', async () => {
    app = await buildApp({});
    expect(new SpillwayError('internal_error', 'boom', { httpStatus: 500 }).docsUrl).toBe(
      `${DEFAULT_ERRORS_DOCS_URL}#internal_error`,
    );
  });
});

describe('pino redaction', () => {
  /** Captures one log line written with the real redaction config. */
  function logged(obj: object): string {
    const lines: string[] = [];
    const log = pino({ redact: LOG_REDACT_PATHS }, { write: (c: string) => lines.push(c) });
    log.info(obj, 'test');
    return lines.join('');
  }

  it('redacts a TOP-LEVEL access_token', () => {
    // The old list was `*.access_token` only, and pino's `*` matches exactly one level — so the
    // shape /auth/session actually returns logged the bearer token verbatim.
    expect(logged({ access_token: 'at_live_secret' })).not.toContain('at_live_secret');
  });

  it('redacts a deeply nested one', () => {
    const line = logged({ res: { body: { data: { access_token: 'at_live_secret' } } } });
    expect(line).not.toContain('at_live_secret');
  });

  it('redacts the Set-Cookie response header (it carries the sealed session)', () => {
    const line = logged({ res: { headers: { 'set-cookie': 'spillway_session=sealed_abc' } } });
    expect(line).not.toContain('sealed_abc');
  });

  it('covers provider-key material and webhook URLs at every depth', () => {
    const line = logged({
      a: {
        plaintext: 'sk-real',
        b: { key_ciphertext: 'ct', webhook_url: 'https://hooks/T00/B11' },
      },
    });
    expect(line).not.toContain('sk-real');
    expect(line).not.toContain('B11');
  });

  it('leaves ordinary fields alone', () => {
    expect(logged({ org_id: 'org_1', total_tokens: 42 })).toContain('org_1');
  });
});
