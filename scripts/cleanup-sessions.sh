#!/bin/bash
#
# v2 session cleanup — prune stale per-session artifacts.
#
# Usage:  ./scripts/cleanup-sessions.sh [--dry-run]
#
# Retention:
#   Session SDK transcript JSONLs:  7 days  (active sessions always kept)
#   Conversation archives:          30 days
#   Logs in groups/<g>/logs:        7 days
#
# Safe to run while the service is up — active sessions are read from v2.db.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

V2_DB="$PROJECT_ROOT/data/v2.db"
SESSIONS_DIR="$PROJECT_ROOT/data/v2-sessions"
GROUPS_DIR="$PROJECT_ROOT/groups"

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

TOTAL_FREED=0

log() { echo "[cleanup] $*"; }

remove() {
  local target="$1"
  local size=0
  if [ -d "$target" ]; then
    size=$(du -sk "$target" 2>/dev/null | cut -f1)
  else
    local bytes
    bytes=$(wc -c < "$target" 2>/dev/null || echo 0)
    size=$((bytes / 1024))
  fi
  if $DRY_RUN; then
    log "would remove: $target (${size}K)"
  else
    rm -rf "$target"
  fi
  TOTAL_FREED=$((TOTAL_FREED + size))
}

# Pull active session IDs from v2.db so we never prune live state.
if [ ! -f "$V2_DB" ]; then
  log "ERROR: v2.db not found at $V2_DB"
  exit 1
fi

# Prefer pnpm + scripts/q.ts (always available since codebase uses better-sqlite3
# everywhere); fall back to system sqlite3 if present.
if command -v pnpm >/dev/null 2>&1 && [ -f "$PROJECT_ROOT/scripts/q.ts" ]; then
  ACTIVE_IDS=$(cd "$PROJECT_ROOT" && pnpm exec tsx scripts/q.ts data/v2.db "SELECT id FROM sessions" 2>/dev/null || true)
elif command -v sqlite3 >/dev/null 2>&1; then
  ACTIVE_IDS=$(sqlite3 "$V2_DB" "SELECT id FROM sessions;" 2>/dev/null || true)
else
  log "WARN: no sqlite3 or pnpm — treating ALL sessions as active (safe)"
  ACTIVE_IDS=""
fi

is_active() {
  echo "$ACTIVE_IDS" | grep -qF "$1"
}

# ── Prune per-session SDK transcript dirs ──
for group_dir in "$SESSIONS_DIR"/*/; do
  [ -d "$group_dir" ] || continue
  for session_dir in "$group_dir"sess-*/; do
    [ -d "$session_dir" ] || continue
    sid=$(basename "$session_dir")
    if is_active "$sid"; then
      continue
    fi
    proj="$session_dir/.claude/projects"
    if [ -d "$proj" ] && [ -n "$(find "$proj" -mtime +7 2>/dev/null | head -1)" ]; then
      remove "$proj"
    fi
  done
done

# ── Prune per-group conversation archives (>30 days) ──
for group_dir in "$GROUPS_DIR"/*/conversations; do
  [ -d "$group_dir" ] || continue
  while IFS= read -r -d '' f; do
    remove "$f"
  done < <(find "$group_dir" -type f -mtime +30 -print0 2>/dev/null)
done

# ── Prune group logs (>7 days) ──
while IFS= read -r -d '' f; do
  remove "$f"
done < <(find "$GROUPS_DIR"/*/logs -type f -mtime +7 -print0 2>/dev/null)

if $DRY_RUN; then
  log "DRY RUN — would free ~${TOTAL_FREED}K"
else
  log "Done — freed ~${TOTAL_FREED}K"
fi
