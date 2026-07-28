/**
 * Routing compilers + shared routing types (15 §2.1/§2.2). Ported verbatim from the red-teamed
 * lab (routing/compile.ts) — pure, no I/O.
 *
 * Aliases and rules are compiled ONCE at bundle-load (authoring-time), never on the hot path
 * (15 §10): flat/typed alias forms normalize to a `TypedChain`, rules sort ascending by priority,
 * and a `deny` action in `routing_rules` is a LINT REJECTION (`CompileError`) — `deny` migrated to
 * the guardrail layer (ADR-034), so the routing engine only ever executes transform actions.
 */

export type ProviderName = 'openai' | 'anthropic' | 'gemini' | 'openai_compat';

const PROVIDERS: ReadonlySet<string> = new Set<ProviderName>([
  'openai',
  'anthropic',
  'gemini',
  'openai_compat',
]);

/** Per-error-class advancement discriminator (15 §7.1). */
export type ErrorClass =
  | 'context_window'
  | 'content_policy'
  | 'rate_limit'
  | 'server'
  | 'timeout'
  | 'auth'
  | 'client'
  | null;

export interface TargetSpec {
  provider: ProviderName;
  model: string;
}

/** Error-typed fallback chain (ADR-042.2). `default` required, ≥1; variants optional. */
export interface TypedChain {
  default: TargetSpec[];
  context_window?: TargetSpec[];
  content_policy?: TargetSpec[];
}

export interface CompiledAlias {
  alias: string;
  targets: TypedChain;
}

export type RewriteModelAction = {
  type: 'rewrite_model';
  to: TargetSpec;
  fallbacks?: TypedChain;
};
export type SetFallbacksAction = {
  type: 'set_fallbacks';
  chain: TypedChain;
};
export type RuleAction = RewriteModelAction | SetFallbacksAction;

/** Structured routing match (15 §4.7). AND of present fields; absent = wildcard. */
export interface RuleMatch {
  virtual_key_ids?: string[];
  team_ids?: string[];
  models?: string[];
  metadata?: Array<Record<string, string>>;
}

export interface CompiledRule {
  id: string;
  priority: number;
  match: RuleMatch;
  action: RuleAction;
  onStatusCodes?: number[];
}

/** A dispatchable target bound to a concrete provider key (15 §4.6). */
export interface Candidate {
  provider: ProviderName;
  model: string;
  providerKeyId: string;
  baseUrl?: string;
}

/** Authoring-time compile violation (15 §2.1/§2.2). Rejected at load, never a hot-path branch. */
export class CompileError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CompileError';
    this.code = code;
  }
}

/** §4.4 normalization: trim + lowercase. */
export function normalizeModel(model: string): string {
  return model.trim().toLowerCase();
}

/** §4.6 provider inference by prefix; null if no prefix matches. */
export function inferProvider(model: string): ProviderName | null {
  if (model.startsWith('ft:gpt-') || model.startsWith('gpt-')) return 'openai';
  if (model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) return 'openai';
  if (model.startsWith('text-embedding-')) return 'openai'; // /v1/embeddings models (task #9)
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gemini-')) return 'gemini';
  return null;
}

const MAX_CHAIN = 10;

function validateTarget(t: unknown): TargetSpec {
  if (t === null || typeof t !== 'object')
    throw new CompileError('invalid_target', 'target must be an object');
  const rec = t as Record<string, unknown>;
  const provider = rec.provider;
  const model = rec.model;
  if (typeof provider !== 'string' || !PROVIDERS.has(provider)) {
    throw new CompileError('invalid_provider', `unknown provider: ${String(provider)}`);
  }
  if (typeof model !== 'string' || model.length === 0) {
    throw new CompileError('invalid_target', 'target.model must be a non-empty string');
  }
  return { provider: provider as ProviderName, model };
}

function validateVariant(arr: unknown, field: string): TargetSpec[] {
  if (!Array.isArray(arr)) throw new CompileError('invalid_target', `${field} must be an array`);
  if (arr.length < 1 || arr.length > MAX_CHAIN) {
    throw new CompileError('chain_too_large', `${field} must have 1..${MAX_CHAIN} entries`);
  }
  return arr.map(validateTarget);
}

/** Normalize the flat-array | typed-object superset into a validated `TypedChain` (§2.1). */
export function normalizeChain(raw: TypedChain | TargetSpec[]): TypedChain {
  if (Array.isArray(raw)) return { default: validateVariant(raw, 'targets') };
  const rec = raw as unknown as Record<string, unknown>;
  if (rec.default === undefined)
    throw new CompileError('alias_empty_default', 'targets.default is required');
  const out: TypedChain = { default: validateVariant(rec.default, 'default') };
  if (rec.context_window !== undefined)
    out.context_window = validateVariant(rec.context_window, 'context_window');
  if (rec.content_policy !== undefined)
    out.content_policy = validateVariant(rec.content_policy, 'content_policy');
  return out;
}

/** Compile one alias row: normalize targets, lowercase the alias key. */
export function compileAlias(raw: {
  alias: string;
  targets: TypedChain | TargetSpec[];
}): CompiledAlias {
  return { alias: normalizeModel(raw.alias), targets: normalizeChain(raw.targets) };
}

interface RawRule {
  id: string;
  priority: number;
  match: RuleMatch;
  action: {
    type: string;
    to?: TargetSpec;
    fallbacks?: TypedChain | TargetSpec[];
    chain?: TypedChain | TargetSpec[];
  };
  onStatusCodes?: number[];
}

/** Compile one rule row: reject `deny`, normalize match.models + the action chains. */
export function compileRule(raw: RawRule): CompiledRule {
  if (raw.action.type === 'deny') {
    throw new CompileError(
      'routing_rule_deny_forbidden',
      'deny is not a routing action (migrated to governance_policies)',
    );
  }
  const match: RuleMatch = { ...raw.match };
  if (match.models) match.models = match.models.map(normalizeModel);

  let action: RuleAction;
  if (raw.action.type === 'rewrite_model') {
    if (raw.action.to === undefined)
      throw new CompileError('invalid_action', 'rewrite_model requires `to`');
    const to = validateTarget(raw.action.to);
    action =
      raw.action.fallbacks !== undefined
        ? { type: 'rewrite_model', to, fallbacks: normalizeChain(raw.action.fallbacks) }
        : { type: 'rewrite_model', to };
  } else if (raw.action.type === 'set_fallbacks') {
    if (raw.action.chain === undefined)
      throw new CompileError('invalid_action', 'set_fallbacks requires `chain`');
    action = { type: 'set_fallbacks', chain: normalizeChain(raw.action.chain) };
  } else {
    throw new CompileError('invalid_action', `unknown routing action: ${raw.action.type}`);
  }

  const rule: CompiledRule = { id: raw.id, priority: raw.priority, match, action };
  if (raw.onStatusCodes !== undefined) rule.onStatusCodes = [...raw.onStatusCodes];
  return rule;
}

/** Compile + pre-sort a rule set ascending by priority (§2.2). Stable on ties (input order). */
export function compileRules(raws: RawRule[]): CompiledRule[] {
  return raws
    .map((r, i) => ({ rule: compileRule(r), i }))
    .sort((a, b) => a.rule.priority - b.rule.priority || a.i - b.i)
    .map((x) => x.rule);
}
