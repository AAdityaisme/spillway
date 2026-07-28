import { getAuthContext } from './auth.js';

/**
 * Typed fetch wrapper over the CONTROL plane (09-frontend §1.4). Base is `/api` (the bible's `/api/v1`
 * predates the two-plane split — control = /api/*, data = /v1/*). Sends the WorkOS session bearer + the
 * active-org header; maps a non-2xx into a typed ApiError the QueryCache handler renders as a toast.
 *
 * Casing landmines (source-grounded from the route files, 2026-07-16):
 * - responses are camelCase EXCEPT GET /approvals, GET /approvals/:id, GET /reports/insights
 *   (raw tx.execute passthroughs → snake_case)
 * - the /requests pagination envelope keys are snake_case while its rows are camelCase
 * - query params are snake_case (virtual_key_id, group_by, …)
 * - jsonb blobs (routing-rule match, approval-policy definition) keep snake_case internally
 * - money is ALWAYS an exact decimal string — never parse for comparisons, display-format only
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  params?: Record<string, string | number | boolean | undefined>;
}

export async function apiFetch<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const { session, activeOrgId } = getAuthContext();
  const url = new URL(`/api${path}`, window.location.origin);
  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: {
      // Only declare a JSON body when one exists — Fastify 400s a bodyless DELETE that
      // arrives with a json content-type (FST_ERR_CTP_EMPTY_JSON_BODY).
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      // L54: only emit the header when we have a real token; sending `Bearer ` with an empty
      // credential triggers a deterministic 401 on every unauthenticated call.
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      ...(activeOrgId ? { 'X-Spillway-Org': activeOrgId } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string; details?: Record<string, unknown> };
    } | null;
    throw new ApiError(
      res.status,
      err?.error?.code ?? 'unknown',
      err?.error?.message ?? res.statusText,
      err?.error?.details,
    );
  }
  return res.json() as Promise<T>;
}

/**
 * Authenticated file download (chargeback CSV). The CSV endpoint requires the bearer +
 * org headers, so a plain <a href> can't reach it — fetch to a blob and click through.
 */
export async function apiDownload(
  path: string,
  params: Record<string, string>,
  filename: string,
): Promise<void> {
  const { session, activeOrgId } = getAuthContext();
  const url = new URL(`/api${path}`, window.location.origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: {
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      ...(activeOrgId ? { 'X-Spillway-Org': activeOrgId } : {}),
    },
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new ApiError(
      res.status,
      err?.error?.code ?? 'unknown',
      err?.error?.message ?? res.statusText,
    );
  }
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(href);
}

// ── orgs / settings ────────────────────────────────────────────────────────────

export type Plan = 'free' | 'pro' | 'governance' | 'enterprise';
export type Role = 'owner' | 'admin' | 'member' | 'viewer';

export interface OrgMembership {
  id: string;
  name: string;
  slug: string;
  plan: Plan;
  role: Role;
}
export interface Org {
  id: string;
  name: string;
  slug: string;
  plan: Plan;
  bodyLoggingEnabled: boolean;
  bodyRetentionDays: number;
  metadataRetentionDays: number;
  createdAt: string;
  updatedAt: string;
}

// ── teams / members ────────────────────────────────────────────────────────────

export interface Team {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
}
export interface Member {
  userId: string;
  role: Role;
  email: string | null;
  name: string | null;
  createdAt: string;
}

// ── keys ───────────────────────────────────────────────────────────────────────

export interface VirtualKey {
  id: string;
  name: string;
  teamId: string | null;
  keyPrefix: string;
  status: 'active' | 'paused' | 'revoked';
  allowedProviders: string[] | null;
  allowedModels: string[] | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  metadata: Record<string, string> | null;
  createdAt: string;
}
/** Reveal-once: only the 201 create response carries `key`. */
export interface CreatedVirtualKey extends VirtualKey {
  key: string;
}
export interface CreateVirtualKeyInput {
  name: string;
  teamId?: string;
  allowedProviders?: string[];
  allowedModels?: string[];
  rpmLimit?: number;
  tpmLimit?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  expiresAt?: string;
  metadata?: Record<string, string>;
}

export interface ProviderKey {
  id: string;
  provider: string;
  label: string;
  baseUrl: string | null;
  keyPrefix: string;
  status: string;
  createdAt: string;
}

// ── budgets ────────────────────────────────────────────────────────────────────

export type BudgetScopeType = 'org' | 'team' | 'virtual_key' | 'provider';
export type BudgetPeriod = 'day' | 'month' | 'rolling_30d';
export type BudgetMode = 'enforce' | 'alert' | 'monitor';

export interface Budget {
  id: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  period: BudgetPeriod;
  limitUsd: string;
  mode: BudgetMode;
  onExceed: 'block' | 'fallback';
  fallbackAlias: string | null;
  createdAt: string;
}
export interface CreateBudgetInput {
  scopeType: BudgetScopeType;
  scopeId: string;
  period: BudgetPeriod;
  limitUsd: string;
  mode?: BudgetMode;
  onExceed?: 'block' | 'fallback';
  fallbackAlias?: string | null;
}

// ── alerts ─────────────────────────────────────────────────────────────────────

export interface Alert {
  id: string;
  name: string;
  kind: string;
  scopeType: string | null;
  scopeId: string | null;
  config: Record<string, unknown>;
  channels: Array<Record<string, unknown>>;
  enabled: boolean;
  createdAt: string;
}

// ── routing: aliases + rules + guardrail policies ─────────────────────────────

export interface ModelTarget {
  provider: string;
  model: string;
}
export type AliasTargets =
  | ModelTarget[]
  | { default: ModelTarget[]; context_window?: ModelTarget[]; content_policy?: ModelTarget[] };
export interface ModelAlias {
  id: string;
  alias: string;
  targets: AliasTargets;
  createdAt: string;
}

export interface RoutingRuleMatch {
  virtual_key_ids?: string[];
  team_ids?: string[];
  models?: string[];
  metadata?: Record<string, string>;
}
export type RoutingRuleAction =
  | { type: 'rewrite_model'; to: ModelTarget; fallbacks?: AliasTargets }
  | { type: 'set_fallbacks'; chain: AliasTargets };
export interface RoutingRule {
  id: string;
  priority: number;
  description: string | null;
  match: RoutingRuleMatch;
  action: RoutingRuleAction;
  enabled: boolean;
  createdAt: string;
}

export interface Policy {
  id: string;
  name: string;
  description: string | null;
  effect: 'deny' | 'require_approval' | 'flag';
  reason: string;
  match: Record<string, unknown>;
  conditionCel: string | null;
  conditionCost: number | null;
  enforcement: 'shadow' | 'enforce';
  enabled: boolean;
  revision: number;
  createdAt: string;
}

// ── approvals (snake_case — raw SQL passthrough on the server) ────────────────

export interface ApprovalRow {
  id: string;
  kind: string;
  status: 'pending' | 'approved' | 'denied' | 'cancelled' | 'expired';
  scope_type: string | null;
  scope_id: string | null;
  amount_usd: string | null;
  current_step_index: number;
  requested_by: string;
  created_at: string;
}
export interface ApprovalDetail extends ApprovalRow {
  decided_by: string | null;
  decided_at: string | null;
  expires_at: string | null;
}
export interface ApprovalStep {
  step_index: number;
  quorum: string | number;
  required_approver_ids: string[];
  notify_only: boolean;
  status: string;
}

// ── requests / traffic log ─────────────────────────────────────────────────────

/** A traffic-log row (04-api-contracts §3.11 list shape; camelCase per the control-plane convention). */
export interface RequestLogRow {
  id: string;
  orgId: string;
  virtualKeyId: string | null;
  teamId: string | null;
  provider: string | null;
  model: string | null;
  requestedModel: string | null;
  endpoint: string;
  status: 'ok' | 'error' | 'blocked' | 'rate_limited';
  blockReason: string | null;
  blockScopeType: string | null;
  blockScopeId: string | null;
  blockPeriod: string | null;
  errorCode: string | null;
  httpStatus: number | null;
  stream: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  usageEstimated: boolean;
  costUsd: string | null;
  latencyMs: number | null;
  ttftMs: number | null;
  fallbackFrom: Array<{ provider: string; model: string; error: string }> | null;
  routingRuleId: string | null;
  metadata: Record<string, string>;
  createdAt: string;
}

/** Detail adds the per-request price snapshot + the matched rule's display name (§3.11 single-record). */
export interface RequestLogDetail extends RequestLogRow {
  unitPrices: Record<string, string> | null;
  routingRuleName: string | null;
}

export interface PaginationMeta {
  has_more: boolean;
  next_cursor: string | null;
}

// A `type` (not `interface`) so it carries an implicit index signature and stays assignable to
// `apiFetch`'s `params: Record<string, …>` — an interface would fail the apps/web build's strict tsc.
export type RequestListParams = {
  limit?: number;
  cursor?: string;
  start?: string;
  end?: string;
  virtual_key_id?: string;
  team_id?: string;
  model?: string;
  provider?: string;
  status?: string;
  endpoint?: string;
};

// ── traces (the routing-trace audit — Governance differentiator) ──────────────

export interface TraceDecision {
  effect: string;
  enforcement: string;
  decidingPolicyId: string | null;
  routingRuleId: string | null;
  reason: string | null;
}
export interface TraceAttempt {
  attemptNumber: number;
  provider: string;
  model: string;
  outcome: string;
  errorCode: string | null;
  costUsd: string | null;
}
export interface RoutingTrace {
  requestId: string;
  requestedModel: string | null;
  status: string;
  costUsd: string | null;
  configSnapshotHash: string | null;
  createdAt: string;
  decisions: TraceDecision[];
  attempts: TraceAttempt[];
}

// ── reports ────────────────────────────────────────────────────────────────────

export interface ChargebackLine {
  scopeType: string;
  scopeId: string | null;
  requestCount: number;
  successCount: number;
  blockedCount: number;
  costUsd: string;
}
export interface ChargebackStatement {
  orgId: string;
  periodStart: string;
  periodEnd: string;
  groupBy: string;
  lines: ChargebackLine[];
  totalCostUsd: string;
  reconciliation: {
    requestsUsd: string;
    attemptsUsd: string;
    consistent: boolean;
    warning?: string;
    countersUsd: string | null;
    counterConsistent: boolean | null;
    counterWarning?: string;
  };
}

/** snake_case — raw SQL passthrough on the server. */
export interface SavingsInsight {
  period: string;
  generated_at: string;
  summary: Record<string, unknown>;
  detail: Record<string, unknown>;
}

// ── KPI / Overview (04-api-contracts §3.15) — SQL-aggregate-backed, camelCase, money as strings ──

export interface BudgetUtilization {
  scopeType: string;
  scopeId: string;
  scopeName: string;
  period: string;
  limitUsd: string;
  spentUsd: string;
  pct: number;
  mode: string;
}
export interface TopModel {
  provider: string;
  model: string;
  spendUsd: string;
  requestCount: number;
  pctOfTotal: number;
}
export interface OverviewKpis {
  period: string;
  spendUsd: string;
  spendUsdPrevPeriod: string;
  requestCount: number;
  blockedCount: number;
  budgetUtilization: BudgetUtilization[];
  topModels: TopModel[];
  errorRatePct: number;
}

export type TimeseriesGroupBy = 'none' | 'team' | 'model' | 'provider' | 'virtual_key';
export interface TimeseriesPoint {
  date: string;
  spendUsd: string;
  requestCount: number;
}
export interface TimeseriesSeries {
  groupKey: string | null;
  groupName: string | null;
  points: TimeseriesPoint[];
}
export interface SpendTimeseries {
  start: string;
  end: string;
  groupBy: TimeseriesGroupBy;
  points?: TimeseriesPoint[];
  series?: TimeseriesSeries[];
}

export interface ModelMixRow {
  provider: string;
  model: string;
  spendUsd: string;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  pctOfSpend: number;
}
export interface ModelMix {
  period: string;
  totalSpendUsd: string;
  models: ModelMixRow[];
}

// ── endpoint map ───────────────────────────────────────────────────────────────

export const api = {
  // orgs
  listOrgs: () => apiFetch<{ orgs: OrgMembership[] }>('/orgs'),
  createOrg: (body: { name: string; slug: string }) =>
    apiFetch<{ org: Org }>('/orgs', { method: 'POST', body }),
  getOrg: () => apiFetch<{ org: Org }>('/org'),
  updateOrg: (
    body: Partial<
      Pick<Org, 'name' | 'bodyLoggingEnabled' | 'bodyRetentionDays' | 'metadataRetentionDays'>
    >,
  ) => apiFetch<{ org: Org }>('/org', { method: 'PATCH', body }),

  // members + teams
  listMembers: () => apiFetch<{ members: Member[] }>('/members'),
  inviteMember: (body: { userId: string; role: Role }) =>
    apiFetch<{ member: { orgId: string; userId: string; role: Role; createdAt: string } }>(
      '/members',
      {
        method: 'POST',
        body,
      },
    ),
  updateMemberRole: (userId: string, role: Role) =>
    apiFetch<{ member: Member }>(`/members/${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      body: { role },
    }),
  removeMember: (userId: string) =>
    apiFetch<void>(`/members/${encodeURIComponent(userId)}`, { method: 'DELETE' }),
  listTeams: () => apiFetch<{ teams: Team[] }>('/teams'),
  createTeam: (body: { name: string; slug: string }) =>
    apiFetch<{ team: Team }>('/teams', { method: 'POST', body }),

  // virtual keys
  listVirtualKeys: () => apiFetch<{ virtualKeys: VirtualKey[] }>('/virtual-keys'),
  createVirtualKey: (body: CreateVirtualKeyInput) =>
    apiFetch<{ virtualKey: CreatedVirtualKey }>('/virtual-keys', { method: 'POST', body }),
  setVirtualKeyStatus: (id: string, status: 'active' | 'paused' | 'revoked') =>
    apiFetch<{ virtualKey: VirtualKey }>(`/virtual-keys/${id}`, {
      method: 'PATCH',
      body: { status },
    }),

  // provider keys
  listProviderKeys: () => apiFetch<{ providerKeys: ProviderKey[] }>('/provider-keys'),
  createProviderKey: (body: { provider: string; label: string; apiKey: string }) =>
    apiFetch<{ providerKey: ProviderKey }>('/provider-keys', { method: 'POST', body }),
  deleteProviderKey: (id: string) => apiFetch<void>(`/provider-keys/${id}`, { method: 'DELETE' }),

  // budgets
  listBudgets: () => apiFetch<{ budgets: Budget[] }>('/budgets'),
  createBudget: (body: CreateBudgetInput) =>
    apiFetch<{ budget: Budget }>('/budgets', { method: 'POST', body }),
  updateBudget: (
    id: string,
    body: Partial<Omit<CreateBudgetInput, 'scopeType' | 'scopeId' | 'period'>>,
  ) => apiFetch<{ budget: Budget }>(`/budgets/${id}`, { method: 'PATCH', body }),
  deleteBudget: (id: string) => apiFetch<void>(`/budgets/${id}`, { method: 'DELETE' }),

  // alerts
  listAlerts: () => apiFetch<{ alerts: Alert[] }>('/alerts'),
  createAlert: (body: {
    name: string;
    kind: string;
    scopeType?: string | null;
    scopeId?: string | null;
    config?: Record<string, unknown>;
    channels?: Array<Record<string, unknown>>;
  }) => apiFetch<{ alert: Alert }>('/alerts', { method: 'POST', body }),
  updateAlert: (
    id: string,
    body: Partial<{
      name: string;
      config: Record<string, unknown>;
      channels: Array<Record<string, unknown>>;
      enabled: boolean;
    }>,
  ) => apiFetch<{ alert: Alert }>(`/alerts/${id}`, { method: 'PATCH', body }),
  deleteAlert: (id: string) => apiFetch<void>(`/alerts/${id}`, { method: 'DELETE' }),

  // routing
  listAliases: () => apiFetch<{ aliases: ModelAlias[] }>('/aliases'),
  createAlias: (body: { alias: string; targets: AliasTargets }) =>
    apiFetch<{ alias: ModelAlias }>('/aliases', { method: 'POST', body }),
  updateAlias: (id: string, targets: AliasTargets) =>
    apiFetch<{ alias: ModelAlias }>(`/aliases/${id}`, { method: 'PATCH', body: { targets } }),
  deleteAlias: (id: string) => apiFetch<void>(`/aliases/${id}`, { method: 'DELETE' }),
  listRoutingRules: () => apiFetch<{ routingRules: RoutingRule[] }>('/routing-rules'),
  createRoutingRule: (body: {
    priority: number;
    description?: string;
    match: RoutingRuleMatch;
    action: RoutingRuleAction;
    enabled?: boolean;
  }) => apiFetch<{ routingRule: RoutingRule }>('/routing-rules', { method: 'POST', body }),
  updateRoutingRule: (
    id: string,
    body: Partial<{
      priority: number;
      description: string;
      match: RoutingRuleMatch;
      action: RoutingRuleAction;
      enabled: boolean;
    }>,
  ) => apiFetch<{ routingRule: RoutingRule }>(`/routing-rules/${id}`, { method: 'PATCH', body }),
  deleteRoutingRule: (id: string) => apiFetch<void>(`/routing-rules/${id}`, { method: 'DELETE' }),

  // guardrail policies
  listPolicies: () => apiFetch<{ policies: Policy[] }>('/policies'),
  createPolicy: (body: {
    name: string;
    description?: string;
    effect: Policy['effect'];
    reason: string;
    match?: Record<string, unknown>;
    conditionCel?: string | null;
    enforcement?: Policy['enforcement'];
    enabled?: boolean;
  }) => apiFetch<{ policy: Policy }>('/policies', { method: 'POST', body }),
  updatePolicy: (
    id: string,
    body: Partial<{
      name: string;
      description: string;
      effect: Policy['effect'];
      reason: string;
      match: Record<string, unknown>;
      conditionCel: string | null;
      enforcement: Policy['enforcement'];
      enabled: boolean;
    }>,
  ) => apiFetch<{ policy: Policy }>(`/policies/${id}`, { method: 'PATCH', body }),
  deletePolicy: (id: string) => apiFetch<void>(`/policies/${id}`, { method: 'DELETE' }),

  // approvals
  listApprovals: (status?: string) =>
    apiFetch<{ approvals: ApprovalRow[] }>('/approvals', {
      params: status ? { status } : undefined,
    }),
  getApproval: (id: string) =>
    apiFetch<{ approval: ApprovalDetail; steps: ApprovalStep[] }>(`/approvals/${id}`),
  decideApproval: (id: string, decision: 'approve' | 'deny', comment?: string) =>
    apiFetch<{ status: string }>(`/approvals/${id}/decisions`, {
      method: 'POST',
      body: { decision, ...(comment ? { comment } : {}) },
    }),
  cancelApproval: (id: string, comment?: string) =>
    apiFetch<{ status: string }>(`/approvals/${id}/cancel`, {
      method: 'POST',
      body: comment ? { comment } : {},
    }),

  // requests + traces
  listRequests: (params: RequestListParams = {}) =>
    apiFetch<{ data: RequestLogRow[]; pagination: PaginationMeta }>('/requests', { params }),
  getRequest: (id: string) => apiFetch<{ request: RequestLogDetail }>(`/requests/${id}`),
  getTrace: (requestId: string) => apiFetch<{ trace: RoutingTrace }>(`/traces/${requestId}`),

  // reports
  getChargeback: (params: { start?: string; end?: string; group_by?: string }) =>
    apiFetch<{ statement: ChargebackStatement }>('/reports/chargeback', { params }),
  downloadChargebackCsv: (params: { start?: string; end?: string; group_by?: string }) =>
    apiDownload(
      '/reports/chargeback',
      {
        format: 'csv',
        ...(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined)) as Record<
          string,
          string
        >),
      },
      'chargeback.csv',
    ),
  getInsights: () => apiFetch<{ insight: SavingsInsight | null }>('/reports/insights'),
  triggerInsights: () =>
    apiFetch<{ result: unknown }>('/reports/insights/trigger', { method: 'POST' }),

  // kpi
  getOverview: (period?: string) =>
    apiFetch<OverviewKpis>('/kpi/overview', { params: period ? { period } : undefined }),
  getSpendTimeseries: (params: {
    start: string;
    end: string;
    group_by?: TimeseriesGroupBy;
    team_id?: string;
  }) => apiFetch<SpendTimeseries>('/kpi/spend-timeseries', { params }),
  getModelMix: (period?: string, limit?: number) =>
    apiFetch<ModelMix>('/kpi/model-mix', { params: { period, limit } }),
};
