import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { KeyRound, Pause, Play, ShieldOff } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { KeyStatusBadge } from '../components/domain/StatusBadge.js';
import { SectionError } from '../components/domain/SectionError.js';
import { PageHeader } from '../components/layout/PageHeader.js';
import { Badge } from '../components/primitives/Badge.js';
import { Button } from '../components/primitives/Button.js';
import { Dialog } from '../components/primitives/Dialog.js';
import { Drawer } from '../components/primitives/Drawer.js';
import { EmptyState } from '../components/primitives/EmptyState.js';
import { Field, Input } from '../components/primitives/Field.js';
import { KeyRevealDialog } from '../components/primitives/KeyRevealDialog.js';
import { Select } from '../components/primitives/Select.js';
import { Table, type Column } from '../components/primitives/Table.js';
import { api, type CreateVirtualKeyInput, type VirtualKey } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { keyPrefix, relTime } from '../lib/format.js';

/** Create-key drawer (bible §3.7 wizard, flattened to one form — the fields are few). */
function CreateKeyDrawer({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (key: string) => void;
}) {
  const { activeOrgId } = useAuth();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [teamId, setTeamId] = useState('none');
  const [rpm, setRpm] = useState('');
  const [tpm, setTpm] = useState('');
  const [models, setModels] = useState('');
  const [expires, setExpires] = useState('');

  const teamsQ = useQuery({
    queryKey: [activeOrgId, 'teams'],
    queryFn: api.listTeams,
    enabled: open,
  });

  const create = useMutation({
    mutationFn: (body: CreateVirtualKeyInput) => api.createVirtualKey(body),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: [activeOrgId, 'virtual-keys'] });
      onClose();
      onCreated(res.virtualKey.key);
      setName('');
      setRpm('');
      setTpm('');
      setModels('');
      setExpires('');
      setTeamId('none');
    },
  });

  const submit = (): void => {
    if (!name.trim()) return;
    const body: CreateVirtualKeyInput = { name: name.trim() };
    if (teamId !== 'none') body.teamId = teamId;
    if (rpm) body.rpmLimit = Number(rpm);
    if (tpm) body.tpmLimit = Number(tpm);
    if (models.trim())
      body.allowedModels = models
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean);
    if (expires) body.expiresAt = new Date(`${expires}T00:00:00Z`).toISOString();
    create.mutate(body);
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Create virtual key"
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            loading={create.isPending}
            disabled={!name.trim()}
            data-testid="keys-create-submit-btn"
          >
            Create key
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name" htmlFor="vk-name">
          <Input
            id="vk-name"
            data-testid="keys-create-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="prod-agent"
          />
        </Field>
        <Field
          label="Team"
          htmlFor="vk-team"
          hint="Optional — scopes the key's spend to a team for budgets and chargeback."
        >
          <Select
            id="vk-team"
            value={teamId}
            onValueChange={setTeamId}
            options={[
              { value: 'none', label: 'No team' },
              ...(teamsQ.data?.teams.map((t) => ({ value: t.id, label: t.name })) ?? []),
            ]}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="RPM limit" htmlFor="vk-rpm" hint="Blank = no limit">
            <Input
              id="vk-rpm"
              type="number"
              min={1}
              value={rpm}
              onChange={(e) => setRpm(e.target.value)}
              placeholder="—"
            />
          </Field>
          <Field label="TPM limit" htmlFor="vk-tpm" hint="Blank = no limit">
            <Input
              id="vk-tpm"
              type="number"
              min={1}
              value={tpm}
              onChange={(e) => setTpm(e.target.value)}
              placeholder="—"
            />
          </Field>
        </div>
        <Field
          label="Allowed models"
          htmlFor="vk-models"
          hint="Comma-separated exact names. Blank = all models."
        >
          <Input
            id="vk-models"
            value={models}
            onChange={(e) => setModels(e.target.value)}
            placeholder="gpt-4o, gpt-4o-mini"
            className="font-mono text-xs"
          />
        </Field>
        <Field label="Expires" htmlFor="vk-expires" hint="Blank = never">
          <Input
            id="vk-expires"
            type="date"
            value={expires}
            onChange={(e) => setExpires(e.target.value)}
          />
        </Field>
      </div>
    </Drawer>
  );
}

/**
 * Virtual keys (bible §3.7): the self-service surface. Pause/unpause inline; revoke is a
 * typed-confirmation destructive dialog; creation ends in the copy-once reveal.
 * Deep link: /keys?drawer=<id> pre-opens the detail (Slack pause-link target).
 */
export function KeysPage() {
  const { session, activeOrgId } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const search = useSearch({ from: '/keys' });
  const [createOpen, setCreateOpen] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<VirtualKey | null>(null);
  const [revokeConfirm, setRevokeConfirm] = useState('');

  const q = useQuery({
    queryKey: [activeOrgId, 'virtual-keys'],
    queryFn: api.listVirtualKeys,
    enabled: !!session && !!activeOrgId,
  });
  const teamsQ = useQuery({
    queryKey: [activeOrgId, 'teams'],
    queryFn: api.listTeams,
    enabled: !!session && !!activeOrgId,
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'active' | 'paused' | 'revoked' }) =>
      api.setVirtualKeyStatus(id, status),
    onSuccess: (_, vars) => {
      void queryClient.invalidateQueries({ queryKey: [activeOrgId, 'virtual-keys'] });
      toast.success(
        vars.status === 'paused'
          ? 'Key paused — requests stop within 30 seconds.'
          : vars.status === 'active'
            ? 'Key unpaused.'
            : 'Key revoked.',
      );
      if (vars.status === 'revoked') {
        setRevokeTarget(null);
        setRevokeConfirm('');
      }
    },
  });

  const rows = q.data?.virtualKeys ?? [];
  const highlighted = search.drawer ?? null;
  const teamName = (id: string | null): string =>
    id ? (teamsQ.data?.teams.find((t) => t.id === id)?.name ?? '—') : 'No team';

  const columns: Column<VirtualKey>[] = [
    {
      key: 'status',
      header: 'Status',
      width: '100px',
      render: (k) => <KeyStatusBadge status={k.status} />,
    },
    {
      key: 'name',
      header: 'Name',
      render: (k) => (
        <div>
          <div className="text-[13px] font-medium">{k.name}</div>
          <div className="num text-[11px] text-[var(--ink-mut)]">{keyPrefix(k.keyPrefix)}</div>
        </div>
      ),
    },
    {
      key: 'team',
      header: 'Team',
      render: (k) => (
        <span className="text-[12.5px] text-[var(--ink-mut)]">{teamName(k.teamId)}</span>
      ),
    },
    {
      key: 'models',
      header: 'Models',
      render: (k) =>
        k.allowedModels && k.allowedModels.length > 0 ? (
          <span className="num text-xs">
            {k.allowedModels.slice(0, 2).join(', ')}
            {k.allowedModels.length > 2 ? ` +${k.allowedModels.length - 2}` : ''}
          </span>
        ) : (
          <Badge variant="neutral">all</Badge>
        ),
    },
    {
      key: 'limits',
      header: 'Limits',
      render: (k) => (
        <span className="num text-xs text-[var(--ink-mut)]">
          {k.rpmLimit ? `${k.rpmLimit} rpm` : ''}
          {k.rpmLimit && k.tpmLimit ? ' · ' : ''}
          {k.tpmLimit ? `${k.tpmLimit} tpm` : ''}
          {!k.rpmLimit && !k.tpmLimit ? '—' : ''}
        </span>
      ),
    },
    {
      key: 'lastUsed',
      header: 'Last used',
      render: (k) => (
        <span className="num text-xs text-[var(--ink-mut)]">
          {k.lastUsedAt ? relTime(k.lastUsedAt) : 'never'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (k) =>
        k.status === 'revoked' ? (
          <span className="text-[11px] text-[var(--ink-mut)]">—</span>
        ) : (
          <span className="flex justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
            <Button
              variant="ghost"
              size="sm"
              data-testid="keys-row-pause-btn"
              icon={
                k.status === 'paused' ? (
                  <Play size={13} aria-hidden />
                ) : (
                  <Pause size={13} aria-hidden />
                )
              }
              onClick={() =>
                setStatus.mutate({ id: k.id, status: k.status === 'paused' ? 'active' : 'paused' })
              }
            >
              {k.status === 'paused' ? 'Unpause' : 'Pause'}
            </Button>
            <Button
              variant="danger-ghost"
              size="sm"
              data-testid="keys-row-revoke-btn"
              icon={<ShieldOff size={13} aria-hidden />}
              onClick={() => setRevokeTarget(k)}
            >
              Revoke
            </Button>
          </span>
        ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Virtual keys"
        sub="The credentials your applications use — pause, scope, and cap them from here."
        actions={
          <Button
            icon={<KeyRound size={14} aria-hidden />}
            onClick={() => setCreateOpen(true)}
            data-testid="keys-create-btn"
          >
            Create key
          </Button>
        }
      />

      {highlighted ? (
        <div className="mb-3 rounded-[var(--radius-btn)] bg-[var(--blue-soft)] px-3.5 py-2.5 text-[13px] text-[var(--blue)]">
          Deep link: key <span className="num">{highlighted.slice(0, 8)}…</span> —{' '}
          <button
            type="button"
            className="focus-ring underline"
            onClick={() => void navigate({ to: '/keys', search: {}, replace: true })}
          >
            clear
          </button>
        </div>
      ) : null}

      {q.error ? (
        <SectionError error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <Table
          columns={columns}
          data={rows}
          rowKey={(k) => k.id}
          loading={q.isLoading}
          rowTestId={(k) => `keys-row-${k.id}`}
          testId="keys-table"
          empty={
            <EmptyState
              icon={<KeyRound size={20} />}
              headline="No virtual keys yet."
              body="Virtual keys are the credentials your applications use to talk to the gateway. Create one to get started."
              action={{
                label: 'Create key',
                onClick: () => setCreateOpen(true),
                testId: 'keys-empty-create-btn',
              }}
            />
          }
        />
      )}

      <CreateKeyDrawer
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={setRevealed}
      />
      <KeyRevealDialog openWithKey={revealed} onDone={() => setRevealed(null)} />

      <Dialog
        open={revokeTarget !== null}
        onClose={() => {
          setRevokeTarget(null);
          setRevokeConfirm('');
        }}
        destructive
        title="Revoke this key?"
        description="This is permanent. Any application using this key will immediately stop working."
        actions={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setRevokeTarget(null);
                setRevokeConfirm('');
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={setStatus.isPending}
              disabled={revokeConfirm !== (revokeTarget?.keyPrefix ?? '')}
              onClick={() =>
                revokeTarget && setStatus.mutate({ id: revokeTarget.id, status: 'revoked' })
              }
              data-testid="keys-revoke-confirm-btn"
            >
              Revoke key
            </Button>
          </>
        }
      >
        {revokeTarget ? (
          <Field
            label={`Type the key prefix to confirm: ${revokeTarget.keyPrefix}`}
            htmlFor="revoke-confirm"
          >
            <Input
              id="revoke-confirm"
              value={revokeConfirm}
              onChange={(e) => setRevokeConfirm(e.target.value)}
              className="font-mono text-xs"
              placeholder={revokeTarget.keyPrefix}
            />
          </Field>
        ) : null}
      </Dialog>
    </div>
  );
}
