# v1 Fork Reference

This directory captures what was in your customized v1 NanoClaw install (`/Users/joel/nanoclaw/`, branch `main` of `https://github.com/califa/nanoclaw.git`), for reference after the v2 migration. None of this is wired into v2 — v2's architecture diverges enough that source-level patches don't apply.

## Source of truth

- v1 working tree (read-only): `/Users/joel/nanoclaw/`
- v1 upstream: `https://github.com/qwibitai/nanoclaw.git` (branch `main`)
- v1 fork was **225 commits ahead** of upstream at migration time.

## Files in this folder

- `commits.txt` — full `git log upstream/main..HEAD --oneline` (225 commits)
- `diffstat.txt` — `git diff upstream/main..HEAD --stat` (506 lines, every changed file)

## Behavior already ported into v2

The CLAUDE.local.md cleanup (Phase 2 of `/migrate-from-v1`) preserved the agent-side behaviors from your v1 fork:

| Behavior | Lives in | Notes |
|----------|----------|-------|
| LLM Wiki (Karpathy pattern) | `groups/main/CLAUDE.local.md`, `groups/slack_main/CLAUDE.local.md` | Mount points already wired in container.json (`/workspace/extra/brain`, `wiki`, `daily`, `generated`) |
| Helium browser + CDP proxy on port 9224 | `groups/main/`, `groups/slack_main/` CLAUDE.local.md | Requires the host-side helium-proxy service (separate from v2 host) |
| 1Password credential pipeline | `groups/slack_main/CLAUDE.local.md` (Self-Healing Logins section) | Endpoint `host.docker.internal:9224/credentials` — host-side |
| Retry / Healer agent signals | `groups/main/CLAUDE.local.md` | v2 scheduler may or may not parse `<retry>` / `<healed>` — verify before relying |
| Slack pre-send checklist + Block Kit task review template | `groups/slack_main/CLAUDE.local.md` | |
| Factual accuracy / inference discipline | `groups/slack_main/CLAUDE.local.md` | |
| Parallel work routing rules | `groups/slack_main/CLAUDE.local.md` | |
| Slack `send-file` endpoint | `groups/slack_main/CLAUDE.local.md` | Host-side helium-proxy service |

## Container skills already copied during migration

These were copied from v1's `container/skills/` into v2's `container/skills/`:

- `capabilities/` — added in v1 fork
- `status/` — added in v1 fork
- `wiki/` — added in v1 fork

These three appeared as untracked dirs after the migration script ran. Commit them when ready.

## NOT portable (do not translate)

Source-level changes in `src/`, `container/agent-runner/src/`, and the v1 SQL schemas. v2 has:

- A different entity model (`users` → `messaging_groups` → `agent_groups` → `sessions`, no `registered_groups` table).
- A different IPC model (`inbound.db` + `outbound.db` per session, no `/workspace/ipc/`).
- A different credential model (OneCLI gateway, not raw env vars passed through containers).
- Different mount paths (`/workspace/agent/`, not `/workspace/group/`).
- A different container runtime (Bun, not Node).

These v1 commits touch things v2 handles differently. Don't translate them — read them for context if you ever need to know "why did v1 do X this way":

- OAuth refresh fixes (`942457f`, `48e4880`, `20deed6`, `ee25101`) — v2 uses OneCLI vault, not direct OAuth.
- Self-healing scheduler (`b034390`) — v2 has its own scheduling model; verify how `<retry>` tags are handled.
- Token usage tracking (`59cf1f0`) — v2 has different telemetry surfaces.
- Sender allowlist (`69ff8fc`) — v2 replaces this with `unknown_sender_policy` + `user_roles` + `agent_group_members`.
- HA/Ollama/cloud MCP wiring (`18c2393`, `606bfb3`, `de08e89`, etc.) — v2 wires MCP servers via `container_configs.mcp_servers`.
- Channel adapters (Slack `69ff8fc`, WhatsApp `d1d3a9c`, Telegram `132c848`, Gmail `b7f7e74`) — v2 has these as `/add-*` skills, copied from the `channels` branch.

## Fork-specific `.claude/skills/` (not copied, listed for reference)

These existed in v1 but were not copied into v2. Most reference v1 paths or APIs that don't exist in v2. To revive: read the v1 SKILL.md, identify what it actually did, decide if v2 needs an equivalent, then write a fresh v2 skill — don't port verbatim.

| Skill | What it did in v1 |
|-------|-------------------|
| `add-compact/` | Added a `/compact` slash command for chat compaction (v1-specific) |
| `add-gmail/` (channel, not the v2 `add-gmail-tool` MCP) | Wired Gmail as an inbound message channel |
| `add-image-vision/` | Added image-understanding capabilities to the container agent |
| `add-pdf-reader/` | Added PDF-reading capability |
| `add-reactions/` | Emoji reaction handling for chat platforms |
| `add-telegram-swarm/` | Multi-agent Telegram routing |
| `add-voice-transcription/` | Voice → text using local Whisper |
| `channel-formatting/` | Per-channel markdown sanitization |
| `use-local-whisper/` | Wires a local Whisper server |
| `setup/diagnostics.md` | v1 setup diagnostics |

## How to revisit

```bash
# See the full fork commit list
cat docs/v1-fork-reference/commits.txt

# See every file the fork changed
cat docs/v1-fork-reference/diffstat.txt

# Read a specific commit
cd /Users/joel/nanoclaw && git show <sha>

# Compare a specific file
cd /Users/joel/nanoclaw && git diff upstream/main..HEAD -- <path>

# Read a v1 skill you might want to port
cat /Users/joel/nanoclaw/.claude/skills/<name>/SKILL.md
```

The v1 working tree is intact and read-only from v2's perspective — nothing in this migration modified `/Users/joel/nanoclaw/`.
