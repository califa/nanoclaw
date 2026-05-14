# bo-features — what's added on top of nanoclaw v2 upstream

This install of nanoclaw v2 carries customizations that bring back v1 behavior
or layer in new functionality. Most live in isolated plugin / migration /
skill directories so future `git pull` from upstream won't clobber them. A
handful are direct edits to upstream files — those are listed below so the
patch can be re-applied on update.

Run `pnpm check:bo-features` (or `node scripts/check-bo-features.mjs`) after
every upstream merge. It exits non-zero if any regression is detected.

## Where customizations live

### Isolated (safe across upstream merges)

These directories are bo-only. Upstream code never writes to them, so a
`git pull` of upstream cannot break them.

- `src/plugins/bo-dreaming/` — nightly reviewer-pattern distillation
- `src/plugins/bo-ha-shortcut/` — Home Assistant fast-path inbound transformer
- `src/plugins/bo-memory-write/` — `<memory-write>` tag handler
- `src/plugins/bo-reviewer-enforcement/` — host-side Slack pre-send reviewer
- `src/plugins/bo-scheduler-tags/` — `<retry> / <healed> / <no-fix>` handlers
- `src/plugins/bo-token-usage/` — SDK usage JSONL → `token_usage` + `session_context`
- `src/plugins/bo-voice/` — local whisper.cpp transcription
- `migrations/bo-001…bo-004` — DB migrations for the above
- `container/skills/bo-*` — container-side skills mounted into Bo's runtime
- `scripts/check-bo-features.mjs` — this regression checker
- `scripts/refresh-oauth.mjs` — 5-min HTTP refresh against
  `console.anthropic.com/v1/oauth/token`
- `scripts/cleanup-sessions.sh` — daily prune of per-session JSONLs / archives
- `scripts/obsidian-bridge.mjs` — host-side HTTP bridge to Obsidian CLI
- `src/oauth-sync.ts` — fs.watch + per-group OAuth credential propagation
- `src/session-cleanup.ts` — schedules cleanup-sessions.sh every 24h

### Upstream patches (re-apply after every `git pull`)

The regression checker verifies these are still in place.

#### `container/agent-runner/src/poll-loop.ts` — bare-text fallback

v2 upstream requires the agent to wrap every reply in
`<message to="name">…</message>`. Models trained for natural conversation
intermittently emit bare text → silently dropped → user sees typing indicator
but no response. This patch falls back to the inbound's origin destination
when bare text is detected, restoring v1 behavior.

**Where:** end of `dispatchResultText`, in the `hasUnwrapped` branch.
**What:** look up `findByRouting(routing.channelType, routing.platformId)`,
and if a destination is found, send the scratchpad to it instead of dropping.

**Regression marker (used by the checker):** the file must contain the string
`falling back to origin destination`.

## Launchd jobs

These run alongside the main service. Reinstall on a fresh machine via
`scripts/install-launchd.sh` (if present) or manual `launchctl bootstrap`.

- `com.nanoclaw-v2-40b8cd25` — the main host process
- `com.claude.token-refresh` — runs `scripts/refresh-oauth.mjs` every 5 min
- `com.nanoclaw.obsidian-bridge` — runs `scripts/obsidian-bridge.mjs` on
  port 27999

## External configs

Lives outside the project root (so the container never sees them):

- `~/.config/nanoclaw/claude-oauth.json` — cached Claude OAuth credential,
  written by `oauth-sync.ts`, mounted into each per-group `.claude-shared`
- `~/.config/nanoclaw/mount-allowlist.json` — host paths the container
  can mount, with read/write scopes
- `~/.config/nanoclaw/credential-allowlist.json` — 1Password items the
  helium-api can fetch on behalf of the container
- `~/.config/nanoclaw/sender-allowlist.json` — legacy from v1; v2 uses
  DB-backed access control via `modules/permissions` instead

## What to do after a v2 upstream pull

```bash
# 1. Pull upstream
git pull origin main

# 2. Re-install any deps that upstream changed
pnpm install

# 3. Rebuild the container if container/* changed
container/build.sh

# 4. Run the regression checker — any "✗" means a behavior broke
pnpm check:bo-features

# 5. If poll-loop.ts lost the bare-text fallback, re-apply it from this doc

# 6. Restart the host service
launchctl kickstart -k "gui/$(id -u)/com.nanoclaw-v2-40b8cd25"
```
