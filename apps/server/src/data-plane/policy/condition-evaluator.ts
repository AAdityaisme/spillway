/**
 * BufbuildConditionEvaluator — the CEL guardrail seam (16 §5.1–§5.4, ADR-034). Ported verbatim from
 * the red-teamed lab. CEL is compiled/typechecked/cost-bounded ONLY at authoring time (compile,
 * control plane). The request path never parses/compiles: the bundle deserializes a stored program
 * once (load) and the hot path only calls run / evalCondition.
 *
 * Engine: @bufbuild/cel@0.6.0 (pinned, RE2 via re2js). It exposes only parse/plan/run — no public
 * typechecker/cost estimator — so the static bounds (bounds.ts) are enforced by walking the parsed
 * AST here. Typecheck is path-existence + result-must-be-bool against the 16 §4.1 catalog; the
 * fail-closed §5.4 contract exists precisely for runtime errors that slip past this best-effort gate.
 */

import { parse, plan, celEnv, isCelError } from '@bufbuild/cel';
import { BANNED_MACROS, CelCompileError, MAX_COST, MAX_NODES, MAX_REGEX_LEN } from './bounds.js';

export interface CompiledCondition {
  readonly source: string;
  readonly program: Uint8Array;
  readonly cost: number;
  readonly refs: string[];
}

/** Activation built once per request (16 §4), namespaced by the four attribute roots. */
export interface AttributeActivation {
  readonly identity: Record<string, unknown>;
  readonly request: Record<string, unknown>;
  readonly spend: Record<string, unknown>;
  readonly time: Record<string, unknown>;
}

export type Enforcement = 'enforce' | 'shadow';

export interface ConditionEvaluator {
  compile(source: string): CompiledCondition;
  load(program: Uint8Array, source: string, cost: number, refs: string[]): CompiledCondition;
  run(condition: CompiledCondition, attrs: AttributeActivation): boolean;
  /** Cumulative hot-path metrics (slow runs / runtime errors); read for per-request cel_error state. */
  readonly metrics: Readonly<CelMetrics>;
}

interface ConstantKind {
  readonly case?: string;
  readonly value?: unknown;
}
interface ExprNode {
  readonly exprKind?: { readonly case?: string; readonly value?: unknown };
}
interface CallValue {
  readonly function: string;
  readonly target?: ExprNode;
  readonly args?: readonly ExprNode[];
}
interface SelectValue {
  readonly operand?: ExprNode;
  readonly field: string;
  readonly testOnly?: boolean;
}
interface IdentValue {
  readonly name: string;
}
interface ListValue {
  readonly elements?: readonly ExprNode[];
}
interface ConstValue {
  readonly constantKind?: ConstantKind;
}

const NAMESPACES = ['identity', 'request', 'spend', 'time'] as const;

const FIXED_PATHS: ReadonlyMap<string, { bool: boolean }> = new Map([
  ['identity.org_id', { bool: false }],
  ['identity.team_id', { bool: false }],
  ['identity.virtual_key_id', { bool: false }],
  ['identity.key_tags', { bool: false }],
  ['identity.actor', { bool: false }],
  ['request.model_requested', { bool: false }],
  ['request.model_resolved', { bool: false }],
  ['request.provider', { bool: false }],
  ['request.endpoint', { bool: false }],
  ['request.stream', { bool: true }],
  ['request.has_tools', { bool: true }],
  ['request.tool_count', { bool: false }],
  ['request.response_format', { bool: false }],
  ['request.temperature', { bool: false }],
  ['request.max_output_tokens', { bool: false }],
  ['request.tokens.input_est', { bool: false }],
  ['time.hour_utc', { bool: false }],
  ['time.dow', { bool: false }],
  ['time.ts', { bool: false }],
]);

const SPEND_SCOPES = new Set(['key', 'team', 'org', 'provider']);
const SPEND_PERIODS = new Set(['day', 'month']);
const SPEND_METRICS = new Set(['used_usd', 'limit_usd', 'utilization', 'remaining_usd']);

function isKnownPath(path: string): boolean {
  if (FIXED_PATHS.has(path)) return true;
  const parts = path.split('.');
  if (parts.length === 3 && parts[0] === 'request' && parts[1] === 'metadata') return true;
  if (parts.length === 4 && parts[0] === 'spend') {
    return (
      SPEND_SCOPES.has(parts[1] ?? '') &&
      SPEND_PERIODS.has(parts[2] ?? '') &&
      SPEND_METRICS.has(parts[3] ?? '')
    );
  }
  return false;
}

const BOOL_FUNCTIONS = new Set([
  '_&&_',
  '_||_',
  '!_',
  '_==_',
  '_!=_',
  '_<_',
  '_<=_',
  '_>_',
  '_>=_',
  '@in',
  '@not_strictly_false',
  'matches',
  'contains',
  'startsWith',
  'endsWith',
]);

interface AstFacts {
  nodeCount: number;
  bannedMacro: boolean;
  regexLiterals: number[];
  globalMatches: boolean; // global-form matches(x, pat) — no runtime overload → reject at authoring
  refs: Set<string>;
  cost: number;
}

function childExprs(value: unknown): ExprNode[] {
  const out: ExprNode[] = [];
  const visit = (v: unknown): void => {
    if (v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const el of v) visit(el);
      return;
    }
    if ('exprKind' in (v as object)) {
      out.push(v as ExprNode);
      return;
    }
    for (const nested of Object.values(v as Record<string, unknown>)) visit(nested);
  };
  visit(value);
  return out;
}

function selectPath(node: ExprNode): string | undefined {
  const kind = node.exprKind;
  if (kind?.case === 'identExpr') {
    const name = (kind.value as IdentValue).name;
    return (NAMESPACES as readonly string[]).includes(name) ? name : undefined;
  }
  if (kind?.case === 'selectExpr') {
    const sel = kind.value as SelectValue;
    const base = sel.operand ? selectPath(sel.operand) : undefined;
    return base === undefined ? undefined : `${base}.${sel.field}`;
  }
  return undefined;
}

function constStringLen(node: ExprNode | undefined): number | undefined {
  const kind = node?.exprKind;
  if (!kind) return undefined;
  if (kind.case === 'constExpr') {
    const c = (kind.value as ConstValue).constantKind;
    return c?.case === 'stringValue' && typeof c.value === 'string' ? c.value.length : undefined;
  }
  if (kind.case === 'callExpr') {
    const call = kind.value as CallValue;
    if (call.function === '_+_' && call.args?.length === 2) {
      const l = constStringLen(call.args[0]);
      const r = constStringLen(call.args[1]);
      return l === undefined || r === undefined ? undefined : l + r;
    }
  }
  return undefined;
}

function analyze(node: ExprNode | undefined, facts: AstFacts, parentIsSelect = false): number {
  if (!node || !node.exprKind) return 0;
  facts.nodeCount += 1;
  const kind = node.exprKind;

  switch (kind.case) {
    case 'constExpr':
      return 0;
    case 'identExpr':
      return 1;
    case 'selectExpr': {
      const sel = kind.value as SelectValue;
      if (!parentIsSelect) {
        const path = selectPath(node);
        if (path !== undefined) facts.refs.add(path);
      }
      return 1 + analyze(sel.operand, facts, true);
    }
    case 'listExpr': {
      const list = kind.value as ListValue;
      let c = 1;
      for (const el of list.elements ?? []) c += analyze(el, facts);
      return c;
    }
    case 'comprehensionExpr': {
      facts.bannedMacro = true;
      return MAX_COST + 1;
    }
    case 'callExpr': {
      const call = kind.value as CallValue;
      let base = 1;
      if (call.function === 'matches') {
        // Pattern position depends on form: receiver `x.matches(pat)` → args[0]; global
        // `matches(x, pat)` → args[1]. Checking args[0] for the global form missed the regex bound
        // entirely (red-team B7). Global matches also has no RE2 runtime overload (always errors →
        // fail-closed always-deny), so we reject it at authoring below.
        const isGlobal = call.target === undefined;
        if (isGlobal) facts.globalMatches = true;
        const pat = isGlobal ? call.args?.[1] : call.args?.[0];
        const len = constStringLen(pat);
        if (len === undefined) {
          facts.regexLiterals.push(MAX_REGEX_LEN + 1);
          base = 10;
        } else {
          facts.regexLiterals.push(len);
          base = 10 + len;
        }
      } else if (call.function === '@in') {
        const rhs = call.args?.[1];
        const listLen =
          rhs?.exprKind?.case === 'listExpr'
            ? ((rhs.exprKind.value as ListValue).elements?.length ?? 0)
            : 0;
        base = 1 + listLen;
      } else if (
        call.function === 'contains' ||
        call.function === 'startsWith' ||
        call.function === 'endsWith'
      ) {
        base = 3;
      }
      let c = base;
      c += analyze(call.target, facts);
      for (const a of call.args ?? []) c += analyze(a, facts);
      return c;
    }
    default: {
      let c = 1;
      for (const child of childExprs(kind.value)) c += analyze(child, facts);
      return c;
    }
  }
}

function resultIsBool(root: ExprNode | undefined): boolean {
  const kind = root?.exprKind;
  if (!kind) return false;
  if (kind.case === 'callExpr') return BOOL_FUNCTIONS.has((kind.value as CallValue).function);
  if (kind.case === 'selectExpr') {
    const sel = kind.value as SelectValue;
    if (sel.testOnly) return true;
    const path = selectPath(root);
    return path !== undefined && (FIXED_PATHS.get(path)?.bool ?? false);
  }
  if (kind.case === 'constExpr') {
    return (kind.value as ConstValue).constantKind?.case === 'boolValue';
  }
  return false;
}

type PlanFn = (ctx: Record<string, unknown>) => unknown;
const SLOW_BUDGET_MS = 0.1;

export interface CelMetrics {
  slow: number;
  errors: number;
}

export class BufbuildConditionEvaluator implements ConditionEvaluator {
  readonly #plans = new WeakMap<CompiledCondition, PlanFn>();
  readonly #env = celEnv();
  readonly #metrics: CelMetrics = { slow: 0, errors: 0 };

  get metrics(): Readonly<CelMetrics> {
    return this.#metrics;
  }
  resetMetrics(): void {
    this.#metrics.slow = 0;
    this.#metrics.errors = 0;
  }

  compile(source: string): CompiledCondition {
    let root: ExprNode | undefined;
    try {
      root = (parse(source) as unknown as { expr?: ExprNode }).expr;
    } catch (e) {
      throw new CelCompileError('cel_parse_error', (e as Error).message, { source });
    }

    const facts: AstFacts = {
      nodeCount: 0,
      bannedMacro: false,
      regexLiterals: [],
      globalMatches: false,
      refs: new Set<string>(),
      cost: 0,
    };
    const cost = analyze(root, facts);
    facts.cost = cost;

    if (facts.bannedMacro) {
      throw new CelCompileError('cel_banned_macro', 'comprehension macros are not allowed', {
        banned: [...BANNED_MACROS],
      });
    }
    if (facts.globalMatches) {
      // Global matches(x, pat) has no RE2 runtime overload → it would always error → fail-closed
      // always-deny. Reject at authoring; require the receiver form x.matches(pat) (red-team B7).
      throw new CelCompileError(
        'cel_type_error',
        'use x.matches(pattern), not matches(x, pattern)',
        {
          form: 'global_matches',
        },
      );
    }
    for (const ref of facts.refs) {
      if (!isKnownPath(ref)) {
        throw new CelCompileError('cel_type_error', `unknown attribute: ${ref}`, { ref });
      }
    }
    if (!resultIsBool(root)) {
      throw new CelCompileError('cel_type_error', 'condition result must be bool', { source });
    }
    for (const len of facts.regexLiterals) {
      if (len > MAX_REGEX_LEN) {
        throw new CelCompileError(
          'cel_regex_too_long',
          `matches() regex ${len} > ${MAX_REGEX_LEN}`,
          { length: len, limit: MAX_REGEX_LEN },
        );
      }
    }
    if (facts.nodeCount > MAX_NODES) {
      throw new CelCompileError(
        'cel_ast_too_large',
        `AST ${facts.nodeCount} > ${MAX_NODES} nodes`,
        {
          nodes: facts.nodeCount,
          limit: MAX_NODES,
        },
      );
    }
    if (cost > MAX_COST) {
      throw new CelCompileError('cel_cost_exceeded', `cost ${cost} > ${MAX_COST}`, {
        cost,
        limit: MAX_COST,
      });
    }

    const refs = [...facts.refs].sort();
    const condition: CompiledCondition = {
      source,
      program: new TextEncoder().encode(source),
      cost,
      refs,
    };
    this.#plans.set(condition, this.#buildPlan(source));
    return condition;
  }

  load(program: Uint8Array, source: string, cost: number, refs: string[]): CompiledCondition {
    const condition: CompiledCondition = { source, program, cost, refs };
    this.#plans.set(condition, this.#buildPlan(source));
    return condition;
  }

  run(condition: CompiledCondition, attrs: AttributeActivation): boolean {
    let planFn = this.#plans.get(condition);
    if (!planFn) {
      planFn = this.#buildPlan(this.#sourceOf(condition));
      this.#plans.set(condition, planFn);
    }
    const result = planFn(attrs as unknown as Record<string, unknown>);
    if (isCelError(result)) throw new Error(`cel runtime error: ${result.message}`);
    if (typeof result !== 'boolean') throw new Error(`cel result not bool: ${typeof result}`);
    return result;
  }

  /** The 16 §5.4 hot-path wrapper: measured 100µs budget + fail-closed enforce / fail-open shadow. */
  evalCondition(
    condition: CompiledCondition,
    attrs: AttributeActivation,
    enforcement: Enforcement,
  ): boolean {
    const t0 = performance.now();
    try {
      return this.run(condition, attrs);
    } catch {
      this.#metrics.errors += 1;
      return enforcement === 'enforce'; // fail CLOSED for enforce, fail OPEN for shadow
    } finally {
      if (performance.now() - t0 > SLOW_BUDGET_MS) this.#metrics.slow += 1;
    }
  }

  #buildPlan(source: string): PlanFn {
    const parsed = parse(source) as unknown as Parameters<typeof plan>[1];
    return plan(this.#env, parsed) as PlanFn;
  }

  #sourceOf(condition: CompiledCondition): string {
    return condition.source || new TextDecoder().decode(condition.program);
  }
}
