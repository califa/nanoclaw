#!/usr/bin/env bash
# bo-features install — idempotent. Copies plugins + container skills +
# migrations from the bo-features sibling branch into the trunk checkout.
# Re-run after /update-nanoclaw to refresh.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

echo "=== bo-features install ==="

# 1. Pre-flight: confirm extension-points patch is in trunk
if ! grep -q "loadPlugins" src/index.ts 2>/dev/null; then
  echo "ERROR: trunk extension-points patch not found (src/index.ts missing loadPlugins)"
  echo "Resolve by merging from upstream before installing bo-features."
  exit 1
fi

# 2. Fetch bo-features
if ! git rev-parse --verify bo-features >/dev/null 2>&1; then
  echo "ERROR: bo-features branch not found locally. Create it first."
  exit 1
fi

# 3. Apply files (selective git checkout from bo-features)
echo "Copying plugins + container skills + migrations from bo-features..."
git checkout bo-features -- \
  src/plugins/ \
  container/skills/bo-slack-formatting \
  container/skills/bo-tags \
  container/skills/bo-adversarial-reviewer \
  container/skills/bo-self-learning \
  container/skills/bo-llm-wiki \
  migrations/ \
  2>/dev/null || echo "(some paths not yet on bo-features — expected during scaffold)"

# 4. Install dependencies (each plugin may have its own package.json deps)
if [ -f package.json ]; then
  pnpm install
fi

# 5. Run any pending migrations from migrations/
if [ -d migrations ] && [ "$(ls -A migrations 2>/dev/null)" ]; then
  echo "Migrations directory has files — implement migration loader to apply them"
  # TODO: pnpm exec tsx scripts/run-bo-migrations.ts
fi

# 6. Build
pnpm run build

# 7. Restart host so the plugin loader picks up new plugins
PLIST_LABEL=$(launchctl list 2>/dev/null | awk '/com.nanoclaw-v2-/ {print $3; exit}')
if [ -n "$PLIST_LABEL" ]; then
  echo "Restarting $PLIST_LABEL..."
  launchctl kickstart -k "gui/$(id -u)/$PLIST_LABEL"
fi

echo "=== bo-features install complete ==="
echo
echo "Verify with:"
echo "  sleep 3 && grep 'Plugin loaded' logs/nanoclaw.log | tail"
