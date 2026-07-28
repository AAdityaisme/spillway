import { parseUsd } from '@spillway/pricing';
import { SpillwayError } from '@spillway/shared';

/**
 * Safety defaults + the pure matcher (Part II §18 §3.2 / §3.5). Blast-radius guardrails for a
 * table-driven automation engine: a misconfigured `pause_key` rule could take down production traffic
 * (workflow-engines OQ5). All logic here is PURE (no IO) so the poller (§3.3) and the dry-run preview
 * (§3.5.3) share one evaluator, and the rule-write validator (§3.2 threshold isolation) is testable
 * without a DB.
 */

// ── rule / event shapes (subset the matcher reads) ────────────────────────────

export interface AutomationRule {
  id: string;
  priority: number;
  trigger_type: string;
  condition: Record<string, unknown>;
  action: Record<string, unknown>;
  state: 'active' | 'notify_only' | 'disabled';
  notify_only_until: Date | string | null;
  stop_on_match: boolean;
  rate_cap_per_hour: number;
  schedule_cron: string | null;
}

export type EventPayload = Record<string, unknown>;

/** Optional CEL hook (16 ConditionEvaluator seam); absent ⇒ a rule with `cel` fails closed. */
export type CelEval = (cel: string, payload: EventPayload) => boolean;

// ── §3.2 trigger_type → event.kind ────────────────────────────────────────────

/** `null` ⇒ matches ANY kind (alert_fired, further filtered by condition.event_kind). */
const TRIGGER_KIND: Record<string, string | null> = {
  alert_fired: null,
  budget_crossed: 'budget_threshold',
  approval_decided: 'approval_decided',
  key_created: 'key_created',
  schedule_cron: 'schedule',
};

/** event.kind = payload.event_type. */
export function eventKindOf(payload: EventPayload): string | null {
  const t = payload['event_type'];
  return typeof t === 'string' ? t : null;
}

function triggerMatches(triggerType: string, eventKind: string | null): boolean {
  if (!(triggerType in TRIGGER_KIND)) return false;
  const want = TRIGGER_KIND[triggerType];
  if (want === null) return true; // alert_fired → any kind
  return eventKind === want;
}

// ── §3.5.1 effective state (7-day notify-only grace) ──────────────────────────

export function effectiveState(
  rule: Pick<AutomationRule, 'state' | 'notify_only_until'>,
  now: Date,
): 'active' | 'notify_only' | 'disabled' {
  if (rule.state === 'disabled') return 'disabled';
  if (rule.state === 'active' && rule.notify_only_until !== null) {
    const until = new Date(rule.notify_only_until);
    if (now < until) return 'notify_only';
  }
  return rule.state; // 'active' past grace, or explicit 'notify_only'
}

// ── §3.2 structured condition match (AND of present fields) ────────────────────

const THRESHOLD_FIELDS = ['pct', 'min_ratio'] as const;

/** anomaly ratio = payload.ratio, else today_usd/baseline_usd (via µUSD, never parseFloat on money). */
function ratioOf(payload: EventPayload): number | undefined {
  const r = payload['ratio'];
  if (typeof r === 'number') return r;
  const today = payload['today_usd'];
  const baseline = payload['baseline_usd'];
  if (typeof today === 'string' && typeof baseline === 'string') {
    const b = parseUsd(baseline);
    if (b === 0n) return undefined;
    return Number(parseUsd(today)) / Number(b);
  }
  return undefined;
}

export function conditionMatches(
  condition: Record<string, unknown>,
  eventKind: string | null,
  payload: EventPayload,
  celEval?: CelEval,
): boolean {
  for (const [field, value] of Object.entries(condition)) {
    if (field === 'cel') continue; // handled below
    if (field === 'event_kind') {
      if (value !== eventKind) return false;
      continue;
    }
    if (field === 'min_ratio') {
      const ratio = ratioOf(payload);
      if (ratio === undefined || ratio < Number(value)) return false;
      continue;
    }
    // structured subset equality (scope_type, scope_id, virtual_key_id, pct, …)
    if (payload[field] !== value) return false;
  }
  const cel = condition['cel'];
  if (typeof cel === 'string') {
    if (!celEval) return false; // fail-closed: cel present, no evaluator
    if (!celEval(cel, payload)) return false;
  }
  return true;
}

/**
 * Priority-ordered first-match with `stop_on_match` (§3.3 step 3.2 / PagerDuty ordinality). Excludes
 * `disabled` rules; `notify_only` rules still MATCH (the poller records a would-have run). Iterates
 * ascending priority, accumulating matches until a matched ACTIVE rule carries `stop_on_match`.
 */
export function matchRules(
  rules: readonly AutomationRule[],
  eventKind: string | null,
  payload: EventPayload,
  now: Date,
  celEval?: CelEval,
): AutomationRule[] {
  const sorted = [...rules].sort((a, b) => a.priority - b.priority);
  const out: AutomationRule[] = [];
  for (const rule of sorted) {
    const eff = effectiveState(rule, now);
    if (eff === 'disabled') continue;
    if (!triggerMatches(rule.trigger_type, eventKind)) continue;
    if (!conditionMatches(rule.condition, eventKind, payload, celEval)) continue;
    out.push(rule);
    // stop_on_match only halts on a rule that will actually enforce. A notify_only rule (explicit or
    // in its §3.5 grace) is recorded as a would-have run but must NOT claim the priority slot from a
    // lower-priority ACTIVE enforcement rule (§3.3 step 3.2 / §3.5.1).
    if (rule.stop_on_match && eff === 'active') break;
  }
  return out;
}

// ── §3.5.2 rate cap ────────────────────────────────────────────────────────────

export function isRateCapped(appliedInWindow: number, cap: number): boolean {
  return appliedInWindow >= cap;
}

// ── §3.2 threshold-condition isolation (rule-write validation) ────────────────

const ALLOWED_WITH_THRESHOLD = new Set([
  'pct',
  'min_ratio',
  'scope_type',
  'scope_id',
  'event_kind',
  'cel',
]);

/**
 * A rule whose condition carries a threshold field (pct, min_ratio) MUST NOT mix it with structured
 * fields beyond scope selectors — 422 (keeps each fired rule explainable, ADR-009). Called at rule
 * create/update.
 */
export function validateRuleCondition(condition: Record<string, unknown>): void {
  const keys = Object.keys(condition);
  if (!keys.some((k) => (THRESHOLD_FIELDS as readonly string[]).includes(k))) return;
  for (const k of keys) {
    if (!ALLOWED_WITH_THRESHOLD.has(k)) {
      throw new SpillwayError(
        'threshold_condition_not_isolated',
        `threshold condition must not mix unrelated field '${k}'`,
        { httpStatus: 422 },
      );
    }
  }
}

// ── §3.5.3 dry-run preview (zero effects) ──────────────────────────────────────

export interface PreviewEvent {
  id: string;
  payload: EventPayload;
}
export interface PreviewMatch {
  event_id: string;
  rule_id: string;
  effects: string[];
}

/** Effect type list for a rule's action (single effect OR `{effects:[…]}`). */
export function normalizeEffects(
  action: Record<string, unknown>,
): Array<{ type: string } & Record<string, unknown>> {
  const arr = action['effects'];
  if (Array.isArray(arr)) return arr as Array<{ type: string } & Record<string, unknown>>;
  return [action as { type: string } & Record<string, unknown>];
}

/** Runs the SAME matcher over a window of events with ZERO effects (§3.5.3). */
export function dryRunPreview(
  rules: readonly AutomationRule[],
  events: readonly PreviewEvent[],
  now: Date,
  celEval?: CelEval,
): PreviewMatch[] {
  const out: PreviewMatch[] = [];
  for (const ev of events) {
    const kind = eventKindOf(ev.payload);
    for (const rule of matchRules(rules, kind, ev.payload, now, celEval)) {
      out.push({
        event_id: ev.id,
        rule_id: rule.id,
        effects: normalizeEffects(rule.action).map((e) => e.type),
      });
    }
  }
  return out;
}
