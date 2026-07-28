import { describe, it, expect, vi } from 'vitest';
import { makeResendEmailSender } from './resend.js';

describe('makeResendEmailSender', () => {
  it('POSTs the Resend payload with bearer auth', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    const sender = makeResendEmailSender('re_key', 'alerts@spillway.dev', fetchImpl);
    await sender.send('ops@acme.ai', '[HIGH] budget_threshold', 'details in dashboard');

    expect(fetchImpl).toHaveBeenCalledWith('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: 'Bearer re_key', 'content-type': 'application/json' },
      body: JSON.stringify({
        from: 'alerts@spillway.dev',
        to: 'ops@acme.ai',
        subject: '[HIGH] budget_threshold',
        text: 'details in dashboard',
      }),
    });
  });

  it('throws with the response body on non-2xx so the drain retry/dead-letter keeps the WHY', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => '{"message":"The spillway.dev domain is not verified"}',
    });
    const sender = makeResendEmailSender('re_key', 'alerts@spillway.dev', fetchImpl);
    await expect(sender.send('ops@acme.ai', 's', 't')).rejects.toThrow(
      /resend 422.*domain is not verified/,
    );
  });
});
