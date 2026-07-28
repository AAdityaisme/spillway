/**
 * alerts.kind registry (19 §5). The DB column is plain text (no enum, no migration to add a kind);
 * validity is enforced here at the API layer. userConfigurable:false kinds are system rows (fired
 * with alert_id=NULL by a producer) and cannot be created through the CRUD. Adding a kind = one entry
 * here (+ a config schema + a producer) — no migration.
 */

export interface AlertKindDef {
  userConfigurable: boolean;
  producer: 'reconcile' | 'anomaly-scan' | 'workflow' | 'auth-expiry';
}

export const ALERT_KINDS: Record<string, AlertKindDef> = {
  budget_threshold: { userConfigurable: true, producer: 'reconcile' },
  anomaly: { userConfigurable: true, producer: 'anomaly-scan' },
  error_rate: { userConfigurable: true, producer: 'reconcile' },
  key_expiry: { userConfigurable: true, producer: 'auth-expiry' },
  budget_forecast: { userConfigurable: true, producer: 'reconcile' },
  anomaly_confirmed: { userConfigurable: false, producer: 'anomaly-scan' },
  approval_notification: { userConfigurable: false, producer: 'workflow' },
  automation_notification: { userConfigurable: false, producer: 'workflow' },
};

export function isKnownAlertKind(kind: string): boolean {
  return Object.hasOwn(ALERT_KINDS, kind);
}

export function isUserConfigurableKind(kind: string): boolean {
  return ALERT_KINDS[kind]?.userConfigurable === true;
}

/**
 * Fallback severity for system/automation event kinds that don't carry their own severity in
 * the payload (expanded-audit M33 — every producer must stamp severity so the delivery tier
 * can page vs. suppress correctly). Producers that can compute a richer severity (e.g. the
 * budget-threshold crossing band → thresholdSeverity) should prefer their own value.
 *
 * approval_notification / automation_notification: informational fire, never page.
 * anomaly_confirmed: an AND-gated burst/projection crossing — operator-facing, warning.
 * All other known kinds fall through to 'warning' (the same implicit default, but now explicit).
 */
export function defaultSeverityForKind(eventType: string): 'info' | 'warning' | 'critical' {
  switch (eventType) {
    case 'approval_notification':
    case 'automation_notification':
      return 'info';
    case 'anomaly_confirmed':
      return 'critical'; // 19 §3: always critical, high-confidence AND-gated signal
    default:
      return 'warning';
  }
}
