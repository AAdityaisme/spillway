#!/usr/bin/env bash
# Apply the Axiom monitor definitions in axiom-monitors.json (12-operations §6.4 alerts 3/4/5/7-backup).
#
# Dry-run by default — prints the request bodies. Pass --apply to actually create.
# Idempotent on name: monitors whose name already exists in the org are skipped (no update API
# round-trip at Phase 0 — delete in the UI and re-apply to change one).
#
# Required env (Half B — exists once Axiom is provisioned):
#   AXIOM_TOKEN             API token with monitors:create scope
# Optional env:
#   AXIOM_NOTIFIER_SLACK    notifier id for Slack routes
#   AXIOM_NOTIFIER_EMAIL    notifier id for email routes
set -euo pipefail

cd "$(dirname "$0")"
MODE="${1:-dry-run}"
API="https://api.axiom.co/v2/monitors"

if [ "$MODE" = "--apply" ] && [ -z "${AXIOM_TOKEN:-}" ]; then
  echo "FATAL: AXIOM_TOKEN is required with --apply" >&2
  exit 1
fi

existing="[]"
if [ "$MODE" = "--apply" ]; then
  existing=$(curl -sf -H "Authorization: Bearer $AXIOM_TOKEN" "$API" | node -e \
    "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.stringify(JSON.parse(d).map(m=>m.name))))")
fi

count=$(node -e "console.log(require('./axiom-monitors.json').monitors.length)")
for i in $(seq 0 $((count - 1))); do
  body=$(node -e "
    const def = require('./axiom-monitors.json').monitors[$i];
    const notifierIds = def.notify.flatMap(n =>
      n === 'slack' ? (process.env.AXIOM_NOTIFIER_SLACK ? [process.env.AXIOM_NOTIFIER_SLACK] : [])
                    : (process.env.AXIOM_NOTIFIER_EMAIL ? [process.env.AXIOM_NOTIFIER_EMAIL] : []));
    const { notify, description, ...m } = def;
    console.log(JSON.stringify({ ...m, description, notifierIds }));
  ")
  name=$(node -e "console.log(require('./axiom-monitors.json').monitors[$i].name)")

  if [ "$MODE" != "--apply" ]; then
    echo "[dry-run] POST $API"
    echo "$body" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.stringify(JSON.parse(d),null,2)))"
    continue
  fi

  if echo "$existing" | grep -q "\"$name\""; then
    echo "skip (exists): $name"
    continue
  fi

  curl -sf -X POST "$API" \
    -H "Authorization: Bearer $AXIOM_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$body" >/dev/null
  echo "created: $name"
done
