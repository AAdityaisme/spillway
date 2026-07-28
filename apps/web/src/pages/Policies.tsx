import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { SectionError } from '../components/domain/SectionError.js';
import { PageHeader } from '../components/layout/PageHeader.js';
import { Badge } from '../components/primitives/Badge.js';
import { Button } from '../components/primitives/Button.js';
import { Dialog } from '../components/primitives/Dialog.js';
import { Drawer } from '../components/primitives/Drawer.js';
import { EmptyState } from '../components/primitives/EmptyState.js';
import { Field, Input, TextArea } from '../components/primitives/Field.js';
import { PlanGate } from '../components/primitives/PlanGate.js';
import { Select, type SelectOption } from '../components/primitives/Select.js';
import { Switch } from '../components/primitives/Switch.js';
import { Table, type Column } from '../components/primitives/Table.js';
import { Tooltip } from '../components/primitives/Tooltip.js';
import { ApiError, api, type Policy } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { roleAtLeast, useOrg } from '../lib/org.js';

const EFFECT_OPTIONS: SelectOption[] = [
  { value: 'deny', label: 'Deny' },
  { value: 'require_approval', label: 'Require approval' },
  { value: 'flag', label: 'Flag' },
];
const ENFORCEMENT_OPTIONS: SelectOption[] = [
  { value: 'enforce', label: 'Enforce' },
  { value: 'shadow', label: 'Shadow' },
];
const EFFECT_LABEL: Record<Policy['effect'], string> = {
  deny: 'Deny',
  require_approval: 'Require approval',
  flag: 'Flag',
};
const EFFECT_BADGE: Record<Policy['effect'], 'amber' | 'blue' | 'neutral'> = {
  deny: 'amber',
  require_approval: 'blue',
  flag: 'neutral',
};
const EFFECT_HINT: Record<Policy['effect'], string> = {
  deny: 'Blocks the request outright and returns the reason below to the caller.',
  require_approval: 'Holds the request in the approval queue before it reaches the provider.',
  flag: 'Logs the match for review but lets the request continue.',
};

const rowIconBtn =
  'focus-ring rounded-[var(--radius-btn)] p-1.5 text-[var(--ink-mut)] transition-colors hover:bg-[var(--paper)] hover:text-[var(--ink)]';

interface PolicyFormBody {
  name: string;
  description?: string;
  effect: Policy['effect'];
  reason: string;
  conditionCel: string | null;
  enforcement: Policy['enforcement'];
}

/**
 * Guardrail policies (M3 surface, api-inventory §12): CEL conditions evaluated at the gateway
 * that deny, require approval for, or flag matching requests. Not in the bible's page list —
 * this is the write surface for the routing-trace decisions the request drawer already shows.
 */
export function PoliciesPage() {
  const { session, activeOrgId } = useAuth();
  const { role } = useOrg();
  const canWrite = roleAtLeast(role, 'admin');
  const queryClient = useQueryClient();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<Policy | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Policy | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [effect, setEffect] = useState<Policy['effect']>('deny');
  const [reason, setReason] = useState('');
  const [conditionCel, setConditionCel] = useState('');
  const [enforcement, setEnforcement] = useState<Policy['enforcement']>('enforce');
  const [celError, setCelError] = useState<string | null>(null);

  const q = useQuery({
    queryKey: [activeOrgId, 'policies'],
    queryFn: api.listPolicies,
    enabled: !!session && !!activeOrgId,
  });
  const policies = q.data?.policies ?? [];

  function openCreate(): void {
    setEditing(null);
    setName('');
    setDescription('');
    setEffect('deny');
    setReason('');
    setConditionCel('');
    setEnforcement('enforce');
    setCelError(null);
    setDrawerOpen(true);
  }

  function openEdit(p: Policy): void {
    setEditing(p);
    setName(p.name);
    setDescription(p.description ?? '');
    setEffect(p.effect);
    setReason(p.reason);
    setConditionCel(p.conditionCel ?? '');
    setEnforcement(p.enforcement);
    setCelError(null);
    setDrawerOpen(true);
  }

  const saveMutation = useMutation({
    mutationFn: (body: PolicyFormBody) =>
      editing ? api.updatePolicy(editing.id, body) : api.createPolicy(body),
    onSuccess: () => {
      toast.success(editing ? 'Policy updated.' : 'Policy created.');
      void queryClient.invalidateQueries({ queryKey: [activeOrgId, 'policies'] });
      setDrawerOpen(false);
    },
    onError: (err) => {
      // CEL is compiled at authoring time — surface compile errors under the field itself
      // rather than leaving the caller to guess from the global toast alone.
      if (err instanceof ApiError && err.code.startsWith('cel_')) setCelError(err.message);
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.updatePolicy(id, { enabled }),
    onSuccess: (_data, vars) => {
      toast.success(vars.enabled ? 'Policy enabled.' : 'Policy disabled.');
      void queryClient.invalidateQueries({ queryKey: [activeOrgId, 'policies'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deletePolicy(id),
    onSuccess: () => {
      toast.success('Policy deleted.');
      void queryClient.invalidateQueries({ queryKey: [activeOrgId, 'policies'] });
      setDeleteTarget(null);
    },
  });

  function handleSubmit(): void {
    saveMutation.mutate({
      name: name.trim(),
      description: description.trim() || undefined,
      effect,
      reason: reason.trim(),
      conditionCel: conditionCel.trim() || null,
      enforcement,
    });
  }

  const columns: Column<Policy>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (p) => (
        <div>
          <div className="text-[13px] font-medium">{p.name}</div>
          {p.description ? (
            <div className="mt-0.5 text-xs text-[var(--ink-mut)]">{p.description}</div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'effect',
      header: 'Effect',
      width: '150px',
      render: (p) => <Badge variant={EFFECT_BADGE[p.effect]}>{EFFECT_LABEL[p.effect]}</Badge>,
    },
    {
      key: 'enforcement',
      header: 'Enforcement',
      width: '150px',
      render: (p) =>
        p.enforcement === 'shadow' ? (
          <Tooltip content="Shadow mode logs what WOULD happen without enforcing.">
            <span>
              <Badge variant="neutral">Shadow</Badge>
            </span>
          </Tooltip>
        ) : (
          <Badge variant="blue">Enforce</Badge>
        ),
    },
    {
      key: 'revision',
      header: 'Rev',
      width: '70px',
      align: 'right',
      render: (p) => <span className="num text-[12.5px] text-[var(--ink-mut)]">v{p.revision}</span>,
    },
    {
      key: 'enabled',
      header: 'Enabled',
      width: '80px',
      render: (p) => (
        <Switch
          checked={p.enabled}
          onCheckedChange={(checked) => toggleMutation.mutate({ id: p.id, enabled: checked })}
          disabled={!canWrite || toggleMutation.isPending}
          testId={`policies-switch-${p.id}`}
        />
      ),
    },
    {
      key: 'actions',
      header: '',
      width: '80px',
      align: 'right',
      render: (p) =>
        canWrite ? (
          <div className="flex items-center justify-end gap-1">
            <button
              type="button"
              aria-label={`Edit ${p.name}`}
              data-testid={`policies-edit-btn-${p.id}`}
              onClick={() => openEdit(p)}
              className={rowIconBtn}
            >
              <Pencil size={14} aria-hidden />
            </button>
            <button
              type="button"
              aria-label={`Delete ${p.name}`}
              data-testid={`policies-delete-btn-${p.id}`}
              onClick={() => setDeleteTarget(p)}
              className={rowIconBtn}
            >
              <Trash2 size={14} aria-hidden />
            </button>
          </div>
        ) : null,
    },
  ];

  return (
    <PlanGate feature="guardrails" label="Guardrail policies">
      <div>
        <PageHeader
          title="Policies"
          sub="Guardrails evaluated at the gateway before dispatch — deny, require approval, or flag matching requests."
          actions={
            canWrite ? (
              <Button
                icon={<Plus size={14} aria-hidden />}
                onClick={openCreate}
                data-testid="policies-new-btn"
              >
                New policy
              </Button>
            ) : null
          }
        />

        {q.error ? (
          <SectionError error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <Table
            columns={columns}
            data={policies}
            rowKey={(p) => p.id}
            loading={q.isLoading}
            testId="policies-table"
            empty={
              <EmptyState
                icon={<ShieldCheck size={20} />}
                headline="No guardrail policies."
                body="Policies deny, require approval for, or flag requests matching CEL conditions — enforced at the gateway before dispatch, with a decision log."
                action={
                  canWrite
                    ? { label: 'New policy', onClick: openCreate, testId: 'policies-empty-new-btn' }
                    : undefined
                }
              />
            }
          />
        )}

        <Drawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          title={editing ? 'Edit policy' : 'New policy'}
          width="md"
          footer={
            <>
              <Button variant="ghost" onClick={() => setDrawerOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleSubmit}
                loading={saveMutation.isPending}
                disabled={!name.trim() || !reason.trim()}
                data-testid="policies-drawer-submit-btn"
              >
                {editing ? 'Save changes' : 'Create policy'}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <Field label="Name" htmlFor="policy-name">
              <Input
                id="policy-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
              />
            </Field>
            <Field
              label="Description"
              htmlFor="policy-description"
              hint="Optional — shown under the name in the policy list."
            >
              <Input
                id="policy-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
            <Field label="Effect" htmlFor="policy-effect" hint={EFFECT_HINT[effect]}>
              <Select
                id="policy-effect"
                value={effect}
                onValueChange={(v) => setEffect(v as Policy['effect'])}
                options={EFFECT_OPTIONS}
              />
            </Field>
            <Field
              label="Reason"
              htmlFor="policy-reason"
              hint="Returned to the caller when this policy blocks."
            >
              <Input
                id="policy-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
              />
            </Field>
            <Field
              label="Condition (CEL)"
              htmlFor="policy-cel"
              error={celError}
              hint={
                celError
                  ? undefined
                  : 'CEL expression, e.g. request.model == "gpt-4o" && request.max_tokens > 4000'
              }
            >
              <TextArea
                id="policy-cel"
                className="font-mono"
                value={conditionCel}
                onChange={(e) => {
                  setConditionCel(e.target.value);
                  setCelError(null);
                }}
                maxLength={2000}
              />
            </Field>
            <Field
              label="Enforcement"
              htmlFor="policy-enforcement"
              hint={
                enforcement === 'shadow'
                  ? 'Shadow mode logs what would happen without enforcing.'
                  : 'Applies immediately at the gateway.'
              }
            >
              <Select
                id="policy-enforcement"
                value={enforcement}
                onValueChange={(v) => setEnforcement(v as Policy['enforcement'])}
                options={ENFORCEMENT_OPTIONS}
              />
            </Field>
          </div>
        </Drawer>

        <Dialog
          open={deleteTarget !== null}
          onClose={() => setDeleteTarget(null)}
          title="Delete policy"
          description={
            deleteTarget
              ? `Delete "${deleteTarget.name}"? Requests will no longer be evaluated against it — this can't be undone.`
              : undefined
          }
          destructive
          actions={
            <>
              <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                loading={deleteMutation.isPending}
                onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
                data-testid="policies-delete-confirm-btn"
              >
                Delete
              </Button>
            </>
          }
        />
      </div>
    </PlanGate>
  );
}
