#!/usr/bin/env bash
# scripts/rollback.sh — kill switch, invoke in an incident (bible §0.7.4).
# Deploys a previously-pushed image tag with --strategy=rolling so it lands fast, without
# waiting on bluegreen/canary health-check windows — the point of a kill switch is speed.
#
# Usage:
#   FLY_APP=spillway ./scripts/rollback.sh <version>
#
# <version> must match a tag already pushed by deploy.yml: registry.fly.io/<app>:deployment-<version>
# (deploy.yml pushes deployment-${{ github.sha }}, so <version> is normally a commit SHA).
set -euo pipefail

usage() {
  echo "Usage: FLY_APP=<app> $0 <version>" >&2
  echo "  <version> is the tag suffix of a previously pushed registry.fly.io/<app>:deployment-<version> image" >&2
  exit 1
}

if [ "$#" -ne 1 ]; then
  usage
fi

APP=${FLY_APP:-spillway}
VERSION=$1
IMAGE="registry.fly.io/${APP}:deployment-${VERSION}"

echo "Rolling back ${APP} to ${VERSION}..."
flyctl releases list -a "$APP" | head -10
flyctl deploy --image "$IMAGE" -a "$APP" --strategy=rolling
echo "Rollback complete. Verify with: flyctl status -a $APP"
