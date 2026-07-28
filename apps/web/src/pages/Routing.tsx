import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { SectionError } from '../components/domain/SectionError.js';
import { PageHeader } from '../components/layout/PageHeader.js';
import { Badge } from '../components/primitives/Badge.js';
import { Button } from '../components/primitives/Button.js';
import { Card } from '../components/primitives/Card.js';
import { Dialog } from '../components/primitives/Dialog.js';
import { Drawer } from '../components/primitives/Drawer.js';
import { EmptyState } from '../components/primitives/EmptyState.js';
import { Field, Input } from '../components/primitives/Field.js';
import { Select } from '../components/primitives/Select.js';
import { Skeleton } from '../components/primitives/Skeleton.js';
import { Switch } from '../components/primitives/Switch.js';
import { Table, type Column } from '../components/primitives/Table.js';
import { TabPanel, Tabs } from '../components/primitives/Tabs.js';
import {
  api,
  type AliasTargets,
  type ModelAlias,
  type ModelTarget,
  type RoutingRule,
  type RoutingRuleAction,
  type RoutingRuleMatch,
} from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { dateLabel } from '../lib/format.js';
import { roleAtLeast, useOrg } from '../lib/org.js';

type RuleActionType = RoutingRuleAction['type'];
type CreateRuleBody = Parameters<typeof api.createRoutingRule>[0];
type UpdateRuleBody = Parameters<typeof api.updateRoutingRule>[1];
type CreateAliasBody = Parameters<typeof api.createAlias>[0];

interface RuleForm {
  id: string | null;
  priority: string;
  description: string;
  models: string;
  virtualKeyIds: string[];
  teamIds: string[];
  metadata: Array<{ key: string; value: string }>;
  actionType: RuleActionType;
  toProvider: string;
  toModel: string;
  fallbackRows: ModelTarget[];
}

interface AliasForm {
  id: string;
  alias: string;
  targets: ModelTarget[];
}

/** Flatten AliasTargets to an ordered list — the typed-chain fields (context_window, content_policy) predate this UI and aren't editable here. */
function targetsArray(targets: AliasTargets): ModelTarget[] {
  return Array.isArray(targets) ? targets : targets.default;
}

function toggleId(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

function blankRuleForm(): RuleForm {
  return {
    id: null,
    priority: '',
    description: '',
    models: '',
    virtualKeyIds: [],
    teamIds: [],
    metadata: [],
    actionType: 'rewrite_model',
    toProvider: 'openai',
    toModel: '',
    fallbackRows: [],
  };
}

function ruleToForm(rule: RoutingRule): RuleForm {
  const { action } = rule;
  const fallbackSource = action.type === 'rewrite_model' ? action.fallbacks : action.chain;
  return {
    id: rule.id,
    priority: String(rule.priority),
    description: rule.description ?? '',
    models: (rule.match.models ?? []).join(', '),
    virtualKeyIds: rule.match.virtual_key_ids ?? [],
    teamIds: rule.match.team_ids ?? [],
    metadata: Object.entries(rule.match.metadata ?? {}).map(([key, value]) => ({ key, value })),
    actionType: action.type,
    toProvider: action.type === 'rewrite_model' ? action.to.provider : 'openai',
    toModel: action.type === 'rewrite_model' ? action.to.model : '',
    fallbackRows: fallbackSource ? targetsArray(fallbackSource) : [],
  };
}

function aliasToForm(alias: ModelAlias): AliasForm {
  return { id: alias.id, alias: alias.alias, targets: targetsArray(alias.targets) };
}

/** Mono pill used for rule-match summaries and other small tags. */
function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-[var(--paper)] px-2 py-0.5 font-mono text-[11px] text-[var(--ink-mut)] shadow-[inset_0_0_0_1px_var(--line)]">
      {children}
    </span>
  );
}

/** Label + hint stack for composite (multi-input) form sections that have no single control to `htmlFor` — Field can't cover these. */
function FieldGroup({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-[var(--ink)]">{label}</span>
      {children}
      {hint ? <p className="text-xs text-[var(--ink-mut)]">{hint}</p> : null}
    </div>
  );
}

function matchChips(
  match: RoutingRuleMatch,
  keyNameById: Map<string, string>,
  teamNameById: Map<string, string>,
): ReactNode[] {
  const chips: ReactNode[] = [];
  if (match.virtual_key_ids && match.virtual_key_ids.length > 0) {
    const ids = match.virtual_key_ids;
    const label =
      ids.length <= 3
        ? ids.map((id) => keyNameById.get(id) ?? `${id.slice(0, 8)}…`).join(', ')
        : String(ids.length);
    chips.push(<Chip key="keys">key: {label}</Chip>);
  }
  if (match.team_ids && match.team_ids.length > 0) {
    const ids = match.team_ids;
    const label =
      ids.length <= 3
        ? ids.map((id) => teamNameById.get(id) ?? `${id.slice(0, 8)}…`).join(', ')
        : String(ids.length);
    chips.push(<Chip key="teams">team: {label}</Chip>);
  }
  if (match.models && match.models.length > 0) {
    chips.push(<Chip key="models">model: {match.models.join(', ')}</Chip>);
  }
  if (match.metadata) {
    for (const [k, v] of Object.entries(match.metadata)) {
      chips.push(
        <Chip key={`md-${k}`}>
          {k}={v}
        </Chip>,
      );
    }
  }
  if (chips.length === 0) chips.push(<Chip key="all">all traffic</Chip>);
  return chips;
}

function ActionBadge({ action }: { action: RoutingRuleAction }) {
  if (action.type === 'rewrite_model') {
    return (
      <Badge variant="blue">
        rewrite → {action.to.provider}/{action.to.model}
      </Badge>
    );
  }
  return <Badge variant="neutral">fallbacks: {targetsArray(action.chain).length}</Badge>;
}

function CheckboxList({
  items,
  selected,
  onToggle,
  limit,
}: {
  items: Array<{ id: string; label: string }>;
  selected: string[];
  onToggle: (id: string) => void;
  limit: number;
}) {
  const shown = items.slice(0, limit);
  return (
    <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto rounded-[var(--radius-btn)] p-2 shadow-[inset_0_0_0_1px_var(--line)]">
      {shown.length === 0 ? (
        <p className="px-1 py-1 text-xs text-[var(--ink-mut)]">None yet.</p>
      ) : (
        shown.map((item) => (
          <label
            key={item.id}
            className="flex items-center gap-2 rounded-md px-1.5 py-1 text-[12.5px] transition-colors hover:bg-[var(--paper)]"
          >
            <input
              type="checkbox"
              checked={selected.includes(item.id)}
              onChange={() => onToggle(item.id)}
              className="focus-ring size-3.5 accent-[var(--blue)]"
            />
            {item.label}
          </label>
        ))
      )}
      {items.length > limit ? (
        <p className="px-1.5 pt-1 text-[11px] text-[var(--ink-mut)]">
          +{items.length - limit} more not shown.
        </p>
      ) : null}
    </div>
  );
}

function MetadataRowsEditor({
  rows,
  onChange,
}: {
  rows: Array<{ key: string; value: string }>;
  onChange: (rows: Array<{ key: string; value: string }>) => void;
}) {
  const update = (i: number, patch: Partial<{ key: string; value: string }>): void =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const remove = (i: number): void => onChange(rows.filter((_, idx) => idx !== i));
  const add = (): void => onChange([...rows, { key: '', value: '' }]);
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            value={r.key}
            onChange={(e) => update(i, { key: e.target.value })}
            placeholder="key"
            aria-label={`Metadata row ${i + 1} key`}
            className="w-28 font-mono text-xs"
          />
          <Input
            value={r.value}
            onChange={(e) => update(i, { value: e.target.value })}
            placeholder="value"
            aria-label={`Metadata row ${i + 1} value`}
            className="flex-1 font-mono text-xs"
          />
          <button
            type="button"
            aria-label="Remove metadata row"
            onClick={() => remove(i)}
            className="focus-ring rounded-md p-1.5 text-[var(--ink-mut)] transition-colors hover:text-[var(--danger)]"
          >
            <Trash2 size={13} aria-hidden />
          </button>
        </div>
      ))}
      <Button
        variant="ghost"
        size="sm"
        icon={<Plus size={13} aria-hidden />}
        onClick={add}
        className="self-start"
      >
        Add metadata
      </Button>
    </div>
  );
}

function TargetRowsEditor({
  rows,
  onChange,
  minRows = 0,
}: {
  rows: ModelTarget[];
  onChange: (rows: ModelTarget[]) => void;
  minRows?: number;
}) {
  const update = (i: number, patch: Partial<ModelTarget>): void =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const remove = (i: number): void => onChange(rows.filter((_, idx) => idx !== i));
  const add = (): void => onChange([...rows, { provider: 'openai', model: '' }]);
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="num w-4 shrink-0 text-xs text-[var(--ink-mut)]">{i + 1}</span>
          <Input
            value={r.provider}
            onChange={(e) => update(i, { provider: e.target.value })}
            placeholder="openai"
            aria-label={`Target ${i + 1} provider`}
            className="w-28 font-mono text-xs"
          />
          <Input
            value={r.model}
            onChange={(e) => update(i, { model: e.target.value })}
            placeholder="gpt-4o-mini"
            aria-label={`Target ${i + 1} model`}
            className="flex-1 font-mono text-xs"
          />
          <button
            type="button"
            aria-label="Remove target"
            onClick={() => remove(i)}
            disabled={rows.length <= minRows}
            className="focus-ring rounded-md p-1.5 text-[var(--ink-mut)] transition-colors hover:text-[var(--danger)] disabled:opacity-30"
          >
            <Trash2 size={13} aria-hidden />
          </button>
        </div>
      ))}
      <Button
        variant="ghost"
        size="sm"
        icon={<Plus size={13} aria-hidden />}
        onClick={add}
        className="self-start"
      >
        Add target
      </Button>
    </div>
  );
}

function RuleCard({
  rule,
  canEdit,
  keyNameById,
  teamNameById,
  onToggle,
  toggling,
  onEdit,
  onDelete,
}: {
  rule: RoutingRule;
  canEdit: boolean;
  keyNameById: Map<string, string>;
  teamNameById: Map<string, string>;
  onToggle: (enabled: boolean) => void;
  toggling: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <Card className="flex flex-wrap items-center gap-3">
      <span className="num flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-btn)] bg-[var(--paper)] text-[12px] font-medium shadow-[inset_0_0_0_1px_var(--line)]">
        {rule.priority}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium">{rule.description || 'Rule'}</span>
          <ActionBadge action={rule.action} />
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {matchChips(rule.match, keyNameById, teamNameById)}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Switch
          checked={rule.enabled}
          onCheckedChange={onToggle}
          disabled={!canEdit || toggling}
          testId={`routing-rule-enabled-switch-${rule.id}`}
        />
        {canEdit ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              icon={<Pencil size={13} aria-hidden />}
              onClick={onEdit}
              data-testid={`routing-rule-edit-btn-${rule.id}`}
            >
              Edit
            </Button>
            <Button
              variant="danger-ghost"
              size="sm"
              icon={<Trash2 size={13} aria-hidden />}
              onClick={onDelete}
              data-testid={`routing-rule-delete-btn-${rule.id}`}
            >
              Delete
            </Button>
          </>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * Routing (bible §3.12): rules rewrite models or add fallback chains for matching traffic;
 * aliases give code a stable name ("spillway/cheap") admins can repoint without a redeploy.
 * No reorder endpoint — priority is a plain int field and a duplicate value 409s (the global
 * mutation-error toast in lib/query.ts covers that; no special handling needed here).
 */
export function RoutingPage() {
  const { session, activeOrgId } = useAuth();
  const { role } = useOrg();
  const canEdit = roleAtLeast(role, 'admin');
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<'rules' | 'aliases'>('rules');
  const [ruleForm, setRuleForm] = useState<RuleForm | null>(null);
  const [deleteRuleTarget, setDeleteRuleTarget] = useState<RoutingRule | null>(null);
  const [aliasForm, setAliasForm] = useState<AliasForm | null>(null);
  const [deleteAliasTarget, setDeleteAliasTarget] = useState<ModelAlias | null>(null);
  const [showNewAlias, setShowNewAlias] = useState(false);
  const [newAlias, setNewAlias] = useState('');
  const [newAliasTargets, setNewAliasTargets] = useState<ModelTarget[]>([
    { provider: 'openai', model: '' },
  ]);

  const enabled = !!session && !!activeOrgId;
  const rulesQ = useQuery({
    queryKey: [activeOrgId, 'routing-rules'],
    queryFn: api.listRoutingRules,
    enabled,
  });
  const aliasesQ = useQuery({
    queryKey: [activeOrgId, 'aliases'],
    queryFn: api.listAliases,
    enabled,
  });
  const keysQ = useQuery({
    queryKey: [activeOrgId, 'virtual-keys'],
    queryFn: api.listVirtualKeys,
    enabled,
  });
  const teamsQ = useQuery({ queryKey: [activeOrgId, 'teams'], queryFn: api.listTeams, enabled });

  const rules = rulesQ.data?.routingRules ?? [];
  const aliases = aliasesQ.data?.aliases ?? [];
  const keyNameById = new Map((keysQ.data?.virtualKeys ?? []).map((k) => [k.id, k.name]));
  const teamNameById = new Map((teamsQ.data?.teams ?? []).map((t) => [t.id, t.name]));

  const createRuleMut = useMutation({
    mutationFn: (body: CreateRuleBody) => api.createRoutingRule(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [activeOrgId, 'routing-rules'] });
      toast.success('Routing rule created.');
      setRuleForm(null);
    },
  });
  const updateRuleMut = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateRuleBody }) =>
      api.updateRoutingRule(id, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [activeOrgId, 'routing-rules'] });
      toast.success('Routing rule updated.');
      setRuleForm(null);
    },
  });
  const toggleRuleMut = useMutation({
    mutationFn: ({ id, enabled: next }: { id: string; enabled: boolean }) =>
      api.updateRoutingRule(id, { enabled: next }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: [activeOrgId, 'routing-rules'] }),
  });
  const deleteRuleMut = useMutation({
    mutationFn: (id: string) => api.deleteRoutingRule(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [activeOrgId, 'routing-rules'] });
      toast.success('Routing rule deleted.');
      setDeleteRuleTarget(null);
    },
  });

  const createAliasMut = useMutation({
    mutationFn: (body: CreateAliasBody) => api.createAlias(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [activeOrgId, 'aliases'] });
      toast.success('Alias created.');
      setNewAlias('');
      setNewAliasTargets([{ provider: 'openai', model: '' }]);
      setShowNewAlias(false);
    },
  });
  const updateAliasMut = useMutation({
    mutationFn: ({ id, targets }: { id: string; targets: AliasTargets }) =>
      api.updateAlias(id, targets),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [activeOrgId, 'aliases'] });
      toast.success('Alias updated.');
      setAliasForm(null);
    },
  });
  const deleteAliasMut = useMutation({
    mutationFn: (id: string) => api.deleteAlias(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [activeOrgId, 'aliases'] });
      toast.success('Alias deleted.');
      setDeleteAliasTarget(null);
    },
  });

  const submitRule = (): void => {
    if (!ruleForm) return;
    const priority = Number.parseInt(ruleForm.priority, 10);
    if (!Number.isFinite(priority)) return;

    const models = ruleForm.models
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
    const metadataEntries = ruleForm.metadata
      .filter((r) => r.key.trim())
      .map((r): [string, string] => [r.key.trim(), r.value.trim()]);

    const match: RoutingRuleMatch = {};
    if (models.length > 0) match.models = models;
    if (ruleForm.virtualKeyIds.length > 0) match.virtual_key_ids = ruleForm.virtualKeyIds;
    if (ruleForm.teamIds.length > 0) match.team_ids = ruleForm.teamIds;
    if (metadataEntries.length > 0) match.metadata = Object.fromEntries(metadataEntries);

    const fallbackTargets: ModelTarget[] = ruleForm.fallbackRows.filter(
      (r) => r.provider.trim() && r.model.trim(),
    );
    const action: RoutingRuleAction =
      ruleForm.actionType === 'rewrite_model'
        ? {
            type: 'rewrite_model',
            to: { provider: ruleForm.toProvider.trim(), model: ruleForm.toModel.trim() },
            fallbacks: fallbackTargets.length > 0 ? fallbackTargets : undefined,
          }
        : { type: 'set_fallbacks', chain: fallbackTargets };

    const description = ruleForm.description.trim();

    if (ruleForm.id) {
      updateRuleMut.mutate({
        id: ruleForm.id,
        body: { priority, description: description || undefined, match, action },
      });
    } else {
      createRuleMut.mutate({ priority, description: description || undefined, match, action });
    }
  };

  const priorityNum = ruleForm ? Number.parseInt(ruleForm.priority, 10) : Number.NaN;
  const ruleValid =
    ruleForm !== null &&
    ruleForm.priority.trim() !== '' &&
    Number.isFinite(priorityNum) &&
    (ruleForm.actionType === 'rewrite_model'
      ? ruleForm.toModel.trim() !== ''
      : ruleForm.fallbackRows.some((r) => r.provider.trim() && r.model.trim()));

  const newAliasValid =
    newAlias.trim() !== '' && newAliasTargets.some((t) => t.provider.trim() && t.model.trim());

  const aliasColumns: Column<ModelAlias>[] = [
    {
      key: 'alias',
      header: 'Alias',
      render: (a) => <span className="num text-[12.5px]">{a.alias}</span>,
    },
    {
      key: 'targets',
      header: 'Targets',
      render: (a) => (
        <div className="flex flex-wrap items-center gap-1.5">
          {targetsArray(a.targets).map((t, i) => (
            <Badge key={`${a.id}-${i}`} variant={i === 0 ? 'blue' : 'neutral'}>
              {t.provider}/{t.model}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      render: (a) => (
        <span className="num text-xs text-[var(--ink-mut)]">{dateLabel(a.createdAt)}</span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (a) =>
        canEdit ? (
          <span className="flex justify-end gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              icon={<Pencil size={13} aria-hidden />}
              onClick={() => setAliasForm(aliasToForm(a))}
              data-testid={`routing-alias-edit-btn-${a.id}`}
            >
              Edit
            </Button>
            <Button
              variant="danger-ghost"
              size="sm"
              icon={<Trash2 size={13} aria-hidden />}
              onClick={() => setDeleteAliasTarget(a)}
              data-testid={`routing-alias-delete-btn-${a.id}`}
            >
              Delete
            </Button>
          </span>
        ) : null,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Routing"
        sub="Rewrite models, add fallback chains, and ship aliases your code can reference without a redeploy."
      />

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as 'rules' | 'aliases')}
        tabs={[
          { value: 'rules', label: 'Rules' },
          { value: 'aliases', label: 'Aliases' },
        ]}
      >
        <TabPanel value="rules" className="pt-5 focus-visible:outline-none">
          <div className="mb-3 flex items-center justify-between">
            <span className="num text-xs text-[var(--ink-mut)]">
              {rules.length} rule{rules.length === 1 ? '' : 's'}
            </span>
            {canEdit ? (
              <Button
                size="sm"
                icon={<Plus size={14} aria-hidden />}
                onClick={() => setRuleForm(blankRuleForm())}
                data-testid="routing-new-rule-btn"
              >
                Add rule
              </Button>
            ) : null}
          </div>

          {rulesQ.isLoading ? (
            <div className="flex flex-col gap-2.5">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : rulesQ.error ? (
            <SectionError error={rulesQ.error} onRetry={() => void rulesQ.refetch()} />
          ) : rules.length === 0 ? (
            <Card padding="none">
              <EmptyState
                icon={<ArrowLeftRight size={20} />}
                headline="No routing rules."
                body="Rules rewrite models or add fallback chains for matching traffic — by key, team, model, or metadata."
                action={
                  canEdit
                    ? {
                        label: 'Add rule',
                        onClick: () => setRuleForm(blankRuleForm()),
                        testId: 'routing-rule-empty-add-btn',
                      }
                    : undefined
                }
              />
            </Card>
          ) : (
            <div className="flex flex-col gap-2.5">
              {rules.map((rule) => (
                <RuleCard
                  key={rule.id}
                  rule={rule}
                  canEdit={canEdit}
                  keyNameById={keyNameById}
                  teamNameById={teamNameById}
                  onToggle={(nextEnabled) =>
                    toggleRuleMut.mutate({ id: rule.id, enabled: nextEnabled })
                  }
                  toggling={toggleRuleMut.isPending && toggleRuleMut.variables?.id === rule.id}
                  onEdit={() => setRuleForm(ruleToForm(rule))}
                  onDelete={() => setDeleteRuleTarget(rule)}
                />
              ))}
            </div>
          )}
        </TabPanel>

        <TabPanel value="aliases" className="pt-5 focus-visible:outline-none">
          <div className="mb-3 flex items-center justify-between">
            <span className="num text-xs text-[var(--ink-mut)]">
              {aliases.length} alias{aliases.length === 1 ? '' : 'es'}
            </span>
            {canEdit ? (
              <Button
                size="sm"
                icon={<Plus size={14} aria-hidden />}
                onClick={() => setShowNewAlias(true)}
                data-testid="routing-new-alias-btn"
              >
                Add alias
              </Button>
            ) : null}
          </div>

          {canEdit && showNewAlias ? (
            <Card className="mb-4">
              <div className="flex flex-col gap-4">
                <Field
                  label="Alias"
                  htmlFor="new-alias-name"
                  hint="e.g. spillway/cheap — lowercase, digits, hyphens, slashes"
                >
                  <Input
                    id="new-alias-name"
                    value={newAlias}
                    onChange={(e) => setNewAlias(e.target.value)}
                    placeholder="spillway/cheap"
                    className="font-mono text-xs"
                  />
                </Field>
                <FieldGroup label="Targets" hint="Tried in order until one succeeds.">
                  <TargetRowsEditor
                    rows={newAliasTargets}
                    onChange={setNewAliasTargets}
                    minRows={1}
                  />
                </FieldGroup>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setShowNewAlias(false);
                      setNewAlias('');
                      setNewAliasTargets([{ provider: 'openai', model: '' }]);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    loading={createAliasMut.isPending}
                    disabled={!newAliasValid}
                    onClick={() =>
                      createAliasMut.mutate({
                        alias: newAlias.trim(),
                        targets: newAliasTargets.filter((t) => t.provider.trim() && t.model.trim()),
                      })
                    }
                  >
                    Create alias
                  </Button>
                </div>
              </div>
            </Card>
          ) : null}

          {aliasesQ.error ? (
            <SectionError error={aliasesQ.error} onRetry={() => void aliasesQ.refetch()} />
          ) : (
            <Table
              columns={aliasColumns}
              data={aliases}
              rowKey={(a) => a.id}
              loading={aliasesQ.isLoading}
              testId="routing-aliases-table"
              rowTestId={(a) => `routing-alias-row-${a.id}`}
              empty={
                <EmptyState
                  icon={<ArrowLeftRight size={20} />}
                  headline="No model aliases."
                  body="Aliases let you ship 'spillway/cheap' in code and change what it means from here — no redeploy."
                  action={
                    canEdit
                      ? {
                          label: 'Add alias',
                          onClick: () => setShowNewAlias(true),
                          testId: 'routing-alias-empty-add-btn',
                        }
                      : undefined
                  }
                />
              }
            />
          )}
        </TabPanel>
      </Tabs>

      <Drawer
        open={ruleForm !== null}
        onClose={() => setRuleForm(null)}
        title={ruleForm?.id ? 'Edit routing rule' : 'New routing rule'}
        width="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRuleForm(null)}>
              Cancel
            </Button>
            <Button
              onClick={submitRule}
              loading={createRuleMut.isPending || updateRuleMut.isPending}
              disabled={!ruleValid}
              data-testid="routing-rule-drawer-submit-btn"
            >
              {ruleForm?.id ? 'Save rule' : 'Create rule'}
            </Button>
          </>
        }
      >
        {ruleForm ? (
          <div className="flex flex-col gap-5">
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Priority"
                htmlFor="rule-priority"
                hint="Lower runs first; must be unique."
              >
                <Input
                  id="rule-priority"
                  type="number"
                  step={1}
                  value={ruleForm.priority}
                  onChange={(e) => setRuleForm((f) => (f ? { ...f, priority: e.target.value } : f))}
                  placeholder="100"
                />
              </Field>
              <Field label="Description" htmlFor="rule-description" hint="Optional">
                <Input
                  id="rule-description"
                  value={ruleForm.description}
                  onChange={(e) =>
                    setRuleForm((f) => (f ? { ...f, description: e.target.value } : f))
                  }
                  placeholder="Route team X to a cheaper model"
                />
              </Field>
            </div>

            <div className="eyebrow -mb-2">Match</div>
            <Field
              label="Models"
              htmlFor="rule-models"
              hint="Comma-separated exact names. Blank = any model."
            >
              <Input
                id="rule-models"
                value={ruleForm.models}
                onChange={(e) => setRuleForm((f) => (f ? { ...f, models: e.target.value } : f))}
                placeholder="gpt-4o, gpt-4o-mini"
                className="font-mono text-xs"
              />
            </Field>
            <FieldGroup label="Virtual keys" hint="Blank = any key.">
              <CheckboxList
                items={(keysQ.data?.virtualKeys ?? []).map((k) => ({ id: k.id, label: k.name }))}
                selected={ruleForm.virtualKeyIds}
                onToggle={(id) =>
                  setRuleForm((f) =>
                    f ? { ...f, virtualKeyIds: toggleId(f.virtualKeyIds, id) } : f,
                  )
                }
                limit={20}
              />
            </FieldGroup>
            <FieldGroup label="Teams" hint="Blank = any team.">
              <CheckboxList
                items={(teamsQ.data?.teams ?? []).map((t) => ({ id: t.id, label: t.name }))}
                selected={ruleForm.teamIds}
                onToggle={(id) =>
                  setRuleForm((f) => (f ? { ...f, teamIds: toggleId(f.teamIds, id) } : f))
                }
                limit={20}
              />
            </FieldGroup>
            <FieldGroup label="Metadata" hint="Optional key/value match.">
              <MetadataRowsEditor
                rows={ruleForm.metadata}
                onChange={(metadata) => setRuleForm((f) => (f ? { ...f, metadata } : f))}
              />
            </FieldGroup>

            <div className="eyebrow -mb-2">Action</div>
            <Field label="Type" htmlFor="rule-action-type">
              <Select
                id="rule-action-type"
                value={ruleForm.actionType}
                onValueChange={(v) =>
                  setRuleForm((f) => (f ? { ...f, actionType: v as RuleActionType } : f))
                }
                options={[
                  { value: 'rewrite_model', label: 'Rewrite model' },
                  { value: 'set_fallbacks', label: 'Set fallbacks' },
                ]}
              />
            </Field>
            {ruleForm.actionType === 'rewrite_model' ? (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Provider" htmlFor="rule-to-provider">
                    <Input
                      id="rule-to-provider"
                      value={ruleForm.toProvider}
                      onChange={(e) =>
                        setRuleForm((f) => (f ? { ...f, toProvider: e.target.value } : f))
                      }
                      className="font-mono text-xs"
                    />
                  </Field>
                  <Field label="Model" htmlFor="rule-to-model">
                    <Input
                      id="rule-to-model"
                      value={ruleForm.toModel}
                      onChange={(e) =>
                        setRuleForm((f) => (f ? { ...f, toModel: e.target.value } : f))
                      }
                      placeholder="gpt-4o-mini"
                      className="font-mono text-xs"
                    />
                  </Field>
                </div>
                <FieldGroup
                  label="Fallbacks"
                  hint="Optional — tried in order if the rewrite target fails."
                >
                  <TargetRowsEditor
                    rows={ruleForm.fallbackRows}
                    onChange={(fallbackRows) =>
                      setRuleForm((f) => (f ? { ...f, fallbackRows } : f))
                    }
                  />
                </FieldGroup>
              </>
            ) : (
              <FieldGroup label="Fallback chain" hint="Tried in order until one succeeds.">
                <TargetRowsEditor
                  rows={ruleForm.fallbackRows}
                  onChange={(fallbackRows) => setRuleForm((f) => (f ? { ...f, fallbackRows } : f))}
                  minRows={1}
                />
              </FieldGroup>
            )}
          </div>
        ) : null}
      </Drawer>

      <Drawer
        open={aliasForm !== null}
        onClose={() => setAliasForm(null)}
        title="Edit alias"
        width="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAliasForm(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!aliasForm) return;
                const targets = aliasForm.targets.filter(
                  (t) => t.provider.trim() && t.model.trim(),
                );
                if (targets.length === 0) return;
                updateAliasMut.mutate({ id: aliasForm.id, targets });
              }}
              loading={updateAliasMut.isPending}
              disabled={
                !aliasForm || !aliasForm.targets.some((t) => t.provider.trim() && t.model.trim())
              }
            >
              Save alias
            </Button>
          </>
        }
      >
        {aliasForm ? (
          <div className="flex flex-col gap-4">
            <Field
              label="Alias"
              htmlFor="edit-alias-name"
              hint="Alias names can't be changed after creation."
            >
              <Input
                id="edit-alias-name"
                value={aliasForm.alias}
                disabled
                className="font-mono text-xs"
              />
            </Field>
            <FieldGroup label="Targets" hint="Tried in order until one succeeds.">
              <TargetRowsEditor
                rows={aliasForm.targets}
                onChange={(targets) => setAliasForm((f) => (f ? { ...f, targets } : f))}
                minRows={1}
              />
            </FieldGroup>
          </div>
        ) : null}
      </Drawer>

      <Dialog
        open={deleteRuleTarget !== null}
        onClose={() => setDeleteRuleTarget(null)}
        destructive
        title="Delete this routing rule?"
        description={
          deleteRuleTarget
            ? `Priority ${deleteRuleTarget.priority} — ${deleteRuleTarget.description || 'this rule'} will stop matching traffic immediately.`
            : undefined
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => setDeleteRuleTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={deleteRuleMut.isPending}
              onClick={() => deleteRuleTarget && deleteRuleMut.mutate(deleteRuleTarget.id)}
            >
              Delete rule
            </Button>
          </>
        }
      />

      <Dialog
        open={deleteAliasTarget !== null}
        onClose={() => setDeleteAliasTarget(null)}
        destructive
        title="Delete this alias?"
        description={
          deleteAliasTarget
            ? `"${deleteAliasTarget.alias}" will stop resolving — any code shipping this alias starts failing.`
            : undefined
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => setDeleteAliasTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={deleteAliasMut.isPending}
              onClick={() => deleteAliasTarget && deleteAliasMut.mutate(deleteAliasTarget.id)}
            >
              Delete alias
            </Button>
          </>
        }
      />
    </div>
  );
}
