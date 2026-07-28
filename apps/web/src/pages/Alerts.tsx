import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { SectionError } from '../components/domain/SectionError.js';
import { PageHeader } from '../components/layout/PageHeader.js';
import { Badge } from '../components/primitives/Badge.js';
import { Button } from '../components/primitives/Button.js';
import { Dialog } from '../components/primitives/Dialog.js';
import { Drawer } from '../components/primitives/Drawer.js';
import { EmptyState } from '../components/primitives/EmptyState.js';
import { Field, Input } from '../components/primitives/Field.js';
import { PlanGate } from '../components/primitives/PlanGate.js';
import { Select } from '../components/primitives/Select.js';
import { Switch } from '../components/primitives/Switch.js';
import { Table, type Column } from '../components/primitives/Table.js';
import { Tooltip } from '../components/primitives/Tooltip.js';
import { api, type Alert } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { useOrg } from '../lib/org.js';

/** The five user-creatable kinds (04-api-contracts §alerts) — the rest (anomaly_confirmed,
 * approval_notification, automation_notification) are system-materialized and 422 on create. */
type Kind = 'budget_threshold' | 'budget_forecast' | 'anomaly' | 'error_rate' | 'key_expiry';
const KIND_VALUES: Kind[] = [
  'budget_threshold',
  'budget_forecast',
  'anomaly',
  'error_rate',
  'key_expiry',
];
function isKnownKind(k: string): k is Kind {
  return (KIND_VALUES as string[]).includes(k);
}

interface ConfigFieldSpec {
  key: string;
  label: string;
  hint?: string;
  min?: number;
  max?: number;
  step?: number;
  default: number;
}

const CONFIG_FIELDS: Record<Kind, ConfigFieldSpec[]> = {
  budget_threshold: [
    { key: 'pct', label: 'Threshold (%)', min: 10, max: 100, step: 1, default: 80 },
  ],
  budget_forecast: [
    {
      key: 'pct',
      label: 'Forecast threshold (%)',
      hint: 'Alert when the month-end forecast crosses this % of the budget.',
      min: 1,
      step: 1,
      default: 100,
    },
  ],
  anomaly: [
    { key: 'multiplier', label: 'Spike multiplier', min: 1, step: 0.1, default: 3.0 },
    { key: 'min_usd', label: 'Minimum spend (USD)', min: 0, step: 0.01, default: 5 },
  ],
  error_rate: [
    { key: 'pct', label: 'Error rate (%)', min: 1, max: 100, step: 1, default: 5 },
    { key: 'window_min', label: 'Window (minutes)', min: 1, step: 1, default: 15 },
  ],
  key_expiry: [{ key: 'days_before', label: 'Days before expiry', min: 1, step: 1, default: 7 }],
};

const KIND_SELECT_OPTIONS: Array<{ value: Kind; label: string }> = [
  { value: 'budget_threshold', label: 'Budget threshold' },
  { value: 'budget_forecast', label: 'Budget forecast — fires when on pace to exceed' },
  { value: 'anomaly', label: 'Anomaly detection' },
  { value: 'error_rate', label: 'Error rate' },
  { value: 'key_expiry', label: 'Key expiry' },
];

const KIND_BADGE_LABEL: Record<Kind, string> = {
  budget_threshold: 'budget threshold',
  budget_forecast: 'forecast',
  anomaly: 'anomaly',
  error_rate: 'error rate',
  key_expiry: 'key expiry',
};
/** System kinds (e.g. anomaly_confirmed) fall back to a de-slugged label — they're display-only here. */
function kindLabel(kind: string): string {
  return isKnownKind(kind) ? KIND_BADGE_LABEL[kind] : kind.replace(/_/g, ' ');
}

const CHANNEL_TYPE_OPTIONS = [
  { value: 'slack', label: 'Slack' },
  { value: 'email', label: 'Email' },
  { value: 'webhook', label: 'Webhook' },
];

type ChannelType = 'slack' | 'email' | 'webhook';
/** Draft carries all three field slots so switching `type` in the editor never loses typed input. */
interface ChannelDraft {
  type: ChannelType;
  webhook_url: string;
  to: string;
  url: string;
  secret: string;
}
function defaultChannel(): ChannelDraft {
  return { type: 'slack', webhook_url: '', to: '', url: '', secret: '' };
}
function toChannelDraft(raw: Record<string, unknown>): ChannelDraft {
  const type: ChannelType = raw.type === 'email' || raw.type === 'webhook' ? raw.type : 'slack';
  return {
    type,
    webhook_url: typeof raw.webhook_url === 'string' ? raw.webhook_url : '',
    to: typeof raw.to === 'string' ? raw.to : '',
    url: typeof raw.url === 'string' ? raw.url : '',
    secret: typeof raw.secret === 'string' ? raw.secret : '',
  };
}
/** Strip the unused field slots so the API only sees the keys that matter for this channel's type. */
function channelPayload(c: ChannelDraft): Record<string, unknown> {
  if (c.type === 'slack') return { type: 'slack', webhook_url: c.webhook_url };
  if (c.type === 'email') return { type: 'email', to: c.to };
  return { type: 'webhook', url: c.url, secret: c.secret };
}

interface AlertFormState {
  name: string;
  kind: Kind;
  config: Record<string, number>;
  channels: ChannelDraft[];
}
function defaultConfig(kind: Kind): Record<string, number> {
  return Object.fromEntries(CONFIG_FIELDS[kind].map((f) => [f.key, f.default]));
}
function defaultForm(): AlertFormState {
  return {
    name: '',
    kind: 'budget_threshold',
    config: defaultConfig('budget_threshold'),
    channels: [],
  };
}
/** kind is immutable post-creation (PATCH /alerts has no kind field) — caller passes the alert's own kind. */
function toFormState(alert: Alert, kind: Kind): AlertFormState {
  const config: Record<string, number> = {};
  for (const f of CONFIG_FIELDS[kind]) {
    const raw = alert.config[f.key];
    config[f.key] = typeof raw === 'number' ? raw : f.default;
  }
  return { name: alert.name, kind, config, channels: alert.channels.map(toChannelDraft) };
}
function buildConfigPayload(form: AlertFormState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of CONFIG_FIELDS[form.kind]) out[f.key] = form.config[f.key] ?? f.default;
  return out;
}

/**
 * Alerts (bible §3.11), admin+ write surface gated by the `alerts` entitlement (Pro+).
 * Table is the read (free on every plan); the create/edit drawer is the gated write.
 * budget_forecast gets a blue badge + tooltip — it's the differentiator (alerts before the
 * overage, not after), everything else reads as a neutral notification rule.
 */
export function AlertsPage() {
  const { session, activeOrgId } = useAuth();
  const { entitlements } = useOrg();
  const queryClient = useQueryClient();
  const enabled = !!session && !!activeOrgId;

  const q = useQuery({ queryKey: [activeOrgId, 'alerts'], queryFn: api.listAlerts, enabled });
  const alerts = q.data?.alerts ?? [];

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<Alert | null>(null);
  const [form, setForm] = useState<AlertFormState>(defaultForm);
  const [deleteTarget, setDeleteTarget] = useState<Alert | null>(null);

  const createMutation = useMutation({
    mutationFn: (body: {
      name: string;
      kind: string;
      config: Record<string, unknown>;
      channels: Array<Record<string, unknown>>;
    }) => api.createAlert(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [activeOrgId, 'alerts'] });
      toast.success('Alert created.');
      setDrawerOpen(false);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: {
        name?: string;
        config?: Record<string, unknown>;
        channels?: Array<Record<string, unknown>>;
      };
    }) => api.updateAlert(id, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [activeOrgId, 'alerts'] });
      toast.success('Alert updated.');
      setDrawerOpen(false);
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled: on }: { id: string; enabled: boolean }) =>
      api.updateAlert(id, { enabled: on }),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: [activeOrgId, 'alerts'] });
      toast.success(`Alert ${vars.enabled ? 'enabled' : 'disabled'}.`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteAlert(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [activeOrgId, 'alerts'] });
      toast.success('Alert deleted.');
      setDeleteTarget(null);
    },
  });

  const openCreate = (): void => {
    setEditing(null);
    setForm(defaultForm());
    setDrawerOpen(true);
  };
  const openEdit = (alert: Alert): void => {
    if (!isKnownKind(alert.kind)) return;
    setEditing(alert);
    setForm(toFormState(alert, alert.kind));
    setDrawerOpen(true);
  };
  const submit = (): void => {
    const name = form.name.trim();
    if (!name) return;
    const config = buildConfigPayload(form);
    const channels = form.channels.map(channelPayload);
    if (editing) {
      updateMutation.mutate({ id: editing.id, body: { name, config, channels } });
    } else {
      createMutation.mutate({ name, kind: form.kind, config, channels });
    }
  };

  const updateChannel = (i: number, patch: Partial<ChannelDraft>): void => {
    setForm((f) => ({
      ...f,
      channels: f.channels.map((c, idx) => (idx === i ? { ...c, ...patch } : c)),
    }));
  };
  const removeChannel = (i: number): void => {
    setForm((f) => ({ ...f, channels: f.channels.filter((_, idx) => idx !== i) }));
  };
  const addChannel = (): void => {
    setForm((f) => ({ ...f, channels: [...f.channels, defaultChannel()] }));
  };

  const kindOptions = entitlements.has('anomaly')
    ? KIND_SELECT_OPTIONS
    : KIND_SELECT_OPTIONS.filter((o) => o.value !== 'anomaly');

  const columns: Column<Alert>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (a) => <span className="text-[13px] font-medium">{a.name}</span>,
    },
    {
      key: 'kind',
      header: 'Kind',
      render: (a) =>
        a.kind === 'budget_forecast' ? (
          <Tooltip content="Forecast alerts fire when spend is ON PACE to exceed a budget — before it happens.">
            {/* span: Radix asChild needs a ref-forwarding child; Badge is a plain component */}
            <span className="inline-flex">
              <Badge variant="blue">{kindLabel(a.kind)}</Badge>
            </span>
          </Tooltip>
        ) : (
          <Badge variant="neutral">{kindLabel(a.kind)}</Badge>
        ),
    },
    {
      key: 'scope',
      header: 'Scope',
      render: (a) => (
        <span className="text-[12.5px] text-[var(--ink-mut)]">{a.scopeType ?? 'org-wide'}</span>
      ),
    },
    {
      key: 'channels',
      header: 'Channels',
      render: (a) => (
        <span className="num text-[12.5px] text-[var(--ink-mut)]">
          {a.channels.length} channel{a.channels.length === 1 ? '' : 's'}
        </span>
      ),
    },
    {
      key: 'enabled',
      header: 'Enabled',
      render: (a) => (
        <Switch
          checked={a.enabled}
          onCheckedChange={(v) => toggleMutation.mutate({ id: a.id, enabled: v })}
          disabled={toggleMutation.isPending && toggleMutation.variables?.id === a.id}
          testId="alerts-row-enabled-switch"
        />
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (a) => (
        <span className="flex justify-end gap-1.5">
          {isKnownKind(a.kind) ? (
            <Button
              variant="ghost"
              size="sm"
              icon={<Pencil size={13} aria-hidden />}
              onClick={() => openEdit(a)}
              data-testid="alerts-row-edit-btn"
            >
              Edit
            </Button>
          ) : null}
          <Button
            variant="danger-ghost"
            size="sm"
            icon={<Trash2 size={13} aria-hidden />}
            onClick={() => setDeleteTarget(a)}
            data-testid="alerts-row-delete-btn"
          >
            Delete
          </Button>
        </span>
      ),
    },
  ];

  return (
    <PlanGate feature="alerts" label="Alerts">
      <div>
        <PageHeader
          title="Alerts"
          sub="Notify your team before problems become invoices."
          actions={
            <Button
              icon={<Plus size={14} aria-hidden />}
              onClick={openCreate}
              data-testid="alerts-new-btn"
            >
              New alert
            </Button>
          }
        />

        {q.error ? (
          <SectionError error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <Table
            columns={columns}
            data={alerts}
            rowKey={(a) => a.id}
            loading={q.isLoading}
            testId="alerts-table"
            rowTestId={(a) => `alerts-row-${a.id}`}
            empty={
              <EmptyState
                icon={<Bell size={20} />}
                headline="No alerts configured."
                body="Alerts notify you before problems become invoices — thresholds, forecasts, anomaly spikes, error rates, key expiry."
                action={{
                  label: 'Create alert',
                  onClick: openCreate,
                  testId: 'alerts-empty-create-btn',
                }}
              />
            }
          />
        )}

        <Drawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          title={editing ? 'Edit alert' : 'Create alert'}
          width="md"
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => setDrawerOpen(false)}
                data-testid="alerts-drawer-cancel-btn"
              >
                Cancel
              </Button>
              <Button
                onClick={submit}
                loading={createMutation.isPending || updateMutation.isPending}
                disabled={!form.name.trim()}
                data-testid="alerts-drawer-submit-btn"
              >
                {editing ? 'Save changes' : 'Create alert'}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <Field label="Name" htmlFor="alert-name">
              <Input
                id="alert-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Monthly budget at 80%"
              />
            </Field>

            <Field
              label="Kind"
              htmlFor="alert-kind"
              hint={
                editing
                  ? "Alert type can't be changed after creation."
                  : !entitlements.has('anomaly')
                    ? 'Anomaly detection requires the Governance plan.'
                    : undefined
              }
            >
              <Select
                id="alert-kind"
                value={form.kind}
                onValueChange={(v) =>
                  setForm((f) => ({ ...f, kind: v as Kind, config: defaultConfig(v as Kind) }))
                }
                options={kindOptions}
                disabled={!!editing}
                testId="alerts-drawer-kind-select"
              />
            </Field>

            {CONFIG_FIELDS[form.kind].map((f) => (
              <Field key={f.key} label={f.label} htmlFor={`alert-config-${f.key}`} hint={f.hint}>
                <Input
                  id={`alert-config-${f.key}`}
                  type="number"
                  className="num"
                  min={f.min}
                  max={f.max}
                  step={f.step}
                  value={form.config[f.key] ?? f.default}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      config: { ...prev.config, [f.key]: Number(e.target.value) },
                    }))
                  }
                />
              </Field>
            ))}

            <div className="flex flex-col gap-3 border-t border-[var(--line)] pt-4">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-medium">Channels</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={addChannel}
                  data-testid="alerts-add-channel-btn"
                >
                  Add channel
                </Button>
              </div>
              {form.channels.length === 0 ? (
                <p className="text-xs text-[var(--ink-mut)]">
                  No channels yet — this alert won&apos;t notify anyone until you add one.
                </p>
              ) : (
                form.channels.map((c, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 rounded-[var(--radius-btn)] bg-[var(--paper)] p-3 shadow-[inset_0_0_0_1px_var(--line)]"
                  >
                    <div className="w-28 shrink-0">
                      <label htmlFor={`channel-type-${i}`} className="sr-only">
                        Channel type
                      </label>
                      <Select
                        id={`channel-type-${i}`}
                        value={c.type}
                        onValueChange={(v) => updateChannel(i, { type: v as ChannelType })}
                        options={CHANNEL_TYPE_OPTIONS}
                      />
                    </div>
                    <div className="flex flex-1 flex-col gap-2">
                      {c.type === 'slack' ? (
                        <>
                          <label htmlFor={`channel-webhook-${i}`} className="sr-only">
                            Slack webhook URL
                          </label>
                          <Input
                            id={`channel-webhook-${i}`}
                            value={c.webhook_url}
                            onChange={(e) => updateChannel(i, { webhook_url: e.target.value })}
                            placeholder="https://hooks.slack.com/services/…"
                            className="font-mono text-xs"
                          />
                        </>
                      ) : c.type === 'email' ? (
                        <>
                          <label htmlFor={`channel-email-${i}`} className="sr-only">
                            Notify email
                          </label>
                          <Input
                            id={`channel-email-${i}`}
                            type="email"
                            value={c.to}
                            onChange={(e) => updateChannel(i, { to: e.target.value })}
                            placeholder="team@company.com"
                          />
                        </>
                      ) : (
                        <>
                          <label htmlFor={`channel-url-${i}`} className="sr-only">
                            Webhook URL
                          </label>
                          <Input
                            id={`channel-url-${i}`}
                            value={c.url}
                            onChange={(e) => updateChannel(i, { url: e.target.value })}
                            placeholder="https://example.com/webhook"
                            className="font-mono text-xs"
                          />
                          <label htmlFor={`channel-secret-${i}`} className="sr-only">
                            Webhook secret
                          </label>
                          <Input
                            id={`channel-secret-${i}`}
                            value={c.secret}
                            onChange={(e) => updateChannel(i, { secret: e.target.value })}
                            placeholder="signing secret"
                            className="font-mono text-xs"
                          />
                        </>
                      )}
                    </div>
                    <button
                      type="button"
                      aria-label="Remove channel"
                      data-testid="alerts-remove-channel-btn"
                      onClick={() => removeChannel(i)}
                      className="focus-ring mt-1.5 rounded-md p-1 text-[var(--ink-mut)] transition-colors hover:text-[var(--danger)]"
                    >
                      <X size={14} aria-hidden />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </Drawer>

        <Dialog
          open={deleteTarget !== null}
          onClose={() => setDeleteTarget(null)}
          destructive
          title="Delete this alert?"
          description={
            deleteTarget
              ? `"${deleteTarget.name}" will stop firing immediately. This can't be undone.`
              : undefined
          }
          actions={
            <>
              <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                loading={deleteMutation.isPending}
                onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
                data-testid="alerts-delete-confirm-btn"
              >
                Delete alert
              </Button>
            </>
          }
        />
      </div>
    </PlanGate>
  );
}
