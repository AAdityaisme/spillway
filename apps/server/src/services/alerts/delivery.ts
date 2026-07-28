import { sql } from 'drizzle-orm';
import { randomUUID, createHmac } from 'node:crypto';
import type { DatabaseClient } from '../../db/client.js';
import { asJobs } from '../../db/jobs.js';
import { withOrg } from '../../db/tenancy.js';
import { defaultSeverityForKind } from '../alert-kinds.js';
import { alertDeliveryDeadLetterTotal } from '../../observability/metrics.js';

/** After this many failed sends an event is dead-lettered (excluded from the claim + counted). */
const MAX_DELIVERY_ATTEMPTS = 5;

/** §5.2 exponential backoff (minutes) keyed off delivery_attempts: immediate, 1, 2, 5, 15. */
const BACKOFF_MINUTES = [0, 1, 2, 5, 15];

/**
 * Alert-delivery job (Part II §20 §5). Drains undelivered `alert_events` cross-org and delivers each to
 * ITS OWN org's configured channels (Slack / email / HMAC webhook), severity-gated. Multi-tenant by
 * construction: an event's channels come from its own `alerts.channels` (alert_id rows) or its
 * `payload.channels` (synthetic alert_id=NULL rows), so one org's alert can NEVER reach another org's
 * channel. Durable at-least-once: `delivered_at` is stamped only AFTER every channel succeeds (a crash
 * or partial failure re-drains — a channel may see a duplicate, §5.2); a failure bumps delivery_attempts
 * + records last_error and defers the row by the backoff. `info` is delivery-suppressed (dashboard-only,
 * §5.4). Channel payloads carry ONLY routing fields (event kind + ids) — NEVER the raw payload, which
 * holds spend figures + scope ids (expanded-audit CRITICAL data-exfil guard).
 */

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface DeliverableAlert {
  eventId: string;
  orgId: string;
  severity: AlertSeverity;
  payload: Record<string, unknown>;
}

export type Channel =
  | { type: 'slack'; webhook_url: string }
  | { type: 'email'; to: string }
  | { type: 'webhook'; url: string; secret: string };

/** A channel dispatcher (Slack Block Kit / email / HMAC webhook). Injected so the drain is testable
 *  without HTTP; the production router lives in makeHttpChannelSink. */
export interface ChannelSink {
  deliver(channel: Channel, alert: DeliverableAlert): Promise<void>;
}

/** Email transport (Resend in prod), injected for testability. */
export interface EmailSender {
  send(to: string, subject: string, text: string): Promise<void>;
}

export interface DeliveryDeps {
  jobsDb: DatabaseClient;
  db: DatabaseClient;
  sink: ChannelSink;
  now?: () => Date;
}

export interface DeliveryResult {
  delivered: number;
  suppressed: number;
  failed: number;
  deadLettered: number;
}

interface EventRow {
  id: string;
  org_id: string;
  payload: Record<string, unknown> | string;
  channels: unknown; // joined alerts.channels (alert_id rows) — null for synthetic rows
  attempts: number;
}

interface ClaimedEventRow extends EventRow {
  lease_id: string;
}

function asJson<T>(v: unknown): T {
  return (typeof v === 'string' ? JSON.parse(v) : v) as T;
}

/** Severity from the payload; defaults to 'warning' for a kind with no explicit severity (never silent). */
export function severityOf(payload: Record<string, unknown>): AlertSeverity {
  const s = payload['severity'];
  return s === 'info' || s === 'critical' ? s : 'warning';
}

/** Coerce a raw jsonb channels array into typed, structurally-valid Channel entries (drops malformed). */
export function parseChannels(raw: unknown): Channel[] {
  const arr = asJson<unknown>(raw);
  if (!Array.isArray(arr)) return [];
  const out: Channel[] = [];
  for (const c of arr) {
    if (!c || typeof c !== 'object') continue;
    const r = c as Record<string, unknown>;
    if (r.type === 'slack' && typeof r.webhook_url === 'string')
      out.push({ type: 'slack', webhook_url: r.webhook_url });
    else if (r.type === 'email' && typeof r.to === 'string') out.push({ type: 'email', to: r.to });
    else if (r.type === 'webhook' && typeof r.url === 'string' && typeof r.secret === 'string')
      out.push({ type: 'webhook', url: r.url, secret: r.secret });
  }
  return out;
}

type FetchLike = (
  url: string,
  init: Record<string, unknown>,
) => Promise<{ ok: boolean; status: number }>;

/**
 * The production channel router: Slack Incoming-Webhook (Block Kit), generic HMAC-signed webhook, and
 * email (Resend). Every channel body carries ONLY the severity, event kind, org id, and event id — the
 * details are looked up by event id in the dashboard. A non-2xx (slack/webhook) or a throwing email send
 * bubbles up so the drain retries the row.
 */
export function makeHttpChannelSink(opts: { fetch: FetchLike; email?: EmailSender }): ChannelSink {
  return {
    async deliver(channel, alert) {
      const kind = String(alert.payload['event_type'] ?? 'alert');
      const text = `[${alert.severity.toUpperCase()}] ${kind}`;
      const context = `org \`${alert.orgId}\` · event \`${alert.eventId}\``;
      if (channel.type === 'slack') {
        const res = await opts.fetch(channel.webhook_url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text,
            blocks: [
              { type: 'section', text: { type: 'mrkdwn', text } },
              { type: 'context', elements: [{ type: 'mrkdwn', text: context }] },
            ],
          }),
        });
        if (!res.ok) throw new Error(`slack webhook ${res.status}`);
      } else if (channel.type === 'webhook') {
        // Privacy-safe body — routing fields only. HMAC-SHA256 over the exact bytes (§5.6).
        const body = JSON.stringify({
          event_type: kind,
          severity: alert.severity,
          org_id: alert.orgId,
          event_id: alert.eventId,
        });
        const signature = createHmac('sha256', channel.secret).update(body).digest('hex');
        const res = await opts.fetch(channel.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-spillway-signature': signature,
            'x-spillway-event': kind,
          },
          body,
        });
        // 2xx = success; 4xx and 5xx both throw (retried until the cap → dead-letter). A finer
        // 4xx=permanent distinction is a follow-up; retrying a 4xx a few times is harmless.
        if (res.status < 200 || res.status >= 300) throw new Error(`webhook ${res.status}`);
      } else {
        if (!opts.email) throw new Error('email channel configured but no email sender wired');
        await opts.email.send(
          channel.to,
          text,
          `A ${alert.severity} ${kind} alert fired. Open the Spillway dashboard for details (event ${alert.eventId}).`,
        );
      }
    },
  };
}

/** §5.6 test-fire per-channel outcome. `target` is the channel's destination (webhook URL / email). */
export interface TestChannelResult {
  channel: Channel['type'];
  target: string;
  ok: boolean;
  error?: string;
}

const TEST_FIRE_TIMEOUT_MS = 15_000;

/** Reject if `p` hasn't settled within `ms` (the test-fire endpoint is synchronous — a hung channel
 *  must not hold the request open indefinitely). The timer is cleared on settle so it never keeps the
 *  event loop alive; a timed-out underlying send is abandoned (its result is discarded). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`delivery timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * §5.6 test-fire: synthesize a mock payload for the alert's `kind` (severity from the kind's default)
 * and deliver it DIRECTLY to each configured channel — bypassing the queue, dedupe, and severity
 * suppression — so an operator can verify their Slack/webhook/email wiring. Each channel is delivered
 * independently and bounded by a 15 s timeout; a channel failure becomes `ok:false` rather than
 * aborting the others. No alert_events row, no audit entry (§5.6). Never throws.
 */
export async function deliverTestFire(
  args: { orgId: string; kind: string; channels: Channel[] },
  sink: ChannelSink,
  opts: { timeoutMs?: number } = {},
): Promise<TestChannelResult[]> {
  const timeoutMs = opts.timeoutMs ?? TEST_FIRE_TIMEOUT_MS;
  const severity = defaultSeverityForKind(args.kind);
  const alert: DeliverableAlert = {
    eventId: `test-${randomUUID()}`,
    orgId: args.orgId,
    severity,
    payload: { event_type: args.kind, test: true, severity },
  };
  const targetOf = (c: Channel): string =>
    c.type === 'slack' ? c.webhook_url : c.type === 'email' ? c.to : c.url;
  return Promise.all(
    args.channels.map(async (channel): Promise<TestChannelResult> => {
      const base = { channel: channel.type, target: targetOf(channel) };
      try {
        await withTimeout(sink.deliver(channel, alert), timeoutMs);
        return { ...base, ok: true };
      } catch (err) {
        return { ...base, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
}

export async function runAlertDelivery(deps: DeliveryDeps): Promise<DeliveryResult> {
  const result: DeliveryResult = { delivered: 0, suppressed: 0, failed: 0, deadLettered: 0 };
  const now = deps.now ?? ((): Date => new Date());
  const leaseId = randomUUID();

  // Claim undelivered events across ALL orgs (jobs role), joining the alert's channels for alert_id rows.
  const rows = (await asJobs(
    deps.jobsDb,
    (tx) =>
      tx.execute(sql`
        with candidates as (
          select id from alert_events
           where delivered_at is null
             and delivery_attempts < ${MAX_DELIVERY_ATTEMPTS}
             and (delivery_lease_until is null or delivery_lease_until < now())
           order by fired_at asc
           for update skip locked
           limit 200
        )
        update alert_events e
           set delivery_lease_id = ${leaseId}::uuid,
               delivery_lease_until = now() + interval '5 minutes'
          from candidates
         where e.id = candidates.id
        returning e.id, e.org_id, e.payload, e.delivery_attempts as attempts,
                  e.delivery_lease_id as lease_id,
                  (select a.channels from alerts a where a.id = e.alert_id) as channels`) as unknown as Promise<
        ClaimedEventRow[]
      >,
  )) as unknown as ClaimedEventRow[];

  for (const row of rows) {
    const payload = asJson<Record<string, unknown>>(row.payload);
    const severity = severityOf(payload);

    // §5.4 info is delivery-suppressed. A warning/critical event with NO channels is likewise nothing
    // to send (dashboard-only) — both stamp delivered without a send.
    // alert_id rows use the joined alerts.channels; synthetic (alert_id NULL) rows use payload.channels.
    const channels =
      row.channels != null ? parseChannels(row.channels) : parseChannels(payload['channels']);
    if (severity === 'info' || channels.length === 0) {
      await withOrg(deps.db, row.org_id, (tx) =>
        tx.execute(sql`
          update alert_events
             set delivered_at = now(), delivery_lease_id = null, delivery_lease_until = null
           where id = ${row.id} and delivery_lease_id = ${row.lease_id}::uuid`),
      );
      result.suppressed++;
      continue;
    }

    const alert: DeliverableAlert = { eventId: row.id, orgId: row.org_id, severity, payload };
    try {
      // Deliver to every configured channel; ANY failure re-drains the whole event (§5.2).
      for (const channel of channels) await deps.sink.deliver(channel, alert);
      await withOrg(deps.db, row.org_id, (tx) =>
        tx.execute(sql`
          update alert_events
             set delivered_at = now(), delivery_lease_id = null, delivery_lease_until = null
           where id = ${row.id} and delivery_lease_id = ${row.lease_id}::uuid`),
      );
      result.delivered++;
    } catch (err) {
      // Defer by the exponential backoff for the NEW attempt count; dead-letter at the cap.
      const nextAttempts = Number(row.attempts) + 1;
      const delayMin = BACKOFF_MINUTES[nextAttempts] ?? 15;
      const until = new Date(now().getTime() + delayMin * 60_000).toISOString();
      await withOrg(deps.db, row.org_id, (tx) =>
        tx.execute(sql`
          update alert_events
             set delivery_attempts = ${nextAttempts}, last_error = ${String(err)},
                 delivery_lease_id = null, delivery_lease_until = ${until}
           where id = ${row.id} and delivery_lease_id = ${row.lease_id}::uuid`),
      );
      result.failed++;
      if (nextAttempts >= MAX_DELIVERY_ATTEMPTS) {
        alertDeliveryDeadLetterTotal.inc();
        result.deadLettered++;
      }
    }
  }
  return result;
}
