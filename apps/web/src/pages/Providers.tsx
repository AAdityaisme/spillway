import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plug, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { SectionError } from '../components/domain/SectionError.js';
import { PageHeader } from '../components/layout/PageHeader.js';
import { Badge } from '../components/primitives/Badge.js';
import { Button } from '../components/primitives/Button.js';
import { Card } from '../components/primitives/Card.js';
import { Dialog } from '../components/primitives/Dialog.js';
import { EmptyState } from '../components/primitives/EmptyState.js';
import { Field, Input } from '../components/primitives/Field.js';
import { Select } from '../components/primitives/Select.js';
import { Table, type Column } from '../components/primitives/Table.js';
import { api, type ProviderKey } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { dateLabel, keyPrefix } from '../lib/format.js';

/** Only `openai` is accepted server-side (schema rejects anything else) — the Select exists for future providers. */
const PROVIDER_LABELS: Record<string, string> = { openai: 'OpenAI' };

/**
 * Inline add-key form (bible §3.8, adapted): no baseUrl field and no test-connection button —
 * the create schema rejects baseUrl and there is no test-connection endpoint in this API.
 */
function AddProviderKeyForm({ onDone }: { onDone: () => void }) {
  const { activeOrgId } = useAuth();
  const queryClient = useQueryClient();
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api.createProviderKey({ provider: 'openai', label: label.trim(), apiKey: apiKey.trim() }),
    onSuccess: () => {
      toast.success('Provider key added');
      void queryClient.invalidateQueries({ queryKey: [activeOrgId, 'provider-keys'] });
      onDone();
    },
  });

  return (
    <Card className="mb-4">
      <div className="flex flex-col gap-4">
        <Field label="Provider" htmlFor="pk-provider">
          {/* Single option today — the API 422s on any provider other than 'openai'. */}
          <Select
            id="pk-provider"
            value="openai"
            onValueChange={() => {}}
            options={[{ value: 'openai', label: 'OpenAI' }]}
          />
        </Field>
        <Field
          label="Label"
          htmlFor="pk-label"
          hint='A name to tell this key apart from others, e.g. "prod" or "eu-region".'
        >
          <Input
            id="pk-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="prod"
            data-testid="providers-form-label-input"
          />
        </Field>
        <Field
          label="API key"
          htmlFor="pk-apikey"
          hint="Your key is encrypted before storage and never returned. Only the first 8 characters are kept for display."
        >
          <Input
            id="pk-apikey"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-…"
            className="font-mono text-xs"
            data-testid="providers-form-apikey-input"
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onDone}>
            Cancel
          </Button>
          <Button
            size="sm"
            loading={create.isPending}
            disabled={!label.trim() || !apiKey.trim()}
            onClick={() => create.mutate()}
            data-testid="providers-form-submit-btn"
          >
            Add key
          </Button>
        </div>
      </div>
    </Card>
  );
}

/**
 * Providers (bible §3.8): the upstream credentials virtual keys route through. Admin+ page —
 * the sidebar nav already gates this route, so there's no in-page role check.
 */
export function ProvidersPage() {
  const { session, activeOrgId } = useAuth();
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProviderKey | null>(null);

  const q = useQuery({
    queryKey: [activeOrgId, 'provider-keys'],
    queryFn: api.listProviderKeys,
    enabled: !!session && !!activeOrgId,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteProviderKey(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [activeOrgId, 'provider-keys'] });
      toast.success('Provider key deleted');
      setDeleteTarget(null);
    },
  });

  const rows = q.data?.providerKeys ?? [];

  const columns: Column<ProviderKey>[] = [
    {
      key: 'provider',
      header: 'Provider',
      render: (k) => (
        <span className="flex items-center gap-2 text-[13px]">
          <Plug size={14} aria-hidden className="text-[var(--ink-mut)]" />
          {PROVIDER_LABELS[k.provider] ?? k.provider}
        </span>
      ),
    },
    {
      key: 'label',
      header: 'Label',
      render: (k) => <span className="text-[13px] font-medium">{k.label}</span>,
    },
    {
      key: 'keyPrefix',
      header: 'Key',
      render: (k) => (
        <span className="num text-xs text-[var(--ink-mut)]">{keyPrefix(k.keyPrefix)}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (k) => (
        <Badge variant={k.status === 'active' ? 'pass' : 'neutral'} dot>
          {k.status}
        </Badge>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      render: (k) => (
        <span className="num text-xs text-[var(--ink-mut)]">{dateLabel(k.createdAt)}</span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (k) => (
        <Button
          variant="danger-ghost"
          size="sm"
          icon={<Trash2 size={13} aria-hidden />}
          onClick={() => setDeleteTarget(k)}
          data-testid="providers-row-delete-btn"
        >
          Delete
        </Button>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Providers"
        sub="Upstream credentials the gateway routes to."
        actions={
          <Button
            icon={<Plus size={14} aria-hidden />}
            onClick={() => setFormOpen((v) => !v)}
            data-testid="providers-add-btn"
          >
            Add provider key
          </Button>
        }
      />

      {formOpen ? <AddProviderKeyForm onDone={() => setFormOpen(false)} /> : null}

      {q.error ? (
        <SectionError error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <Table
          columns={columns}
          data={rows}
          rowKey={(k) => k.id}
          loading={q.isLoading}
          testId="providers-table"
          rowTestId={(k) => `providers-row-${k.id}`}
          empty={
            <EmptyState
              icon={<Plug size={20} />}
              headline="Add a provider key."
              body="Spillway routes to OpenAI or any OpenAI-compatible provider. Add your first key to enable routing."
              action={{
                label: 'Add provider key',
                onClick: () => setFormOpen(true),
                testId: 'providers-empty-add-btn',
              }}
            />
          }
        />
      )}

      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        destructive
        title="Delete this provider key?"
        description="Virtual keys that route to this provider will start failing if no other key for the same provider exists."
        actions={
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => deleteTarget && remove.mutate(deleteTarget.id)}
            >
              Delete key
            </Button>
          </>
        }
      />
    </div>
  );
}
