import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  type RouteConfig,
} from '@asteasolutions/zod-to-openapi';
import {
  createOrgSchema,
  updateOrgSchema,
  inviteMemberSchema,
  updateMemberSchema,
  createTeamSchema,
  updateTeamSchema,
  createVirtualKeySchema,
  updateVirtualKeySchema,
  createAdminKeySchema,
  createBudgetSchema,
  updateBudgetSchema,
  createAliasSchema,
  updateAliasSchema,
  createRoutingRuleSchema,
  updateRoutingRuleSchema,
  createPolicySchema,
  updatePolicySchema,
  createAlertSchema,
  updateAlertSchema,
  createAutomationRuleSchema,
  updateAutomationRuleSchema,
  createApprovalPolicySchema,
  updateApprovalPolicySchema,
  createDelegationSchema,
  ChatCompletionsRequest,
  AnthropicMessagesRequest,
} from '../../packages/shared/src/index.js';

/**
 * Generates the OpenAPI 3.1 document for the public API from the zod schemas in `@spillway/shared`
 * (04-api-contracts §1 — the schemas are the single source of truth; this emits the spec that drives
 * the docs site, so there is no hand-maintained YAML to drift). Request bodies reference the ACTUAL
 * runtime schemas, so a schema change re-shapes the spec on the next `pnpm build:openapi`.
 *
 * Paths are the ones the server actually serves: control plane at `/api/*`, data plane at `/v1/*`.
 * (The bible §1.1 still says `/api/v1/*` for the control plane; the implementation collapsed the `v1`
 * segment during the two-plane split — see apps/web/src/lib/api.ts. Reality wins here.)
 */

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

// ── security schemes (§1.2) ──────────────────────────────────────────────────
registry.registerComponent('securitySchemes', 'virtualKey', {
  type: 'http',
  scheme: 'bearer',
  description:
    'Virtual key `mk-live-…` on the data plane. `x-api-key: mk-live-…` is also accepted.',
});
registry.registerComponent('securitySchemes', 'sessionToken', {
  type: 'http',
  scheme: 'bearer',
  description: 'WorkOS session access token (human dashboard sessions) on the control plane.',
});
registry.registerComponent('securitySchemes', 'adminKey', {
  type: 'http',
  scheme: 'bearer',
  description: 'Admin API key `mka-…` for machine control-plane access. Requires `X-Spillway-Org`.',
});

// X-Spillway-Org selects the active org for control-plane calls (mandatory for admin keys and for
// users in more than one org; the two exemptions are POST /api/orgs and GET /api/me). The ZodObject
// form makes each key a header parameter named by the key.
const orgHeaders = z.object({
  'X-Spillway-Org': z
    .string()
    .uuid()
    .optional()
    .openapi({ example: '601c5d19-0b88-42f7-acda-d1d31abd100d' }),
});

// ── error envelope (§1.4) ────────────────────────────────────────────────────
const errorCode = z.enum([
  'budget_exceeded',
  'rate_limited',
  'model_not_allowed',
  'key_not_found',
  'key_revoked',
  'key_paused',
  'rule_deny',
  'all_providers_failed',
  'upstream_error',
  'invalid_request',
  'internal_error',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'validation_error',
  'org_required',
  'last_owner',
  'key_expired',
  'service_unavailable',
  'no_candidates',
  'provider_key_decrypt_failed',
  'provider_unavailable',
  'upstream_parse_error',
  'request_too_large',
  'model_not_found',
  'no_route_available',
  'approval_required',
  'tier_required',
  'plan_upgrade_required',
  'cel_parse_error',
  'cel_type_error',
  'cel_cost_exceeded',
  'cel_ast_too_large',
  'cel_banned_macro',
  'cel_regex_too_long',
  'approval_chain_unsatisfiable',
  'not_pending',
  'self_approval_not_allowed',
  'not_an_approver',
  'unknown_effect',
  'invalid_action_token',
  'threshold_condition_not_isolated',
]);

const ControlPlaneError = registry.register(
  'Error',
  z
    .object({
      error: z.object({
        code: errorCode,
        message: z.string(),
        details: z.record(z.unknown()).optional(),
      }),
    })
    .openapi({ description: 'Control-plane error envelope (§1.4).' }),
);

const pagination = z.object({
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});

/** Generic paginated list envelope (§1.3). Items are documented per-resource in the dashboard types. */
const listEnvelope = (name: string) =>
  registry.register(
    name,
    z
      .object({ data: z.array(z.record(z.unknown())), pagination })
      .openapi({ description: 'Cursor-paginated list (§1.3).' }),
  );

// The shared createProviderKeySchema forbids `baseUrl` with `z.never()` (custom upstreams are
// unavailable until the compat adapter ships) — a contract zod-to-openapi cannot render. This is a
// faithful projection of the fields the endpoint actually accepts today.
const createProviderKeyDoc = z
  .object({
    provider: z.enum(['openai']),
    label: z.string().min(1).max(120),
    apiKey: z.string().min(1).max(512),
  })
  .openapi({
    description: '`base_url` is not accepted yet (custom upstreams ship with the compat adapter).',
  });

// updateAdminKeySchema is defined route-locally (not exported from @spillway/shared); mirror it here.
const updateAdminKeyDoc = z.object({ status: z.enum(['active', 'revoked']) });

const okObject = z.record(z.unknown()).openapi({ description: 'Resource object.' });
const errorResponse = {
  description: 'Error',
  content: { 'application/json': { schema: ControlPlaneError } },
};

// ── route table ──────────────────────────────────────────────────────────────
type Plane = 'data' | 'session' | 'admin';
interface Op {
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  tag: string;
  summary: string;
  plane: Plane;
  body?: z.ZodTypeAny;
  bodyName?: string;
  params?: { name: string; uuid?: boolean }[];
  success?: number; // default 200
  list?: string; // component name → list envelope response
  raw?: boolean; // data-plane pass-through response (provider-shaped)
}

const idParam = (name = 'id', uuid = true) => [{ name, uuid }];

const ops: Op[] = [
  // ── data plane (/v1) ──
  {
    method: 'post',
    path: '/v1/chat/completions',
    tag: 'Gateway',
    plane: 'data',
    raw: true,
    summary: 'OpenAI-compatible chat completion (streaming when `stream:true`).',
    body: ChatCompletionsRequest,
    bodyName: 'ChatCompletionsRequest',
  },
  {
    method: 'post',
    path: '/v1/messages',
    tag: 'Gateway',
    plane: 'data',
    raw: true,
    summary: 'Anthropic-compatible messages endpoint.',
    body: AnthropicMessagesRequest,
    bodyName: 'AnthropicMessagesRequest',
  },
  {
    method: 'get',
    path: '/v1/models',
    tag: 'Gateway',
    plane: 'data',
    raw: true,
    summary: 'Merged model catalogue (org providers + aliases).',
  },

  // ── orgs & identity (/api) ──
  {
    method: 'get',
    path: '/api/orgs',
    tag: 'Orgs',
    plane: 'session',
    summary: 'List orgs the caller belongs to.',
    list: 'OrgList',
  },
  {
    method: 'post',
    path: '/api/orgs',
    tag: 'Orgs',
    plane: 'session',
    summary: 'Create an org.',
    body: createOrgSchema,
    bodyName: 'CreateOrg',
    success: 201,
  },
  {
    method: 'get',
    path: '/api/org',
    tag: 'Orgs',
    plane: 'session',
    summary: 'Get the active org.',
  },
  {
    method: 'patch',
    path: '/api/org',
    tag: 'Orgs',
    plane: 'session',
    summary: 'Update the active org (settings, data policy).',
    body: updateOrgSchema,
    bodyName: 'UpdateOrg',
  },

  // ── members ──
  {
    method: 'get',
    path: '/api/members',
    tag: 'Members',
    plane: 'session',
    summary: 'List members.',
    list: 'MemberList',
  },
  {
    method: 'post',
    path: '/api/members',
    tag: 'Members',
    plane: 'session',
    summary: 'Invite a member by email.',
    body: inviteMemberSchema,
    bodyName: 'InviteMember',
    success: 201,
  },
  {
    method: 'patch',
    path: '/api/members/{userId}',
    tag: 'Members',
    plane: 'session',
    summary: "Change a member's role.",
    body: updateMemberSchema,
    bodyName: 'UpdateMember',
    params: idParam('userId', false),
  },
  {
    method: 'delete',
    path: '/api/members/{userId}',
    tag: 'Members',
    plane: 'session',
    summary: 'Remove a member (≥1 owner invariant enforced).',
    params: idParam('userId', false),
    success: 204,
  },

  // ── teams ──
  {
    method: 'get',
    path: '/api/teams',
    tag: 'Teams',
    plane: 'session',
    summary: 'List teams.',
    list: 'TeamList',
  },
  {
    method: 'post',
    path: '/api/teams',
    tag: 'Teams',
    plane: 'session',
    summary: 'Create a team.',
    body: createTeamSchema,
    bodyName: 'CreateTeam',
    success: 201,
  },
  {
    method: 'patch',
    path: '/api/teams/{id}',
    tag: 'Teams',
    plane: 'session',
    summary: 'Update a team.',
    body: updateTeamSchema,
    bodyName: 'UpdateTeam',
    params: idParam(),
  },
  {
    method: 'delete',
    path: '/api/teams/{id}',
    tag: 'Teams',
    plane: 'session',
    summary: 'Delete a team.',
    params: idParam(),
    success: 204,
  },

  // ── provider keys ──
  {
    method: 'get',
    path: '/api/provider-keys',
    tag: 'Provider keys',
    plane: 'session',
    summary: 'List provider keys (metadata only; ciphertext never returned).',
    list: 'ProviderKeyList',
  },
  {
    method: 'post',
    path: '/api/provider-keys',
    tag: 'Provider keys',
    plane: 'session',
    summary: 'Add a provider key (sealed AES-256-GCM).',
    body: createProviderKeyDoc,
    bodyName: 'CreateProviderKey',
    success: 201,
  },
  {
    method: 'delete',
    path: '/api/provider-keys/{id}',
    tag: 'Provider keys',
    plane: 'session',
    summary: 'Delete a provider key.',
    params: idParam(),
    success: 204,
  },

  // ── virtual keys ──
  {
    method: 'get',
    path: '/api/virtual-keys',
    tag: 'Virtual keys',
    plane: 'session',
    summary: 'List virtual keys.',
    list: 'VirtualKeyList',
  },
  {
    method: 'post',
    path: '/api/virtual-keys',
    tag: 'Virtual keys',
    plane: 'session',
    summary: 'Mint a virtual key (plaintext returned ONCE).',
    body: createVirtualKeySchema,
    bodyName: 'CreateVirtualKey',
    success: 201,
  },
  {
    method: 'patch',
    path: '/api/virtual-keys/{id}',
    tag: 'Virtual keys',
    plane: 'session',
    summary: 'Update a virtual key (pause/revoke/limits).',
    body: updateVirtualKeySchema,
    bodyName: 'UpdateVirtualKey',
    params: idParam(),
  },

  // ── admin api keys ──
  {
    method: 'get',
    path: '/api/admin-api-keys',
    tag: 'Admin keys',
    plane: 'session',
    summary: 'List admin API keys.',
    list: 'AdminKeyList',
  },
  {
    method: 'post',
    path: '/api/admin-api-keys',
    tag: 'Admin keys',
    plane: 'session',
    summary: 'Mint an admin API key (plaintext returned ONCE).',
    body: createAdminKeySchema,
    bodyName: 'CreateAdminKey',
    success: 201,
  },
  {
    method: 'patch',
    path: '/api/admin-api-keys/{id}',
    tag: 'Admin keys',
    plane: 'session',
    summary: 'Update an admin API key (revoke).',
    body: updateAdminKeyDoc,
    bodyName: 'UpdateAdminKey',
    params: idParam(),
  },

  // ── budgets ──
  {
    method: 'get',
    path: '/api/budgets',
    tag: 'Budgets',
    plane: 'session',
    summary: 'List budgets.',
    list: 'BudgetList',
  },
  {
    method: 'post',
    path: '/api/budgets',
    tag: 'Budgets',
    plane: 'session',
    summary: 'Create a budget.',
    body: createBudgetSchema,
    bodyName: 'CreateBudget',
    success: 201,
  },
  {
    method: 'patch',
    path: '/api/budgets/{id}',
    tag: 'Budgets',
    plane: 'session',
    summary: 'Update a budget.',
    body: updateBudgetSchema,
    bodyName: 'UpdateBudget',
    params: idParam(),
  },
  {
    method: 'delete',
    path: '/api/budgets/{id}',
    tag: 'Budgets',
    plane: 'session',
    summary: 'Delete a budget.',
    params: idParam(),
    success: 204,
  },

  // ── aliases ──
  {
    method: 'get',
    path: '/api/aliases',
    tag: 'Routing',
    plane: 'session',
    summary: 'List model aliases.',
    list: 'AliasList',
  },
  {
    method: 'post',
    path: '/api/aliases',
    tag: 'Routing',
    plane: 'session',
    summary: 'Create a model alias.',
    body: createAliasSchema,
    bodyName: 'CreateAlias',
    success: 201,
  },
  {
    method: 'patch',
    path: '/api/aliases/{id}',
    tag: 'Routing',
    plane: 'session',
    summary: 'Update a model alias.',
    body: updateAliasSchema,
    bodyName: 'UpdateAlias',
    params: idParam(),
  },
  {
    method: 'delete',
    path: '/api/aliases/{id}',
    tag: 'Routing',
    plane: 'session',
    summary: 'Delete a model alias.',
    params: idParam(),
    success: 204,
  },

  // ── routing rules ──
  {
    method: 'get',
    path: '/api/routing-rules',
    tag: 'Routing',
    plane: 'session',
    summary: 'List routing rules.',
    list: 'RoutingRuleList',
  },
  {
    method: 'post',
    path: '/api/routing-rules',
    tag: 'Routing',
    plane: 'session',
    summary: 'Create a routing rule.',
    body: createRoutingRuleSchema,
    bodyName: 'CreateRoutingRule',
    success: 201,
  },
  {
    method: 'patch',
    path: '/api/routing-rules/{id}',
    tag: 'Routing',
    plane: 'session',
    summary: 'Update a routing rule.',
    body: updateRoutingRuleSchema,
    bodyName: 'UpdateRoutingRule',
    params: idParam(),
  },
  {
    method: 'delete',
    path: '/api/routing-rules/{id}',
    tag: 'Routing',
    plane: 'session',
    summary: 'Delete a routing rule.',
    params: idParam(),
    success: 204,
  },

  // ── policies (guardrails) ──
  {
    method: 'get',
    path: '/api/policies',
    tag: 'Guardrails',
    plane: 'session',
    summary: 'List guardrail policies.',
    list: 'PolicyList',
  },
  {
    method: 'post',
    path: '/api/policies',
    tag: 'Guardrails',
    plane: 'session',
    summary: 'Create a guardrail policy.',
    body: createPolicySchema,
    bodyName: 'CreatePolicy',
    success: 201,
  },
  {
    method: 'patch',
    path: '/api/policies/{id}',
    tag: 'Guardrails',
    plane: 'session',
    summary: 'Update a guardrail policy.',
    body: updatePolicySchema,
    bodyName: 'UpdatePolicy',
    params: idParam(),
  },
  {
    method: 'delete',
    path: '/api/policies/{id}',
    tag: 'Guardrails',
    plane: 'session',
    summary: 'Delete a guardrail policy.',
    params: idParam(),
    success: 204,
  },
  {
    method: 'get',
    path: '/api/policies/{id}/shadow-impact',
    tag: 'Guardrails',
    plane: 'session',
    summary: 'Shadow-impact aggregate — "would have denied N requests / blocked $X" (16 §8.2).',
    params: idParam(),
  },
  {
    method: 'post',
    path: '/api/policies/lint',
    tag: 'Guardrails',
    plane: 'session',
    summary: 'Lint the effective routing rules + guardrail policies (16 §9.1 L1/L2/L5).',
  },
  {
    method: 'get',
    path: '/api/decision-logs',
    tag: 'Guardrails',
    plane: 'session',
    summary: 'Query the policy decision log (effect/policy/time filters).',
    list: 'DecisionLogList',
  },
  {
    method: 'get',
    path: '/api/decision-logs/{id}',
    tag: 'Guardrails',
    plane: 'session',
    summary: 'Get a single decision-log record (the "why was this denied" drill-down).',
    params: idParam(),
  },

  // ── alerts ──
  {
    method: 'get',
    path: '/api/alerts',
    tag: 'Alerts',
    plane: 'session',
    summary: 'List alerts.',
    list: 'AlertList',
  },
  {
    method: 'post',
    path: '/api/alerts',
    tag: 'Alerts',
    plane: 'session',
    summary: 'Create an alert.',
    body: createAlertSchema,
    bodyName: 'CreateAlert',
    success: 201,
  },
  {
    method: 'patch',
    path: '/api/alerts/{id}',
    tag: 'Alerts',
    plane: 'session',
    summary: 'Update an alert.',
    body: updateAlertSchema,
    bodyName: 'UpdateAlert',
    params: idParam(),
  },
  {
    method: 'delete',
    path: '/api/alerts/{id}',
    tag: 'Alerts',
    plane: 'session',
    summary: 'Delete an alert.',
    params: idParam(),
    success: 204,
  },

  // ── approvals ──
  {
    method: 'get',
    path: '/api/approvals',
    tag: 'Approvals',
    plane: 'session',
    summary: 'List approval requests.',
    list: 'ApprovalList',
  },
  {
    method: 'post',
    path: '/api/approvals',
    tag: 'Approvals',
    plane: 'session',
    summary: 'Open a human-initiated approval request (budget increase / key unpause).',
    success: 201,
  },
  {
    method: 'get',
    path: '/api/approvals/{id}',
    tag: 'Approvals',
    plane: 'session',
    summary: 'Get an approval request.',
    params: idParam(),
  },
  {
    method: 'post',
    path: '/api/approvals/{id}/decisions',
    tag: 'Approvals',
    plane: 'session',
    summary: 'Cast an approve/reject decision.',
    params: idParam(),
    success: 201,
  },
  {
    method: 'post',
    path: '/api/approvals/{id}/cancel',
    tag: 'Approvals',
    plane: 'session',
    summary: 'Cancel an approval request.',
    params: idParam(),
  },

  // ── approval policies ──
  {
    method: 'get',
    path: '/api/approval-policies',
    tag: 'Approvals',
    plane: 'session',
    summary: 'List approval policies.',
    list: 'ApprovalPolicyList',
  },
  {
    method: 'post',
    path: '/api/approval-policies',
    tag: 'Approvals',
    plane: 'session',
    summary: 'Create an approval policy.',
    body: createApprovalPolicySchema,
    bodyName: 'CreateApprovalPolicy',
    success: 201,
  },
  {
    method: 'patch',
    path: '/api/approval-policies/{id}',
    tag: 'Approvals',
    plane: 'session',
    summary: 'Update an approval policy.',
    body: updateApprovalPolicySchema,
    bodyName: 'UpdateApprovalPolicy',
    params: idParam(),
  },
  {
    method: 'delete',
    path: '/api/approval-policies/{id}',
    tag: 'Approvals',
    plane: 'session',
    summary: 'Delete an approval policy.',
    params: idParam(),
    success: 204,
  },

  // ── automation rules ──
  {
    method: 'get',
    path: '/api/automation-rules',
    tag: 'Automation',
    plane: 'session',
    summary: 'List automation rules.',
    list: 'AutomationRuleList',
  },
  {
    method: 'post',
    path: '/api/automation-rules',
    tag: 'Automation',
    plane: 'session',
    summary: 'Create an automation rule.',
    body: createAutomationRuleSchema,
    bodyName: 'CreateAutomationRule',
    success: 201,
  },
  {
    method: 'post',
    path: '/api/automation-rules/reorder',
    tag: 'Automation',
    plane: 'session',
    summary: 'Reorder automation-rule priority.',
  },
  {
    method: 'patch',
    path: '/api/automation-rules/{id}',
    tag: 'Automation',
    plane: 'session',
    summary: 'Update an automation rule.',
    body: updateAutomationRuleSchema,
    bodyName: 'UpdateAutomationRule',
    params: idParam(),
  },
  {
    method: 'delete',
    path: '/api/automation-rules/{id}',
    tag: 'Automation',
    plane: 'session',
    summary: 'Delete an automation rule.',
    params: idParam(),
    success: 204,
  },

  // ── delegations ──
  {
    method: 'get',
    path: '/api/delegations',
    tag: 'Approvals',
    plane: 'session',
    summary: 'List approval delegations.',
    list: 'DelegationList',
  },
  {
    method: 'post',
    path: '/api/delegations',
    tag: 'Approvals',
    plane: 'session',
    summary: 'Create an approval delegation.',
    body: createDelegationSchema,
    bodyName: 'CreateDelegation',
    success: 201,
  },
  {
    method: 'delete',
    path: '/api/delegations/{id}',
    tag: 'Approvals',
    plane: 'session',
    summary: 'Revoke an approval delegation.',
    params: idParam(),
    success: 204,
  },

  // ── reporting & observability ──
  {
    method: 'get',
    path: '/api/requests',
    tag: 'Reporting',
    plane: 'session',
    summary: 'Query the request log.',
    list: 'RequestList',
  },
  {
    method: 'get',
    path: '/api/reports/chargeback',
    tag: 'Reporting',
    plane: 'session',
    summary: 'Monthly chargeback statement (per team/key/model).',
  },
  {
    method: 'get',
    path: '/api/reports/insights',
    tag: 'Reporting',
    plane: 'session',
    summary: 'Savings insights report.',
  },
  {
    method: 'post',
    path: '/api/reports/insights/trigger',
    tag: 'Reporting',
    plane: 'session',
    summary: 'Trigger an on-demand insights run.',
    success: 202,
  },
  {
    method: 'get',
    path: '/api/kpi/overview',
    tag: 'Reporting',
    plane: 'session',
    summary: 'Dashboard KPI overview.',
  },
  {
    method: 'get',
    path: '/api/kpi/spend-timeseries',
    tag: 'Reporting',
    plane: 'session',
    summary: 'Spend time-series for the overview chart.',
  },
  {
    method: 'get',
    path: '/api/kpi/model-mix',
    tag: 'Reporting',
    plane: 'session',
    summary: 'Model-mix breakdown.',
  },
];

function responsesFor(op: Op): RouteConfig['responses'] {
  const responses: RouteConfig['responses'] = {};
  const code = op.success ?? 200;
  if (code === 204) {
    responses[204] = { description: 'No content' };
  } else if (op.list) {
    responses[code] = {
      description: 'OK',
      content: { 'application/json': { schema: listEnvelope(op.list) } },
    };
  } else if (op.raw) {
    responses[code] = {
      description:
        'Provider-shaped response (OpenAI/Anthropic JSON, or an SSE stream when streaming).',
    };
  } else {
    responses[code] = { description: 'OK', content: { 'application/json': { schema: okObject } } };
  }
  responses.default = errorResponse;
  return responses;
}

function security(plane: Plane): RouteConfig['security'] {
  if (plane === 'data') return [{ virtualKey: [] }];
  return [{ sessionToken: [] }, { adminKey: [] }];
}

for (const op of ops) {
  const request: RouteConfig['request'] = {};
  if (op.body)
    request.body = { content: { 'application/json': { schema: op.body } }, required: true };
  if (op.params) {
    request.params = z.object(
      Object.fromEntries(
        op.params.map((p) => [p.name, p.uuid === false ? z.string() : z.string().uuid()]),
      ),
    );
  }
  if (op.plane !== 'data') request.headers = orgHeaders;

  registry.registerPath({
    method: op.method,
    path: op.path,
    tags: [op.tag],
    summary: op.summary,
    security: security(op.plane),
    ...(Object.keys(request).length ? { request } : {}),
    responses: responsesFor(op),
  });
}

const generator = new OpenApiGeneratorV31(registry.definitions);
const doc = generator.generateDocument({
  openapi: '3.1.0',
  info: {
    title: 'Spillway API',
    version: '1.0.0',
    description:
      'The control plane for AI spend. One OpenAI-compatible gateway (`/v1/*`) plus a governance ' +
      'and administration API (`/api/*`). Request bodies are generated from the zod schemas in ' +
      '`@spillway/shared` — the single source of truth.',
  },
  servers: [
    { url: 'https://api.spillway.dev', description: 'Production' },
    { url: 'http://localhost:3000', description: 'Local dev' },
  ],
});

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../apps/docs/reference');
mkdirSync(outDir, { recursive: true });
const outFile = resolve(outDir, 'openapi.json');
writeFileSync(outFile, JSON.stringify(doc, null, 2) + '\n');

// ── self-contained HTML reference (no CDN — inline, static, rendered from `doc`) ──────────────────
interface JsonSchema {
  $ref?: string;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  type?: string;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
}
interface OpObj {
  summary?: string;
  tags?: string[];
  security?: Record<string, unknown>[];
  parameters?: { name?: string; in?: string; required?: boolean }[];
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
}
const esc = (s: unknown): string =>
  String(s ?? '').replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
  );

function typeName(s: JsonSchema | undefined): string {
  if (!s) return 'any';
  if (s.$ref) return String(s.$ref).split('/').pop()!;
  if (Array.isArray(s.enum)) return s.enum.map((v: unknown) => JSON.stringify(v)).join(' | ');
  const union = s.anyOf ?? s.oneOf;
  if (union) return union.map(typeName).join(' | ');
  if (s.allOf) return s.allOf.map(typeName).join(' & ');
  if (s.type === 'array') return `${typeName(s.items)}[]`;
  if (s.type === 'object' || s.properties) return 'object';
  return String(s.type ?? 'any');
}

function fieldsTable(schema: JsonSchema | undefined): string {
  const inner = schema?.allOf?.find((x: JsonSchema) => x.properties) ?? schema;
  const props = inner?.properties as Record<string, JsonSchema> | undefined;
  if (!props) return '';
  const required = new Set<string>(inner?.required ?? []);
  const rows = Object.entries(props)
    .map(
      ([name, s]) =>
        `<tr><td class="fn">${esc(name)}${required.has(name) ? '<span class="req">*</span>' : ''}</td>` +
        `<td class="ft">${esc(typeName(s))}</td>` +
        `<td class="fd">${esc(s.description ?? '')}</td></tr>`,
    )
    .join('');
  return `<table class="fields"><thead><tr><th>field</th><th>type</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

const methodOrder = ['get', 'post', 'patch', 'put', 'delete'];
const byTag = new Map<string, { method: string; path: string; op: OpObj }[]>();
for (const [p, item] of Object.entries(doc.paths ?? {})) {
  const pathItem = item as Record<string, OpObj>;
  for (const method of methodOrder) {
    const op = pathItem[method];
    if (!op) continue;
    const tag = op.tags?.[0] ?? 'Other';
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag)!.push({ method, path: p, op });
  }
}

function renderOp(method: string, path: string, op: OpObj): string {
  const body = op.requestBody?.content?.['application/json']?.schema;
  const params = op.parameters ?? [];
  const auth = (op.security ?? []).flatMap((s) => Object.keys(s)).join(' or ');
  const paramList = params.length
    ? `<div class="sub">Parameters</div><ul class="params">${params
        .map(
          (p) =>
            `<li><code>${esc(p.name)}</code> <span class="pin">${esc(p.in)}</span>${
              p.required ? '<span class="req">*</span>' : ''
            }</li>`,
        )
        .join('')}</ul>`
    : '';
  const bodyBlock = body ? `<div class="sub">Request body</div>${fieldsTable(body)}` : '';
  return `<div class="op" id="${esc(method + path)}">
    <div class="opline"><span class="m m-${method}">${method.toUpperCase()}</span><code class="path">${esc(path)}</code></div>
    <p class="summary">${esc(op.summary ?? '')}</p>
    ${auth ? `<div class="auth">auth: ${esc(auth)}</div>` : ''}
    ${paramList}
    ${bodyBlock}
  </div>`;
}

const tags = [...byTag.keys()];
const nav = tags.map((t) => `<a href="#tag-${esc(t.replace(/\s+/g, '-'))}">${esc(t)}</a>`).join('');
const sections = tags
  .map(
    (t) =>
      `<section id="tag-${esc(t.replace(/\s+/g, '-'))}"><h2>${esc(t)}</h2>${byTag
        .get(t)!
        .map(({ method, path, op }) => renderOp(method, path, op))
        .join('')}</section>`,
  )
  .join('');

const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(doc.info.title)} · API reference</title>
<style>
  :root { --bg:#0c0d10; --panel:#141519; --ink:#e7e7ea; --mut:#9a9ba2; --line:#24262c; --acc:#e8a33d; }
  * { box-sizing:border-box; } html { scroll-behavior:smooth; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif; }
  code,.m,.path,.ft,.fn { font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace; }
  .wrap { display:grid; grid-template-columns:220px 1fr; max-width:1080px; margin:0 auto; }
  nav { position:sticky; top:0; align-self:start; height:100vh; overflow:auto; padding:28px 16px; border-right:1px solid var(--line); }
  nav .brand { font-weight:600; letter-spacing:.02em; margin-bottom:4px; }
  nav .ver { color:var(--mut); font-size:12px; margin-bottom:18px; }
  nav a { display:block; color:var(--mut); text-decoration:none; padding:4px 0; font-size:13px; }
  nav a:hover { color:var(--acc); }
  main { padding:28px 32px; min-width:0; }
  h1 { font-size:22px; margin:0 0 6px; } .lede { color:var(--mut); margin:0 0 28px; max-width:60ch; }
  h2 { font-size:15px; text-transform:uppercase; letter-spacing:.08em; color:var(--acc); border-bottom:1px solid var(--line); padding-bottom:8px; margin:36px 0 14px; }
  .op { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px 18px; margin:12px 0; }
  .opline { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .m { font-size:11px; font-weight:700; padding:3px 8px; border-radius:5px; letter-spacing:.05em; }
  .m-get{background:#12341f;color:#5fd18b} .m-post{background:#123047;color:#5aa9e0}
  .m-patch{background:#3a2e12;color:#e8c25f} .m-delete{background:#3a1616;color:#e07a7a}
  .path { font-size:13.5px; } .summary { margin:10px 0 0; color:var(--ink); }
  .auth { color:var(--mut); font-size:12px; margin-top:8px; } .auth::before{content:"🔒 ";}
  .sub { text-transform:uppercase; font-size:11px; letter-spacing:.07em; color:var(--mut); margin:14px 0 6px; }
  .params { list-style:none; margin:0; padding:0; } .params li { padding:2px 0; }
  .pin { color:var(--mut); font-size:11px; margin-left:6px; }
  table.fields { width:100%; border-collapse:collapse; font-size:13px; }
  .fields th { text-align:left; color:var(--mut); font-weight:500; font-size:11px; text-transform:uppercase; letter-spacing:.06em; border-bottom:1px solid var(--line); padding:4px 8px; }
  .fields td { padding:5px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  .fn { color:var(--ink); } .ft { color:var(--acc); } .fd { color:var(--mut); }
  .req { color:#e07a7a; margin-left:2px; }
  .foot { color:var(--mut); font-size:12px; margin-top:40px; border-top:1px solid var(--line); padding-top:16px; }
  a { color:var(--acc); }
  @media (max-width:760px){ .wrap{grid-template-columns:1fr} nav{position:static;height:auto;border-right:none;border-bottom:1px solid var(--line)} }
</style></head>
<body><div class="wrap">
<nav><div class="brand">${esc(doc.info.title)}</div><div class="ver">v${esc(doc.info.version)}</div>${nav}</nav>
<main>
  <h1>${esc(doc.info.title)} — API reference</h1>
  <p class="lede">${esc(doc.info.description)}</p>
  ${sections}
  <div class="foot">Generated from the zod schemas by <code>pnpm build:openapi</code>. Machine-readable spec: <a href="./openapi.json">openapi.json</a>.</div>
</main>
</div></body></html>`;

const htmlFile = resolve(outDir, 'index.html');
writeFileSync(htmlFile, html);

const pathCount = Object.keys(doc.paths ?? {}).length;
const opCount = ops.length;
console.log(`openapi 3.1 → ${outFile}`);
console.log(
  `  ${pathCount} paths, ${opCount} operations, ${Object.keys(doc.components?.schemas ?? {}).length} schema components`,
);
console.log(`html reference → ${htmlFile}`);
