import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { fetch as undiciFetch } from 'undici';
import { ssrfConnector, ssrfGuardedDispatcher } from './egress-guard.js';

type ConnectOpts = Parameters<typeof ssrfConnector>[0];

/** Drive the connector directly; resolve {blocked} without opening a real socket for reserved hosts. */
function connect(hostname: string): Promise<{ blocked: boolean; msg?: string }> {
  return new Promise((resolve) => {
    ssrfConnector(
      { hostname, host: hostname, protocol: 'http:', port: '80' } as ConnectOpts,
      (err, socket) => {
        if (socket) socket.destroy();
        resolve({ blocked: !!err, msg: err?.message });
      },
    );
  });
}

describe('SSRF egress guard (M2 red-team)', () => {
  it('refuses a loopback host', async () => {
    expect((await connect('127.0.0.1')).blocked).toBe(true);
  });

  it('refuses the cloud-metadata / link-local address', async () => {
    expect((await connect('169.254.169.254')).blocked).toBe(true);
  });

  it('refuses a private-range address', async () => {
    expect((await connect('10.0.0.5')).blocked).toBe(true);
  });

  it('the guarded dispatcher blocks egress to a loopback-resolving host even with a live listener (a bypass would 200)', async () => {
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((r) => server.listen(0, () => r())); // all interfaces (both families)
    const { port } = server.address() as { port: number };
    try {
      await expect(
        undiciFetch(`http://localhost:${port}/`, { dispatcher: ssrfGuardedDispatcher() }),
      ).rejects.toThrow();
    } finally {
      server.close();
    }
  });
});
