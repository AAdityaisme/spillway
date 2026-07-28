import type { EmailSender } from './delivery.js';

type FetchLike = (
  url: string,
  init: Record<string, unknown>,
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Resend-backed EmailSender for alert delivery (20 §5). A non-2xx throws WITH the response body —
 * the drain retries the row and the error lands in the delivery dead-letter, where a bare status
 * code would force a manual re-send to re-diagnose (same lesson as certifier task #21).
 */
export function makeResendEmailSender(
  apiKey: string,
  from: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): EmailSender {
  return {
    async send(to, subject, text) {
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to, subject, text }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`resend ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
      }
    },
  };
}
