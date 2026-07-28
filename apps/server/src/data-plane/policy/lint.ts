import { matchIsSuperset } from './guardrails.js';
import type { MatchSpec } from './guardrail-types.js';

/**
 * Policy lint (16 §9.1) — static analysis of the effective config on save / via POST /api/policies/lint.
 * Each finding is `{ rule, severity, subjectIds[], message }`.
 *   L1 unreachable routing rule (higher-priority match is a superset) — warn.
 *   L2 shadowed priority (equal match scope) — warn.
 *   L3 guardrail-vs-routing conflict (a routing rewrite/fallback target an enforcing deny always blocks) — error.
 *   L4 alias-target-not-allowed (an alias target no active provider serves, or an enforcing deny blocks) — error.
 *   L5 CEL cost > 200 — error.
 *   L6 spend-attribute on a non-cached scope/period (e.g. rolling_30d, absent from the v1 attribute set) — warn.
 * Reuses the ch15/ch16 shared structural-match analyzer (`matchIsSuperset`).
 */

export interface Target {
  provider: string;
  model: string;
}

export interface RoutingRuleLint {
  id: string;
  priority: number;
  match: MatchSpec;
  enabled: boolean;
  /** §9.1 L3: the {provider,model} targets this rule routes TO (rewrite `to` + fallbacks / set_fallbacks chain). */
  targets?: Target[];
}
export interface PolicyLint {
  id: string;
  conditionCost: number | null;
  enabled: boolean;
  // §9.1 L3/L4/L6 (optional — absent ⇒ those rules skip this policy):
  effect?: string; // 'deny' | 'require_approval' | 'flag'
  enforcement?: string; // 'shadow' | 'enforce'
  match?: MatchSpec;
  conditionCel?: string | null;
}
export interface AliasLint {
  alias: string;
  targets: Target[];
}
export interface LintExtras {
  aliases?: AliasLint[];
  /** Providers with an active provider_key — an alias target on a provider absent here can never dispatch. */
  activeProviders?: string[];
}
export interface LintFinding {
  rule: string;
  severity: 'warn' | 'error';
  subjectIds: string[];
  message: string;
}

/** The valid CEL spend namespace (attributes.ts SpendScope/SpendPeriod). rolling_30d is a BUDGET period
 *  but NOT a policy attribute in v1 — a condition referencing it reads null/zero (§9.1 L6). */
const SPEND_SCOPES = new Set(['key', 'team', 'org', 'provider']);
const SPEND_PERIODS = new Set(['day', 'month']);
const SPEND_REF = /\bspend\.([a-z_]+)\.([a-z0-9_]+)/g;

/** An unconditional (no CEL), enabled, ENFORCING deny whose match is scoped to model/provider — the only
 *  deny class that produces a GUARANTEED dead route (a CEL-conditional or shadow deny is not always-firing). */
function isUnconditionalEnforcingDeny(p: PolicyLint): boolean {
  return (
    p.enabled &&
    p.effect === 'deny' &&
    p.enforcement === 'enforce' &&
    (p.conditionCel === null || p.conditionCel === undefined) &&
    p.match !== undefined &&
    ((p.match.models?.length ?? 0) > 0 || (p.match.providers?.length ?? 0) > 0)
  );
}

/** Does a deny's match cover a concrete target? Model the target as a fully-specified MatchSpec and reuse
 *  the superset analyzer: the deny accepts the target iff its constraints are a superset of {provider,model}.
 *  (A deny with a metadata match returns false in matchIsSuperset — conditional, so never a dead route.) */
function denyCovers(match: MatchSpec, t: Target): boolean {
  return matchIsSuperset(match, { providers: [t.provider], models: [t.model] });
}

export function lintConfig(
  rules: RoutingRuleLint[],
  policies: PolicyLint[],
  extras: LintExtras = {},
): LintFinding[] {
  const findings: LintFinding[] = [];

  // L1/L2 — routing rules are first-match by ascending priority. A lower-priority-NUMBER rule whose
  // match structurally contains a later rule's match fully shadows it (L1 unreachable); when the two
  // match scopes are equal, the later rule can never win on priority (L2 shadowed priority).
  const active = rules.filter((r) => r.enabled).sort((a, b) => a.priority - b.priority);
  for (let j = 0; j < active.length; j++) {
    for (let i = 0; i < j; i++) {
      if (!matchIsSuperset(active[i]!.match, active[j]!.match)) continue;
      const equal = matchIsSuperset(active[j]!.match, active[i]!.match);
      findings.push({
        rule: equal ? 'L2' : 'L1',
        severity: 'warn',
        subjectIds: [active[j]!.id],
        message: equal
          ? `routing rule ${active[j]!.id} shares its match scope with higher-priority rule ${active[i]!.id}; the lower-priority number always wins`
          : `routing rule ${active[j]!.id} is unreachable — higher-priority rule ${active[i]!.id} fully contains its match`,
      });
      break; // one finding per shadowed rule (its first container)
    }
  }

  // L3 — a routing rule whose rewrite/fallback target is always blocked by an enforcing deny is a DEAD
  // route (the rewrite produces a request the guardrail would reject). Only unconditional model/provider
  // denies count (a CEL/shadow deny isn't guaranteed to fire).
  const hardDenies = policies.filter(isUnconditionalEnforcingDeny);
  for (const r of rules) {
    if (!r.enabled || !r.targets) continue;
    let flagged = false;
    for (const t of r.targets) {
      for (const d of hardDenies) {
        if (denyCovers(d.match!, t)) {
          findings.push({
            rule: 'L3',
            severity: 'error',
            subjectIds: [r.id, d.id],
            message: `routing rule ${r.id} routes to ${t.provider}/${t.model}, which enforcing deny ${d.id} always blocks — a dead route`,
          });
          flagged = true;
          break;
        }
      }
      if (flagged) break; // one L3 per rule (its first dead target)
    }
  }

  // L4 — an alias target that no active provider serves, or that an enforcing deny always blocks, resolves
  // to a chain entry that is always dropped or denied.
  const activeProviders = extras.activeProviders ? new Set(extras.activeProviders) : null;
  for (const a of extras.aliases ?? []) {
    let flagged = false;
    for (const t of a.targets) {
      if (activeProviders && !activeProviders.has(t.provider)) {
        findings.push({
          rule: 'L4',
          severity: 'error',
          subjectIds: [a.alias],
          message: `alias ${a.alias} targets ${t.provider}/${t.model}, but the org has no active ${t.provider} provider key`,
        });
        flagged = true;
        break;
      }
      const d = hardDenies.find((p) => denyCovers(p.match!, t));
      if (d) {
        findings.push({
          rule: 'L4',
          severity: 'error',
          subjectIds: [a.alias, d.id],
          message: `alias ${a.alias} targets ${t.provider}/${t.model}, which enforcing deny ${d.id} always blocks`,
        });
        flagged = true;
        break;
      }
    }
    if (flagged) continue;
  }

  // L5 — a stored CEL static cost over the 200 budget (§5.3). Normally rejected at authoring; re-checked
  // here to catch a schema-drift regression (an attribute type change that raises the cost).
  for (const p of policies) {
    if (p.enabled && p.conditionCost !== null && p.conditionCost > 200)
      findings.push({
        rule: 'L5',
        severity: 'error',
        subjectIds: [p.id],
        message: `guardrail policy ${p.id} has a CEL static cost of ${p.conditionCost}, over the 200 budget`,
      });
  }

  // L6 — a condition_cel referencing a spend attribute with a scope/period outside the v1 attribute set
  // (e.g. rolling_30d, which is a budget period but not a policy attribute) reads null/zero silently.
  for (const p of policies) {
    if (!p.enabled || !p.conditionCel) continue;
    const seen = new Set<string>();
    for (const m of p.conditionCel.matchAll(SPEND_REF)) {
      const [ref, scope, period] = m;
      if (SPEND_SCOPES.has(scope!) && SPEND_PERIODS.has(period!)) continue;
      if (seen.has(ref)) continue;
      seen.add(ref);
      findings.push({
        rule: 'L6',
        severity: 'warn',
        subjectIds: [p.id],
        message: `guardrail policy ${p.id} references ${ref}, which is not a v1 spend attribute (valid scopes: key/team/org/provider; periods: day/month) — it reads null/zero`,
      });
    }
  }

  return findings;
}
